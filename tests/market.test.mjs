// The market: a listed seat is frozen, and a sale moves it only if the buyer gets what they saw.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASHA, DAY_MS, FAN, HALL, LEO, MALLORY, MAYA, ONE_YOCTO, PAYOUT_FEE, SAM,
  admit, amplify, amplifyOwn, assertSolvent, choir, create, info, join, member, near, post, rules, setup, storageCost, tip, token, wait,
} from './harness.mjs';

const list = (chain, id, who = ASHA, price = near(50)) =>
  chain.call(who, HALL, 'list', { token_id: id, price: price.toString() }, { deposit: ONE_YOCTO });
const unlist = (chain, id, who = ASHA) => chain.call(who, HALL, 'unlist', { token_id: id }, { deposit: ONE_YOCTO });
const buy = (chain, id, who, { deposit = near(50), seq = '0', min = near(1) } = {}) =>
  chain.call(who, HALL, 'buy', { token_id: id, expect_seq: seq, min_seat_balance: min.toString() }, { deposit });

/** A Choir with one amplified member and a 10 NEAR tip: 9 in the pot, 1 on the seat. */
function funded() {
  const { chain } = setup();
  const id = create(chain);
  join(chain, id, MAYA);
  amplifyOwn(chain, id, MAYA, post(chain, MAYA));
  tip(chain, id, FAN, 10);
  return { chain, id };
}

test('market: listing freezes the seat and records what was sealed', () => {
  const { chain, id } = funded();
  assert.match(list(chain, id, MALLORY).error, /Only the conductor can list/);
  assert.match(chain.call(ASHA, HALL, 'list', { token_id: id, price: near(50).toString() }).error, /exactly 1 yoctoNEAR/);
  assert.match(list(chain, id, ASHA, 0n).error, /Set a price/);

  const listed = list(chain, id);
  assert.ok(listed.ok);
  assert.equal(listed.value, true);
  assert.equal(info(chain, id).status, 'Frozen');
  assert.equal(choir(chain, id).status, 'Frozen');
  const listing = chain.view(HALL, 'get_listing', { token_id: id });
  assert.equal(listing.seller, ASHA);
  assert.equal(BigInt(listing.price), near(50));
  assert.equal(BigInt(listing.sealed_seat_balance), near(1));
  assert.equal(listing.rotation_seq, '0');
  assert.equal(chain.view(HALL, 'get_listings', {}).length, 1);
  assert.equal(chain.view(HALL, 'nft_rotation', { token_id: id }).listed, true);
  assert.match(list(chain, id).error, /already listed/);
});

test('market: seller cannot withdraw while listed, nor use any other conductor power', () => {
  const { chain, id } = funded();
  list(chain, id);
  for (const [method, args] of [
    ['withdraw_seat', {}],
    ['set_rules', { rules: rules({ seat_bps: 2000 }) }],
    ['set_curator', { account: MALLORY, on: true }],
    ['set_profile', { name: 'Sold' }],
  ]) {
    assert.match(chain.call(ASHA, id, method, args).error, /The seat is Frozen/, method);
  }
  assert.match(amplify(chain, id, ASHA, MAYA, post(chain, MAYA)).error, /Only the conductor or a curator/);
  assert.match(
    chain.call(ASHA, HALL, 'nft_transfer', { receiver_id: SAM, token_id: id }, { deposit: ONE_YOCTO }).error,
    /listed for sale/,
  );
  assert.equal(BigInt(choir(chain, id).seat_balance), near(1));
});

test('market: the community carries on while the seat is for sale', () => {
  const { chain, id } = funded();
  list(chain, id);
  join(chain, id, LEO);
  assert.ok(amplifyOwn(chain, id, LEO, post(chain, LEO)).ok);
  assert.ok(tip(chain, id, FAN, 10).ok);
  assert.equal(BigInt(choir(chain, id).seat_balance), near(2), 'the seat keeps earning for whoever buys it');
  wait(chain, 7 * DAY_MS);
  const before = chain.balance(MAYA);
  assert.ok(chain.call(MAYA, id, 'claim').ok);
  assert.equal(chain.balance(MAYA) - before, near(9) - PAYOUT_FEE);
});

test('market: unlisting releases the freeze', () => {
  const { chain, id } = funded();
  list(chain, id);
  assert.match(unlist(chain, id, MALLORY).error, /Only the conductor can unlist/);
  assert.ok(unlist(chain, id).ok);
  assert.equal(info(chain, id).status, 'Active');
  assert.equal(chain.view(HALL, 'get_listing', { token_id: id }), null);
  assert.equal(chain.view(HALL, 'get_listings', {}).length, 0);
  assert.ok(chain.call(ASHA, id, 'withdraw_seat', {}).ok);
  assert.match(unlist(chain, id).error, /not listed/);
});

test('market: a sale moves the seat, its balance and its powers, and pays the seller', () => {
  const { chain, id } = funded();
  chain.call(ASHA, id, 'set_curator', { account: LEO, on: true });
  list(chain, id);
  const seller = chain.balance(ASHA);
  const buyer = chain.balance(SAM);
  const sold = buy(chain, id, SAM, { deposit: near(60) });
  assert.ok(sold.ok);
  assert.equal(sold.value, true);
  assert.equal(chain.balance(ASHA) - seller, near(50));
  assert.equal(buyer - chain.balance(SAM), near(50), 'the extra 10 NEAR came back');

  assert.equal(info(chain, id).owner_id, SAM);
  assert.equal(info(chain, id).status, 'Active');
  assert.equal(info(chain, id).rotation_seq, '1');
  assert.equal(token(chain, id).owner_id, SAM);
  assert.equal(chain.view(HALL, 'get_listing', { token_id: id }), null);
  assert.deepEqual(choir(chain, id).curators, []);
  assert.deepEqual(sold.events.map((e) => e.event), ['nft_transfer', 'seat_sold']);
  const handover = sold.social.find((row) => row.key.startsWith('post/'));
  assert.match(handover.value.text, new RegExp(`from @${ASHA} to @${SAM}`));

  assert.match(chain.call(ASHA, id, 'withdraw_seat', {}).error, /Only the conductor/);
  const before = chain.balance(SAM);
  assert.ok(chain.call(SAM, id, 'withdraw_seat', {}).ok);
  assert.equal(chain.balance(SAM) - before, near(1) - PAYOUT_FEE);
  // Members' money did not move.
  assert.equal(BigInt(choir(chain, id).pot), near(9));
  assertSolvent(chain, id, assert);
});

test('market: buy aborts and refunds if the seat holds less than shown', () => {
  const { chain, id } = funded();
  list(chain, id);
  const buyer = chain.balance(SAM);
  const seller = chain.balance(ASHA);
  const refused = buy(chain, id, SAM, { min: near(1.5) });
  assert.equal(refused.value, false);
  assert.match(refused.failures[0].error, /holds less than the buyer was shown/);
  assert.equal(chain.balance(SAM), buyer, 'the buyer has every yocto back');
  assert.equal(chain.balance(ASHA), seller);
  assert.equal(info(chain, id).owner_id, ASHA);
  assert.equal(info(chain, id).status, 'Frozen', 'the listing is still up');
  assert.equal(chain.view(HALL, 'nft_rotation', { token_id: id }).locked, false);
  // The same buyer can go through at the true figure.
  assert.equal(buy(chain, id, SAM, { min: near(1) }).value, true);
});

test('market: failed rotation refunds the buyer', () => {
  const { chain, id } = funded();
  list(chain, id);
  // Make the item refuse for a reason the collection cannot foresee: it has not one spare byte
  // to record the handover with. (Every other call leaves a margin so this cannot happen in use.)
  chain.get(id).balance = storageCost(chain, id) + BigInt(choir(chain, id).reserved);
  const buyer = chain.balance(SAM);
  const refused = buy(chain, id, SAM);
  assert.equal(refused.value, false);
  assert.equal(chain.balance(SAM), buyer);
  assert.equal(token(chain, id).owner_id, ASHA);
  assert.equal(info(chain, id).owner_id, ASHA);
});

test('market: price raised in front of buyer refunds', () => {
  const { chain, id } = funded();
  list(chain, id, ASHA, near(50));
  const buyer = chain.balance(SAM);
  // The buyer's transaction is signed for 50. Before it lands the seller relists at 80.
  unlist(chain, id);
  list(chain, id, ASHA, near(80));
  const refused = buy(chain, id, SAM, { deposit: near(50) });
  assert.match(refused.error, /price is higher than the amount attached/);
  assert.equal(chain.balance(SAM), buyer);
  assert.equal(token(chain, id).owner_id, ASHA);
});

test('market: a buyer cannot buy what is not for sale, or an older state of the seat', () => {
  const { chain, id } = funded();
  assert.match(buy(chain, id, SAM).error, /not for sale/);
  list(chain, id);
  assert.match(buy(chain, id, ASHA).error, /already hold this seat/);
  assert.match(buy(chain, id, SAM, { seq: '7' }).error, /changed since you looked/);
  assert.match(buy(chain, id, SAM, { deposit: near(49) }).error, /price is higher/);
});

test('market: unpayable seller does not block the sale', () => {
  const { chain, id } = funded();
  list(chain, id);
  const tx = chain.submit(SAM, HALL, 'buy', { token_id: id, expect_seq: '0', min_seat_balance: near(1).toString() }, { deposit: near(50) });
  chain.step(3); // buy, rotate, on_bought: the seat has moved and the payout is on its way
  const seller = chain.accounts.get(ASHA);
  chain.accounts.delete(ASHA);
  chain.drain();
  assert.equal(chain.summary(tx).value, true);
  assert.equal(token(chain, id).owner_id, SAM);
  assert.equal(BigInt(chain.view(HALL, 'owed_to', { account_id: ASHA })), near(50));

  chain.accounts.set(ASHA, seller);
  const before = chain.balance(ASHA);
  assert.ok(chain.call(ASHA, HALL, 'withdraw_owed').ok);
  assert.equal(chain.balance(ASHA) - before, near(50));
  assert.match(chain.call(ASHA, HALL, 'withdraw_owed').error, /Nothing is waiting/);
  assert.equal(BigInt(member(chain, id, MAYA).points), 1n);
});
