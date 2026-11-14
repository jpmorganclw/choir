// The conductor's desk: a page only the current holder can open, checked against the chain on
// every request. Runs the real gate over the practice chain.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGate } from '../server/gate.mjs';
import { COLLECTION, createLocal } from '../server/local.mjs';

const ASHA = 'asha.testnet';
const SAM = 'sam.testnet';
const MAYA = 'maya.testnet';
const BUILDERS = `builders.${COLLECTION}`;

function setup() {
  const local = createLocal();
  const notes = new Map();
  const gate = createGate({
    reader: local.reader,
    collection: COLLECTION,
    store: { get: (choir) => notes.get(choir), set: (choir, text) => notes.set(choir, text) },
  });
  const signIn = async (who, choir = BUILDERS) => {
    const { nonce } = gate.challenge();
    return gate.enter({ choir, ...local.signNep413(who, nonce), nonce });
  };
  return { local, gate, signIn, notes };
}

const refusal = (status, pattern) => (error) => error.status === status && pattern.test(error.message);

test('gate: the conductor opens the desk; a member and a stranger cannot', async () => {
  const { gate, signIn } = setup();
  const { session } = await signIn(ASHA);
  const desk = await gate.open(session, BUILDERS);
  assert.equal(desk.conductor, ASHA);
  assert.equal(desk.proof.owner, ASHA);
  assert.equal(desk.proof.status, 'Active');
  await gate.save(session, BUILDERS, 'Venue wants the headcount by Wednesday.');
  assert.equal((await gate.open(session, BUILDERS)).notes, 'Venue wants the headcount by Wednesday.');

  await assert.rejects(signIn(MAYA), refusal(403, /Only the conductor can open this desk/));
  await assert.rejects(gate.open('made-up-session', BUILDERS), refusal(401, /Sign in/));
  await assert.rejects(gate.save(session, BUILDERS, 'x'.repeat(4001)), refusal(400, /up to 4000/));
});

test('gate: a signature cannot be replayed, forged or borrowed', async () => {
  const { local, gate } = setup();
  const { nonce } = gate.challenge();
  const signed = local.signNep413(ASHA, nonce);
  await gate.enter({ choir: BUILDERS, ...signed, nonce });
  await assert.rejects(gate.enter({ choir: BUILDERS, ...signed, nonce }), refusal(401, /expired/), 'a nonce works once');

  // Maya signs with her own key but claims to be Asha.
  const second = gate.challenge();
  const mayas = local.signNep413(MAYA, second.nonce);
  await assert.rejects(gate.enter({ choir: BUILDERS, ...mayas, accountId: ASHA, nonce: second.nonce }), refusal(401, /not on asha/));

  // A signature over a different nonce does not fit this one.
  const third = gate.challenge();
  const other = gate.challenge();
  const wrong = local.signNep413(ASHA, other.nonce);
  await assert.rejects(gate.enter({ choir: BUILDERS, ...wrong, nonce: third.nonce }), refusal(401, /signature does not match/));

  // A nonce the gate never issued.
  const invented = Buffer.alloc(32, 7).toString('base64');
  await assert.rejects(gate.enter({ choir: BUILDERS, ...local.signNep413(ASHA, invented), nonce: invented }), refusal(401, /expired/));
});

test('gate: after a handover the old session opens nothing and the new holder gets in', async () => {
  const { local, gate, signIn } = setup();
  const { session } = await signIn(ASHA);
  await gate.save(session, BUILDERS, 'Handover notes for whoever holds the seat next.');

  const moved = local.call({ persona: ASHA, receiver: COLLECTION, method: 'nft_transfer', args: { receiver_id: SAM, token_id: BUILDERS }, deposit: '1' });
  assert.equal(moved.value, true);

  // The very next request with the old session is refused, because the chain is asked again.
  await assert.rejects(gate.open(session, BUILDERS), refusal(403, /The seat has moved to sam\.testnet/));
  await assert.rejects(gate.save(session, BUILDERS, 'still mine?'), refusal(401, /Sign in/));
  await assert.rejects(signIn(ASHA), refusal(403, /held by sam\.testnet/));

  const next = await signIn(SAM);
  const desk = await gate.open(next.session, BUILDERS);
  assert.equal(desk.conductor, SAM);
  assert.equal(desk.notes, 'Handover notes for whoever holds the seat next.', 'the notes stay with the seat');
});

test('gate: an account that only claims to be a Choir opens no desk', async () => {
  const { local, gate, signIn } = setup();
  const fake = 'builders.evil.testnet';
  local.chain.mock(fake, ({ method }) =>
    method === 'nft_item_info'
      ? { spec: 'sharded-item-1.0.0', init: true, status: 'Active', collection_id: COLLECTION, token_id: fake, owner_id: MAYA, rotation_seq: '0', rotation_epoch: 0 }
      : undefined,
  );
  await assert.rejects(signIn(MAYA, fake), refusal(403, /collection-denies-membership/));
  void gate;
});

test('gate: the practice chain starts with a story to explore', () => {
  const { local } = setup();
  const view = local.view(BUILDERS, 'get_choir');
  assert.equal(view.name, 'NEAR Builders');
  assert.equal(view.members, 2);
  assert.equal(view.round, 1);
  assert.equal(view.totals.rounds_settled, 1);
  assert.equal(local.view(COLLECTION, 'get_listings', {}).length, 1);
  const feed = local.kv.byAccount('social', BUILDERS, { key_prefix: 'repost/' }).entries;
  assert.equal(feed.length, 3);
  assert.equal(BigInt(view.pot), 5_400_000_000_000_000_000_000_000n, 'this round already has a pot');
  assert.ok(BigInt(view.totals.paid_members) > 0n, 'and a member has already been paid');
  assert.equal(local.account(BUILDERS).keys, 0);
});
