# Choir

**The community account nobody can speak through.**

A Choir is a near.social account that belongs to a community instead of a person. It is a real
NEAR account with **no access keys**. It follows its members, reposts ("amplifies") their own
posts, and splits every tip between the members it amplified. The seat that curates it is an
NEP-171 NFT: hand it over or sell it, and the seat changes hands in one step.

Track: **NFTs That Do Something** (`nfts`). It also fits **Social Money** (`social`).

Demo video: [video/choir-demo.mp4](video/choir-demo.mp4) (88 seconds). Every action in it is a real
call to the compiled contracts, run on the practice chain described below.

## The problem

A community account on any social network belongs to whoever holds its password. That person can
post anything in everyone's name, keeps whatever the account earns, and takes the account with
them when they leave. The people who write the posts that make the account worth following get
nothing, and a handover means sending someone a password and hoping.

## What Choir does about it

| | A normal community account | A Choir |
| --- | --- | --- |
| Who can log in | whoever has the password | nobody: the account has zero access keys |
| Who can post in its name | whoever has the password | nobody: there is no method that takes text and posts it |
| What it shows | whatever that person types | members' own posts, reposted, and receipts the contract composes |
| Where tips go | to that person | split on arrival: a capped cut to the seat, the rest to the members amplified that round |
| Handing it over | send a password | transfer one NFT; curators reset, the old holder is refused from the next block |

Each Choir is **one NFT and one NEAR account with the same id**, for example
`builders.choir-hall.testnet`. The account:

- **owns money**: the round's pot, members' unclaimed earnings, and the seat's balance;
- **acts by itself**: it writes to near.social as itself (follow, repost, receipt, handover notice);
- **carries memberships and access rights**: members, curators, and the conductor's seat;
- **keeps its own history**: every tip, payout and holder, readable from the account with no indexer.

## Try it in two minutes

Needs Node 22 or newer. No Rust, no wallet, no network: the compiled contracts are in `res/`.

```bash
npm ci
npm test          # 77 tests against the real compiled contracts
npm run story     # the whole product in 13 steps, each printed with its evidence
npm run demo      # builds the app and serves it at http://localhost:8791
```

`npm run demo` runs the **practice chain**: the same wasm that is deployed, executing inside the
server, with five people you can act as and a clock you can move.

### Do X, see Y (in the app, on the practice chain)

1. Open http://localhost:8791 and click **NEAR Builders**.
   See: the account's feed, "0 access keys", this round's pot.
2. Top right, choose **You are: Maya**. In *Your posts*, type a post, click **Post as maya**, then
   **Amplify** on it.
   See: the post appears in the Choir's feed marked "NEAR Builders repeated this". Maya is still
   the author. Her row in *Members* shows one more post this round.
3. Choose **You are: Fan**. Click **Tip 5 NEAR**.
   See: the pot rises by 4.5 and the seat by 0.5 (the rules say 10%). *Books* shows the split.
4. Click **Skip a week** (black bar), then **Close the round**.
   See: a new post in the feed marked "Posted by the account itself": the round's receipt.
5. Choose **You are: Maya**, click **Claim**.
   See: her earnings are paid; *Books* records the payout.
6. Choose **You are: Asha**, click **Open your desk**. Under *Pass the seat on*, type
   `sam.testnet` and click **Hand over**.
   See: the Choir now says "Conducted by Sam", and the account posted the handover itself.
7. Still as Asha, open the desk again (`/#/c/builders.choir-hall.testnet/desk`).
   See: "Only the conductor can open this desk. The seat is held by Sam", with the block it was
   checked at.
8. Open the **Proof** tab.
   See: seven checks read live from the chain: no keys, published code hash, the account and the
   collection agreeing on the holder at one block, and the collection itself having no keys.
9. Open **Seats for sale**, choose **You are: Maya**, and buy Night Shift.
   See: you are taken to the desk of the seat you just bought; the seller was paid after the
   account changed hands.

Everything above is also covered by tests, which a script can check without a browser.

## How control passes on transfer, and what stops the old owner

This is the question the track asks. The short version:

1. **Nobody ever held a key.** The collection creates each Choir account in one receipt:
   `CreateAccount`, `Transfer`, `UseGlobalContract(hash)`, `FunctionCall(init)`. No `AddKey`. The
   item code contains no action that adds a key or deploys code, and it is referenced by hash, so
   it cannot be replaced. `view_access_key_list` is empty and stays empty.
2. **The account is the authority on who holds it.** Its state has one `owner`. Every conductor
   method checks that the caller is that owner and that the seat is not frozen. `nft_item_info`
   reports `status` from the same function those methods call, so it cannot say `Active` while a
   request would be refused.
3. **Only the collection can change the owner**, by calling `rotate(new_owner, expect_seq, ...)`
   on the account. `expect_seq` must equal the account's current rotation number, so a stale or
   repeated request fails. In that one receipt the account sets the new owner, adds one to
   `rotation_seq`, clears the freeze, drops queued rule changes, records the handover and posts it
   to near.social.
4. **Curator grants die with the old conductor.** Each grant stores the rotation number it was made
   under and counts only while that number is current. The line that changes the owner also changes
   the number. Nothing has to be revoked one by one.
5. **The index follows the account.** The collection updates its NEP-171 index only in the
   callback of a rotation the account accepted. If a callback were ever lost, anyone can call
   `sync`, which can only move the index toward what the account reports.
6. **A listed seat is frozen.** `list` asks the account to freeze before the listing exists. While
   frozen, the conductor cannot withdraw, change rules or appoint curators. `buy` carries the
   rotation number and the seat balance the buyer was shown; the account refuses the handover if
   either is worse, and the buyer's whole deposit is returned. The seller is paid only after the
   account has changed hands.
7. **Three ledgers never mix.** The seat's balance moves with the NFT. The pot and members'
   earnings are members' money: no conductor method can debit them. A payout that fails is credited
   back to the ledger it came from; a failed seat withdrawal is credited to the *seat*, not to the
   person who asked, so it cannot pay an old conductor after a sale.

The full list of attacks, with the test that tries each one, is in
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). It was written before the contracts.

To check that the tests really hold those defences up, `node scripts/mutate.mjs` deletes each
defence from the contract source in turn, rebuilds the wasm and runs the suite: 23 defences, from
the freeze on a listed seat to the one-yocto confirmation. **All 23 were caught**, and afterwards
the rebuilt wasm was byte-for-byte the one in `res/`. Which tests caught which defence:
[docs/MUTATIONS.md](docs/MUTATIONS.md). `node scripts/mutate.mjs --dry` checks the list without
building anything.

## What the track asked for, and where it is

| Asked for | Where |
| --- | --- |
| NEP-171 contract and the logic tying each token to its sub-account | [contracts/registry](contracts/registry/src), [contracts/item](contracts/item/src) |
| README explaining how control passes and what stops the old owner | the section above |
| A gated page only current holders can open | the conductor's desk: [app/src/pages/Desk.jsx](app/src/pages/Desk.jsx), [server/gate.mjs](server/gate.mjs), [tests/gate.test.mjs](tests/gate.test.mjs) |
| A history view per NFT: what it earned, what it paid out, who held it | the **Books** tab, read from `get_events` and `get_holders` on the account |
| Tests for the transfer path, including a sale in the middle of a payout | [tests/races.test.mjs](tests/races.test.mjs), [tests/market.test.mjs](tests/market.test.mjs), [tests/nft.test.mjs](tests/nft.test.mjs) |
| Threat model written before coding | [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) |

### The gated page

The conductor's desk opens in two steps, and neither trusts the browser:

- The page runs the **pair check** from the sharded-item draft: it reads `nft_item_info` from the
  account and `nft_token` from the collection at the **same final block**, and opens only if both
  name the signed-in account. The collection id comes from the app's own configuration, never from
  the item.
- The desk's private handover notes are served by [server/gate.mjs](server/gate.mjs). Signing in
  is a NEP-413 signature by a key that is on the account. Access is then decided by running the
  pair check again **on every request**, so a session, a signature or an open tab kept from before
  a sale opens nothing afterwards. `tests/gate.test.mjs` hands the seat over and uses the old
  session.

A static copy of the app (the FastFS one) has no server, so it has the desk but not the notes.

## How it works

Two contracts, both in Rust with near-sdk 5.30.

**`choir-registry`** (the collection, [contracts/registry](contracts/registry/src)): NEP-171 core
including `nft_transfer_call`, NEP-177 metadata, NEP-181 enumeration, NEP-297 events, the mint, and
a fixed-price market. It has no owner, no admin method, no upgrade method and no configuration
setter. After deployment its own access keys are deleted. NEP-178 approvals are deliberately not
implemented.

**`choir-item`** (one Choir, [contracts/item](contracts/item/src)): published once as a global
contract and used by every Choir account by hash. It holds members, curators, rounds, the three
ledgers and the event history, and it is the only thing that writes to near.social for the
account.

### near.social

near.social stores data as FastData KV: a function call to the account `social` with method
`__fastdata_kv`. The FastData indexer records the receipt's **predecessor** as the author and does
not look at whether the receipt succeeded
([its source](https://github.com/fastnear/fastdata-indexer/blob/main/main-indexer/src/main.rs)).
So a contract can be an author. A Choir's contract makes that call itself, with 1 gas:

| When | What the account writes |
| --- | --- |
| it is created, or the conductor edits the profile | `profile/name`, `profile/about`, `profile/links/website` |
| someone joins or is admitted / leaves or is removed | `graph/follow/{member}` set / cleared |
| a member's post is amplified / taken down | `repost/{member}/{post_id}` set / cleared |
| a round with a pot is settled | `post/{id}`: the receipt, composed by the contract |
| the seat changes hands | `post/{id}`: the handover notice, composed by the contract |

There is no method that takes text from a caller and posts it. `tests/lifecycle.test.mjs` checks
the wasm export table for one.

The app reads near.social straight from FastData KV (`kv.test.fastnear.com` on testnet), with no
indexer of its own. The writes follow the `social-kv/1` standard and near.social attributes a
write to the receipt's predecessor, so a Choir on mainnet should show up on near.social itself
with nothing else to build. That last step has not been tried: this project is on testnet only.

### Rounds and money

- A tip is split when it arrives: `seat_bps` (public, at most 20%) to the seat, the rest to the
  round's pot. NEAR sent by plain transfer runs no code; anyone can call `sweep` to count it as a
  tip. So a Sputnik DAO can fund a Choir with an ordinary Transfer proposal to the Choir's name,
  and an exchange withdrawal works too.
- The conductor can be any account, including a Sputnik DAO: its proposals can call `set_rules`,
  `set_curator` or `nft_transfer` like any other holder.
- Amplifying a post gives its author one point in the open round. A post can be amplified once.
- When a round's time is up, anyone can close it. The pot is shared by points. Closing is one
  state change whatever the number of members; each member's share is worked out when they claim.
- Rule changes are queued in public and take effect only when the next round opens.
- Every action that stores something carries a small fixed fee for its bytes (0.01 NEAR to join,
  0.005 per amplification and per tip, 0.001 per payout), and every state-changing call ends by
  checking `balance >= storage + everything owed`. A 400-step randomised test checks that after
  every call.

### The sharded-item draft

The item implements `nft_item_info` from the
[Sharded NFT Items draft](https://github.com/houseofstake/tla-contracts/blob/main/docs/sharded-nft-items.md):
`token_id` is read from `env::current_account_id()`, `owner_id` is the state that governs the
account, `status` comes from the predicate the methods enforce, and `rotation_seq` increases on
every rotation. The collection exposes `config_epoch` (always 0: nothing about it can change) and
its own `rotation_seq` per token through `nft_rotation`, so a consumer can read the direction of a
disagreement. The consumer side, with all four tiers, is
[app/src/lib/verify.js](app/src/lib/verify.js); the app, the desk server and the tests share it.

## What it does not do

- **Curation is trusted.** The conductor and curators choose which posts are amplified, so they
  choose who shares the pot. Choir makes that public and caps the conductor's own cut. It does not
  stop a conductor favouring friends.
- **It does not read near.social on chain.** A contract cannot see FastData. Amplifying
  `maya/123` reposts that reference whether or not the post exists; a member can only submit
  references under their own account.
- **The collection can move a seat.** That is how a transfer works. The defence is that the
  collection has no keys and no admin, not that the power is absent.
- **Posts are public and permanent**, as everything on FastData is.
- **Gas is not modelled by the local tests.** The practice chain checks that gas handed to child
  calls fits the gas attached, but real gas use is only confirmed on testnet.

## Testnet

`scripts/accounts-testnet.mjs` creates the six demo accounts with the public faucet.
`scripts/deploy-testnet.mjs`, `scripts/seed-testnet.mjs`, `scripts/lock-testnet.mjs` and
`scripts/upload-site.mjs` then deploy the collection, play a short real story, delete the
collection's keys and publish the app to FastFS. `npm run verify:testnet` runs read-only checks
against whatever is live: it compares on-chain code with `res/`, runs the pair check on every
Choir, reads what each wrote to near.social from FastData, and checks solvency.

The scripts sign only with accounts named `choir-*.testnet` from the local NEAR keychain. See
[docs/DEMO.md](docs/DEMO.md) for the exact commands.

<!-- TESTNET-STATUS -->
**Status:** Choir is not deployed to testnet. Everything in this README up to here was verified on
the practice chain, which runs the same wasm files that these scripts deploy.
<!-- /TESTNET-STATUS -->

## Building the contracts

Only needed if you change them. Needs Rust (see `rust-toolchain.toml`) and `cargo-near`.

```bash
npm run build:contracts   # builds both and copies the wasm to res/, printing their hashes
```

## Layout

```
contracts/item        one Choir: members, rounds, ledgers, near.social writes, the seat
contracts/registry    the collection: NEP-171 index, mint, market
res/                  the compiled wasm the tests, the practice chain and the deploy scripts use
tests/                77 tests; tools/localnet/chain.mjs runs the wasm in Node
app/                  the web app (Vite, React); app/src/lib is the verifier and the RPC reader
server/               the practice chain, the conductor's desk, and testnet access
scripts/              build, story, and the testnet scripts
docs/                 threat model, mutation check, demo video script and demo post
tools/video/          how the demo video is made
video/                the demo video
```

## What was reused, and how AI was used

- **near-sdk 5.30.1**, **near-api-js**, **React**, **Vite**, **@hot-labs/near-connect** and the
  **Fraunces**, **DM Sans** and **IBM Plex Mono** fonts, all under their own licences.
- `tools/localnet/chain.mjs` (the small NEAR-compatible host the tests run on), the NEP-413
  hashing in `server/gate.mjs`, the FastFS upload in `scripts/upload-site.mjs` and the video
  tooling in `tools/video` are the author's own code, written during the hackathon window and
  extended for Choir (the FastData index, the account-creation rule, the checks that a keyless
  account cannot sign).
- The demo video's voices are AI-generated with Kokoro, an open text-to-speech model, using its
  stock voices. Its music is generated note by note by `tools/video/mix.py`.
- The code, tests and documents were written with Claude Code, directed by the repository owner.
- No part of this project runs on another chain.
- All code was written inside the hackathon window.

## Licence

MIT. See [LICENSE](LICENSE).
