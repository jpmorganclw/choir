//! Types shared by the item's methods and views.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

pub const SPEC: &str = "sharded-item-1.0.0";

/// The conductor's cut of every tip can never be set above this.
pub const MAX_SEAT_BPS: u16 = 2_000;
pub const MIN_ROUND_MS: u64 = 60_000;
pub const MAX_ROUND_MS: u64 = 90 * 86_400_000;
pub const MAX_NAME: usize = 64;
pub const MAX_ABOUT: usize = 600;
pub const MAX_MEMO: usize = 140;
pub const MAX_URI: usize = 512;

pub const YOCTO: u128 = 1_000_000_000_000_000_000_000_000;
/// Smallest tip that is recorded. Smaller amounts would cost more to store than they carry.
pub const MIN_TIP: u128 = YOCTO / 20;
/// Kept from every tip for the bytes of its own record, so tips never eat the storage reserve.
pub const TIP_FEE: u128 = YOCTO / 200;
/// Attached to every amplification, for the bytes of its record.
pub const AMPLIFY_FEE: u128 = YOCTO / 200;
/// Kept from every payout for the bytes of its record.
pub const PAYOUT_FEE: u128 = YOCTO / 1_000;
/// Paid once for a new member on top of any dues, to cover the bytes their record takes.
pub const JOIN_FEE: u128 = YOCTO / 100;
/// NEAR that `sweep` always leaves untouched so the account can keep growing its state.
pub const BUFFER: u128 = YOCTO * 15 / 100;
/// Held above storage and everything owed, for the few bytes of the account's own record that
/// are written only after a call returns (a longer name or bio, a queued rule change).
pub const MARGIN: u128 = YOCTO * 3 / 100;

/// The rules everyone can read before they tip or join. They change only at a round boundary.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Rules {
    /// Anyone may join. When false, only the conductor or a curator can admit members.
    pub open: bool,
    /// Paid on joining. It is split exactly like a tip.
    pub dues: U128,
    /// How many of their own posts a member may amplify per round without a curator. 0 = none.
    pub self_cap: u8,
    /// Length of a round in milliseconds.
    pub round_ms: u64,
    /// The seat's cut of every tip, in basis points. Never above `MAX_SEAT_BPS`.
    pub seat_bps: u16,
}

impl Rules {
    pub fn check(&self) {
        near_sdk::require!(self.seat_bps <= MAX_SEAT_BPS, "The seat's cut cannot be above 20%");
        near_sdk::require!(
            (MIN_ROUND_MS..=MAX_ROUND_MS).contains(&self.round_ms),
            "A round lasts between one minute and 90 days"
        );
    }
}

/// `status` in `nft_item_info`. Only `Active` and `Frozen` are produced by this contract.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ItemStatus {
    Parked,
    Suspended,
    Expired,
    Frozen,
    Active,
}

/// The answer the sharded-item draft asks every item to give about itself.
#[near(serializers = [json])]
pub struct NftItemInfo {
    pub spec: String,
    pub init: bool,
    pub status: ItemStatus,
    pub collection_id: AccountId,
    pub token_id: String,
    pub owner_id: AccountId,
    pub rotation_seq: U64,
    pub rotation_epoch: u32,
}

#[near(serializers = [json])]
pub struct InitArgs {
    pub owner: AccountId,
    pub name: String,
    pub about: String,
    pub rules: Rules,
    /// The account near.social writes go to. `social` on mainnet and on testnet.
    pub social: AccountId,
    /// Where the app lives, for the profile link. May be empty.
    pub site: String,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Member {
    pub joined_ms: u64,
    pub active: bool,
    /// The round `points` and `self_amps` belong to.
    pub round: u64,
    pub points: u32,
    pub self_amps: u8,
    /// Settled earnings waiting to be claimed.
    pub balance: u128,
    pub earned: u128,
    pub amplified: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct RoundResult {
    pub pot: U128,
    pub points: u64,
    pub contributors: u32,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Amp {
    pub round: u64,
    pub live: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Holder {
    pub account: AccountId,
    pub since_ms: u64,
    pub seq: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Totals {
    pub received: U128,
    pub tips: u32,
    pub paid_members: U128,
    pub paid_seat: U128,
    pub amplified: u32,
    pub rounds_settled: u32,
}

/// One line of the account's own history. Stored on the account so the history view needs no indexer.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Event {
    pub at_ms: u64,
    pub round: u64,
    pub kind: EventKind,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub enum EventKind {
    Created { conductor: AccountId },
    Joined { member: AccountId, dues: U128 },
    Admitted { member: AccountId, by: AccountId },
    Left { member: AccountId },
    Removed { member: AccountId, by: AccountId },
    Tip { from: AccountId, amount: U128, seat_cut: U128, memo: Option<String> },
    Swept { amount: U128, seat_cut: U128 },
    Amplified { author: AccountId, post_id: String, by: AccountId },
    Unamplified { author: AccountId, post_id: String, by: AccountId },
    Settled { round: u64, pot: U128, points: u64, contributors: u32 },
    Claimed { member: AccountId, amount: U128 },
    SeatWithdrawn { to: AccountId, amount: U128 },
    PayoutReturned { to: AccountId, amount: U128, seat: bool },
    ProfileSet { by: AccountId },
    RulesQueued { by: AccountId },
    RulesApplied,
    CuratorSet { account: AccountId, on: bool },
    Frozen,
    Unfrozen,
    Rotated { from: AccountId, to: AccountId, seq: U64 },
}

#[near(serializers = [json])]
pub struct ChoirView {
    pub id: AccountId,
    pub collection: AccountId,
    pub social: AccountId,
    pub conductor: AccountId,
    pub rotation_seq: U64,
    pub status: ItemStatus,
    pub name: String,
    pub about: String,
    pub rules: Rules,
    pub pending_rules: Option<Rules>,
    pub round: u64,
    pub round_start_ms: u64,
    pub round_end_ms: u64,
    pub round_due: bool,
    pub pot: U128,
    pub points: u64,
    pub contributors: u32,
    pub seat_balance: U128,
    pub reserved: U128,
    pub members: u32,
    pub curators: Vec<AccountId>,
    pub totals: Totals,
    pub events: u64,
    pub created_ms: u64,
    pub now_ms: u64,
}

#[near(serializers = [json])]
pub struct MemberView {
    pub account: AccountId,
    pub joined_ms: u64,
    pub active: bool,
    /// Points in the round that is open now.
    pub points: u32,
    pub self_amps: u8,
    /// What a `claim` would pay right now.
    pub claimable: U128,
    pub earned: U128,
    pub amplified: u32,
}

/// What `freeze` returns to the collection, so a listing can show what was sealed.
#[near(serializers = [json])]
pub struct Sealed {
    pub rotation_seq: U64,
    pub seat_balance: U128,
}
