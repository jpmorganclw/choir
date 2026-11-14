// The practice chain: the real compiled contracts running in this process, with five people to
// act as and a clock you can move. Nothing here touches a network, a wallet or real money.

import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Chain, near } from '../tools/localnet/chain.mjs';
import { base58encode, nep413Hash } from './gate.mjs';

const res = (name) => readFileSync(new URL(`../res/${name}`, import.meta.url));

export const COLLECTION = 'choir-hall.testnet';
export const SOCIAL = 'social';
const MS = 1_000_000n;
const DAY = 86_400_000;

export const PEOPLE = [
  { id: 'asha.testnet', name: 'Asha', role: 'organiser', about: 'Runs the NEAR Builders meetup.' },
  { id: 'maya.testnet', name: 'Maya', role: 'builder', about: 'Writes Rust. Ships on Fridays.' },
  { id: 'leo.testnet', name: 'Leo', role: 'builder', about: 'Front-end, docs and bad puns.' },
  { id: 'fan.testnet', name: 'Fan', role: 'supporter', about: 'Reads everything, builds nothing. Yet.' },
  { id: 'sam.testnet', name: 'Sam', role: 'organiser', about: 'Organises the monthly demo day.' },
];

export function createLocal({ site = '' } = {}) {
  let chain;
  let postId;
  const keys = new Map();
  for (const person of PEOPLE) {
    const pair = generateKeyPairSync('ed25519');
    const raw = pair.publicKey.export({ format: 'jwk' }).x;
    keys.set(person.id, { privateKey: pair.privateKey, publicKey: `ed25519:${base58encode(Buffer.from(raw, 'base64url'))}` });
  }

  const must = (result, what) => {
    if (!result.ok) throw new Error(`${what} failed: ${result.error ?? JSON.stringify(result.failures)}`);
    return result;
  };
  const say = (who, text) => {
    postId += 1;
    chain.call(who, SOCIAL, '__fastdata_kv', { [`post/${postId}`]: { text } }, { gas: 1n });
    return String(postId);
  };

  function reset() {
    chain = new Chain();
    for (const person of PEOPLE) {
      chain.account(person.id, near(200));
      chain.call(person.id, SOCIAL, '__fastdata_kv', { 'profile/name': person.name, 'profile/about': person.about }, { gas: 1n });
    }
    postId = Math.floor(Number(chain.now / MS));
    const itemCode = chain.publishGlobal(res('choir_item.wasm'));
    chain.deploy(COLLECTION, res('choir_registry.wasm'));
    chain.get(COLLECTION).balance = near(5);
    must(chain.call('asha.testnet', COLLECTION, 'new', { item_code: itemCode, social: SOCIAL, site }), 'init');
    chain.get(COLLECTION).keys = 0;
    seed();
  }

  /** A small story so the first page is not empty: one busy Choir and one seat for sale. */
  function seed() {
    const [asha, maya, leo, fan, sam] = PEOPLE.map((p) => p.id);
    const rules = { open: true, dues: '0', self_cap: 2, round_ms: 7 * DAY, seat_bps: 1000 };
    const builders = must(
      chain.call(asha, COLLECTION, 'create_choir', { slug: 'builders', name: 'NEAR Builders', about: 'People who ship on NEAR. Post what you built and we will repeat it.', rules }, { deposit: near(1) }),
      'create builders',
    ).value;
    for (const who of [maya, leo]) must(chain.call(who, builders, 'join', {}, { deposit: near(0.01) }), 'join');

    // Last week: two amplified posts, one tip, a settled round.
    const first = say(maya, 'Shipped my first contract to testnet today. 61 tests, all green. #near');
    const second = say(leo, 'Wrote a guide to function-call access keys for people who are scared of them.');
    must(chain.call(maya, builders, 'amplify_own', { post_id: first }, { deposit: near(0.005) }), 'amplify');
    must(chain.call(leo, builders, 'amplify_own', { post_id: second }, { deposit: near(0.005) }), 'amplify');
    must(chain.call(fan, builders, 'tip', { memo: 'for the guide' }, { deposit: near(4.005) }), 'tip');
    chain.advance(BigInt(7 * DAY) * MS);
    must(chain.call(fan, builders, 'settle', {}), 'settle');
    must(chain.call(leo, builders, 'claim', {}), 'claim');

    // This week, so far.
    const third = say(maya, 'Storage staking finally clicked: your contract pays rent for every byte, so make the caller bring it.');
    must(chain.call(maya, builders, 'amplify_own', { post_id: third }, { deposit: near(0.005) }), 'amplify');
    say(leo, 'Demo day is Friday. I am bringing a wallet that explains itself.');
    must(chain.call(fan, builders, 'tip', { memo: 'keep shipping' }, { deposit: near(6.005) }), 'tip');
    chain.advance(BigInt(2 * DAY) * MS);

    const night = must(
      chain.call(sam, COLLECTION, 'create_choir', { slug: 'night-shift', name: 'Night Shift', about: 'For the people who deploy at 2 a.m.', rules: { ...rules, seat_bps: 500 } }, { deposit: near(0.5) }),
      'create night-shift',
    ).value;
    must(chain.call(leo, night, 'join', {}, { deposit: near(0.01) }), 'join');
    const late = say(leo, 'Deployed at 2 a.m. again. It worked first time, which is how I know something is wrong.');
    must(chain.call(leo, night, 'amplify_own', { post_id: late }, { deposit: near(0.005) }), 'amplify');
    must(chain.call(fan, night, 'tip', {}, { deposit: near(2.005) }), 'tip');
    must(chain.call(sam, COLLECTION, 'list', { token_id: night, price: near(12).toString() }, { deposit: 1n }), 'list');
  }

  reset();

  const summary = (result) => ({
    ok: result.ok,
    value: result.value,
    error: result.error,
    // A write to near.social always fails as a receipt: nothing is deployed there. That is expected.
    failures: result.failures
      .filter((f) => f.error !== `AccountDoesNotExist: ${SOCIAL}`)
      .map((f) => ({ error: f.error, account: f.account, method: f.method })),
    events: result.events,
    logs: result.logs.map((l) => l.log),
  });

  return {
    reset,
    get chain() {
      return chain;
    },
    people: () => PEOPLE.map((p) => ({ ...p, publicKey: keys.get(p.id).publicKey })),
    view(account, method, args = {}) {
      return chain.view(account, method, args);
    },
    call({ persona, receiver, method, args = {}, deposit = '0', gas = '300000000000000' }) {
      if (!keys.has(persona)) throw new Error('Pick one of the five people to act as.');
      // A `__fastdata_kv` write fails by design (nothing is deployed on `social`). It is still indexed.
      const result = chain.call(persona, receiver, method, args, { deposit: BigInt(deposit), gas: BigInt(gas) });
      if (method === '__fastdata_kv') return { ...summary(result), ok: true, error: undefined };
      return summary(result);
    },
    send({ persona, receiver, amount }) {
      if (!keys.has(persona)) throw new Error('Pick one of the five people to act as.');
      return summary(chain.send(persona, receiver, BigInt(amount)));
    },
    skip(ms) {
      chain.advance(BigInt(Math.max(0, Math.min(Number(ms), 400 * DAY))) * MS);
      return { nowMs: Number(chain.now / MS) };
    },
    account(id) {
      const acct = chain.get(id);
      if (!acct) return { exists: false };
      return { exists: true, balance: acct.balance.toString(), keys: acct.keys, codeHash: acct.codeHash, global: acct.codeBytes === 0 && Boolean(acct.code) };
    },
    state: () => ({ height: Number(chain.height), nowMs: Number(chain.now / MS) }),
    signNep413(persona, nonceBase64) {
      const key = keys.get(persona);
      if (!key) throw new Error('Pick one of the five people to act as.');
      const signature = sign(null, nep413Hash({ nonce: Buffer.from(nonceBase64, 'base64') }), key.privateKey);
      return { accountId: persona, publicKey: key.publicKey, signature: signature.toString('base64') };
    },
    /** The verifier's reader over this chain. */
    reader: {
      finalBlock: async () => ({ height: Number(chain.height) }),
      view: async (account, method, args) => chain.view(account, method, args),
      keys: async (account) => chain.keys(account),
      hasKey: async (account, publicKey) => keys.get(account)?.publicKey === publicKey,
    },
    /** FastData KV, in the shape kv.*.fastnear.com answers with. */
    kv: {
      byAccount(receiver, predecessor, { key, key_prefix: prefix = '' } = {}) {
        const rows = chain.kvLatest(receiver, predecessor, key ?? prefix).filter((row) => (key ? row.key === key : true));
        return { entries: rows.map(kvRow) };
      },
      byKey(receiver, { key, key_prefix: prefix } = {}) {
        const latest = new Map();
        for (const row of chain.fastdata) {
          if (row.current_account_id !== receiver) continue;
          if (key !== undefined ? row.key !== key : !row.key.startsWith(prefix ?? '')) continue;
          latest.set(`${row.predecessor_id}\n${row.key}`, row);
        }
        return { entries: [...latest.values()].map(kvRow) };
      },
      multi(keys = []) {
        return {
          entries: keys.map((full) => {
            const [receiver, predecessor, ...rest] = full.split('/');
            const found = chain.kvLatest(receiver, predecessor, rest.join('/')).find((row) => row.key === rest.join('/'));
            return found ? kvRow(found) : null;
          }),
        };
      },
    },
  };
}

const kvRow = (row) => ({
  predecessor_id: row.predecessor_id,
  current_account_id: row.current_account_id,
  block_height: row.block_height,
  block_timestamp: row.block_timestamp,
  key: row.key,
  value: row.value,
});
