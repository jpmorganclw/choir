// The whole product in one run, on the practice chain, with every claim printed next to the
// evidence for it. No network, no wallet, no keys: it runs the compiled contracts from res/.
//
//   npm run story
//
// Each step is "do X, see Y". The script exits with an error if any Y is not what it says.

import assert from 'node:assert/strict';
import { isActiveConductor, pair, provenance } from '../app/src/lib/verify.js';
import { COLLECTION, SOCIAL, createLocal } from '../server/local.mjs';
import { near, toNear } from '../tools/localnet/chain.mjs';

const local = createLocal();
const chain = local.chain;
const [ASHA, MAYA, LEO, FAN, SAM] = ['asha', 'maya', 'leo', 'fan', 'sam'].map((n) => `${n}.testnet`);
const DAY = 86_400_000;

let step = 0;
const say = (title) => console.log(`\n${String(++step).padStart(2, ' ')}. ${title}`);
const see = (text) => console.log(`    -> ${text}`);
const call = (persona, receiver, method, args = {}, deposit = 0n) => local.call({ persona, receiver, method, args, deposit: deposit.toString() });
const rows = (account, prefix) => Object.fromEntries(local.kv.byAccount(SOCIAL, account, { key_prefix: prefix }).entries.map((r) => [r.key, r.value]));
const N = (yocto) => `${toNear(yocto)} NEAR`;

console.log('Choir, start to finish, on the practice chain');
console.log('=============================================');

say('Asha starts a Choir called "Demo Day" with 10% for the seat and one-day rounds.');
const created = call(ASHA, COLLECTION, 'create_choir', {
  slug: 'demo-day',
  name: 'Demo Day',
  about: 'Show what you built this month.',
  rules: { open: true, dues: '0', self_cap: 2, round_ms: DAY, seat_bps: 1000 },
}, near(0.5));
const id = created.value;
assert.equal(id, `demo-day.${COLLECTION}`);
see(`a new NEAR account exists: ${id}`);
assert.equal(local.account(id).keys, 0);
see('it has 0 access keys, so nobody can sign as it');
assert.equal(local.account(id).codeHash, local.view(COLLECTION, 'get_config').item_code);
see('it runs the shared Choir code, referenced by hash');
assert.equal(local.view(COLLECTION, 'nft_token', { token_id: id }).owner_id, ASHA);
see(`the collection's NEP-171 token ${id} is owned by ${ASHA}`);
const profile = rows(id, 'profile/');
assert.equal(profile['profile/name'], 'Demo Day');
see(`the account wrote its own near.social profile: "${profile['profile/name']}"`);

say('Maya and Leo join.');
for (const who of [MAYA, LEO]) assert.ok(call(who, id, 'join', {}, near(0.01)).ok);
const follows = rows(id, 'graph/follow/');
assert.deepEqual(Object.keys(follows).sort(), [`graph/follow/${LEO}`, `graph/follow/${MAYA}`]);
see('the account now follows both of them on near.social: the member list is its follow list');

say('Maya posts from her own account, then asks the Choir to amplify it.');
const postId = String(Math.floor(local.state().nowMs) + 500);
call(MAYA, SOCIAL, '__fastdata_kv', { [`post/${postId}`]: { text: 'My contract passed 61 tests today.' } });
assert.ok(call(MAYA, id, 'amplify_own', { post_id: postId }, near(0.005)).ok);
assert.deepEqual(rows(id, 'repost/'), { [`repost/${MAYA}/${postId}`]: {} });
see(`the account reposted ${MAYA}/${postId}. The author of the post is still Maya`);
assert.equal(local.view(id, 'get_member', { account: MAYA }).points, 1);
see('Maya has 1 point in this round');

say('Nobody can make the account say something of their own.');
for (const method of ['announce', 'post', 'speak']) assert.match(call(ASHA, id, method, { text: 'buy my token' }).error, /MethodNotFound/);
see('there is no method that takes text and posts it, not even for the conductor');

say('Fan tips 10 NEAR.');
assert.ok(call(FAN, id, 'tip', { memo: 'great demos' }, near(10.005)).ok);
let view = local.view(id, 'get_choir');
assert.equal(BigInt(view.pot), near(9));
assert.equal(BigInt(view.seat_balance), near(1));
see(`split on arrival: ${N(view.pot)} to the members' pot, ${N(view.seat_balance)} to the seat`);

say('Asha tries to take the pot.');
assert.match(call(ASHA, id, 'withdraw_seat', { amount: near(5).toString() }).error, /does not hold that much/);
see('refused: the conductor can only take the seat balance');

say('A day passes. Anyone closes the round.');
local.skip(DAY);
assert.ok(call(LEO, id, 'settle').ok);
const receipt = Object.values(rows(id, 'post/')).map((p) => p.text).find((text) => /Round 1 is settled/.test(text));
assert.ok(receipt);
see(`the account posted its own receipt: "${receipt.split('\n')[0]}"`);

say('Maya claims.');
const before = chain.balance(MAYA);
assert.ok(call(MAYA, id, 'claim').ok);
assert.equal(chain.balance(MAYA) - before, near(9) - near(0.001));
see(`Maya received ${N(chain.balance(MAYA) - before)} (0.001 NEAR stays behind to pay for the record)`);

say('Asha lists the seat for 20 NEAR. The seat freezes.');
assert.ok(call(ASHA, COLLECTION, 'list', { token_id: id, price: near(20).toString() }, 1n).ok);
assert.equal(local.view(id, 'nft_item_info').status, 'Frozen');
assert.match(call(ASHA, id, 'withdraw_seat', {}).error, /The seat is Frozen/);
see('while listed, the seller cannot withdraw the seat balance or change anything');

say('Sam buys it, stating what he was shown: rotation 0 and 1 NEAR on the seat.');
const sellerBefore = chain.balance(ASHA);
const sold = call(SAM, COLLECTION, 'buy', { token_id: id, expect_seq: '0', min_seat_balance: near(1).toString() }, near(20));
assert.equal(sold.value, true);
assert.equal(chain.balance(ASHA) - sellerBefore, near(20));
see('Asha was paid 20 NEAR, after the account had changed hands');
const info = local.view(id, 'nft_item_info');
assert.deepEqual([info.owner_id, info.rotation_seq, info.status], [SAM, '1', 'Active']);
see(`the account itself now says: owner ${info.owner_id}, rotation ${info.rotation_seq}, ${info.status}`);
const handover = Object.values(rows(id, 'post/')).map((p) => p.text).find((text) => /seat has passed/.test(text));
assert.ok(handover);
see(`the account announced it: "${handover.split('\n')[0]}"`);

say('Asha tries to use the seat she sold.');
assert.match(call(ASHA, id, 'withdraw_seat', {}).error, /Only the conductor/);
assert.match(call(ASHA, id, 'set_curator', { account: ASHA, on: true }).error, /Only the conductor/);
see('refused: she is not the owner on the account any more');
const samBefore = chain.balance(SAM);
assert.ok(call(SAM, id, 'withdraw_seat', {}).ok);
see(`Sam withdrew the ${N(chain.balance(SAM) - samBefore)} that came with the seat`);

say('A consumer checks the pair: the account and the collection, at one block.');
const checked = await pair(local.reader, COLLECTION, id);
assert.ok(checked.ok);
see(`both name ${checked.owner}; status ${checked.status}; rotation ${checked.seq}`);
assert.equal((await isActiveConductor(local.reader, COLLECTION, id, ASHA)).holds, false);
see('so the app treats Sam, and only Sam, as the conductor');
const sealed = await provenance(local.reader, COLLECTION);
assert.ok(sealed.ok);
see(`the collection has ${sealed.keys} access keys and config_epoch ${sealed.configEpoch}: only its code can mint or move a seat`);

view = local.view(id, 'get_choir');
const acct = chain.get(id);
let bytes = 100;
for (const [k, v] of acct.storage) bytes += k.length / 2 + v.length + 40;
assert.ok(acct.balance >= BigInt(bytes) * 10n ** 19n + BigInt(view.reserved));
say('The books balance.');
see(`received ${N(view.totals.received)}, paid to members ${N(view.totals.paid_members)}, paid to the seat ${N(view.totals.paid_seat)}`);
see(`the account holds ${N(acct.balance)}: enough for its ${bytes} bytes of storage plus the ${N(view.reserved)} it still owes`);

console.log(`\nAll ${step} steps did what they said.`);
