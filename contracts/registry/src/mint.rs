//! Creating a Choir: one receipt makes the account, funds it, points it at the shared code and
//! initialises it. No access key is ever added, so nobody can sign as the new account.

use crate::*;

#[near]
impl Registry {
    /// Starts a Choir at `<slug>.<this account>` with the caller as its first conductor.
    ///
    /// Attach at least `get_config().min_deposit`. A small part pays for the index row; the rest
    /// goes into the new account, which keeps it for its own storage. `rules` is passed to the
    /// item unchanged; the item checks it.
    #[payable]
    pub fn create_choir(&mut self, slug: String, name: String, about: String, rules: Value) -> Promise {
        let owner = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= MIN_ITEM_DEPOSIT + INDEX_FEE, "Attach at least 0.27 NEAR to start a Choir");
        check_slug(&slug);
        let token_id = format!("{slug}.{}", env::current_account_id());
        require!(token_id.len() <= 64, "That name is too long");
        require!(!self.tokens.contains_key(&token_id), "That name is taken");

        let init = json!({
            "args": {
                "owner": owner,
                "name": name,
                "about": about,
                "rules": rules,
                "social": self.social,
                "site": self.site,
            }
        });
        Promise::new(account(&token_id))
            .create_account()
            .transfer(NearToken::from_yoctonear(deposit - INDEX_FEE))
            .use_global_contract(self.item_code)
            .function_call("init", json_bytes(init), NO_DEPOSIT, GAS_ITEM_INIT)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_created(token_id, owner, name, U128(deposit)),
            )
    }

    /// Adds the token to the index only once its account exists and is initialised. If creation
    /// failed (the rules were refused, say) nothing was created and the deposit goes back.
    #[private]
    pub fn on_created(&mut self, token_id: String, owner: AccountId, title: String, deposit: U128) -> Option<String> {
        if !near_sdk::is_promise_success() || self.tokens.contains_key(&token_id) {
            Promise::new(owner).transfer(NearToken::from_yoctonear(deposit.0)).detach();
            return None;
        }
        let slot = self.give_to_owner(&owner, &token_id);
        self.tokens.insert(
            token_id.clone(),
            Token { owner: owner.clone(), seq: 0, busy_until_ms: 0, slot, title, created_ms: env::block_timestamp_ms(), listing: None },
        );
        emit("nft_mint", json!({ "owner_id": owner, "token_ids": [token_id] }));
        Some(token_id)
    }
}

/// 2 to 32 characters: lowercase letters, digits and single hyphens inside.
fn check_slug(slug: &str) {
    let bytes = slug.as_bytes();
    let ok = (2..=32).contains(&bytes.len())
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && bytes[0] != b'-'
        && bytes[bytes.len() - 1] != b'-'
        && !slug.contains("--");
    require!(ok, "A name is 2 to 32 characters: lowercase letters, digits and hyphens");
}
