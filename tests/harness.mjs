// Shared set-up: a local chain running the real compiled contracts from res/.

import { readFileSync } from 'node:fs';
import { Chain, near } from '../tools/localnet/chain.mjs';

export { near };
export const ITEM_WASM = readFileSync(new URL('../res/choir_item.wasm', import.meta.url));
export const REGISTRY_WASM = readFileSync(new URL('../res/choir_registry.wasm', import.meta.url));

export const HALL = 'choir-hall.testnet';
export const SOCIAL = 'social';
export const SITE = 'https://choir.example/';
export const MS = 1_000_000n; // nanoseconds in a millisecond
export const DAY_MS = 86_400_000;
export const ONE_YOCTO = 1n;
/** Kept from every tip, and from every payout, for the bytes of its record. */
export const TIP_FEE = near(0.005);
export const AMPLIFY_FEE = near(0.005);
export const JOIN_FEE = near(0.01);
export const PAYOUT_FEE = near(0.001);
/** Held above storage and everything owed. */
export const MARGIN = near(0.03);

export const PEOPLE = ['asha', 'sam', 'maya', 'leo', 'noor', 'fan', 'mallory'].map((name) => `${name}.testnet`);
export const [ASHA, SAM, MAYA, LEO, NOOR, FAN, MALLORY] = PEOPLE;

export function rules(overrides = {}) {
  return { open: true, dues: '0', self_cap: 2, round_ms: 7 * DAY_MS, seat_bps: 1000, ...overrides };
}

/** A chain with the item code published and the collection deployed, initialised and keyless. */
export function setup() {
  const chain = new Chain();
  for (const id of PEOPLE) chain.account(id, near(1000));
  const itemCode = chain.publishGlobal(ITEM_WASM);
  chain.deploy(HALL, REGISTRY_WASM);
  chain.get(HALL).balance = near(5);
  const init = chain.call(ASHA, HALL, 'new', { item_code: itemCode, social: SOCIAL, site: SITE });
  if (!init.ok) throw new Error(`collection init failed: ${init.error}`);
  chain.get(HALL).keys = 0; // what scripts/lock-testnet.mjs does on a real network
  return { chain, itemCode };
}

/** Starts a Choir and returns its account id. */
export function create(chain, { slug = 'builders', by = ASHA, name = 'NEAR Builders', about = 'People who ship on NEAR.', deposit = near(1), ...ruleOverrides } = {}) {
  const result = chain.call(by, HALL, 'create_choir', { slug, name, about, rules: rules(ruleOverrides) }, { deposit });
  if (!result.ok || !result.value) throw new Error(`create failed: ${result.error ?? JSON.stringify(result.failures)}`);
  return result.value;
}

export const choir = (chain, id) => chain.view(id, 'get_choir');
export const member = (chain, id, account) => chain.view(id, 'get_member', { account });
export const info = (chain, id) => chain.view(id, 'nft_item_info');
export const token = (chain, id) => chain.view(HALL, 'nft_token', { token_id: id });

/** Moves the clock forward. */
export function wait(chain, ms) {
  chain.advance(BigInt(ms) * MS);
}

export function join(chain, id, who, deposit = near(0.01)) {
  const result = chain.call(who, id, 'join', {}, { deposit });
  if (!result.ok) throw new Error(`join failed: ${result.error}`);
  return result;
}

/** Tips so that exactly `amount` NEAR enters the split: the record fee is attached on top. */
export function tip(chain, id, who, amount, memo) {
  const result = chain.call(who, id, 'tip', memo ? { memo } : {}, { deposit: near(amount) + TIP_FEE });
  if (!result.ok) throw new Error(`tip failed: ${result.error}`);
  return result;
}

/** The bytes an account's state takes, priced as the protocol prices them. */
export function storageCost(chain, id) {
  let bytes = 100;
  for (const [k, v] of chain.get(id).storage) bytes += k.length / 2 + v.length + 40;
  return BigInt(bytes) * 10n ** 19n;
}

/** A curator or the conductor amplifies a member's post. Returns the call result. */
export function amplify(chain, id, by, author, postId) {
  return chain.call(by, id, 'amplify', { author, post_id: postId }, { deposit: AMPLIFY_FEE });
}

/** A member amplifies their own post. Returns the call result. */
export function amplifyOwn(chain, id, who, postId) {
  return chain.call(who, id, 'amplify_own', { post_id: postId }, { deposit: AMPLIFY_FEE });
}

export function admit(chain, id, by, account) {
  return chain.call(by, id, 'admit', { account }, { deposit: JOIN_FEE });
}

let postCounter = 1_790_000_000_000;
/** A member writes a post on near.social from their own account and returns its id. */
export function post(chain, who, text = 'gm') {
  const id = String(++postCounter);
  chain.call(who, SOCIAL, '__fastdata_kv', { [`post/${id}`]: { text } }, { gas: 1n });
  return id;
}

/** The latest near.social rows an account wrote, as { key: value }. */
export function social(chain, account, prefix = '') {
  return Object.fromEntries(chain.kvLatest(SOCIAL, account, prefix).map((row) => [row.key, row.value]));
}

/** Everything the chain should always satisfy for a Choir: it can pay all it owes. */
export function assertSolvent(chain, id, assert) {
  const view = choir(chain, id);
  const acct = chain.get(id);
  const storage = storageCost(chain, id);
  assert.ok(
    acct.balance >= storage + BigInt(view.reserved),
    `${id} holds ${acct.balance} but needs ${storage} for storage plus ${view.reserved} reserved`,
  );
}
