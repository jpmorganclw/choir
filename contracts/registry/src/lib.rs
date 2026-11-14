//! The Choir collection.
//!
//! Every Choir is a NEP-171 token here and a NEAR account of its own, with the token id equal to
//! the account id (`<slug>.<this account>`). This contract
//!
//! - creates those accounts: no key, shared immutable code, initialised in the same receipt;
//! - keeps the NEP-171 index and is the only account an item lets change its conductor;
//! - runs a small market where a listed seat is frozen until it is sold or unlisted.
//!
//! The item is the authority on who owns it. The index here follows the item: it is updated in the
//! callback of the rotation the item accepted, and `sync` lets anyone make it catch up if a
//! callback was ever lost. This contract has no owner, no admin method and no way to change its
//! configuration, so once its own keys are deleted only this code can act for it.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, CryptoHash, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
};

mod market;
mod mint;
mod nft;
pub mod types;

pub use types::*;

pub(crate) const GAS_ITEM_INIT: Gas = Gas::from_tgas(30);
pub(crate) const GAS_ROTATE: Gas = Gas::from_tgas(25);
pub(crate) const GAS_FREEZE: Gas = Gas::from_tgas(15);
pub(crate) const GAS_VIEW: Gas = Gas::from_tgas(10);
pub(crate) const GAS_CALLBACK: Gas = Gas::from_tgas(25);
pub(crate) const GAS_ON_TRANSFER: Gas = Gas::from_tgas(35);
pub(crate) const GAS_RESOLVE: Gas = Gas::from_tgas(70);
pub(crate) const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);

pub(crate) const YOCTO: u128 = 1_000_000_000_000_000_000_000_000;
/// Kept by the collection for the bytes of the token record.
pub(crate) const INDEX_FEE: u128 = YOCTO / 50;
/// The least a new Choir account is funded with: its own storage plus a working buffer.
pub(crate) const MIN_ITEM_DEPOSIT: u128 = YOCTO / 4;
/// How long a move may stay in flight before the seat is free again.
pub(crate) const BUSY_MS: u64 = 5 * 60 * 1_000;

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Tokens,
    OwnerCount,
    OwnerSlots,
    Listed,
    Owed,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    /// Hash of the global contract every Choir account runs. Fixed for the life of the collection.
    item_code: CryptoHash,
    social: AccountId,
    site: String,
    tokens: IterableMap<String, Token>,
    /// Each owner's tokens as a numbered list, so moving a seat costs the same for any holder.
    owner_count: LookupMap<AccountId, u32>,
    owner_slots: LookupMap<(AccountId, u32), String>,
    listed: IterableSet<String>,
    /// Sale proceeds that could not be delivered, waiting for their seller.
    owed: LookupMap<AccountId, u128>,
}

#[near]
impl Registry {
    /// `item_code` is the base58 SHA-256 of the published item contract.
    #[init]
    pub fn new(item_code: String, social: AccountId, site: String) -> Self {
        let bytes = bs58_decode(&item_code);
        let item_code: CryptoHash =
            bytes.try_into().unwrap_or_else(|_| env::panic_str("item_code must be a 32-byte base58 hash"));
        Self {
            item_code,
            social,
            site,
            tokens: IterableMap::new(Key::Tokens),
            owner_count: LookupMap::new(Key::OwnerCount),
            owner_slots: LookupMap::new(Key::OwnerSlots),
            listed: IterableSet::new(Key::Listed),
            owed: LookupMap::new(Key::Owed),
        }
    }

    /// The parent half of the sharded-item draft. It must move whenever code or configuration
    /// changes what this account will mint. Neither can change here, so it stays at zero; if the
    /// account ever held a key again, a consumer would see that in the key list instead.
    pub fn config_epoch(&self) -> u32 {
        0
    }

    pub fn get_config(&self) -> Config {
        Config {
            item_code: bs58_encode(&self.item_code),
            social: self.social.clone(),
            site: self.site.clone(),
            min_deposit: U128(MIN_ITEM_DEPOSIT + INDEX_FEE),
            config_epoch: 0,
        }
    }

    /// Makes the index catch up with an item that is ahead of it, and releases a freeze that no
    /// listing explains. Anyone can call it. It can only ever move the index towards what the
    /// account itself reports; it cannot move a seat.
    pub fn sync(&mut self, token_id: String) -> Promise {
        self.lock(&token_id);
        Promise::new(account(&token_id))
            .function_call("nft_item_info", Vec::new(), NO_DEPOSIT, GAS_VIEW)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_synced(token_id))
    }

    #[private]
    pub fn on_synced(&mut self, token_id: String, #[callback_result] info: Result<ItemInfo, PromiseError>) -> bool {
        self.unlock(&token_id);
        let Ok(info) = info else { return false };
        // An item is believed only about itself, and only if it names this collection.
        if info.token_id != token_id || info.collection_id != env::current_account_id() || !info.init {
            return false;
        }
        let token = self.tokens.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("No such token"));
        let mut changed = false;
        if info.rotation_seq.0 > token.seq {
            self.set_owner(&token_id, &info.owner_id, info.rotation_seq.0);
            self.drop_listing(&token_id);
            emit_transfer(&token.owner, &info.owner_id, &token_id, Some("sync"));
            changed = true;
        }
        let listed = self.tokens.get(&token_id).is_some_and(|t| t.listing.is_some());
        if info.status == "Frozen" && !listed {
            Promise::new(account(&token_id))
                .function_call("unfreeze", json_bytes(json!({ "expect_seq": info.rotation_seq })), NO_DEPOSIT, GAS_FREEZE)
                .detach();
            changed = true;
        }
        changed
    }
}

// ---------------------------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------------------------

impl Registry {
    pub(crate) fn token(&self, token_id: &str) -> Token {
        self.tokens.get(token_id).cloned().unwrap_or_else(|| env::panic_str("No such Choir"))
    }

    /// Marks a token as busy for the length of one round trip to its account. While it is busy
    /// every other transfer, listing or sale of it refuses.
    pub(crate) fn lock(&mut self, token_id: &str) -> Token {
        let mut token = self.token(token_id);
        let now = env::block_timestamp_ms();
        require!(now >= token.busy_until_ms, "This seat is in the middle of another move. Try again in a moment");
        token.busy_until_ms = now + BUSY_MS;
        self.tokens.insert(token_id.to_string(), token.clone());
        token
    }

    pub(crate) fn unlock(&mut self, token_id: &str) {
        let mut token = self.token(token_id);
        token.busy_until_ms = 0;
        self.tokens.insert(token_id.to_string(), token);
    }

    /// Records what the item has already accepted: a new owner and rotation number.
    pub(crate) fn set_owner(&mut self, token_id: &str, to: &AccountId, seq: u64) {
        let mut token = self.token(token_id);
        let from = token.owner.clone();
        if from != *to {
            self.take_from_owner(&from, token.slot);
            token.slot = self.give_to_owner(to, token_id);
        }
        token.owner = to.clone();
        token.seq = seq;
        self.tokens.insert(token_id.to_string(), token);
    }

    /// Appends a token to an owner's list and returns its slot.
    pub(crate) fn give_to_owner(&mut self, owner: &AccountId, token_id: &str) -> u32 {
        let slot = self.owner_count.get(owner).copied().unwrap_or(0);
        self.owner_slots.insert((owner.clone(), slot), token_id.to_string());
        self.owner_count.insert(owner.clone(), slot + 1);
        slot
    }

    /// Removes the token at `slot` by moving the owner's last token into its place.
    pub(crate) fn take_from_owner(&mut self, owner: &AccountId, slot: u32) {
        let last = self.owner_count.get(owner).copied().unwrap_or(0).saturating_sub(1);
        if slot != last {
            let moved = self.owner_slots.get(&(owner.clone(), last)).cloned().unwrap_or_else(|| env::panic_str("owner list is inconsistent"));
            let mut other = self.token(&moved);
            other.slot = slot;
            self.tokens.insert(moved.clone(), other);
            self.owner_slots.insert((owner.clone(), slot), moved);
        }
        self.owner_slots.remove(&(owner.clone(), last));
        self.owner_count.insert(owner.clone(), last);
    }

    pub(crate) fn drop_listing(&mut self, token_id: &str) {
        let mut token = self.token(token_id);
        if token.listing.take().is_some() {
            self.tokens.insert(token_id.to_string(), token);
            self.listed.remove(token_id);
        }
    }

    /// Checks that `who` may move this seat right now, locks it and returns its rotation number.
    pub(crate) fn begin_move(&mut self, token_id: &str, who: &AccountId, to: &AccountId) -> u64 {
        let token = self.token(token_id);
        require!(token.owner == *who, "Only the conductor can hand over the seat");
        require!(token.owner != *to, "That account already holds the seat");
        require!(token.listing.is_none(), "This seat is listed for sale. Unlist it first");
        self.lock(token_id).seq
    }

    pub(crate) fn rotate(
        &self,
        token_id: &str,
        to: &AccountId,
        seq: u64,
        min_seat_balance: Option<U128>,
        hold: bool,
        quiet: bool,
    ) -> Promise {
        Promise::new(account(token_id)).function_call(
            "rotate",
            json_bytes(json!({
                "new_owner": to,
                "expect_seq": U64(seq),
                "min_seat_balance": min_seat_balance,
                "hold": hold,
                "quiet": quiet,
            })),
            NO_DEPOSIT,
            GAS_ROTATE,
        )
    }
}

pub(crate) fn account(token_id: &str) -> AccountId {
    token_id.parse().unwrap_or_else(|_| env::panic_str("Not an account id"))
}

pub(crate) fn json_bytes(value: Value) -> Vec<u8> {
    value.to_string().into_bytes()
}

/// NEP-297 event for NEP-171.
pub(crate) fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "nep171", "version": "1.0.0", "event": event, "data": [data] })
    ));
}

pub(crate) fn emit_transfer(from: &AccountId, to: &AccountId, token_id: &str, memo: Option<&str>) {
    let mut data = json!({ "old_owner_id": from, "new_owner_id": to, "token_ids": [token_id] });
    if let Some(memo) = memo {
        data["memo"] = json!(memo);
    }
    emit("nft_transfer", data);
}

/// Events of the Choir market, under their own standard name.
pub(crate) fn emit_market(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "choir", "version": "1.0.0", "event": event, "data": [data] })
    ));
}

const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

pub(crate) fn bs58_encode(bytes: &[u8]) -> String {
    let mut digits: Vec<u8> = Vec::new();
    for &byte in bytes {
        let mut carry = byte as u32;
        for digit in digits.iter_mut() {
            carry += (*digit as u32) << 8;
            *digit = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut out = String::new();
    for &byte in bytes {
        if byte != 0 {
            break;
        }
        out.push('1');
    }
    for &digit in digits.iter().rev() {
        out.push(ALPHABET[digit as usize] as char);
    }
    out
}

pub(crate) fn bs58_decode(text: &str) -> Vec<u8> {
    let mut bytes: Vec<u8> = Vec::new();
    for ch in text.bytes() {
        let mut carry = ALPHABET
            .iter()
            .position(|&a| a == ch)
            .unwrap_or_else(|| env::panic_str("item_code is not base58")) as u32;
        for byte in bytes.iter_mut() {
            carry += (*byte as u32) * 58;
            *byte = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    for ch in text.bytes() {
        if ch != b'1' {
            break;
        }
        bytes.push(0);
    }
    bytes.reverse();
    bytes
}
