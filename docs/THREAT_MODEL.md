# Threat model: handing over a Choir

Written before any contract code, as the track asks. The track prompt says to stop here and wait
for the human's OK. The human asked for this project to be built independently, so the model was
written first and the build continued; every defence below maps to a test named at the end of its
row, and the list was re-checked against the finished code.

## What is being transferred

A Choir is one NEP-171 token and one NEAR account with the same id, for example
`builders.choir-hall.testnet`. The account has no access keys. It runs immutable shared code (a
global contract referenced by hash). Whoever the account records as `owner` is the **conductor**.

What sits inside the account, and whose it is:

| Thing | Belongs to | Moves with the NFT? |
| --- | --- | --- |
| Seat balance: the conductor's capped cut of every tip, not yet withdrawn | the seat | Yes |
| The pot: this round's share for amplified members | members | No. Nobody can take it except through the round's split |
| Member balances: settled earnings not yet claimed | each member | No |
| Storage reserve and buffer | the account | Yes, but it cannot be withdrawn by anyone |
| The near.social identity: profile, followers, post history | the account | Yes |
| The right to set rules, appoint curators, remove members and edit the profile | the conductor | Yes |
| The right to write a post as the account | nobody | It does not exist. The account posts only what its code composes: round receipts and handovers |
| Curator grants | people the previous conductor chose | No. All of them are void after a handover |

"The money" a seller could try to keep is therefore the seat balance, the future cut, and any
lever that lets them steer the pot or speak as the account after they have been paid.

## Actors

- **Seller**: the current conductor. Fully malicious. May control other accounts, including
  members, curators and contracts.
- **Buyer**: pays through the collection's market, or receives a plain `nft_transfer`.
- **Members, curators, tippers**: bystanders whose money must not be touched by a handover.
- **Collection** (`choir-hall`): the only account that can change an item's owner. It is trusted to
  follow its code, so the code must be the only thing that can act for it.

## Every way a seller could try to keep the money or the access

| # | Attack | What stops it | Test |
| --- | --- | --- | --- |
| 1 | Keep an access key to the account and sign as it after the sale. | The account is created by the collection in one batch that adds no key, and the item code contains no add-key action. Its code is a global contract referenced by hash, so it cannot be swapped for code that does. `view_access_key_list` is empty and stays empty. | `proofs: a choir has no access keys and its code hash is the published one` |
| 2 | Keep a second key on the collection and use it to move the NFT back or deploy new collection code. | The collection has no upgrade method and no admin. After deployment its own keys are deleted, so only its code can act. The app's proof page reads the empty key list (T3, step 2). | `proofs: collection reports config_epoch and has no keys after lock` |
| 3 | Withdraw the seat balance after the buyer looked, just before the sale lands. | Listing freezes the item: every conductor-only method refuses while `status` is `Frozen`. `buy` also carries the seat balance the buyer was shown; the item refuses the rotation if it holds less. | `market: seller cannot withdraw while listed`, `market: buy aborts and refunds if the seat holds less than shown` |
| 4 | Unlist, drain, relist at the same price, hoping a buyer's transaction is already on its way. | Same check as 3: the rotation compares the live seat balance against the buyer's minimum, in the receipt that changes the owner. A relist cannot fake that. | `races: unlist-drain-relist in front of a buy` |
| 5 | Raise the price in front of the buyer. | `buy` pays the price in the listing at execution time and requires the attached deposit to cover it. A higher price fails and refunds; a lower one refunds the difference. | `market: price raised in front of buyer refunds` |
| 6 | Start a seat withdrawal, then sell while the payout is still in flight, and get paid twice if the payout fails. | The withdrawal debits the seat before the transfer is sent. If the transfer fails, the callback credits **the seat**, not the person who asked. After a sale that is the buyer's seat. The seller can only lose by this. | `races: sale lands between a seat withdrawal and its callback` |
| 7 | Sell in the middle of a member payout or a round settlement and capture members' money. | Member balances and the pot are separate ledgers that no conductor method can debit. Settlement is one state change with no cross-contract step, so there is nothing to interleave with. A failed member payout is credited back to that member whoever the conductor is. | `races: sale in the middle of a member payout`, `races: round settles in the same block as a sale` |
| 8 | Stay on as a curator, or leave a friend as one, and keep steering the pot. | Every curator grant is stamped with the rotation number it was made under and counts only while that number is current. A handover increases the number, which voids all grants in one step. | `lifecycle: curators are void after a handover` |
| 9 | Queue a rule change (for example a higher cut) that takes effect after the sale. | Rule changes only take effect at the next round, are visible as `pending_rules` while they wait, cannot be made while listed, and are dropped at handover. The cut is capped at 20% in code. | `lifecycle: pending rules are dropped at handover`, `lifecycle: cut is capped` |
| 10 | Transfer to a contract with `nft_transfer_call`, have it drain the seat during `nft_on_transfer`, then return the token. | During a transfer-call the item is rotated *frozen*. The receiver cannot use conductor methods until the transfer resolves. If it is returned, the seat comes back with what it held. | `nft: transfer_call receiver cannot act before resolve`, `nft: returned token restores the previous owner` |
| 11 | Move the NFT twice at once (transfer and sale, or two sales) so both counterparties believe they own it. | The collection locks a token from the moment it asks the item to rotate until the answer returns. Any other transfer, list or buy for that token refuses while locked. The item rejects a rotation whose expected sequence is stale. | `races: second transfer while the first is in flight`, `races: stale sequence is refused` |
| 12 | Make the index and the account disagree, then show the buyer whichever half suits. | The item is the authority on its owner. Consumers run the pair check (item and collection, same final block). If the item is ahead, anyone can call `sync` to make the index catch up; the index can never move an owner the item did not record. | `proofs: pair check refuses when halves disagree`, `proofs: sync adopts only newer item state` |
| 13 | Sell a look-alike: an account that answers `nft_item_info` naming this collection. | The collection's `nft_token` is null for anything it did not mint, and only the keyless collection can create accounts under its name. The app pins the collection from its own config, never from the item. | `proofs: forgery outside the namespace is refused`, `proofs: forgery cannot be minted under the parent` |
| 14 | Take the buyer's payment and make the rotation fail. | Payment sits in the collection until the item confirms the rotation. On failure the whole deposit goes back to the buyer and the listing stays. | `market: failed rotation refunds the buyer` |
| 15 | Make the seller's own account unpayable to wedge the sale. | If the payout to the seller fails, the amount is parked as owed to the seller and the sale still completes. | `market: unpayable seller does not block the sale` |
| 16 | Use the account's standing after the sale: change its profile, unfollow members, or post in its name. | Profile and membership changes are conductor-only and check the live owner. Posting in its name is not possible for anyone: no method takes text and posts it. The handover itself is posted by the account, so followers see who holds the seat. | `lifecycle: old conductor is refused after handover`, `lifecycle: nobody can speak as the account` |
| 17 | Pull the storage reserve, or sweep tips that were sent by plain transfer into the seat. | No method pays out the reserve. Unaccounted NEAR can only enter through `sweep`, which splits it by the same public rule as a tip. Every state-changing call ends by checking `balance >= storage + reserved`. | `money: plain transfers are split by sweep`, `money: solvency holds after every call` |

## What a handover does not protect against

Stated so nobody reads more into this than is there.

- **Curation is trusted, not trustless.** The conductor and curators decide which posts are
  amplified, so they decide who shares the pot. A conductor can favour friends. What Choir adds is
  that it is public (every amplification and payout is on chain and posted by the account), the
  conductor's own cut is capped, and earned money cannot be taken back.
- **A new conductor can change direction.** They can appoint new curators, remove members and
  change rules from the next round. Members keep everything already earned and can leave.
- **The collection can move a seat.** That is how transfers work. The defence is that the
  collection is code with no keys, not that the power does not exist.
- **Posts are public and permanent.** FastData keeps history. A handover cannot unsay what the
  account said.
- **Off-chain promises do not transfer.** A sponsor deal or a Discord server is not in the
  account.

## Order of state changes in a sale

1. `list`: collection checks the caller owns the token, then calls `freeze` on the item. The item
   refuses conductor-only calls from here on. The listing records price and seller.
2. `buy`: collection takes the buyer's deposit, locks the token, and calls
   `rotate(new_owner, expect_seq, min_seat_balance)` on the item.
3. The item checks the caller is its collection, the sequence, and the seat balance, then in one
   receipt: sets the owner, increases `rotation_seq` (voiding curators), clears the freeze, drops
   pending rules, records the handover and posts it to near.social.
4. Callback on the collection: on success it updates the index, pays the seller, refunds any
   excess and removes the listing. On failure it refunds the buyer and unlocks.

Between 2 and 3 the item is still frozen under the seller, so the seller has no window. After 3
the seller is not the owner on the account, which is the state that governs it.
