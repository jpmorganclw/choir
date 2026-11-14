# Mutation check

Each row removes one defence from the contract source, rebuilds the wasm and runs the tests.
"Caught" means the tests named for that defence failed. Produced by `node scripts/mutate.mjs`.

Run on 2026-11-11: **23 of 23 caught**. After the run the source was restored and rebuilt; res/ is byte-for-byte what it was before, and every test passes again.

| Defence removed | Result | Tests that failed |
| --- | --- | --- |
| a listed seat refuses conductor actions (`frozen-seat`) | CAUGHT | `market: listing freezes the seat and records what was sealed`, `market: seller cannot withdraw while listed, nor use any other conductor power`, `market: buy aborts and refunds if the seat holds less than shown`, `nft: transfer_call receiver cannot act before resolve, and keeps the seat if it says so` and 1 more |
| the handover refuses if the seat holds less than the buyer was shown (`buyer-minimum`) | CAUGHT | `market: buy aborts and refunds if the seat holds less than shown`, `races: stale sequence is refused`, `races: unlist-drain-relist in front of a buy` |
| a rotation prepared for an older state is refused (`stale-rotation`) | CAUGHT | `races: stale sequence is refused` |
| only the collection can rotate, freeze or release (`collection-only`) | CAUGHT | `proofs: an item obeys only its collection` |
| curator grants end with the conductor who made them (`curators-void`) | CAUGHT | `lifecycle: curators are void after a handover` |
| queued rule changes are dropped at handover (`pending-rules`) | CAUGHT | `lifecycle: pending rules are dropped at handover` |
| the seat's cut is capped at 20% (`cut-cap`) | CAUGHT | `lifecycle: cut is capped`, `nft: minting emits nft_mint and refuses bad names and thin deposits` |
| a failed seat withdrawal is credited back to the seat (`seat-refund`) | CAUGHT | `races: sale lands between a seat withdrawal and its callback` |
| a failed member payout is credited back to that member (`member-refund`) | CAUGHT | `money: a member payout that fails is credited back to that member`, `races: a member payout that fails during a sale goes back to the member, not the seat` |
| only the conductor can take the seat balance (`conductor-only`) | CAUGHT | `lifecycle: old conductor is refused after handover, and the account announces it`, `market: seller cannot withdraw while listed, nor use any other conductor power`, `market: a sale moves the seat, its balance and its powers, and pays the seller`, `money: the conductor can take the seat balance and nothing else` and 3 more |
| a call must leave the account able to pay for storage and all it owes (`solvency`) | CAUGHT | `margin: a seat changes hands even when the account is down to its margin`, `money: a call that would leave the account unable to pay for its bytes is refused` |
| a post can be amplified only once (`amplify-once`) | CAUGHT | `lifecycle: a member amplifies their own post up to the cap, and the account reposts it`, `lifecycle: taking a repost down in the same round removes its point` |
| only the parent account can initialise an item (`parent-only-init`) | CAUGHT | `proofs: an item can only be initialised by its parent, and never as its own collection` |
| only members can be amplified (`member-only-amplify`) | CAUGHT | `lifecycle: joining makes the account follow the member, leaving unfollows` |
| only the conductor can hand over the seat (`owner-moves`) | CAUGHT | `lifecycle: old conductor is refused after handover, and the account announces it`, `nft: transfer needs one yocto, the real conductor and no approval`, `nft: a transfer_call to an account with no contract comes straight back`, `races: a lost answer cannot wedge a seat; the lock runs out and sync repairs the index` |
| a seat in the middle of a move cannot start another (`busy-lock`) | CAUGHT | `races: second transfer while the first is in flight`, `races: two buyers at once, one seat`, `races: a lost answer cannot wedge a seat; the lock runs out and sync repairs the index` |
| a purchase must cover the listed price (`price-check`) | CAUGHT | `market: price raised in front of buyer refunds`, `market: a buyer cannot buy what is not for sale, or an older state of the seat` |
| a refused handover returns the whole deposit to the buyer (`buyer-refund`) | CAUGHT | `market: buy aborts and refunds if the seat holds less than shown`, `market: failed rotation refunds the buyer`, `races: unlist-drain-relist in front of a buy` |
| only the conductor can list the seat (`owner-lists`) | CAUGHT | `market: listing freezes the seat and records what was sealed` |
| sync only ever moves the index toward a newer rotation (`sync-forward`) | CAUGHT | `proofs: sync adopts only newer item state`, `races: a lost answer cannot wedge a seat; the lock runs out and sync repairs the index` |
| a transfer needs the one-yocto confirmation (`one-yocto`) | CAUGHT | `nft: transfer needs one yocto, the real conductor and no approval` |
| a transfer-call holds the seat frozen until it resolves (`held-transfer`) | CAUGHT | `nft: transfer_call receiver cannot act before resolve, and keeps the seat if it says so` |
| sale proceeds that cannot be delivered wait for the seller (`seller-owed`) | CAUGHT | `market: unpayable seller does not block the sale`, `races: sale lands between a seat withdrawal and its callback` |
