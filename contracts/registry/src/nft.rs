//! NEP-171 core, NEP-177 metadata and NEP-181 enumeration.
//!
//! A transfer here is a request to the item. The collection locks the token, asks the account to
//! rotate, and updates the index only in the callback of a rotation the account accepted.
//! NEP-178 approvals are not implemented, so `approval_id` must be absent.

use std::collections::HashMap;

use crate::*;

#[near]
impl Registry {
    // ---- NEP-171 ----

    /// Hands the seat to `receiver_id`. Requires exactly one yoctoNEAR, as the standard asks.
    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) -> Promise {
        near_sdk::assert_one_yocto();
        require!(approval_id.is_none(), "Approvals are not supported: only the conductor can hand over the seat");
        let sender = env::predecessor_account_id();
        let seq = self.begin_move(&token_id, &sender, &receiver_id);
        self.rotate(&token_id, &receiver_id, seq, None, false, false).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_moved(token_id, sender, receiver_id, memo),
        )
    }

    #[private]
    pub fn on_moved(
        &mut self,
        token_id: String,
        from: AccountId,
        to: AccountId,
        memo: Option<String>,
        #[callback_result] seq: Result<U64, PromiseError>,
    ) -> bool {
        self.unlock(&token_id);
        let Ok(seq) = seq else { return false };
        self.set_owner(&token_id, &to, seq.0);
        emit_transfer(&from, &to, &token_id, memo.as_deref());
        true
    }

    /// Transfers and then calls `nft_on_transfer` on the receiver. Until that call resolves the
    /// seat is held frozen under the receiver, so a receiving contract cannot use conductor
    /// methods and then hand the token back. Returns true if the receiver kept the token.
    #[payable]
    pub fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        near_sdk::assert_one_yocto();
        require!(approval_id.is_none(), "Approvals are not supported: only the conductor can hand over the seat");
        let sender = env::predecessor_account_id();
        let seq = self.begin_move(&token_id, &sender, &receiver_id);
        self.rotate(&token_id, &receiver_id, seq, None, true, true).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_TRANSFER.saturating_add(GAS_RESOLVE).saturating_add(GAS_CALLBACK))
                .on_held(token_id, sender, receiver_id, memo, msg),
        )
    }

    #[private]
    pub fn on_held(
        &mut self,
        token_id: String,
        from: AccountId,
        to: AccountId,
        memo: Option<String>,
        msg: String,
        #[callback_result] seq: Result<U64, PromiseError>,
    ) -> PromiseOrValue<bool> {
        let Ok(seq) = seq else {
            self.unlock(&token_id);
            return PromiseOrValue::Value(false);
        };
        // The account has rotated, so the index follows. The token stays locked until resolved.
        self.set_owner(&token_id, &to, seq.0);
        emit_transfer(&from, &to, &token_id, memo.as_deref());
        Promise::new(to.clone())
            .function_call(
                "nft_on_transfer",
                json_bytes(json!({ "sender_id": from, "previous_owner_id": from, "token_id": token_id, "msg": msg })),
                NO_DEPOSIT,
                GAS_ON_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_RESOLVE)
                    .nft_resolve_transfer(from, to, token_id, None),
            )
            .into()
    }

    /// NEP-171's resolver. The receiver keeps the token only if `nft_on_transfer` succeeded and
    /// returned false. Otherwise the seat is rotated back to the previous conductor.
    #[private]
    pub fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: String,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> Promise {
        let _ = approved_account_ids;
        let give_back = match env::promise_result_checked(0, 16) {
            Ok(value) => near_sdk::serde_json::from_slice::<bool>(&value).unwrap_or(true),
            Err(_) => true,
        };
        let seq = self.token(&token_id).seq;
        let me = Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK);
        if give_back {
            self.rotate(&token_id, &previous_owner_id, seq, None, false, true)
                .then(me.on_returned(token_id, receiver_id, previous_owner_id))
        } else {
            Promise::new(account(&token_id))
                .function_call("unfreeze", json_bytes(json!({ "expect_seq": U64(seq), "announce": true })), NO_DEPOSIT, GAS_FREEZE)
                .then(me.on_kept(token_id))
        }
    }

    #[private]
    pub fn on_kept(&mut self, token_id: String) -> bool {
        // If the release was lost, `sync` releases it later. Either way the receiver owns the seat.
        self.unlock(&token_id);
        true
    }

    #[private]
    pub fn on_returned(
        &mut self,
        token_id: String,
        from: AccountId,
        to: AccountId,
        #[callback_result] seq: Result<U64, PromiseError>,
    ) -> bool {
        self.unlock(&token_id);
        let Ok(seq) = seq else { return true };
        self.set_owner(&token_id, &to, seq.0);
        emit_transfer(&from, &to, &token_id, Some("returned"));
        false
    }

    pub fn nft_token(&self, token_id: String) -> Option<TokenView> {
        self.tokens.get(&token_id).map(|token| self.token_view(&token_id, token))
    }

    /// The collection's own rotation number for a token, so a consumer can read the direction of
    /// a disagreement with the item instead of only retrying.
    pub fn nft_rotation(&self, token_id: String) -> Option<RotationView> {
        self.tokens.get(&token_id).map(|token| RotationView {
            rotation_seq: U64(token.seq),
            rotation_epoch: 0,
            locked: env::block_timestamp_ms() < token.busy_until_ms,
            listed: token.listing.is_some(),
        })
    }

    // ---- NEP-177 ----

    pub fn nft_metadata(&self) -> ContractMetadata {
        ContractMetadata {
            spec: "nft-1.0.0".to_string(),
            name: "Choir".to_string(),
            symbol: "CHOIR".to_string(),
            icon: Some(data_uri(&icon_svg())),
            base_uri: None,
            reference: if self.site.is_empty() { None } else { Some(self.site.clone()) },
            reference_hash: None,
        }
    }

    // ---- NEP-181 ----

    pub fn nft_total_supply(&self) -> U128 {
        U128(self.tokens.len() as u128)
    }

    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<TokenView> {
        self.tokens
            .iter()
            .skip(from_index.map(|i| i.0 as usize).unwrap_or(0))
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(|(id, token)| self.token_view(id, token))
            .collect()
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(self.owner_count.get(&account_id).copied().unwrap_or(0) as u128)
    }

    pub fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<TokenView> {
        let count = self.owner_count.get(&account_id).copied().unwrap_or(0);
        let from = from_index.map(|i| i.0.min(count as u128) as u32).unwrap_or(0);
        let to = from.saturating_add(limit.unwrap_or(50).min(100) as u32).min(count);
        (from..to)
            .filter_map(|slot| self.owner_slots.get(&(account_id.clone(), slot)))
            .filter_map(|id| self.tokens.get(id).map(|token| self.token_view(id, token)))
            .collect()
    }
}

impl Registry {
    fn token_view(&self, token_id: &str, token: &Token) -> TokenView {
        TokenView {
            token_id: token_id.to_string(),
            owner_id: token.owner.clone(),
            metadata: TokenMetadata {
                title: Some(token.title.clone()),
                description: Some(format!(
                    "A Choir: the shared near.social account {token_id}. Whoever holds this token is its conductor. The account has no keys; its wallet, its voice and its history move with the token."
                )),
                media: Some(data_uri(&card_svg(&token.title, token_id))),
                media_hash: None,
                copies: Some(1),
                issued_at: Some(token.created_ms.to_string()),
                expires_at: None,
                starts_at: None,
                updated_at: None,
                extra: None,
                reference: if self.site.is_empty() { None } else { Some(format!("{}#/c/{}", self.site, token_id)) },
                reference_hash: None,
            },
        }
    }
}

fn xml(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn data_uri(svg: &str) -> String {
    // Percent-encode only what a data URI cannot carry raw.
    let mut out = String::from("data:image/svg+xml;utf8,");
    for ch in svg.chars() {
        match ch {
            '#' => out.push_str("%23"),
            '%' => out.push_str("%25"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            '"' => out.push('\''),
            _ => out.push(ch),
        }
    }
    out
}

/// Five voices of different heights: the mark of the collection.
fn bars(x: u32, y: u32, scale: u32) -> String {
    let heights = [3u32, 6, 9, 5, 7];
    let mut out = String::new();
    for (i, h) in heights.iter().enumerate() {
        let bx = x + i as u32 * 3 * scale;
        let bh = h * scale;
        out.push_str(&format!(
            "<rect x=\"{bx}\" y=\"{}\" width=\"{}\" height=\"{bh}\" rx=\"{}\" fill=\"#F2C14E\"/>",
            y + (9 * scale - bh),
            2 * scale,
            scale
        ));
    }
    out
}

fn icon_svg() -> String {
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 96 96\"><rect width=\"96\" height=\"96\" rx=\"20\" fill=\"#14213D\"/>{}</svg>",
        bars(20, 21, 4)
    )
}

fn card_svg(title: &str, token_id: &str) -> String {
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 400 400\"><rect width=\"400\" height=\"400\" fill=\"#14213D\"/>{}<text x=\"32\" y=\"268\" font-family=\"Georgia,serif\" font-size=\"34\" fill=\"#FFF8E7\">{}</text><text x=\"32\" y=\"302\" font-family=\"monospace\" font-size=\"13\" fill=\"#9FB0D0\">{}</text><text x=\"32\" y=\"364\" font-family=\"monospace\" font-size=\"12\" fill=\"#F2C14E\">CHOIR · the holder conducts</text></svg>",
        bars(32, 56, 14),
        xml(title),
        xml(token_id)
    )
}
