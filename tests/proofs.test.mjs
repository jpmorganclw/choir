// Proofs: what a consumer can check before trusting that an account is a Choir and who holds it.
// These run the same verifier the app and the gate server use (app/src/lib/verify.js).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isActiveConductor, namespace, pair, pairOnce, provenance } from '../app/src/lib/verify.js';
import { ASHA, HALL, ITEM_WASM, LEO, MALLORY, ONE_YOCTO, SAM, create, info, near, rules, setup, token } from './harness.mjs';

/** The verifier's reader over the local chain. Every read is of the chain as it stands now. */
const reader = (chain) => ({
  finalBlock: async () => ({ height: Number(chain.height) }),
  view: async (account, method, args) => chain.view(account, method, args),
  keys: async (account) => chain.keys(account),
});
const noSleep = { sleep: async () => {} };

function itemAnswer(overrides = {}) {
  return {
    spec: 'sharded-item-1.0.0', init: true, status: 'Active', collection_id: HALL,
    token_id: `builders.${HALL}`, owner_id: MALLORY, rotation_seq: '0', rotation_epoch: 0, ...overrides,
  };
}

test('proofs: a choir has no access keys and its code hash is the published one', () => {
  const { chain, itemCode } = setup();
  const id = create(chain);
  assert.equal(chain.keys(id), 0);
  assert.equal(chain.get(id).codeHash, itemCode);
  assert.equal(chain.view(HALL, 'get_config').item_code, itemCode);
  // With no key, nobody can sign as the account. Only its contract can act for it.
  assert.throws(() => chain.call(id, id, 'withdraw_seat', {}), /has no access keys/);
  assert.throws(() => chain.send(id, MALLORY, near(0.1)), /has no access keys/);
});

test('proofs: collection reports config_epoch and has no keys after lock', async () => {
  const { chain } = setup();
  assert.equal(chain.view(HALL, 'config_epoch'), 0);
  const proof = await provenance(reader(chain), HALL);
  assert.deepEqual({ ok: proof.ok, keys: proof.keys, configEpoch: proof.configEpoch, sealed: proof.sealed }, { ok: true, keys: 0, configEpoch: 0, sealed: true });
  assert.throws(() => chain.call(HALL, HALL, 'new', { item_code: '11111111111111111111111111111111', social: 'social', site: '' }), /has no access keys/);
  // A collection that still held a key would fail the same check.
  chain.get(HALL).keys = 1;
  assert.equal((await provenance(reader(chain), HALL)).ok, false);
});

test('proofs: the pair check accepts a real Choir and names its holder', async () => {
  const { chain } = setup();
  const id = create(chain);
  assert.deepEqual(namespace(id, HALL), { ok: true, parent: HALL, label: 'builders' });
  const result = await pair(reader(chain), HALL, id, noSleep);
  assert.equal(result.ok, true);
  assert.equal(result.owner, ASHA);
  assert.equal(result.status, 'Active');
  assert.equal(result.seq, '0');
  assert.equal((await isActiveConductor(reader(chain), HALL, id, ASHA)).holds, true);
  assert.equal((await isActiveConductor(reader(chain), HALL, id, MALLORY)).holds, false);

  chain.call(ASHA, HALL, 'list', { token_id: id, price: '1' }, { deposit: ONE_YOCTO });
  const listed = await isActiveConductor(reader(chain), HALL, id, ASHA);
  assert.equal(listed.holds, true);
  assert.equal(listed.active, false, 'authentic and owned, but the seat would refuse a request');
});

test('proofs: forgery outside the namespace is refused', async () => {
  const { chain } = setup();
  const id = create(chain);
  // A contract anywhere can claim to be an item of this collection.
  const fake = 'builders.evil.testnet';
  chain.mock(fake, ({ method }) => (method === 'nft_item_info' ? itemAnswer({ token_id: fake }) : undefined));
  assert.equal(namespace(fake, HALL).ok, false);
  const result = await pair(reader(chain), HALL, fake, noSleep);
  assert.deepEqual([result.ok, result.reason], [false, 'collection-denies-membership']);

  // One that answers for a real token id is caught by the identity clause.
  const imposter = 'imposter.testnet';
  chain.mock(imposter, ({ method }) => (method === 'nft_item_info' ? itemAnswer({ token_id: id }) : undefined));
  assert.equal((await pair(reader(chain), HALL, imposter, noSleep)).reason, 'answers-for-another-token');

  // An attacker who supplies both halves is caught only because the collection is pinned.
  const theirHall = 'their-hall.testnet';
  const theirItem = `builders.${theirHall}`;
  chain.mock(theirHall, ({ method }) => (method === 'nft_token' ? { token_id: theirItem, owner_id: MALLORY } : undefined));
  chain.mock(theirItem, ({ method }) => (method === 'nft_item_info' ? itemAnswer({ token_id: theirItem, collection_id: theirHall }) : undefined));
  assert.equal((await pair(reader(chain), HALL, theirItem, noSleep)).reason, 'names-another-collection');
  assert.equal((await pair(reader(chain), theirHall, theirItem, noSleep)).ok, true, 'which is why the collection must never be read from the item');

  for (const [answer, reason] of [
    [itemAnswer({ spec: 'sharded-item-9.9.9' }), 'unknown-spec'],
    [itemAnswer({ init: false, token_id: 'parked.testnet' }), 'not-initialised'],
  ]) {
    const at = answer.init ? 'odd.testnet' : 'parked.testnet';
    chain.mock(at, ({ method }) => (method === 'nft_item_info' ? { ...answer, token_id: answer.init ? id : at } : undefined));
    const got = await pair(reader(chain), HALL, at, noSleep);
    assert.equal(got.reason, reason);
  }
  assert.equal((await pair(reader(chain), HALL, 'no-such-account.testnet', noSleep)).reason, 'item-unreadable');
});

test('proofs: forgery cannot be minted under the parent', () => {
  const { chain } = setup();
  const fake = `treasury.${HALL}`;
  const attempt = chain.createAccount(MALLORY, fake, near(1));
  assert.equal(attempt.ok, false);
  assert.match(attempt.error, /can only be created by its parent/);
  assert.equal(chain.exists(fake), false);
  // The parent could, but it has no key, so the only way is through its own mint.
  assert.throws(() => chain.createAccount(HALL, fake, near(1)), /has no access keys/);
});

test('proofs: an item can only be initialised by its parent, and never as its own collection', () => {
  const { chain } = setup();
  // The same published code, put on an account the collection did not create.
  const rogue = 'rogue.testnet';
  chain.deploy(rogue, ITEM_WASM);
  const args = { args: { owner: MALLORY, name: 'Rogue', about: '', rules: rules(), social: 'social', site: '' } };
  assert.match(chain.call(MALLORY, rogue, 'init', args).error, /Only the parent account can initialise an item/);
  assert.match(chain.call(rogue, rogue, 'init', args).error, /An item cannot be its own collection/);
  // Its real parent can initialise it. Then it names that parent as its collection, never this
  // one, so naming a collection can never be claimed, only earned by being created by it.
  chain.account('testnet', near(10));
  assert.ok(chain.call('testnet', rogue, 'init', args).ok);
  assert.equal(info(chain, rogue).collection_id, 'testnet');
  assert.equal(token(chain, rogue), null);
});

test('proofs: an item obeys only its collection', () => {
  const { chain } = setup();
  const id = create(chain);
  for (const [method, args] of [
    ['rotate', { new_owner: MALLORY, expect_seq: '0' }],
    ['freeze', { expect_seq: '0' }],
    ['unfreeze', { expect_seq: '0' }],
  ]) {
    assert.match(chain.call(MALLORY, id, method, args).error, /Only the collection/, method);
    assert.match(chain.call(ASHA, id, method, args).error, /Only the collection/, `${method} by the conductor`);
  }
  assert.match(chain.call(MALLORY, id, 'on_paid', { to: MALLORY, amount: '1', seat: true }).error, /private/i);
  assert.match(
    chain.call(MALLORY, id, 'init', { args: { owner: MALLORY, name: 'x', about: '', rules: rules(), social: 'social', site: '' } }).error,
    /already been initialized|already initialized/i,
  );
  assert.equal(info(chain, id).owner_id, ASHA);
});

test('races: stale sequence is refused', () => {
  const { chain } = setup();
  const id = create(chain);
  // Speak as the collection directly. Possible only in this local chain, by handing it a key.
  chain.get(HALL).keys = 1;
  const rotate = (args) => chain.call(HALL, id, 'rotate', args);
  assert.match(rotate({ new_owner: SAM, expect_seq: '3' }).error, /older state of the seat/);
  assert.match(rotate({ new_owner: ASHA, expect_seq: '0' }).error, /already holds the seat/);
  assert.match(rotate({ new_owner: SAM, expect_seq: '0', min_seat_balance: '1' }).error, /holds less than the buyer was shown/);
  assert.equal(rotate({ new_owner: SAM, expect_seq: '0' }).value, '1');
  assert.match(rotate({ new_owner: LEO, expect_seq: '0' }).error, /older state of the seat/, 'the same request cannot land twice');
  assert.match(chain.call(HALL, id, 'freeze', { expect_seq: '0' }).error, /older state of the seat/);
});

test('proofs: pair check refuses when halves disagree', async () => {
  const { chain } = setup();
  const id = create(chain);
  chain.submit(ASHA, HALL, 'nft_transfer', { receiver_id: SAM, token_id: id }, { deposit: ONE_YOCTO });
  chain.stepOn('nft_transfer');
  chain.stepOn('rotate');
  // The account has moved; the index answers in a later receipt.
  assert.equal(info(chain, id).owner_id, SAM);
  assert.equal(token(chain, id).owner_id, ASHA);
  const during = await pairOnce(reader(chain), HALL, id);
  assert.deepEqual([during.ok, during.reason, during.retryable], [false, 'index-catching-up', true]);
  // Neither side is believed alone: nobody is treated as the conductor until they agree.
  assert.equal((await isActiveConductor(reader(chain), HALL, id, SAM, noSleep)).holds, false);

  // A bounded retry sees it converge once the callback has run.
  let waited = 0;
  const converged = await pair(reader(chain), HALL, id, {
    sleep: async () => {
      waited += 1;
      chain.drain();
    },
  });
  assert.equal(converged.ok, true);
  assert.equal(converged.owner, SAM);
  assert.equal(waited, 1);
});

test('proofs: the direction of a disagreement decides between retry and refusal', async () => {
  const { chain } = setup();
  const hall = 'mock-hall.testnet';
  const item = `seat.${hall}`;
  const state = { itemSeq: '3', indexSeq: '3', itemOwner: ASHA, indexOwner: MALLORY };
  chain.mock(hall, ({ method }) => {
    if (method === 'nft_token') return { token_id: item, owner_id: state.indexOwner };
    if (method === 'nft_rotation') return { rotation_seq: state.indexSeq, rotation_epoch: 0, locked: false, listed: false };
    return undefined;
  });
  chain.mock(item, ({ method }) =>
    method === 'nft_item_info' ? itemAnswer({ token_id: item, collection_id: hall, owner_id: state.itemOwner, rotation_seq: state.itemSeq }) : undefined,
  );
  const check = () => pair(reader(chain), hall, item, noSleep);

  // Same rotation, different owners: corruption. Refuse without retrying.
  assert.equal((await check()).reason, 'owners-differ-at-the-same-rotation');
  // The index claims a rotation the account never made: refuse.
  Object.assign(state, { indexSeq: '5' });
  assert.equal((await check()).reason, 'index-claims-a-rotation-the-account-never-made');
  // The account is ahead and the index never catches up: retried, then refused once the bound elapses.
  Object.assign(state, { indexSeq: '2' });
  assert.equal((await check()).reason, 'index-catching-up-and-did-not-converge');
  // Agreement.
  Object.assign(state, { indexSeq: '3', indexOwner: ASHA });
  assert.equal((await check()).ok, true);
});

test('proofs: sync adopts only newer item state', () => {
  const { chain } = setup();
  const id = create(chain);
  // In step: nothing to do.
  assert.equal(chain.call(LEO, HALL, 'sync', { token_id: id }).value, false);
  // Move the account ahead of the index (speaking as the collection, as in the test above).
  chain.get(HALL).keys = 1;
  chain.call(HALL, id, 'rotate', { new_owner: SAM, expect_seq: '0' });
  chain.get(HALL).keys = 0;
  assert.equal(token(chain, id).owner_id, ASHA);
  const synced = chain.call(MALLORY, HALL, 'sync', { token_id: id });
  assert.equal(synced.value, true);
  assert.equal(token(chain, id).owner_id, SAM);
  assert.deepEqual(synced.events[0].data[0], { old_owner_id: ASHA, new_owner_id: SAM, token_ids: [id], memo: 'sync' });
  assert.match(chain.call(LEO, HALL, 'sync', { token_id: `nope.${HALL}` }).error, /No such Choir/);
});
