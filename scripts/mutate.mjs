// A mutation check: are the defences in the threat model really held up by tests?
//
//   node scripts/mutate.mjs            every mutation
//   node scripts/mutate.mjs frozen     only mutations whose id contains "frozen"
//   node scripts/mutate.mjs --dry      builds nothing: checks that each line to break is in the
//                                      source exactly once and that each test it names exists
//
// For each defence it removes that one line from the contract source, rebuilds the wasm, and runs
// the tests. A defence is "caught" when the tests it names fail. Afterwards the source is put
// back, both contracts are rebuilt, and the script refuses to finish unless res/ is byte-for-byte
// what it was before. Needs Rust and cargo-near. Results go to docs/MUTATIONS.md.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const ITEM = 'contracts/item/src';
const HALL = 'contracts/registry/src';

/** id, what the defence is, file, the line to break, what to put instead, and the tests that must fail. */
const MUTATIONS = [
  ['frozen-seat', 'a listed seat refuses conductor actions', `${ITEM}/lib.rs`,
    '        if self.frozen {\n            return Some(ItemStatus::Frozen);\n        }\n        None',
    '        None',
    ['market: seller cannot withdraw while listed']],
  ['buyer-minimum', 'the handover refuses if the seat holds less than the buyer was shown', `${ITEM}/seat.rs`,
    '            require!(self.seat_balance >= min.0, "The seat holds less than the buyer was shown");',
    '            let _ = min;',
    ['market: buy aborts and refunds if the seat holds less than shown', 'races: unlist-drain-relist in front of a buy']],
  ['stale-rotation', 'a rotation prepared for an older state is refused', `${ITEM}/seat.rs`,
    '        require!(expect_seq.0 == self.rotation_seq, "This handover was prepared for an older state of the seat");',
    '',
    ['races: stale sequence is refused']],
  ['collection-only', 'only the collection can rotate, freeze or release', `${ITEM}/lib.rs`,
    '            env::predecessor_account_id() == self.collection,',
    '            env::predecessor_account_id() == self.collection || true,',
    ['proofs: an item obeys only its collection']],
  ['curators-void', 'curator grants end with the conductor who made them', `${ITEM}/lib.rs`,
    '        self.curators.get(who).is_some_and(|seq| *seq == self.rotation_seq)',
    '        self.curators.get(who).is_some()',
    ['lifecycle: curators are void after a handover']],
  ['pending-rules', 'queued rule changes are dropped at handover', `${ITEM}/seat.rs`,
    '        self.pending_rules = None;\n        let now',
    '        let now',
    ['lifecycle: pending rules are dropped at handover']],
  ['cut-cap', "the seat's cut is capped at 20%", `${ITEM}/types.rs`,
    'pub const MAX_SEAT_BPS: u16 = 2_000;',
    'pub const MAX_SEAT_BPS: u16 = 10_000;',
    ['lifecycle: cut is capped']],
  ['seat-refund', 'a failed seat withdrawal is credited back to the seat', `${ITEM}/money.rs`,
    '            self.seat_balance += amount.0;\n            self.totals.paid_seat',
    '            self.totals.paid_seat',
    ['races: sale lands between a seat withdrawal and its callback']],
  ['member-refund', 'a failed member payout is credited back to that member', `${ITEM}/money.rs`,
    '            member.balance += amount.0;',
    '',
    ['money: a member payout that fails is credited back to that member', 'races: a member payout that fails during a sale goes back to the member']],
  ['conductor-only', 'only the conductor can take the seat balance', `${ITEM}/money.rs`,
    '        let who = self.assert_conductor();\n        self.roll();\n        let amount = amount.map',
    '        let who = env::predecessor_account_id();\n        self.roll();\n        let amount = amount.map',
    ['money: the conductor can take the seat balance and nothing else', 'lifecycle: old conductor is refused after handover']],
  ['solvency', 'a call must leave the account able to pay for storage and all it owes', `${ITEM}/lib.rs`,
    '            balance >= self.storage_cost() + self.reserved + MARGIN + leaving,',
    '            balance >= leaving,',
    ['money: a call that would leave the account unable to pay for its bytes is refused']],
  ['amplify-once', 'a post can be amplified only once', `${ITEM}/members.rs`,
    '        require!(!self.amplified.contains_key(&key), "That post has already been amplified here");',
    '',
    ['lifecycle: a member amplifies their own post up to the cap']],
  ['parent-only-init', 'only the parent account can initialise an item', `${ITEM}/lib.rs`,
    "            me.as_str().strip_suffix(collection.as_str()).is_some_and(|rest| rest.ends_with('.')),",
    '            true,',
    ['proofs: an item can only be initialised by its parent']],
  ['member-only-amplify', 'only members can be amplified', `${ITEM}/members.rs`,
    '        require!(member.active, "The author is not a member");\n        self.touch(&mut member);\n        if own {',
    '        self.touch(&mut member);\n        if own {',
    ['lifecycle: joining makes the account follow the member, leaving unfollows']],

  ['owner-moves', 'only the conductor can hand over the seat', `${HALL}/lib.rs`,
    '        require!(token.owner == *who, "Only the conductor can hand over the seat");',
    '',
    ['nft: transfer needs one yocto, the real conductor and no approval']],
  ['busy-lock', 'a seat in the middle of a move cannot start another', `${HALL}/lib.rs`,
    '        require!(now >= token.busy_until_ms, "This seat is in the middle of another move. Try again in a moment");',
    '',
    ['races: second transfer while the first is in flight', 'races: two buyers at once, one seat']],
  ['price-check', 'a purchase must cover the listed price', `${HALL}/market.rs`,
    '        require!(deposit >= listing.price.0, "The price is higher than the amount attached");',
    '',
    ['market: price raised in front of buyer refunds']],
  ['buyer-refund', 'a refused handover returns the whole deposit to the buyer', `${HALL}/market.rs`,
    '            Promise::new(buyer).transfer(NearToken::from_yoctonear(deposit.0)).detach();\n            return false;',
    '            return false;',
    ['market: buy aborts and refunds if the seat holds less than shown', 'market: failed rotation refunds the buyer']],
  ['owner-lists', 'only the conductor can list the seat', `${HALL}/market.rs`,
    '        require!(token.owner == seller, "Only the conductor can list the seat");',
    '',
    ['market: listing freezes the seat and records what was sealed']],
  ['sync-forward', 'sync only ever moves the index toward a newer rotation', `${HALL}/lib.rs`,
    '        if info.rotation_seq.0 > token.seq {',
    '        if info.rotation_seq.0 >= token.seq {',
    ['proofs: sync adopts only newer item state']],
  ['one-yocto', 'a transfer needs the one-yocto confirmation', `${HALL}/nft.rs`,
    '        near_sdk::assert_one_yocto();\n        require!(approval_id.is_none(), "Approvals are not supported: only the conductor can hand over the seat");\n        let sender = env::predecessor_account_id();\n        let seq = self.begin_move(&token_id, &sender, &receiver_id);\n        self.rotate(&token_id, &receiver_id, seq, None, false, false)',
    '        require!(approval_id.is_none(), "Approvals are not supported: only the conductor can hand over the seat");\n        let sender = env::predecessor_account_id();\n        let seq = self.begin_move(&token_id, &sender, &receiver_id);\n        self.rotate(&token_id, &receiver_id, seq, None, false, false)',
    ['nft: transfer needs one yocto, the real conductor and no approval']],
  ['held-transfer', 'a transfer-call holds the seat frozen until it resolves', `${HALL}/nft.rs`,
    '        self.rotate(&token_id, &receiver_id, seq, None, true, true).then(',
    '        self.rotate(&token_id, &receiver_id, seq, None, false, true).then(',
    ['nft: transfer_call receiver cannot act before resolve']],
  ['seller-owed', 'sale proceeds that cannot be delivered wait for the seller', `${HALL}/market.rs`,
    '            self.owed.insert(seller, owed);',
    '            let _ = (seller, owed);',
    ['market: unpayable seller does not block the sale']],
];

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const WASM = ['res/choir_item.wasm', 'res/choir_registry.wasm'];
const before = WASM.map(sha);

/** Returns null when both contracts built, or the first lines of what the compiler said. */
function build() {
  let said = '';
  // A compiler that dies for lack of memory is not a verdict on the mutation: try again.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const out = spawnSync(process.execPath, ['scripts/build.mjs'], { encoding: 'utf8' });
    if (out.status === 0) return null;
    said = (out.stdout + out.stderr).split('\n').filter((line) => /error/.test(line)).slice(0, 3).join(' | ') || 'build failed';
    if (/error\[E\d+\]/.test(said)) break; // the compiler refused the code itself
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000);
  }
  return said;
}

function failingTests() {
  const out = spawnSync(process.execPath, ['--test', '--test-reporter=spec', 'tests/'], { encoding: 'utf8' });
  const text = out.stdout + out.stderr;
  return [...new Set([...text.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]))];
}

if (process.argv[2] === '--dry') {
  const tests = readdirSync('tests')
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => readFileSync(`tests/${name}`, 'utf8'))
    .join('\n');
  let bad = 0;
  for (const [id, , file, find, , expects] of MUTATIONS) {
    const times = readFileSync(file, 'utf8').split(find).length - 1;
    const missing = expects.filter((name) => !tests.includes(`test('${name}`) && !tests.includes(`test("${name}`));
    if (times !== 1) console.log(`${id}: the line to break appears ${times} times in ${file}`);
    if (missing.length) console.log(`${id}: no such test: ${missing.join('; ')}`);
    if (times !== 1 || missing.length) bad += 1;
  }
  console.log(`${MUTATIONS.length - bad} of ${MUTATIONS.length} mutations are ready to run.`);
  process.exit(bad ? 1 : 0);
}

const only = process.argv[2];
const results = [];
for (const [id, what, file, find, replace, expects] of MUTATIONS) {
  if (only && !id.includes(only)) continue;
  const original = readFileSync(file, 'utf8');
  if (original.split(find).length !== 2) {
    results.push({ id, what, verdict: 'SKIPPED', note: 'the line to break was not found exactly once' });
    console.log(`${id}: SKIPPED (source line not found exactly once)`);
    continue;
  }
  writeFileSync(file, original.replace(find, replace));
  let verdict;
  let failed = [];
  let note = '';
  try {
    const error = build();
    if (error) {
      // A mutation the compiler refuses is not a test of the tests.
      verdict = 'DID NOT BUILD';
      note = error.slice(0, 200);
    } else {
      failed = failingTests();
      const hit = expects.filter((name) => failed.some((f) => f.startsWith(name)));
      if (expects.length === 0) verdict = failed.length ? 'CAUGHT' : 'NOT CAUGHT';
      else verdict = hit.length === expects.length ? 'CAUGHT' : failed.length ? 'CAUGHT ELSEWHERE' : 'NOT CAUGHT';
      note = `${failed.length} test(s) failed`;
    }
  } finally {
    writeFileSync(file, original);
  }
  results.push({ id, what, verdict, note, failed });
  console.log(`${id}: ${verdict}  (${note})`);
}

console.log('\nRestoring the real build...');
const error = build();
if (error) throw new Error(`the clean rebuild failed: ${error}`);
const after = WASM.map(sha);
const same = before.every((hash, i) => hash === after[i]);
const stillPass = failingTests();

const caught = results.filter((r) => r.verdict === 'CAUGHT').length;
const lines = [
  '# Mutation check',
  '',
  'Each row removes one defence from the contract source, rebuilds the wasm and runs the tests.',
  '"Caught" means the tests named for that defence failed. Produced by `node scripts/mutate.mjs`.',
  '',
  `Run on ${new Date().toISOString().slice(0, 10)}: **${caught} of ${results.length} caught**. After the run the source was restored and rebuilt; ` +
    `res/ is ${same ? 'byte-for-byte what it was before' : 'NOT what it was before'}, and ${stillPass.length === 0 ? 'every test passes again' : `${stillPass.length} test(s) fail`}.`,
  '',
  '| Defence removed | Result | Tests that failed |',
  '| --- | --- | --- |',
  ...results.map((r) => `| ${r.what} (\`${r.id}\`) | ${r.verdict} | ${r.failed?.length ? r.failed.slice(0, 4).map((f) => `\`${f}\``).join(', ') + (r.failed.length > 4 ? ` and ${r.failed.length - 4} more` : '') : r.note} |`),
  '',
];
if (!only) writeFileSync('docs/MUTATIONS.md', lines.join('\n'));
console.log(`\n${caught} of ${results.length} caught. res/ unchanged: ${same}. Tests after restore: ${stillPass.length === 0 ? 'all pass' : stillPass.join('; ')}`);
if (!same || stillPass.length) process.exit(1);
