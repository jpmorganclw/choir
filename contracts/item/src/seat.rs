//! The seat: what the conductor can do, and how the collection hands the seat to someone else.
//!
//! There is deliberately no method that lets anyone, the conductor included, write a post as the
//! account. The only posts it ever makes are composed by this contract from its own state: a
//! round's receipt and a handover notice. Everything else in its feed is a member's own post,
//! reposted. A conductor who wants to say something posts from their own account, like any member.

use crate::*;

#[near]
impl Choir {
    // ---- the sharded-item interface ----

    /// What this account says about itself. A consumer pairs it with the collection's `nft_token`
    /// at the same final block and refuses unless the two agree.
    pub fn nft_item_info(&self) -> NftItemInfo {
        NftItemInfo {
            spec: SPEC.to_string(),
            init: true,
            // Same predicate the conductor methods enforce, so `Active` is never reported while
            // a conductor request would be refused.
            status: self.status(),
            collection_id: self.collection.clone(),
            // Read from the account, never from stored state.
            token_id: env::current_account_id().to_string(),
            owner_id: self.owner.clone(),
            rotation_seq: U64(self.rotation_seq),
            rotation_epoch: 0,
        }
    }

    // ---- only the collection ----

    /// Hands the seat to `new_owner`. One receipt changes the owner, voids every curator grant,
    /// clears the freeze, drops queued rule changes, records the handover and posts it.
    ///
    /// `expect_seq` must be the current rotation number, so a stale request cannot land late.
    /// `min_seat_balance` is what a buyer was shown; the handover refuses if the seat holds less.
    /// `hold` keeps the seat frozen under the new owner until the collection releases it, which
    /// is how a transfer-call stops its receiver acting before the transfer has resolved.
    /// `quiet` skips the public post, for a transfer-call that is being returned.
    pub fn rotate(
        &mut self,
        new_owner: AccountId,
        expect_seq: U64,
        min_seat_balance: Option<U128>,
        hold: Option<bool>,
        quiet: Option<bool>,
    ) -> U64 {
        self.assert_collection();
        require!(expect_seq.0 == self.rotation_seq, "This handover was prepared for an older state of the seat");
        require!(new_owner != self.owner, "That account already holds the seat");
        if let Some(min) = min_seat_balance {
            require!(self.seat_balance >= min.0, "The seat holds less than the buyer was shown");
        }
        let hold = hold.unwrap_or(false);
        let from = std::mem::replace(&mut self.owner, new_owner.clone());
        self.rotation_seq += 1;
        self.frozen = hold;
        self.pending_rules = None;
        let now = env::block_timestamp_ms();
        self.holders.push(Holder { account: new_owner.clone(), since_ms: now, seq: U64(self.rotation_seq) });
        self.record(EventKind::Rotated { from: from.clone(), to: new_owner.clone(), seq: U64(self.rotation_seq) });
        if !hold && !quiet.unwrap_or(false) {
            self.post_handover(&from, &new_owner);
        }
        self.assert_covered();
        U64(self.rotation_seq)
    }

    /// The collection freezes the seat when it is listed. Conductor-only methods refuse until it
    /// is released, so what a buyer was shown cannot be taken out from under them.
    pub fn freeze(&mut self, expect_seq: U64) -> Sealed {
        self.assert_collection();
        require!(expect_seq.0 == self.rotation_seq, "This listing was prepared for an older state of the seat");
        if !self.frozen {
            self.frozen = true;
            self.record(EventKind::Frozen);
        }
        self.assert_covered();
        Sealed { rotation_seq: U64(self.rotation_seq), seat_balance: U128(self.seat_balance) }
    }

    /// Releases the freeze. With `announce`, the account also posts the handover that a held
    /// rotation kept quiet until it was final.
    pub fn unfreeze(&mut self, expect_seq: U64, announce: Option<bool>) {
        self.assert_collection();
        require!(expect_seq.0 == self.rotation_seq, "This release was prepared for an older state of the seat");
        if self.frozen {
            self.frozen = false;
            self.record(EventKind::Unfrozen);
        }
        if announce.unwrap_or(false) && self.holders.len() >= 2 {
            let from = self.holders.get(self.holders.len() - 2).map(|h| h.account.clone());
            if let Some(from) = from {
                let to = self.owner.clone();
                self.post_handover(&from, &to);
            }
        }
        self.assert_covered();
    }

    // ---- only the conductor ----

    /// Changes how the account presents itself on near.social. Images are `fastfs://` URIs.
    #[payable]
    pub fn set_profile(
        &mut self,
        name: Option<String>,
        about: Option<String>,
        avatar: Option<String>,
        banner: Option<String>,
    ) {
        let by = self.assert_conductor();
        self.roll();
        if let Some(name) = name {
            check_text("name", &name, 1, MAX_NAME);
            self.name = name;
        }
        if let Some(about) = about {
            check_text("about", &about, 0, MAX_ABOUT);
            self.about = about;
        }
        for uri in [&avatar, &banner].into_iter().flatten() {
            require!(uri.starts_with("fastfs://") && uri.len() <= MAX_URI, "Images must be fastfs:// links");
        }
        self.write_profile(avatar, banner);
        self.record(EventKind::ProfileSet { by });
        self.assert_solvent();
    }

    /// Queues new rules. They take effect when the next round opens, never in the middle of one,
    /// and anyone can read them while they wait.
    #[payable]
    pub fn set_rules(&mut self, rules: Rules) {
        let by = self.assert_conductor();
        self.roll();
        rules.check();
        self.pending_rules = Some(rules);
        self.record(EventKind::RulesQueued { by });
        self.assert_solvent();
    }

    /// Appoints or dismisses a curator. A grant lasts only while this conductor holds the seat.
    #[payable]
    pub fn set_curator(&mut self, account: AccountId, on: bool) {
        self.assert_conductor();
        self.roll();
        if on {
            self.curators.insert(account.clone(), self.rotation_seq);
        } else {
            self.curators.remove(&account);
        }
        self.record(EventKind::CuratorSet { account, on });
        self.assert_solvent();
    }
}

impl Choir {
    fn post_handover(&mut self, from: &AccountId, to: &AccountId) {
        self.post(&format!(
            "The conductor's seat has passed from @{from} to @{to}. All curator rights were reset. Members keep everything they earned.\n\nPosted by the account itself. Nobody holds its keys."
        ));
    }
}
