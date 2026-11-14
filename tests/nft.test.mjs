// The collection as a NEP-171 contract: core, metadata, enumeration, events and transfer-call.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASHA, FAN, HALL, LEO, MAYA, ONE_YOCTO, PAYOUT_FEE, SAM, SITE,
  choir, create, info, join, near, setup, social, tip, token,
} from './harness.mjs';

const VAULT = 'vault.testnet';
const transferCall = (chain, id, from, to, msg = '') =>
  chain.call(from, HALL, 'nft_transfer_call', { receiver_id: to, token_id: id, msg }, { deposit: ONE_YOCTO });

test('nft: metadata follows NEP-177', () => {
  const { chain } = setup();
  const id = create(chain);
  const meta = chain.view(HALL, 'nft_metadata');
  assert.equal(meta.spec, 'nft-1.0.0');
  assert.equal(meta.name, 'Choir');
  assert.equal(meta.symbol, 'CHOIR');
  assert.match(meta.icon, /^data:image\/svg\+xml/);

  const t = token(chain, id);
  assert.equal(t.token_id, id);
  assert.equal(t.owner_id, ASHA);
  assert.equal(t.metadata.title, 'NEAR Builders');
  assert.match(t.metadata.description, /Whoever holds this token is its conductor/);
  assert.match(t.metadata.media, /^data:image\/svg\+xml/);
  assert.equal(t.metadata.reference, `${SITE}#/c/${id}`);
  assert.equal(t.metadata.copies, 1);
  assert.equal(token(chain, `nobody.${HALL}`), null);
});

test('nft: minting emits nft_mint and refuses bad names and thin deposits', () => {
  const { chain } = setup();
  const minted = chain.call(ASHA, HALL, 'create_choir', {
    slug: 'builders', name: 'NEAR Builders', about: '', rules: { open: true, dues: '0', self_cap: 1, round_ms: 60_000, seat_bps: 0 },
  }, { deposit: near(0.27) });
  assert.equal(minted.value, `builders.${HALL}`);
  assert.deepEqual(minted.events[0], {
    standard: 'nep171', version: '1.0.0', event: 'nft_mint',
    data: [{ owner_id: ASHA, token_ids: [`builders.${HALL}`] }],
  });

  const again = () => create(chain, { slug: 'builders' });
  assert.throws(again, /That name is taken/);
  for (const slug of ['a', 'Builders', 'has.dot', '-edge', 'edge-', 'two--hyphens', 'x'.repeat(33)]) {
    assert.throws(() => create(chain, { slug }), /2 to 32 characters/, slug);
  }
  assert.throws(() => create(chain, { slug: 'cheap', deposit: near(0.2) }), /at least 0.27 NEAR/);

  // A creation the item refuses returns the whole deposit and leaves nothing behind.
  const before = chain.balance(SAM);
  const refused = chain.call(SAM, HALL, 'create_choir', {
    slug: 'greedy', name: 'Greedy', about: '', rules: { open: true, dues: '0', self_cap: 1, round_ms: 60_000, seat_bps: 9000 },
  }, { deposit: near(1) });
  assert.equal(refused.value, null);
  assert.equal(chain.balance(SAM), before);
  assert.equal(chain.exists(`greedy.${HALL}`), false);
  assert.equal(chain.view(HALL, 'nft_total_supply'), '1');
});

test('nft: enumeration follows NEP-181 through transfers', () => {
  const { chain } = setup();
  const a = create(chain, { slug: 'alpha' });
  const b = create(chain, { slug: 'beta' });
  const c = create(chain, { slug: 'gamma' });
  const d = create(chain, { slug: 'delta', by: SAM });
  const ids = (list) => list.map((t) => t.token_id);
  const owned = (who) => ids(chain.view(HALL, 'nft_tokens_for_owner', { account_id: who }));

  assert.equal(chain.view(HALL, 'nft_total_supply'), '4');
  assert.deepEqual(ids(chain.view(HALL, 'nft_tokens', {})), [a, b, c, d]);
  assert.deepEqual(ids(chain.view(HALL, 'nft_tokens', { from_index: '1', limit: 2 })), [b, c]);
  assert.equal(chain.view(HALL, 'nft_supply_for_owner', { account_id: ASHA }), '3');
  assert.deepEqual(owned(ASHA), [a, b, c]);
  assert.deepEqual(owned(LEO), []);

  // Moving the first of three exercises the swap in the owner list.
  assert.ok(chain.call(ASHA, HALL, 'nft_transfer', { receiver_id: SAM, token_id: a, memo: 'yours now' }, { deposit: ONE_YOCTO }).ok);
  assert.deepEqual(owned(ASHA), [c, b]);
  assert.deepEqual(owned(SAM), [d, a]);
  assert.ok(chain.call(ASHA, HALL, 'nft_transfer', { receiver_id: SAM, token_id: b }, { deposit: ONE_YOCTO }).ok);
  assert.ok(chain.call(ASHA, HALL, 'nft_transfer', { receiver_id: LEO, token_id: c }, { deposit: ONE_YOCTO }).ok);
  assert.deepEqual(owned(ASHA), []);
  assert.deepEqual(owned(SAM), [d, a, b]);
  assert.deepEqual(owned(LEO), [c]);
  assert.equal(chain.view(HALL, 'nft_supply_for_owner', { account_id: ASHA }), '0');
  assert.deepEqual(ids(chain.view(HALL, 'nft_tokens_for_owner', { account_id: SAM, from_index: '1', limit: 1 })), [a]);
  for (const id of [a, b, c, d]) assert.equal(token(chain, id).owner_id, info(chain, id).owner_id);
});

test('nft: transfer needs one yocto, the real conductor and no approval', () => {
  const { chain } = setup();
  const id = create(chain);
  const args = { receiver_id: SAM, token_id: id };
  assert.match(chain.call(ASHA, HALL, 'nft_transfer', args).error, /exactly 1 yoctoNEAR/);
  assert.match(chain.call(LEO, HALL, 'nft_transfer', args, { deposit: ONE_YOCTO }).error, /Only the conductor can hand over/);
  assert.match(chain.call(ASHA, HALL, 'nft_transfer', { ...args, approval_id: 1 }, { deposit: ONE_YOCTO }).error, /Approvals are not supported/);
  assert.match(chain.call(ASHA, HALL, 'nft_transfer', { ...args, receiver_id: ASHA }, { deposit: ONE_YOCTO }).error, /already holds the seat/);
  assert.match(chain.call(ASHA, HALL, 'nft_transfer', { ...args, token_id: `nope.${HALL}` }, { deposit: ONE_YOCTO }).error, /No such Choir/);
  const moved = chain.call(ASHA, HALL, 'nft_transfer', { ...args, memo: 'good luck' }, { deposit: ONE_YOCTO });
  assert.equal(moved.value, true);
  assert.equal(moved.events[0].data[0].memo, 'good luck');
});

/** A contract that receives the token and answers `nft_on_transfer` with `answer`. */
function receiver(chain, answer) {
  const seen = {};
  chain.mock(VAULT, ({ method, args, chain: c }) => {
    if (method !== 'nft_on_transfer') return undefined;
    seen.args = args;
    seen.during = c.view(args.token_id, 'nft_item_info');
    if (answer === 'panic') throw new (Object.getPrototypeOf(chainPanic(c)).constructor)('receiver exploded');
    return answer;
  }, { balance: near(10) });
  return seen;
}
// The mock needs the chain's own Panic class to fail the receipt the way a contract panic does.
function chainPanic(chain) {
  try {
    chain.view('no-such-account.testnet', 'x');
  } catch (error) {
    return error;
  }
  return new Error('unreachable');
}

test('nft: transfer_call receiver cannot act before resolve, and keeps the seat if it says so', () => {
  const { chain } = setup();
  const id = create(chain);
  tip(chain, id, FAN, 10);
  const seen = receiver(chain, false);

  const tx = chain.submit(ASHA, HALL, 'nft_transfer_call', { receiver_id: VAULT, token_id: id, msg: 'escrow' }, { deposit: ONE_YOCTO });
  for (const label of ['nft_transfer_call', 'rotate', 'on_held']) chain.stepOn(label);
  // The account already names the receiver as owner, but holds the seat frozen.
  assert.equal(info(chain, id).owner_id, VAULT);
  assert.equal(info(chain, id).status, 'Frozen');
  const grab = chain.submit(VAULT, id, 'withdraw_seat', {});
  chain.stepOn('withdraw_seat');
  assert.match(chain.summary(grab).error, /The seat is Frozen/);

  chain.drain();
  assert.equal(chain.summary(tx).value, true);
  assert.deepEqual(seen.args, { sender_id: ASHA, previous_owner_id: ASHA, token_id: id, msg: 'escrow' });
  assert.equal(seen.during.status, 'Frozen');
  assert.equal(info(chain, id).owner_id, VAULT);
  assert.equal(info(chain, id).status, 'Active');
  assert.equal(info(chain, id).rotation_seq, '1');
  assert.equal(token(chain, id).owner_id, VAULT);
  assert.equal(chain.view(HALL, 'nft_rotation', { token_id: id }).locked, false);
  const posts = Object.values(social(chain, id, 'post/')).map((p) => p.text);
  assert.equal(posts.filter((text) => text.includes(`from @${ASHA} to @${VAULT}`)).length, 1);
  // Only now can the receiver use the seat.
  const before = chain.balance(VAULT);
  assert.ok(chain.call(VAULT, id, 'withdraw_seat', {}).ok);
  assert.equal(chain.balance(VAULT) - before, near(1) - PAYOUT_FEE);
});

for (const [why, answer] of [['asks to return it', true], ['panics', 'panic']]) {
  test(`nft: returned token restores the previous owner when the receiver ${why}`, () => {
    const { chain } = setup();
    const id = create(chain);
    tip(chain, id, FAN, 10);
    receiver(chain, answer);
    const result = transferCall(chain, id, ASHA, VAULT);
    assert.equal(result.value, false, 'the standard reports that the receiver did not keep the token');
    assert.equal(info(chain, id).owner_id, ASHA);
    assert.equal(info(chain, id).status, 'Active');
    assert.equal(info(chain, id).rotation_seq, '2', 'out and back are two rotations');
    assert.equal(token(chain, id).owner_id, ASHA);
    assert.deepEqual(result.events.map((e) => [e.data[0].old_owner_id, e.data[0].new_owner_id]), [[ASHA, VAULT], [VAULT, ASHA]]);
    assert.equal(BigInt(choir(chain, id).seat_balance), near(1), 'the seat came back with what it held');
    assert.equal(Object.keys(social(chain, id, 'post/')).length, 0, 'a bounced transfer is not announced');
    assert.ok(chain.call(ASHA, id, 'withdraw_seat', {}).ok);
  });
}

test('nft: a transfer_call to an account with no contract comes straight back', () => {
  const { chain } = setup();
  const id = create(chain);
  const result = transferCall(chain, id, ASHA, MAYA);
  assert.equal(result.value, false);
  assert.equal(token(chain, id).owner_id, ASHA);
  assert.equal(info(chain, id).owner_id, ASHA);
  assert.match(transferCall(chain, id, LEO, MAYA).error, /Only the conductor can hand over/);
  join(chain, id, MAYA);
});
