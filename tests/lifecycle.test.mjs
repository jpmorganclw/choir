// The life of a Choir: members, amplification, rounds, and what a handover does to the seat.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASHA, DAY_MS, FAN, HALL, ITEM_WASM, LEO, MALLORY, MAYA, NOOR, ONE_YOCTO, PAYOUT_FEE, SAM,
  admit, amplify, amplifyOwn, assertSolvent, choir, create, info, join, member, near, post, rules, setup, social, tip, token, wait,
} from './harness.mjs';

const transfer = (chain, id, from, to) =>
  chain.call(from, HALL, 'nft_transfer', { receiver_id: to, token_id: id }, { deposit: ONE_YOCTO });

test('lifecycle: joining makes the account follow the member, leaving unfollows', () => {
  const { chain } = setup();
  const id = create(chain);
  join(chain, id, MAYA);
  assert.deepEqual(social(chain, id, 'graph/follow/'), { [`graph/follow/${MAYA}`]: {} });
  assert.equal(choir(chain, id).members, 1);
  assert.equal(member(chain, id, MAYA).active, true);

  const again = chain.call(MAYA, id, 'join', {}, { deposit: near(0.01) });
  assert.match(again.error, /Already a member/);

  assert.ok(chain.call(MAYA, id, 'leave').ok);
  assert.equal(social(chain, id, 'graph/follow/')[`graph/follow/${MAYA}`], null);
  assert.equal(choir(chain, id).members, 0);
  assert.equal(member(chain, id, MAYA).active, false);
  // Someone who has left is not amplified, by themselves or by the conductor.
  assert.match(amplifyOwn(chain, id, MAYA, post(chain, MAYA)).error, /not a member/);
  assert.match(amplify(chain, id, ASHA, MAYA, post(chain, MAYA)).error, /not a member/);
});

test('lifecycle: an invitation-only Choir refuses join but the conductor can admit', () => {
  const { chain } = setup();
  const id = create(chain, { open: false });
  const refused = chain.call(MAYA, id, 'join', {}, { deposit: near(0.01) });
  assert.match(refused.error, /by invitation/);
  assert.match(admit(chain, id, MALLORY, MALLORY).error, /Only the conductor or a curator/);
  assert.ok(admit(chain, id, ASHA, MAYA).ok);
  assert.equal(member(chain, id, MAYA).active, true);
});

test('lifecycle: dues are split like a tip', () => {
  const { chain } = setup();
  const id = create(chain, { dues: near(2).toString() });
  assert.match(chain.call(MAYA, id, 'join', {}, { deposit: near(1) }).error, /Attach the dues/);
  join(chain, id, MAYA, near(2.01));
  const view = choir(chain, id);
  assert.equal(BigInt(view.pot), near(1.8));
  assert.equal(BigInt(view.seat_balance), near(0.2));
  assertSolvent(chain, id, assert);
});

test('lifecycle: a member amplifies their own post up to the cap, and the account reposts it', () => {
  const { chain } = setup();
  const id = create(chain); // self_cap 2
  join(chain, id, MAYA);
  const first = post(chain, MAYA, 'I shipped a contract today');
  const second = post(chain, MAYA, 'and wrote the tests');
  const third = post(chain, MAYA, 'and the docs');

  assert.ok(amplifyOwn(chain, id, MAYA, first).ok);
  assert.deepEqual(social(chain, id, 'repost/'), { [`repost/${MAYA}/${first}`]: {} });
  assert.equal(member(chain, id, MAYA).points, 1);
  assert.equal(chain.view(id, 'amplified', { author: MAYA, post_id: first }), true);

  assert.match(amplifyOwn(chain, id, MAYA, first).error, /already been amplified/);
  assert.ok(amplifyOwn(chain, id, MAYA, second).ok);
  assert.match(amplifyOwn(chain, id, MAYA, third).error, /used your own amplifications/);

  // A stranger cannot be amplified, and a stranger cannot amplify.
  const strangers = post(chain, MALLORY, 'buy my token');
  assert.match(amplifyOwn(chain, id, MALLORY, strangers).error, /not a member/);
  assert.match(amplify(chain, id, MALLORY, MAYA, third).error, /Only the conductor or a curator/);
  assert.match(amplify(chain, id, ASHA, MALLORY, strangers).error, /not a member/);
  assert.match(amplifyOwn(chain, id, MAYA, '007').error, /not a near.social post id/);

  // The conductor is not bound by the member's cap.
  assert.ok(amplify(chain, id, ASHA, MAYA, third).ok);
  assert.equal(choir(chain, id).points, 3);
  assert.equal(choir(chain, id).contributors, 1);
});

test('lifecycle: a round settles, the account posts its own receipt, and members claim their share', () => {
  const { chain } = setup();
  const id = create(chain);
  for (const who of [MAYA, LEO, NOOR]) join(chain, id, who);
  // Maya is amplified twice, Leo once, Noor not at all.
  amplifyOwn(chain, id, MAYA, post(chain, MAYA));
  amplifyOwn(chain, id, MAYA, post(chain, MAYA));
  amplifyOwn(chain, id, LEO, post(chain, LEO));

  assert.ok(tip(chain, id, FAN, 10, 'for the builders').ok);
  let view = choir(chain, id);
  assert.equal(BigInt(view.pot), near(9));
  assert.equal(BigInt(view.seat_balance), near(1));
  assert.match(chain.call(MAYA, id, 'claim').error, /Nothing to claim yet/);

  wait(chain, 7 * DAY_MS);
  assert.equal(choir(chain, id).round_due, true);
  const settled = chain.call(NOOR, id, 'settle');
  assert.equal(settled.value, 1);
  const receipt = settled.social.find((row) => row.key.startsWith('post/'));
  assert.equal(receipt.predecessor_id, id);
  assert.match(receipt.value.text, /Round 1 is settled\. 9 NEAR is shared between 2 members for 3 amplified posts/);

  view = choir(chain, id);
  assert.equal(view.round, 1);
  assert.equal(BigInt(view.pot), 0n);
  assert.deepEqual(chain.view(id, 'get_round', { round: 0 }), { pot: near(9).toString(), points: 3, contributors: 2 });
  assert.equal(BigInt(member(chain, id, MAYA).claimable), near(6));
  assert.equal(BigInt(member(chain, id, LEO).claimable), near(3));
  assert.equal(BigInt(member(chain, id, NOOR).claimable), 0n);

  const before = chain.balance(MAYA);
  assert.ok(chain.call(MAYA, id, 'claim').ok);
  assert.equal(chain.balance(MAYA) - before, near(6) - PAYOUT_FEE);
  assert.match(chain.call(MAYA, id, 'claim').error, /Nothing to claim yet/);
  assert.match(chain.call(NOOR, id, 'claim').error, /Nothing to claim yet/);
  assertSolvent(chain, id, assert);
});

test('lifecycle: a pot with no amplified posts waits for the next round', () => {
  const { chain } = setup();
  const id = create(chain);
  join(chain, id, MAYA);
  tip(chain, id, FAN, 10);
  wait(chain, 7 * DAY_MS);
  const settled = chain.call(FAN, id, 'settle');
  assert.equal(settled.social.length, 0, 'nothing was shared, so the account posts nothing');
  assert.equal(BigInt(choir(chain, id).pot), near(9));

  amplifyOwn(chain, id, MAYA, post(chain, MAYA));
  wait(chain, 30 * DAY_MS); // several rounds pass with nobody calling
  chain.call(FAN, id, 'settle');
  assert.equal(choir(chain, id).round, 5);
  assert.equal(BigInt(member(chain, id, MAYA).claimable), near(9));
});

test('lifecycle: a member who leaves or is removed still gets what the round owes them', () => {
  const { chain } = setup();
  const id = create(chain);
  join(chain, id, MAYA);
  join(chain, id, LEO);
  amplifyOwn(chain, id, MAYA, post(chain, MAYA));
  amplifyOwn(chain, id, LEO, post(chain, LEO));
  tip(chain, id, FAN, 10);
  assert.ok(chain.call(MAYA, id, 'leave').ok);
  assert.ok(chain.call(ASHA, id, 'remove_member', { account: LEO }).ok);
  wait(chain, 7 * DAY_MS);
  for (const who of [MAYA, LEO]) {
    const before = chain.balance(who);
    assert.ok(chain.call(who, id, 'claim').ok);
    assert.equal(chain.balance(who) - before, near(4.5) - PAYOUT_FEE);
  }
});

test('lifecycle: taking a repost down in the same round removes its point', () => {
  const { chain } = setup();
  const id = create(chain);
  join(chain, id, MAYA);
  const spam = post(chain, MAYA, 'off topic');
  amplifyOwn(chain, id, MAYA, spam);
  assert.match(chain.call(MALLORY, id, 'unamplify', { author: MAYA, post_id: spam }).error, /Only the conductor or a curator/);
  assert.ok(chain.call(ASHA, id, 'unamplify', { author: MAYA, post_id: spam }).ok);
  assert.equal(social(chain, id, 'repost/')[`repost/${MAYA}/${spam}`], null);
  assert.equal(choir(chain, id).points, 0);
  assert.equal(choir(chain, id).contributors, 0);
  assert.equal(chain.view(id, 'amplified', { author: MAYA, post_id: spam }), false);
  assert.match(amplify(chain, id, ASHA, MAYA, spam).error, /already been amplified/);
});

test('lifecycle: curators are void after a handover', () => {
  const { chain } = setup();
  const id = create(chain);
  join(chain, id, MAYA);
  assert.ok(chain.call(ASHA, id, 'set_curator', { account: LEO, on: true }).ok);
  assert.deepEqual(choir(chain, id).curators, [LEO]);
  assert.ok(amplify(chain, id, LEO, MAYA, post(chain, MAYA)).ok);

  assert.ok(transfer(chain, id, ASHA, SAM).ok);
  assert.deepEqual(choir(chain, id).curators, []);
  assert.match(
    amplify(chain, id, LEO, MAYA, post(chain, MAYA)).error,
    /Only the conductor or a curator/,
  );
  // The new conductor can appoint the same person again.
  assert.ok(chain.call(SAM, id, 'set_curator', { account: LEO, on: true }).ok);
  assert.ok(amplify(chain, id, LEO, MAYA, post(chain, MAYA)).ok);
});

test('lifecycle: old conductor is refused after handover, and the account announces it', () => {
  const { chain } = setup();
  const id = create(chain);
  tip(chain, id, FAN, 10);
  const moved = transfer(chain, id, ASHA, SAM);
  assert.ok(moved.ok);
  assert.equal(moved.events[0].event, 'nft_transfer');
  assert.deepEqual(moved.events[0].data[0], { old_owner_id: ASHA, new_owner_id: SAM, token_ids: [id] });

  const handover = moved.social.find((row) => row.key.startsWith('post/'));
  assert.equal(handover.predecessor_id, id);
  assert.match(handover.value.text, new RegExp(`passed from @${ASHA} to @${SAM}`));

  assert.equal(info(chain, id).owner_id, SAM);
  assert.equal(info(chain, id).rotation_seq, '1');
  assert.equal(token(chain, id).owner_id, SAM);
  assert.deepEqual(chain.view(id, 'get_holders').map((h) => h.account), [ASHA, SAM]);

  for (const [method, args] of [
    ['withdraw_seat', {}],
    ['set_profile', { name: 'Mine' }],
    ['set_rules', { rules: rules({ seat_bps: 2000 }) }],
    ['set_curator', { account: ASHA, on: true }],
  ]) {
    assert.match(chain.call(ASHA, id, method, args).error, /Only the conductor/, method);
  }
  assert.match(chain.call(ASHA, id, 'remove_member', { account: MAYA }).error, /Only the conductor or a curator/);
  assert.match(transfer(chain, id, ASHA, ASHA).error, /Only the conductor can hand over/);

  // The seat balance moved with the seat.
  const before = chain.balance(SAM);
  assert.ok(chain.call(SAM, id, 'withdraw_seat', {}).ok);
  assert.equal(chain.balance(SAM) - before, near(1) - PAYOUT_FEE);
  assertSolvent(chain, id, assert);
});

test('lifecycle: pending rules are dropped at handover', () => {
  const { chain } = setup();
  const id = create(chain);
  assert.ok(chain.call(ASHA, id, 'set_rules', { rules: rules({ seat_bps: 2000 }) }).ok);
  assert.equal(choir(chain, id).pending_rules.seat_bps, 2000);
  assert.equal(choir(chain, id).rules.seat_bps, 1000, 'rules never change in the middle of a round');
  assert.ok(transfer(chain, id, ASHA, SAM).ok);
  assert.equal(choir(chain, id).pending_rules, null);
  wait(chain, 7 * DAY_MS);
  chain.call(FAN, id, 'settle');
  assert.equal(choir(chain, id).rules.seat_bps, 1000);
});

test('lifecycle: queued rules take effect only when the next round opens', () => {
  const { chain } = setup();
  const id = create(chain);
  chain.call(ASHA, id, 'set_rules', { rules: rules({ seat_bps: 500, self_cap: 0 }) });
  tip(chain, id, FAN, 10);
  assert.equal(BigInt(choir(chain, id).seat_balance), near(1), 'this round still pays the old cut');
  wait(chain, 7 * DAY_MS);
  tip(chain, id, FAN, 10);
  assert.equal(BigInt(choir(chain, id).seat_balance), near(1.5));
  assert.equal(choir(chain, id).rules.self_cap, 0);
  join(chain, id, MAYA);
  assert.match(amplifyOwn(chain, id, MAYA, post(chain, MAYA)).error, /only curators amplify/);
});

test('lifecycle: cut is capped', () => {
  const { chain } = setup();
  assert.throws(() => create(chain, { seat_bps: 2001 }), /create failed/);
  assert.equal(chain.exists(`builders.${HALL}`), false, 'a refused creation leaves no account behind');
  const id = create(chain, { seat_bps: 2000 });
  assert.match(chain.call(ASHA, id, 'set_rules', { rules: rules({ seat_bps: 2500 }) }).error, /cannot be above 20%/);
  assert.match(chain.call(ASHA, id, 'set_rules', { rules: rules({ round_ms: 1000 }) }).error, /between one minute and 90 days/);
});

test('lifecycle: nobody can speak as the account; the conductor can only edit its profile', () => {
  const { chain } = setup();
  const id = create(chain);
  // There is no method that takes text and posts it. Not for the conductor, not for anyone.
  for (const method of ['announce', 'post', 'say', 'speak', 'social_write', 'social_set', 'write_profile']) {
    assert.match(chain.call(ASHA, id, method, { text: 'buy my token' }).error, /MethodNotFound/, method);
  }
  const exported = WebAssembly.Module.exports(new WebAssembly.Module(ITEM_WASM)).map((e) => e.name);
  const takesText = exported.filter((name) => /announce|post|say|speak|write/i.test(name));
  assert.deepEqual(takesText, [], 'no exported method writes free text to near.social');

  assert.match(chain.call(ASHA, id, 'set_profile', { avatar: 'https://evil.example/pixel.png' }).error, /fastfs:\/\//);
  assert.ok(chain.call(ASHA, id, 'set_profile', { name: 'NEAR Builders Guild', avatar: `fastfs://${ASHA}/social/media/ab.webp` }).ok);
  const profile = social(chain, id, 'profile/');
  assert.equal(profile['profile/name'], 'NEAR Builders Guild');
  assert.equal(profile['profile/avatar'], `fastfs://${ASHA}/social/media/ab.webp`);
});

test('lifecycle: the history view records what came in, what went out and who held the seat', () => {
  const { chain } = setup();
  const id = create(chain);
  join(chain, id, MAYA);
  amplifyOwn(chain, id, MAYA, post(chain, MAYA));
  tip(chain, id, FAN, 10, 'thanks');
  wait(chain, 7 * DAY_MS);
  chain.call(MAYA, id, 'claim');
  chain.call(ASHA, id, 'withdraw_seat', {});
  transfer(chain, id, ASHA, SAM);

  const view = choir(chain, id);
  const events = chain.view(id, 'get_events', { from_index: 0, limit: 100 });
  assert.equal(events.length, view.events);
  const kinds = events.map((e) => Object.keys(e.kind)[0] ?? e.kind);
  assert.deepEqual(kinds, ['Created', 'Joined', 'Amplified', 'Tip', 'Settled', 'Claimed', 'SeatWithdrawn', 'Rotated']);
  assert.equal(BigInt(view.totals.received), near(10));
  assert.equal(BigInt(view.totals.paid_members), near(9) - PAYOUT_FEE);
  assert.equal(BigInt(view.totals.paid_seat), near(1) - PAYOUT_FEE);
  assert.equal(view.totals.amplified, 1);
  assert.equal(view.totals.rounds_settled, 1);
});
