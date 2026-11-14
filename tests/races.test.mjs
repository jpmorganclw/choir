// Races: transactions interleaved receipt by receipt, in the orders an attacker would want.
//
// `chain.submit` queues a transaction without running it. `chain.stepOn(label)` runs one waiting
// receipt out of turn, so a test can hold a payout back while a whole sale goes through.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASHA, DAY_MS, FAN, HALL, LEO, MAYA, ONE_YOCTO, PAYOUT_FEE, SAM,
  amplifyOwn, assertSolvent, choir, create, info, join, member, near, post, setup, social, tip, token, wait,
} from './harness.mjs';

const PRICE = near(50);
const steps = (chain, ...labels) => labels.forEach((label) => chain.stepOn(label));

function funded() {
  const { chain } = setup();
  const id = create(chain);
  join(chain, id, MAYA);
  amplifyOwn(chain, id, MAYA, post(chain, MAYA));
  tip(chain, id, FAN, 10); // 9 in the pot, 1 on the seat
  return { chain, id };
}

/** Lists the seat, running only the listing's own receipts. */
function listNow(chain, id, price = PRICE) {
  chain.submit(ASHA, HALL, 'list', { token_id: id, price: price.toString() }, { deposit: ONE_YOCTO });
  steps(chain, 'list', 'freeze', 'on_listed');
}

function submitBuy(chain, id, who, { min = 0n, seq = '0', deposit = PRICE } = {}) {
  return chain.submit(who, HALL, 'buy', { token_id: id, expect_seq: seq, min_seat_balance: min.toString() }, { deposit });
}

test('races: sale lands between a seat withdrawal and its callback', () => {
  const { chain, id } = funded();
  // The conductor asks for the seat balance. The payout is created but has not landed.
  chain.submit(ASHA, id, 'withdraw_seat', {});
  chain.stepOn('withdraw_seat');
  assert.equal(BigInt(choir(chain, id).seat_balance), 0n);
  assert.deepEqual(chain.waiting(), [`${ASHA}.transfer`]);

  // While it is in flight the seat is listed and sold.
  listNow(chain, id);
  const sale = submitBuy(chain, id, SAM);
  steps(chain, 'buy', 'rotate', 'on_bought');
  assert.equal(info(chain, id).owner_id, SAM);

  // Now the old conductor's account is gone, so both payments to it fail.
  const seller = chain.accounts.get(ASHA);
  chain.accounts.delete(ASHA);
  chain.drain();
  assert.equal(chain.summary(sale).value, true);

  // The failed withdrawal is credited to the seat, which is the buyer's now.
  assert.equal(BigInt(choir(chain, id).seat_balance), near(1));
  const before = chain.balance(SAM);
  assert.ok(chain.call(SAM, id, 'withdraw_seat', {}).ok);
  assert.equal(chain.balance(SAM) - before, near(1) - PAYOUT_FEE);

  // The seller is still owed the sale price, and nothing more.
  chain.accounts.set(ASHA, seller);
  assert.match(chain.call(ASHA, id, 'withdraw_seat', {}).error, /Only the conductor/);
  const sellerBefore = chain.balance(ASHA);
  assert.ok(chain.call(ASHA, HALL, 'withdraw_owed').ok);
  assert.equal(chain.balance(ASHA) - sellerBefore, PRICE);
  assertSolvent(chain, id, assert);
});

test('races: a withdrawal that lands after the sale still pays only what was taken before listing', () => {
  const { chain, id } = funded();
  const before = chain.balance(ASHA);
  chain.submit(ASHA, id, 'withdraw_seat', {});
  chain.stepOn('withdraw_seat');
  listNow(chain, id);
  // The buyer sees an empty seat and agrees to that.
  const sale = submitBuy(chain, id, SAM, { min: 0n });
  chain.drain();
  assert.equal(chain.summary(sale).value, true);
  // The withdrawal made before listing, plus the sale price, less the one yocto the listing cost.
  assert.equal(chain.balance(ASHA) - before, near(1) - PAYOUT_FEE + PRICE - ONE_YOCTO);
  assert.equal(BigInt(choir(chain, id).seat_balance), 0n);
});

test('races: sale in the middle of a member payout', () => {
  const { chain, id } = funded();
  wait(chain, 7 * DAY_MS);
  const before = chain.balance(MAYA);
  chain.submit(MAYA, id, 'claim');
  chain.stepOn('claim'); // debited from her ledger; the transfer is waiting
  assert.equal(BigInt(member(chain, id, MAYA).claimable), 0n);

  listNow(chain, id);
  const sale = submitBuy(chain, id, SAM, { min: near(1) });
  steps(chain, 'buy', 'rotate', 'on_bought');
  assert.equal(info(chain, id).owner_id, SAM);

  // The payout lands after the handover and pays exactly what she was owed.
  chain.drain();
  assert.equal(chain.summary(sale).value, true);
  assert.equal(chain.balance(MAYA) - before, near(9) - PAYOUT_FEE);
  assert.equal(BigInt(choir(chain, id).seat_balance), near(1), 'the seat got none of it');
  assertSolvent(chain, id, assert);
});

test('races: a member payout that fails during a sale goes back to the member, not the seat', () => {
  const { chain, id } = funded();
  wait(chain, 7 * DAY_MS);
  chain.submit(MAYA, id, 'claim');
  chain.stepOn('claim');
  listNow(chain, id);
  submitBuy(chain, id, SAM, { min: near(1) });
  steps(chain, 'buy', 'rotate', 'on_bought');

  const gone = chain.accounts.get(MAYA);
  chain.accounts.delete(MAYA);
  chain.drain();
  chain.accounts.set(MAYA, gone);

  assert.equal(BigInt(member(chain, id, MAYA).claimable), near(9));
  assert.equal(BigInt(choir(chain, id).seat_balance), near(1));
  // The new conductor has no way to reach it.
  assert.match(chain.call(SAM, id, 'withdraw_seat', { amount: near(2).toString() }).error, /does not hold that much/);
  const before = chain.balance(MAYA);
  assert.ok(chain.call(MAYA, id, 'claim').ok);
  assert.equal(chain.balance(MAYA) - before, near(9) - PAYOUT_FEE);
});

for (const order of ['settle first', 'sale first', 'interleaved']) {
  test(`races: round settles in the same block as a sale (${order})`, () => {
    const { chain, id } = funded();
    listNow(chain, id);
    wait(chain, 7 * DAY_MS); // the round is over but nobody has closed it
    const sale = submitBuy(chain, id, SAM, { min: near(1) });
    chain.submit(LEO, id, 'settle');
    if (order === 'settle first') steps(chain, 'settle', 'buy', 'rotate', 'on_bought');
    if (order === 'sale first') steps(chain, 'buy', 'rotate', 'on_bought', 'settle');
    if (order === 'interleaved') steps(chain, 'buy', 'settle', 'rotate', 'on_bought');
    chain.drain();

    assert.equal(chain.summary(sale).value, true);
    const view = choir(chain, id);
    assert.equal(view.conductor, SAM);
    assert.equal(view.round, 1);
    assert.equal(BigInt(view.seat_balance), near(1));
    assert.equal(BigInt(member(chain, id, MAYA).claimable), near(9), 'the members are paid the same in every order');
    const posts = Object.values(social(chain, id, 'post/')).map((p) => p.text);
    assert.equal(posts.filter((text) => /Round 1 is settled/.test(text)).length, 1);
    assert.equal(posts.filter((text) => /seat has passed/.test(text)).length, 1);
    assertSolvent(chain, id, assert);
  });
}

test('races: second transfer while the first is in flight', () => {
  const { chain, id } = funded();
  const first = chain.submit(ASHA, HALL, 'nft_transfer', { receiver_id: SAM, token_id: id }, { deposit: ONE_YOCTO });
  chain.stepOn('nft_transfer'); // the collection has asked the item; the answer is not back
  assert.equal(chain.view(HALL, 'nft_rotation', { token_id: id }).locked, true);

  const second = chain.submit(ASHA, HALL, 'nft_transfer', { receiver_id: LEO, token_id: id }, { deposit: ONE_YOCTO });
  chain.stepOn('nft_transfer');
  assert.match(chain.summary(second).error, /in the middle of another move/);
  const listing = chain.submit(ASHA, HALL, 'list', { token_id: id, price: '1' }, { deposit: ONE_YOCTO });
  chain.stepOn('list');
  assert.match(chain.summary(listing).error, /in the middle of another move/);

  chain.drain();
  assert.equal(chain.summary(first).value, true);
  assert.equal(token(chain, id).owner_id, SAM);
  assert.equal(info(chain, id).owner_id, SAM);
  assert.equal(chain.view(HALL, 'nft_rotation', { token_id: id }).locked, false);
});

test('races: two buyers at once, one seat', () => {
  const { chain, id } = funded();
  listNow(chain, id);
  const sam = chain.balance(SAM);
  const leo = chain.balance(LEO);
  const first = submitBuy(chain, id, SAM);
  const second = submitBuy(chain, id, LEO);
  steps(chain, 'buy', 'buy');
  chain.drain();
  assert.equal(chain.summary(first).value, true);
  assert.match(chain.summary(second).error, /in the middle of another move/);
  assert.equal(token(chain, id).owner_id, SAM);
  assert.equal(sam - chain.balance(SAM), PRICE);
  assert.equal(chain.balance(LEO), leo, 'the second buyer paid nothing');
});

test('races: unlist-drain-relist in front of a buy', () => {
  const { chain, id } = funded();
  listNow(chain, id);
  // The buyer saw 1 NEAR on the seat and signs a purchase that says so.
  const buyer = chain.balance(SAM);
  const sale = submitBuy(chain, id, SAM, { min: near(1) });

  // In front of it the seller unlists, empties the seat and relists at the same price.
  chain.submit(ASHA, HALL, 'unlist', { token_id: id }, { deposit: ONE_YOCTO });
  steps(chain, 'unlist', 'unfreeze', 'on_unlisted');
  chain.submit(ASHA, id, 'withdraw_seat', {});
  steps(chain, 'withdraw_seat', `${ASHA}.transfer`, 'on_paid');
  listNow(chain, id);
  assert.equal(BigInt(choir(chain, id).seat_balance), 0n);

  chain.drain(); // now the purchase lands
  assert.equal(chain.summary(sale).value, false);
  assert.equal(chain.balance(SAM), buyer, 'the buyer has everything back');
  assert.equal(token(chain, id).owner_id, ASHA);
  assert.equal(info(chain, id).owner_id, ASHA);
});

test('races: a lost answer cannot wedge a seat; the lock runs out and sync repairs the index', () => {
  const { chain, id } = funded();
  chain.submit(ASHA, HALL, 'nft_transfer', { receiver_id: SAM, token_id: id }, { deposit: ONE_YOCTO });
  steps(chain, 'nft_transfer', 'rotate');
  // Pretend the callback never ran. On a real network this would take a failed callback.
  chain.queue = chain.queue.filter((r) => !r.actions.some((a) => a.method === 'on_moved'));
  chain.drain();

  assert.equal(info(chain, id).owner_id, SAM, 'the account has moved');
  assert.equal(token(chain, id).owner_id, ASHA, 'the index has not');
  assert.match(chain.call(LEO, HALL, 'sync', { token_id: id }).error, /in the middle of another move/);

  wait(chain, 5 * 60 * 1000 + 1);
  const synced = chain.call(LEO, HALL, 'sync', { token_id: id }); // anyone may call it
  assert.equal(synced.value, true);
  assert.equal(token(chain, id).owner_id, SAM);
  assert.equal(chain.view(HALL, 'nft_rotation', { token_id: id }).rotation_seq, '1');
  assert.deepEqual(chain.view(HALL, 'nft_tokens_for_owner', { account_id: ASHA }), []);
  assert.equal(chain.view(HALL, 'nft_tokens_for_owner', { account_id: SAM })[0].token_id, id);
  // A second sync has nothing to do, and the old conductor cannot use the stale index.
  assert.equal(chain.call(LEO, HALL, 'sync', { token_id: id }).value, false);
  assert.match(
    chain.call(ASHA, HALL, 'nft_transfer', { receiver_id: LEO, token_id: id }, { deposit: ONE_YOCTO }).error,
    /Only the conductor can hand over/,
  );
});
