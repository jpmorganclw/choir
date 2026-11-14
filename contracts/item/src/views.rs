//! Read-only views. Everything the app shows comes from here or from near.social.

use crate::*;

#[near]
impl Choir {
    pub fn get_choir(&self) -> ChoirView {
        let now = env::block_timestamp_ms();
        let end = self.round_start_ms + self.rules.round_ms;
        ChoirView {
            id: env::current_account_id(),
            collection: self.collection.clone(),
            social: self.social.clone(),
            conductor: self.owner.clone(),
            rotation_seq: U64(self.rotation_seq),
            status: self.status(),
            name: self.name.clone(),
            about: self.about.clone(),
            rules: self.rules.clone(),
            pending_rules: self.pending_rules.clone(),
            round: self.round,
            round_start_ms: self.round_start_ms,
            round_end_ms: end,
            round_due: now >= end,
            pot: U128(self.pot),
            points: self.points,
            contributors: self.contributors,
            seat_balance: U128(self.seat_balance),
            reserved: U128(self.reserved),
            members: self.active_members,
            curators: self.get_curators(),
            totals: self.totals.clone(),
            events: self.events.len() as u64,
            created_ms: self.created_ms,
            now_ms: now,
        }
    }

    pub fn get_member(&self, account: AccountId) -> Option<MemberView> {
        self.members.get(&account).map(|member| self.member_view(&account, member))
    }

    /// Members in the order they first joined, including those who have left but still have a
    /// record (they may have earnings to claim).
    pub fn get_members(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<MemberView> {
        self.members
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(|(account, member)| self.member_view(account, member))
            .collect()
    }

    /// Curators appointed by the current conductor. Grants from earlier conductors do not count.
    pub fn get_curators(&self) -> Vec<AccountId> {
        self.curators
            .iter()
            .filter(|(_, seq)| **seq == self.rotation_seq)
            .map(|(account, _)| account.clone())
            .collect()
    }

    /// The account's own history, oldest first. `get_choir().events` is the total.
    pub fn get_events(&self, from_index: Option<u64>, limit: Option<u32>) -> Vec<Event> {
        let from = from_index.unwrap_or(0).min(self.events.len() as u64) as u32;
        let to = from.saturating_add(limit.unwrap_or(50).min(200)).min(self.events.len());
        (from..to).filter_map(|i| self.events.get(i).cloned()).collect()
    }

    /// Everyone who has held the seat, oldest first.
    pub fn get_holders(&self) -> Vec<Holder> {
        self.holders.iter().cloned().collect()
    }

    pub fn get_round(&self, round: u64) -> Option<RoundResult> {
        self.rounds.get(&round).cloned()
    }

    /// `None` if never amplified, `Some(true)` while the repost is up, `Some(false)` once taken down.
    pub fn amplified(&self, author: AccountId, post_id: String) -> Option<bool> {
        self.amplified.get(&format!("{author}/{post_id}")).map(|amp| amp.live)
    }
}

impl Choir {
    fn member_view(&self, account: &AccountId, member: &Member) -> MemberView {
        let current = member.round == self.round;
        MemberView {
            account: account.clone(),
            joined_ms: member.joined_ms,
            active: member.active,
            points: if current { member.points } else { 0 },
            self_amps: if current { member.self_amps } else { 0 },
            claimable: U128(member.balance + self.share_of(member)),
            earned: U128(member.earned + self.share_of(member)),
            amplified: member.amplified,
        }
    }
}
