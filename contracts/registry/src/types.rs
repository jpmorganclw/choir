//! Types of the collection's index, market and views.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

/// One row of the index. The owner here follows the item; it is never the authority.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Token {
    pub owner: AccountId,
    /// The collection's copy of the item's rotation number, so a consumer can tell an index
    /// that is catching up from one that claims a rotation the account never made.
    pub seq: u64,
    /// A move is in flight until this time. It is cleared when the item answers. If an answer
    /// were ever lost it simply runs out, so a seat can never be stuck; the item's own sequence
    /// check is what keeps two moves from both succeeding.
    pub busy_until_ms: u64,
    /// This token's place in its owner's list.
    pub slot: u32,
    pub title: String,
    pub created_ms: u64,
    pub listing: Option<Listing>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Listing {
    pub seller: AccountId,
    pub price: U128,
    pub listed_ms: u64,
    /// What the seat held when it was frozen for this listing.
    pub sealed_seat_balance: U128,
}

#[near(serializers = [json])]
pub struct ListingView {
    pub token_id: String,
    pub title: String,
    pub seller: AccountId,
    pub price: U128,
    pub listed_ms: u64,
    pub sealed_seat_balance: U128,
    pub rotation_seq: U64,
}

/// NEP-171 token.
#[near(serializers = [json])]
pub struct TokenView {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: TokenMetadata,
}

/// NEP-177 token metadata.
#[near(serializers = [json])]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub media_hash: Option<String>,
    pub copies: Option<u64>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub starts_at: Option<String>,
    pub updated_at: Option<String>,
    pub extra: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

/// NEP-177 contract metadata.
#[near(serializers = [json])]
pub struct ContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

/// The collection's side of a token's rotation state.
#[near(serializers = [json])]
pub struct RotationView {
    pub rotation_seq: U64,
    pub rotation_epoch: u32,
    pub locked: bool,
    pub listed: bool,
}

#[near(serializers = [json])]
pub struct Config {
    pub item_code: String,
    pub social: AccountId,
    pub site: String,
    pub min_deposit: U128,
    pub config_epoch: u32,
}

/// The parts of an item's `nft_item_info` the collection reads.
#[near(serializers = [json])]
pub struct ItemInfo {
    pub init: bool,
    pub status: String,
    pub collection_id: AccountId,
    pub token_id: String,
    pub owner_id: AccountId,
    pub rotation_seq: U64,
}

/// What an item returns from `freeze`.
#[near(serializers = [json])]
pub struct Sealed {
    pub rotation_seq: U64,
    pub seat_balance: U128,
}
