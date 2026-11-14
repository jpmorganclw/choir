//! Members: joining, being amplified, and claiming what a round paid.

use crate::*;

#[near]
impl Choir {
    /// Joins an open Choir. Attach the dues plus a small one-time fee for the bytes of the record.
    /// The dues are split like a tip. The account follows the new member on near.social.
    #[payable]
    pub fn join(&mut self) {
        self.roll();
        require!(self.rules.open, "This Choir admits members by invitation");
        let who = env::predecessor_account_id();
        let dues = self.rules.dues.0;
        require!(
            env::attached_deposit().as_yoctonear() >= dues + JOIN_FEE,
            "Attach the dues plus 0.01 NEAR to join"
        );
        self.enrol(&who);
        if dues > 0 {
            self.take_in(dues);
        }
        self.record(EventKind::Joined { member: who, dues: U128(dues) });
        self.assert_solvent();
    }

    /// The conductor or a curator brings someone in, whatever the join rule says. No dues, only
    /// the 0.01 NEAR for the bytes of the record.
    #[payable]
    pub fn admit(&mut self, account: AccountId) {
        let by = self.assert_curator();
        require!(env::attached_deposit().as_yoctonear() >= JOIN_FEE, "Attach 0.01 NEAR to admit a member");
        self.roll();
        self.enrol(&account);
        self.record(EventKind::Admitted { member: account, by });
        self.assert_solvent();
    }

    /// Leaves. Points already earned this round still pay out, and settled earnings stay claimable.
    #[payable]
    pub fn leave(&mut self) {
        self.roll();
        let who = env::predecessor_account_id();
        self.retire(&who);
        self.record(EventKind::Left { member: who });
        self.assert_solvent();
    }

    /// Removes a member. It cannot take back anything they earned.
    #[payable]
    pub fn remove_member(&mut self, account: AccountId) {
        let by = self.assert_curator();
        self.roll();
        self.retire(&account);
        self.record(EventKind::Removed { member: account, by });
        self.assert_solvent();
    }

    /// A curator (or the conductor) amplifies a member's post: the account reposts it on
    /// near.social and the author earns one point in this round's split. Attach 0.005 NEAR for
    /// the bytes of the record.
    #[payable]
    pub fn amplify(&mut self, author: AccountId, post_id: String) {
        let by = self.assert_curator();
        assert_amplify_fee();
        self.roll();
        self.do_amplify(author, post_id, by, false);
        self.assert_solvent();
    }

    /// A member amplifies one of their own posts, up to the per-round limit in the rules.
    /// Attach 0.005 NEAR for the bytes of the record.
    #[payable]
    pub fn amplify_own(&mut self, post_id: String) {
        assert_amplify_fee();
        self.roll();
        let who = env::predecessor_account_id();
        require!(self.rules.self_cap > 0, "In this Choir only curators amplify posts");
        self.do_amplify(who.clone(), post_id, who, true);
        self.assert_solvent();
    }

    /// Takes a repost down. If it was amplified in the open round, its point is removed too.
    /// A post that was taken down cannot be amplified again.
    #[payable]
    pub fn unamplify(&mut self, author: AccountId, post_id: String) {
        let by = self.assert_curator();
        self.roll();
        let key = format!("{author}/{post_id}");
        let amp = self.amplified.get(&key).cloned().unwrap_or_else(|| env::panic_str("That post is not amplified"));
        require!(amp.live, "That post was already taken down");
        self.amplified.insert(key, Amp { round: amp.round, live: false });
        if amp.round == self.round {
            if let Some(mut member) = self.members.get(&author).cloned() {
                self.touch(&mut member);
                if member.points > 0 {
                    member.points -= 1;
                    self.points -= 1;
                    if member.points == 0 {
                        self.contributors -= 1;
                    }
                }
                self.members.insert(author.clone(), member);
            }
        }
        self.social_set(format!("repost/{author}/{post_id}"), Value::Null);
        self.record(EventKind::Unamplified { author, post_id, by });
        self.assert_solvent();
    }

    /// Pays the caller everything their amplified posts have earned in settled rounds.
    /// 0.001 NEAR of the payout stays behind for the bytes of its record.
    pub fn claim(&mut self) -> Promise {
        self.roll();
        let who = env::predecessor_account_id();
        let mut member = self.members.get(&who).cloned().unwrap_or_else(|| env::panic_str("You have no earnings here"));
        self.touch(&mut member);
        let amount = member.balance;
        require!(amount > PAYOUT_FEE, "Nothing to claim yet. Earnings arrive when a round is settled");
        member.balance = 0;
        self.members.insert(who.clone(), member);
        self.reserved -= amount;
        let net = amount - PAYOUT_FEE;
        self.totals.paid_members = U128(self.totals.paid_members.0 + net);
        self.record(EventKind::Claimed { member: who.clone(), amount: U128(net) });
        self.pay(who, amount, false)
    }
}

fn assert_amplify_fee() {
    require!(
        env::attached_deposit().as_yoctonear() >= AMPLIFY_FEE,
        "Attach 0.005 NEAR to amplify a post: it pays for the record"
    );
}

impl Choir {
    fn enrol(&mut self, who: &AccountId) {
        let now = env::block_timestamp_ms();
        let mut member = match self.members.get(who).cloned() {
            Some(member) => {
                require!(!member.active, "Already a member");
                member
            }
            None => Member { joined_ms: now, active: false, round: self.round, points: 0, self_amps: 0, balance: 0, earned: 0, amplified: 0 },
        };
        self.touch(&mut member);
        member.active = true;
        self.members.insert(who.clone(), member);
        self.active_members += 1;
        self.social_set(format!("graph/follow/{who}"), json!({}));
    }

    fn retire(&mut self, who: &AccountId) {
        let mut member = self.members.get(who).cloned().unwrap_or_else(|| env::panic_str("Not a member"));
        require!(member.active, "Not a member");
        self.touch(&mut member);
        member.active = false;
        self.members.insert(who.clone(), member);
        self.active_members -= 1;
        self.social_set(format!("graph/follow/{who}"), Value::Null);
    }

    fn do_amplify(&mut self, author: AccountId, post_id: String, by: AccountId, own: bool) {
        check_post_id(&post_id);
        let key = format!("{author}/{post_id}");
        require!(!self.amplified.contains_key(&key), "That post has already been amplified here");
        let mut member = self.members.get(&author).cloned().unwrap_or_else(|| env::panic_str("The author is not a member"));
        require!(member.active, "The author is not a member");
        self.touch(&mut member);
        if own {
            require!(
                member.self_amps < self.rules.self_cap,
                "You have used your own amplifications for this round. A curator can still amplify you"
            );
            member.self_amps += 1;
        }
        if member.points == 0 {
            self.contributors += 1;
        }
        member.points += 1;
        member.amplified += 1;
        self.points += 1;
        self.totals.amplified += 1;
        self.members.insert(author.clone(), member);
        self.amplified.insert(key, Amp { round: self.round, live: true });
        self.social_set(format!("repost/{author}/{post_id}"), json!({}));
        self.record(EventKind::Amplified { author, post_id, by });
    }
}
