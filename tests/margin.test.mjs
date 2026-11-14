// The margin: every call a person makes leaves a little NEAR above storage and everything owed,
// so the calls the collection makes for them (a handover, a listing) never fail for a few bytes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASHA, FAN, HALL, LEO, MARGIN, MAYA, ONE_YOCTO, SAM,
  amplifyOwn, choir, create, info, join, near, post, setup, storageCost, tip,
} from './harness.mjs';

const spare = (chain, id) => chain.get(id).balance - storageCost(chain, id) - BigInt(choir(chain, id).reserved);

test('margin: a seat changes hands even when the account is down to its margin', () => {
  const { chain } = setup();
  const id = create(chain);
  join(chain, id, MAYA);
  amplifyOwn(chain, id, MAYA, post(chain, MAYA));
  tip(chain, id, FAN, 10);

  // Leave the account with exactly the margin and nothing more.
  chain.get(id).balance -= spare(chain, id) - MARGIN;
  assert.equal(spare(chain, id), MARGIN);
  // A person's call that adds bytes and brings no NEAR is refused...
  assert.match(chain.call(ASHA, id, 'set_curator', { account: LEO, on: true }).error, /needs a little NEAR attached/);
  // ...but the handover, the listing and the sale all go through on the margin.
  assert.equal(chain.call(ASHA, HALL, 'nft_transfer', { receiver_id: SAM, token_id: id }, { deposit: ONE_YOCTO }).value, true);
  assert.equal(info(chain, id).owner_id, SAM);
  assert.equal(chain.call(SAM, HALL, 'list', { token_id: id, price: near(5).toString() }, { deposit: ONE_YOCTO }).value, true);
  const sold = chain.call(LEO, HALL, 'buy', { token_id: id, expect_seq: '1', min_seat_balance: near(1).toString() }, { deposit: near(5) });
  assert.equal(sold.value, true);
  assert.equal(info(chain, id).owner_id, LEO);
  assert.ok(spare(chain, id) >= 0n, 'and the account can still pay for its storage and everything it owes');
});

test('margin: ordinary use never eats into it', () => {
  const { chain } = setup();
  const id = create(chain, { deposit: near(0.27), self_cap: 50 });
  chain.call(FAN, id, 'sweep'); // take the founder's spare NEAR out, leaving only the buffer
  join(chain, id, MAYA);
  let lowest = spare(chain, id);
  for (let i = 0; i < 40; i += 1) {
    assert.ok(amplifyOwn(chain, id, MAYA, post(chain, MAYA)).ok, `amplification ${i}`);
    tip(chain, id, FAN, 0.05, 'x'.repeat(140));
    const now = spare(chain, id);
    if (now < lowest) lowest = now;
  }
  assert.ok(lowest >= MARGIN, `spare NEAR fell to ${lowest}, below the margin`);
  assert.ok(spare(chain, id) > near(0.15), 'the fees more than paid for the bytes they stored');
});
