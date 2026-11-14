// Money: the split, plain transfers, failed payouts and the solvency invariant.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASHA, DAY_MS, FAN, HALL, MARGIN, MAYA, ONE_YOCTO, PAYOUT_FEE, PEOPLE, SAM, TIP_FEE,
  admit, amplify, amplifyOwn, assertSolvent, choir, create, join, member, near, post, setup, storageCost, tip, wait,
} from './harness.mjs';

test('money: every tip is split exactly, with nothing lost to rounding', () => {
  const { chain } = setup();
  const id = create(chain, { seat_bps: 1234 });
  assert.match(chain.call(FAN, id, 'tip', {}, { deposit: near(0.001) }).error, /at least 0.05 NEAR/);
  assert.match(chain.call(FAN, id, 'tip', { memo: 'x'.repeat(141) }, { deposit: near(1) }).error, /memo must be/);
  const odd = 1_234_567_890_123_456_789_012_345n;
  assert.ok(chain.call(FAN, id, 'tip', {}, { deposit: odd + TIP_FEE }).ok);
  const view = choir(chain, id);
  assert.equal(BigInt(view.seat_balance), (odd * 1234n) / 10_000n);
  assert.equal(BigInt(view.pot) + BigInt(view.seat_balance), odd);
  assert.equal(BigInt(view.reserved), odd);
  assert.equal(view.totals.tips, 1);
});

test('money: plain transfers are split by sweep, never handed to the seat', () => {
  const { chain } = setup();
  const id = create(chain, { deposit: near(0.27) });
  // What the founder attached beyond the working buffer is the first thing a sweep picks up.
  chain.call(FAN, id, 'sweep');
  assert.match(chain.call(FAN, id, 'sweep').error, /Nothing to sweep/);
  const base = choir(chain, id);

  // Someone pays the account from an exchange: a transfer that runs no code.
  chain.send(FAN, id, near(5));
  assert.equal(choir(chain, id).reserved, base.reserved, 'a transfer alone changes no ledger');
  const swept = chain.call(MAYA, id, 'sweep'); // anyone may call it
  assert.ok(swept.ok);
  const amount = BigInt(swept.value);
  assert.ok(amount > near(4.99) && amount <= near(5), `swept ${amount}`);
  const view = choir(chain, id);
  assert.equal(BigInt(view.seat_balance) - BigInt(base.seat_balance), amount / 10n);
  assert.equal(BigInt(view.pot) - BigInt(base.pot), amount - amount / 10n);
  assert.match(chain.call(MAYA, id, 'sweep').error, /Nothing to sweep/);
  assertSolvent(chain, id, assert);
});

test('money: the conductor can take the seat balance and nothing else', () => {
  const { chain } = setup();
  const id = create(chain);
  join(chain, id, MAYA);
  amplifyOwn(chain, id, MAYA, post(chain, MAYA));
  tip(chain, id, FAN, 10);

  assert.match(chain.call(ASHA, id, 'withdraw_seat', { amount: near(1.01).toString() }).error, /does not hold that much/);
  assert.match(chain.call(MAYA, id, 'withdraw_seat', {}).error, /Only the conductor/);
  const before = chain.balance(ASHA);
  assert.ok(chain.call(ASHA, id, 'withdraw_seat', { amount: near(0.4).toString() }).ok);
  assert.ok(chain.call(ASHA, id, 'withdraw_seat', {}).ok);
  assert.equal(chain.balance(ASHA) - before, near(1) - 2n * PAYOUT_FEE);
  assert.match(chain.call(ASHA, id, 'withdraw_seat', {}).error, /too little on the seat/);
  // The pot is untouched and still goes to the member.
  assert.equal(BigInt(choir(chain, id).pot), near(9));
  assert.match(chain.call(ASHA, id, 'claim').error, /no earnings here/);
  wait(chain, 7 * DAY_MS);
  const mayaBefore = chain.balance(MAYA);
  chain.call(MAYA, id, 'claim');
  assert.equal(chain.balance(MAYA) - mayaBefore, near(9) - PAYOUT_FEE);
});

test('money: a member payout that fails is credited back to that member', () => {
  const { chain } = setup();
  const id = create(chain);
  join(chain, id, MAYA);
  amplifyOwn(chain, id, MAYA, post(chain, MAYA));
  tip(chain, id, FAN, 10);
  wait(chain, 7 * DAY_MS);

  const tx = chain.submit(MAYA, id, 'claim');
  chain.step(1); // the claim ran; the transfer is on its way
  assert.equal(BigInt(member(chain, id, MAYA).claimable), 0n);
  const gone = chain.accounts.get(MAYA);
  chain.accounts.delete(MAYA); // the member's account disappears before the money lands
  chain.drain();
  assert.equal(chain.summary(tx).value, false);
  assert.equal(BigInt(member(chain, id, MAYA).claimable), near(9));
  assert.equal(BigInt(choir(chain, id).totals.paid_members), 0n);
  assertSolvent(chain, id, assert);

  chain.accounts.set(MAYA, gone);
  const before = chain.balance(MAYA);
  assert.ok(chain.call(MAYA, id, 'claim').ok);
  assert.equal(chain.balance(MAYA) - before, near(9) - PAYOUT_FEE);
});

test('money: solvency holds after every call', () => {
  const { chain } = setup();
  const id = create(chain, { round_ms: DAY_MS, self_cap: 3 });
  const everyone = PEOPLE.filter((p) => p !== ASHA);
  let conductor = ASHA;
  // A small seeded generator (mulberry32), so the same 400 steps run every time.
  let state = 20261111;
  const random = (n) => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
  const pick = () => everyone[random(everyone.length)];
  let paidOut = 0n;
  let payouts = 0n;
  for (const who of everyone) chain.call(who, id, 'join', {}, { deposit: near(0.01) });
  const balances = () => Object.fromEntries(PEOPLE.map((p) => [p, chain.balance(p)]));

  for (let i = 0; i < 400; i += 1) {
    const who = pick();
    const before = balances();
    let spent = 0n;
    switch (random(12)) {
      case 0: {
        const r = chain.call(who, id, 'join', {}, { deposit: near(0.01) });
        if (r.ok) spent = near(0.01);
        break;
      }
      case 1:
        amplifyOwn(chain, id, who, post(chain, who));
        break;
      case 2: {
        const amount = near(0.05) + BigInt(random(1_000_000)) * 10n ** 18n + BigInt(random(997));
        if (chain.call(who, id, 'tip', {}, { deposit: amount }).ok) spent = amount;
        break;
      }
      case 3:
        wait(chain, random(2 * DAY_MS));
        chain.call(who, id, 'settle');
        break;
      case 4:
        if (chain.call(who, id, 'claim').value === true) payouts += 1n;
        break;
      case 5:
        if (chain.call(conductor, id, 'withdraw_seat', {}).value === true) payouts += 1n;
        break;
      case 6:
        chain.call(who, id, 'leave');
        break;
      case 7:
        if (random(4) === 0 && who !== conductor) {
          if (chain.call(conductor, HALL, 'nft_transfer', { receiver_id: who, token_id: id }, { deposit: ONE_YOCTO }).ok) {
            spent = 0n;
            conductor = who;
          }
        }
        break;
      default:
        amplify(chain, id, conductor, who, post(chain, who));
    }
    const after = balances();
    for (const p of PEOPLE) {
      const delta = after[p] - before[p] + (p === who ? spent : 0n);
      // The one yoctoNEAR a transfer attaches stays with the collection.
      if (delta > 0n) paidOut += delta;
    }
    assertSolvent(chain, id, assert);
    const view = choir(chain, id);
    const members = chain.view(id, 'get_members', { limit: 100 });
    const owed = members.reduce((sum, m) => sum + BigInt(m.claimable), 0n) + BigInt(view.pot) + BigInt(view.seat_balance);
    // What is reserved covers everything owed; the only gap is rounding dust left by a split.
    assert.ok(BigInt(view.reserved) >= owed, `step ${i}: reserved ${view.reserved} < owed ${owed}`);
    assert.ok(BigInt(view.reserved) - owed < 10_000n, `step ${i}: more than dust is unaccounted`);
  }
  const view = choir(chain, id);
  assert.equal(BigInt(view.totals.paid_members) + BigInt(view.totals.paid_seat), paidOut, 'every yocto that left is in the totals');
  // Each payout also left its record fee behind, outside the reserve.
  assert.equal(BigInt(view.totals.received) - paidOut - payouts * PAYOUT_FEE, BigInt(view.reserved));
  assert.ok(
    view.totals.rounds_settled > 5 && view.totals.amplified > 50 && payouts > 20n,
    `the run exercised rounds (${view.totals.rounds_settled}), amplification (${view.totals.amplified}) and payouts (${payouts})`,
  );
});

test('money: a call that would leave the account unable to pay for its bytes is refused', () => {
  const { chain } = setup();
  const id = create(chain, { deposit: near(0.27) });
  // Drain the working buffer down to the storage line by leaving nothing spare.
  chain.get(id).balance = storageCost(chain, id) + BigInt(choir(chain, id).reserved) + MARGIN;
  const refused = chain.call(ASHA, id, 'set_curator', { account: SAM, on: true });
  assert.ok(!refused.ok);
  assert.match(refused.error, /needs a little NEAR attached/);
  // Attaching NEAR for the bytes makes the same call succeed.
  assert.ok(chain.call(ASHA, id, 'set_curator', { account: SAM, on: true }, { deposit: near(0.01) }).ok);
});
