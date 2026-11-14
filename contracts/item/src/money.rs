//! Money in and out: tips, plain transfers picked up by `sweep`, round settlement and payouts.

use crate::*;

#[near]
impl Choir {
    /// Tips the Choir. 0.005 NEAR of it pays for the record of the tip. Of the rest, the seat
    /// takes its public cut and everything else joins this round's pot.
    #[payable]
    pub fn tip(&mut self, memo: Option<String>) {
        self.roll();
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= MIN_TIP, "Tip at least 0.05 NEAR");
        let amount = attached - TIP_FEE;
        if let Some(memo) = &memo {
            check_text("memo", memo, 0, MAX_MEMO);
            require!(memo.len() <= 2 * MAX_MEMO, "The memo is too long");
        }
        let cut = self.take_in(amount);
        self.totals.tips += 1;
        self.record(EventKind::Tip {
            from: env::predecessor_account_id(),
            amount: U128(amount),
            seat_cut: U128(cut),
            memo,
        });
        self.assert_solvent();
    }

    /// NEAR sent to the account by plain transfer runs no code, so it sits unaccounted. Anyone can
    /// call this to count it as a tip. It leaves the storage reserve and a small buffer untouched.
    pub fn sweep(&mut self) -> U128 {
        self.roll();
        let balance = env::account_balance().as_yoctonear();
        let held_back = self.storage_cost() + self.reserved + BUFFER + MARGIN;
        require!(balance >= held_back + MIN_TIP, "Nothing to sweep");
        let amount = balance - held_back;
        let cut = self.take_in(amount);
        self.record(EventKind::Swept { amount: U128(amount), seat_cut: U128(cut) });
        self.assert_solvent();
        U128(amount)
    }

    /// Closes the round if its time is up. Anyone can call it; every other call does the same first.
    /// Returns the number of the round that is open afterwards.
    #[payable]
    pub fn settle(&mut self) -> u64 {
        self.roll();
        self.assert_solvent();
        self.round
    }

    /// The conductor takes the seat's balance, or part of it. Refused while the seat is listed.
    /// 0.001 NEAR of the payout stays behind for the bytes of its record.
    pub fn withdraw_seat(&mut self, amount: Option<U128>) -> Promise {
        let who = self.assert_conductor();
        self.roll();
        let amount = amount.map(|a| a.0).unwrap_or(self.seat_balance);
        require!(amount <= self.seat_balance, "The seat does not hold that much");
        require!(amount > PAYOUT_FEE, "There is too little on the seat to be worth a payout");
        self.seat_balance -= amount;
        self.reserved -= amount;
        let net = amount - PAYOUT_FEE;
        self.totals.paid_seat = U128(self.totals.paid_seat.0 + net);
        self.record(EventKind::SeatWithdrawn { to: who.clone(), amount: U128(net) });
        self.pay(who, amount, true)
    }

    /// Runs after a payout. If the transfer failed, the money goes back to the ledger it came
    /// from: a member's own balance, or the seat. A seat refund is credited to the seat and not to
    /// the person who asked, so a withdrawal that fails after a handover cannot pay the old
    /// conductor twice.
    #[private]
    pub fn on_paid(&mut self, to: AccountId, amount: U128, seat: bool) -> bool {
        if near_sdk::is_promise_success() {
            return true;
        }
        // `amount` is what was debited. The whole of it goes back, fee included.
        let net = amount.0 - PAYOUT_FEE;
        if seat {
            self.seat_balance += amount.0;
            self.totals.paid_seat = U128(self.totals.paid_seat.0 - net);
        } else {
            let mut member = self.members.get(&to).cloned().unwrap_or_else(|| env::panic_str("unknown payee"));
            member.balance += amount.0;
            self.members.insert(to.clone(), member);
            self.totals.paid_members = U128(self.totals.paid_members.0 - net);
        }
        self.reserved += amount.0;
        self.record(EventKind::PayoutReturned { to, amount, seat });
        false
    }
}
