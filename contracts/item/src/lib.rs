//! One Choir.
//!
//! A Choir is a NEAR account with no access keys that a community shares. This contract is the
//! only thing that can act for it. It
//!
//! - writes to near.social as itself, and only what this code composes: it follows its members,
//!   reposts ("amplifies") their own posts, and posts its own payout receipts and handovers.
//!   Nobody, the conductor included, can write a post in its name;
//! - takes tips and splits each one by public rules: a capped cut for the seat, the rest into the
//!   round's pot, shared between the members whose posts were amplified that round;
//! - records one account as its conductor. That account holds the matching NEP-171 token in the
//!   collection, and only the collection can change it.
//!
//! Three ledgers never mix: the seat balance (moves with the NFT), the pot and settled member
//! balances (members' money, no conductor method can debit them), and the storage reserve.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Map, Value};
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise};

mod members;
mod money;
mod seat;
pub mod types;
mod views;

pub use types::*;

/// near.social writes carry the least gas a function call may carry: nothing runs on `social`.
const GAS_SOCIAL: Gas = Gas::from_gas(1);
const GAS_ON_PAID: Gas = Gas::from_tgas(8);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Rounds,
    Members,
    Curators,
    Amplified,
    Events,
    Holders,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Choir {
    /// The only account that may rotate, freeze or unfreeze this item. Set once, at creation.
    collection: AccountId,
    social: AccountId,
    site: String,
    /// The conductor. This is the state that governs the account; the collection's index follows it.
    owner: AccountId,
    rotation_seq: u64,
    /// Set by the collection while the seat is listed or in the middle of a transfer-call.
    frozen: bool,
    created_ms: u64,

    name: String,
    about: String,
    rules: Rules,
    pending_rules: Option<Rules>,

    round: u64,
    round_start_ms: u64,
    /// This round's share for amplified members.
    pot: u128,
    points: u64,
    contributors: u32,
    rounds: LookupMap<u64, RoundResult>,

    /// The seat's cut, not yet withdrawn. Moves with the NFT.
    seat_balance: u128,
    /// Everything this account owes: pot, settled member earnings and the seat balance.
    reserved: u128,

    members: IterableMap<AccountId, Member>,
    active_members: u32,
    /// Curator -> the rotation number the grant was made under. Valid only while that is current.
    curators: IterableMap<AccountId, u64>,
    amplified: LookupMap<String, Amp>,

    events: Vector<Event>,
    holders: Vector<Holder>,
    last_post_id: u64,
    totals: Totals,
}

#[near]
impl Choir {
    /// Called once by the collection, in the same receipt that creates this account.
    #[init]
    pub fn init(args: InitArgs) -> Self {
        let me = env::current_account_id();
        let collection = env::predecessor_account_id();
        // Only a parent can create a sub-account, so the name itself proves who made this item.
        require!(collection != me, "An item cannot be its own collection");
        require!(
            me.as_str().strip_suffix(collection.as_str()).is_some_and(|rest| rest.ends_with('.')),
            "Only the parent account can initialise an item"
        );
        args.rules.check();
        check_text("name", &args.name, 1, MAX_NAME);
        check_text("about", &args.about, 0, MAX_ABOUT);

        let now = env::block_timestamp_ms();
        let mut choir = Self {
            collection,
            social: args.social,
            site: args.site,
            owner: args.owner.clone(),
            rotation_seq: 0,
            frozen: false,
            created_ms: now,
            name: args.name,
            about: args.about,
            rules: args.rules,
            pending_rules: None,
            round: 0,
            round_start_ms: now,
            pot: 0,
            points: 0,
            contributors: 0,
            rounds: LookupMap::new(Key::Rounds),
            seat_balance: 0,
            reserved: 0,
            members: IterableMap::new(Key::Members),
            active_members: 0,
            curators: IterableMap::new(Key::Curators),
            amplified: LookupMap::new(Key::Amplified),
            events: Vector::new(Key::Events),
            holders: Vector::new(Key::Holders),
            last_post_id: 0,
            totals: Totals::default(),
        };
        choir.holders.push(Holder { account: args.owner.clone(), since_ms: now, seq: U64(0) });
        choir.record(EventKind::Created { conductor: args.owner });
        choir.write_profile(None, None);
        choir
    }
}

// ---------------------------------------------------------------------------------------------
// Internal bookkeeping. Nothing below is callable from outside.
// ---------------------------------------------------------------------------------------------

impl Choir {
    // ---- who may do what ----

    /// The first condition that would refuse a request from the conductor, if any.
    /// `nft_item_info` reports its status from this same function, so the two cannot drift.
    pub(crate) fn blocking_condition(&self) -> Option<ItemStatus> {
        if self.frozen {
            return Some(ItemStatus::Frozen);
        }
        None
    }

    pub(crate) fn status(&self) -> ItemStatus {
        self.blocking_condition().unwrap_or(ItemStatus::Active)
    }

    /// True only for the conductor while nothing blocks the seat.
    pub(crate) fn is_active_conductor(&self, who: &AccountId) -> bool {
        *who == self.owner && self.blocking_condition().is_none()
    }

    pub(crate) fn assert_conductor(&self) -> AccountId {
        let who = env::predecessor_account_id();
        require!(who == self.owner, "Only the conductor can do this");
        if let Some(status) = self.blocking_condition() {
            env::panic_str(&format!(
                "The seat is {status:?}: it is listed for sale or being handed over, so conductor actions wait"
            ));
        }
        who
    }

    pub(crate) fn assert_collection(&self) {
        require!(
            env::predecessor_account_id() == self.collection,
            "Only the collection can change who holds the seat"
        );
    }

    pub(crate) fn is_curator(&self, who: &AccountId) -> bool {
        self.curators.get(who).is_some_and(|seq| *seq == self.rotation_seq)
    }

    /// Conductor (while active) or a curator appointed under the current conductor.
    pub(crate) fn assert_curator(&self) -> AccountId {
        let who = env::predecessor_account_id();
        require!(
            self.is_active_conductor(&who) || self.is_curator(&who),
            "Only the conductor or a curator can do this"
        );
        who
    }

    // ---- rounds ----

    /// Closes the round if its time is up. Costs the same however long nobody called.
    pub(crate) fn roll(&mut self) {
        let now = env::block_timestamp_ms();
        let len = self.rules.round_ms;
        if now < self.round_start_ms + len {
            return;
        }
        if self.points > 0 {
            let result =
                RoundResult { pot: U128(self.pot), points: self.points, contributors: self.contributors };
            self.rounds.insert(self.round, result);
            self.record(EventKind::Settled {
                round: self.round,
                pot: U128(self.pot),
                points: self.points,
                contributors: self.contributors,
            });
            self.totals.rounds_settled += 1;
            if self.pot > 0 {
                let text = format!(
                    "Round {} is settled. {} NEAR is shared between {} for {}. Each can claim their part now.\n\nPosted by the account itself. Nobody holds its keys.",
                    self.round + 1,
                    fmt_near(self.pot),
                    plural(self.contributors as u64, "member", "members"),
                    plural(self.points, "amplified post", "amplified posts"),
                );
                self.post(&text);
            }
            self.pot = 0;
        }
        // With no points the pot simply waits for the next round.
        self.points = 0;
        self.contributors = 0;
        let elapsed = (now - self.round_start_ms) / len;
        self.round += elapsed;
        self.round_start_ms += elapsed * len;
        if let Some(rules) = self.pending_rules.take() {
            self.rules = rules;
            self.record(EventKind::RulesApplied);
        }
    }

    /// Brings a member's record into the open round, crediting what an earlier round paid them.
    pub(crate) fn touch(&self, member: &mut Member) {
        if member.round == self.round {
            return;
        }
        let share = self.share_of(member);
        member.balance += share;
        member.earned += share;
        member.points = 0;
        member.self_amps = 0;
        member.round = self.round;
    }

    /// What a member's points in an already closed round are worth.
    pub(crate) fn share_of(&self, member: &Member) -> u128 {
        if member.round >= self.round || member.points == 0 {
            return 0;
        }
        match self.rounds.get(&member.round) {
            Some(result) if result.points > 0 => result.pot.0 * member.points as u128 / result.points as u128,
            _ => 0,
        }
    }

    // ---- money ----

    /// Splits incoming NEAR by the public rule and returns the seat's cut.
    pub(crate) fn take_in(&mut self, amount: u128) -> u128 {
        let cut = amount * self.rules.seat_bps as u128 / 10_000;
        self.seat_balance += cut;
        self.pot += amount - cut;
        self.reserved += amount;
        self.totals.received = U128(self.totals.received.0 + amount);
        cut
    }

    pub(crate) fn storage_cost(&self) -> u128 {
        env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear()
    }

    /// Every call that changes state ends here: the account must cover its bytes and all it owes.
    pub(crate) fn assert_solvent(&mut self) {
        self.assert_solvent_after(0);
    }

    /// For calls the collection makes (a handover, a freeze, a release). They carry no deposit, so
    /// their few bytes come out of the margin every other call leaves behind. That is what the
    /// margin is for: a handover must never fail for want of a few bytes.
    pub(crate) fn assert_covered(&mut self) {
        self.flush_all();
        let balance = env::account_balance().as_yoctonear();
        require!(balance >= self.storage_cost() + self.reserved, "The account cannot cover its storage. Send it a little NEAR and try again");
    }

    fn flush_all(&mut self) {
        self.rounds.flush();
        self.members.flush();
        self.curators.flush();
        self.amplified.flush();
        self.events.flush();
        self.holders.flush();
    }

    fn assert_solvent_after(&mut self, leaving: u128) {
        // Collections keep their writes in memory until the call ends. Writing them out first
        // makes `storage_usage` count every byte this call added.
        self.flush_all();
        let balance = env::account_balance().as_yoctonear();
        require!(
            balance >= self.storage_cost() + self.reserved + MARGIN + leaving,
            "This call needs a little NEAR attached to pay for the bytes it adds"
        );
    }

    /// Sends `amount` less the payout fee. `amount` is what the ledger was debited, and what the
    /// callback credits back if the transfer fails.
    pub(crate) fn pay(&self, to: AccountId, amount: u128, seat: bool) -> Promise {
        Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount - PAYOUT_FEE)).then(
            Self::ext(env::current_account_id()).with_static_gas(GAS_ON_PAID).on_paid(to, U128(amount), seat),
        )
    }

    // ---- history ----

    pub(crate) fn record(&mut self, kind: EventKind) {
        self.events.push(Event { at_ms: env::block_timestamp_ms(), round: self.round, kind });
    }

    // ---- near.social ----

    /// One `__fastdata_kv` write to near.social. The author is this account, because the receipt's
    /// predecessor is. The receipt always fails (nothing is deployed on `social`); the FastData
    /// indexer reads the arguments and never looks at the status.
    pub(crate) fn social_write(&self, args: Map<String, Value>) {
        Promise::new(self.social.clone())
            .function_call("__fastdata_kv", Value::Object(args).to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_SOCIAL)
            .detach();
    }

    pub(crate) fn social_set(&self, key: String, value: Value) {
        let mut args = Map::new();
        args.insert(key, value);
        self.social_write(args);
    }

    /// Posts as this account and returns the post id. Only ever called with text this contract
    /// composed from its own state.
    pub(crate) fn post(&mut self, text: &str) -> u64 {
        // near.social asks for millisecond ids that only ever grow.
        let id = env::block_timestamp_ms().max(self.last_post_id + 1);
        self.last_post_id = id;
        self.social_set(format!("post/{id}"), json!({ "text": text }));
        id
    }

    pub(crate) fn write_profile(&self, avatar: Option<String>, banner: Option<String>) {
        let me = env::current_account_id();
        let link = if self.site.is_empty() { String::new() } else { format!("{}#/c/{}", self.site, me) };
        let mut about = self.about.clone();
        if !about.is_empty() {
            about.push_str("\n\n");
        }
        // near.social asks automated accounts to say so in their bio.
        about.push_str("A Choir: a shared account run by a contract. Nobody holds its keys. Members are amplified here and share the tips.");
        let mut args = Map::new();
        args.insert("profile/name".into(), json!(self.name));
        args.insert("profile/about".into(), json!(about));
        if !link.is_empty() {
            args.insert("profile/links/website".into(), json!(link));
        }
        if let Some(uri) = avatar {
            args.insert("profile/avatar".into(), json!(uri));
        }
        if let Some(uri) = banner {
            args.insert("profile/banner".into(), json!(uri));
        }
        self.social_write(args);
    }
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

pub(crate) fn check_text(what: &str, text: &str, min: usize, max: usize) {
    let len = text.chars().count();
    if len < min || len > max {
        env::panic_str(&format!("The {what} must be {min} to {max} characters long"));
    }
}

/// A near.social post id: a decimal integer from 1 to 2^53 - 1 with no leading zero.
pub(crate) fn check_post_id(post_id: &str) {
    let ok = !post_id.is_empty()
        && post_id.len() <= 16
        && !post_id.starts_with('0')
        && post_id.bytes().all(|b| b.is_ascii_digit())
        && post_id.parse::<u64>().is_ok_and(|n| n <= 9_007_199_254_740_991);
    require!(ok, "That is not a near.social post id");
}

/// NEAR with up to three decimals, for the account's own posts.
pub(crate) fn fmt_near(yocto: u128) -> String {
    let milli = yocto / (YOCTO / 1_000);
    let whole = milli / 1_000;
    let frac = milli % 1_000;
    if frac == 0 {
        return whole.to_string();
    }
    let digits = format!("{frac:03}");
    format!("{whole}.{}", digits.trim_end_matches('0'))
}

pub(crate) fn plural(n: u64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}
