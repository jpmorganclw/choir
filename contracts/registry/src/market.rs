//! The market: a listed seat is frozen on its own account until it is sold or unlisted, and a
//! sale changes hands in the same receipt that checks what the buyer was shown.

use crate::*;

#[near]
impl Registry {
    /// Lists the seat at a fixed price. The account freezes first; the listing exists only once
    /// the account has confirmed it, so there is never a listing over an unfrozen seat.
    #[payable]
    pub fn list(&mut self, token_id: String, price: U128) -> Promise {
        near_sdk::assert_one_yocto();
        let seller = env::predecessor_account_id();
        let token = self.token(&token_id);
        require!(token.owner == seller, "Only the conductor can list the seat");
        require!(token.listing.is_none(), "This seat is already listed");
        require!(price.0 > 0, "Set a price");
        let seq = self.lock(&token_id).seq;
        Promise::new(account(&token_id))
            .function_call("freeze", json_bytes(json!({ "expect_seq": U64(seq) })), NO_DEPOSIT, GAS_FREEZE)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_listed(token_id, seller, price))
    }

    #[private]
    pub fn on_listed(
        &mut self,
        token_id: String,
        seller: AccountId,
        price: U128,
        #[callback_result] sealed: Result<Sealed, PromiseError>,
    ) -> bool {
        self.unlock(&token_id);
        let Ok(sealed) = sealed else { return false };
        let mut token = self.token(&token_id);
        token.listing = Some(Listing {
            seller: seller.clone(),
            price,
            listed_ms: env::block_timestamp_ms(),
            sealed_seat_balance: sealed.seat_balance,
        });
        self.tokens.insert(token_id.clone(), token);
        self.listed.insert(token_id.clone());
        emit_market("seat_listed", json!({ "token_id": token_id, "seller": seller, "price": price, "seat_balance": sealed.seat_balance }));
        true
    }

    /// Takes the listing down and releases the freeze.
    #[payable]
    pub fn unlist(&mut self, token_id: String) -> Promise {
        near_sdk::assert_one_yocto();
        let token = self.token(&token_id);
        require!(token.owner == env::predecessor_account_id(), "Only the conductor can unlist the seat");
        require!(token.listing.is_some(), "This seat is not listed");
        let seq = self.lock(&token_id).seq;
        Promise::new(account(&token_id))
            .function_call("unfreeze", json_bytes(json!({ "expect_seq": U64(seq) })), NO_DEPOSIT, GAS_FREEZE)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_unlisted(token_id))
    }

    #[private]
    pub fn on_unlisted(&mut self, token_id: String) -> bool {
        self.unlock(&token_id);
        if !near_sdk::is_promise_success() {
            return false;
        }
        self.drop_listing(&token_id);
        emit_market("seat_unlisted", json!({ "token_id": token_id }));
        true
    }

    /// Buys a listed seat. Attach at least the price; anything above it is returned.
    ///
    /// `expect_seq` and `min_seat_balance` are what the buyer saw. The account itself refuses the
    /// handover if its rotation number has moved or the seat holds less, and then the whole
    /// deposit is returned. The seller is paid only after the account has changed hands.
    #[payable]
    pub fn buy(&mut self, token_id: String, expect_seq: U64, min_seat_balance: U128) -> Promise {
        let buyer = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        let token = self.token(&token_id);
        let listing = token.listing.clone().unwrap_or_else(|| env::panic_str("This seat is not for sale"));
        require!(buyer != token.owner, "You already hold this seat");
        require!(expect_seq.0 == token.seq, "The seat changed since you looked. Check it again");
        require!(deposit >= listing.price.0, "The price is higher than the amount attached");
        self.lock(&token_id);
        self.rotate(&token_id, &buyer, token.seq, Some(min_seat_balance), false, false).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_bought(token_id, listing.seller, buyer, listing.price, U128(deposit)),
        )
    }

    #[private]
    pub fn on_bought(
        &mut self,
        token_id: String,
        seller: AccountId,
        buyer: AccountId,
        price: U128,
        deposit: U128,
        #[callback_result] seq: Result<U64, PromiseError>,
    ) -> bool {
        self.unlock(&token_id);
        let Ok(seq) = seq else {
            // The account refused. Nothing changed hands, so the buyer gets everything back.
            Promise::new(buyer).transfer(NearToken::from_yoctonear(deposit.0)).detach();
            return false;
        };
        self.drop_listing(&token_id);
        self.set_owner(&token_id, &buyer, seq.0);
        emit_transfer(&seller, &buyer, &token_id, Some("sale"));
        emit_market("seat_sold", json!({ "token_id": token_id, "seller": seller, "buyer": buyer, "price": price }));
        Promise::new(seller.clone())
            .transfer(NearToken::from_yoctonear(price.0))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_VIEW).on_seller_paid(seller, price))
            .detach();
        if deposit.0 > price.0 {
            Promise::new(buyer).transfer(NearToken::from_yoctonear(deposit.0 - price.0)).detach();
        }
        true
    }

    /// A seller who cannot be paid does not undo the sale: the proceeds wait here for them.
    #[private]
    pub fn on_seller_paid(&mut self, seller: AccountId, amount: U128) {
        if !near_sdk::is_promise_success() {
            let owed = self.owed.get(&seller).copied().unwrap_or(0) + amount.0;
            self.owed.insert(seller, owed);
        }
    }

    /// Collects sale proceeds that could not be delivered at the time of the sale.
    pub fn withdraw_owed(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amount = self.owed.remove(&who).unwrap_or(0);
        require!(amount > 0, "Nothing is waiting for you");
        Promise::new(who.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_VIEW).on_seller_paid(who, U128(amount)))
    }

    pub fn owed_to(&self, account_id: AccountId) -> U128 {
        U128(self.owed.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_listing(&self, token_id: String) -> Option<ListingView> {
        let token = self.tokens.get(&token_id)?;
        token.listing.as_ref().map(|listing| listing_view(&token_id, token, listing))
    }

    pub fn get_listings(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<ListingView> {
        self.listed
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .filter_map(|id| {
                let token = self.tokens.get(id)?;
                token.listing.as_ref().map(|listing| listing_view(id, token, listing))
            })
            .collect()
    }
}

fn listing_view(token_id: &str, token: &Token, listing: &Listing) -> ListingView {
    ListingView {
        token_id: token_id.to_string(),
        title: token.title.clone(),
        seller: listing.seller.clone(),
        price: listing.price,
        listed_ms: listing.listed_ms,
        sealed_seat_balance: listing.sealed_seat_balance,
        rotation_seq: U64(token.seq),
    }
}
