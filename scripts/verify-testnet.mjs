// Read-only checks against the live testnet deployment. Needs no key and changes nothing.
//
//   npm run verify:testnet
//
// It compares what is on chain with the wasm in res/, runs the consumer's pair check on every
// Choir, reads what each Choir wrote to near.social straight from FastData, and checks that each
// account can pay everything it owes.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rpcReader } from '../app/src/lib/reader.js';
import { namespace, pair, provenance } from '../app/src/lib/verify.js';
import { base58encode } from '../server/gate.mjs';

const deployment = JSON.parse(readFileSync('deployments/testnet.json', 'utf8'));
const RPCS = (process.env.NEAR_RPC_URLS ?? 'https://rpc.testnet.fastnear.com,https://test.rpc.fastnear.com,https://near-testnet.drpc.org').split(',');
const KV = 'https://kv.test.fastnear.com';
const reader = rpcReader(RPCS);
const { collection, social } = deployment;
const sha = (file) => base58encode(createHash('sha256').update(readFileSync(file)).digest());

let passed = 0;
let failed = 0;
function check(ok, what, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
}

async function kv(account, prefix) {
  const response = await fetch(`${KV}/v0/latest/${social}/${account}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key_prefix: prefix }),
  });
  return (await response.json()).entries ?? [];
}

console.log(`Checking ${collection} on testnet\n`);

// ---- the collection ----
const hall = await reader.account(collection);
check(hall.exists, 'the collection account exists');
check(hall.codeHash === sha('res/choir_registry.wasm'), 'its code is the collection wasm in res/', hall.codeHash);
const config = await reader.view(collection, 'get_config', {});
check(config.item_code === sha('res/choir_item.wasm'), 'it mints with the item wasm in res/', config.item_code);
check(config.social === social, `it writes to the near.social receiver "${social}"`);
const t3 = await provenance(reader, collection);
check(t3.configEpoch === 0, 'config_epoch is 0: its configuration has never changed');
check(t3.sealed, 'the collection has no access keys, so only its code can act', `${t3.keys} keys`);
const meta = await reader.view(collection, 'nft_metadata', {});
check(meta.spec === 'nft-1.0.0' && meta.symbol === 'CHOIR', 'NEP-177 metadata is served');
const supply = Number(await reader.view(collection, 'nft_total_supply', {}));
const tokens = await reader.view(collection, 'nft_tokens', { limit: 100 });
check(supply > 0 && tokens.length === Math.min(supply, 100), 'NEP-181 enumeration lists every Choir', `${supply} minted`);

// ---- every Choir ----
for (const token of tokens) {
  const id = token.token_id;
  console.log(`\n${id}`);
  check(namespace(id, collection).ok, '  its name is inside the collection namespace (T0)');
  const account = await reader.account(id);
  check(account.exists && account.keys === 0, '  the account has no access keys', `${account.keys} keys`);
  check(account.codeHash === config.item_code && account.global, '  it runs the published item code by hash', account.codeHash);
  const t2 = await pair(reader, collection, id);
  check(t2.ok, '  the account and the collection agree at one final block (T2)', t2.ok ? `owner ${t2.owner}, rotation ${t2.seq}, block ${t2.block.height}` : t2.reason);
  check(t2.ok && t2.owner === token.owner_id, '  nft_token names the same owner');

  const view = await reader.view(id, 'get_choir', {});
  const need = BigInt(account.storageBytes) * 10n ** 19n + BigInt(view.reserved);
  check(BigInt(account.balance) >= need, '  the account can pay for its storage and everything it owes', `holds ${account.balance}, needs ${need}`);
  const members = await reader.view(id, 'get_members', { limit: 100 });
  const owed = members.reduce((sum, m) => sum + BigInt(m.claimable), 0n) + BigInt(view.pot) + BigInt(view.seat_balance);
  check(BigInt(view.reserved) >= owed, '  what it has reserved covers the pot, the seat and every unclaimed share', `reserved ${view.reserved}, owed ${owed}`);
  const holders = await reader.view(id, 'get_holders', {});
  check(holders.at(-1).account === view.conductor, '  its own history ends with the current conductor', `${holders.length} holder(s)`);

  const profile = await kv(id, 'profile/');
  check(profile.some((row) => row.key === 'profile/name' && row.value === view.name), '  it wrote its own near.social profile', `predecessor ${profile[0]?.predecessor_id ?? 'none'}`);
  const follows = (await kv(id, 'graph/follow/')).filter((row) => row.value && typeof row.value === 'object').map((row) => row.key.slice(13));
  const active = members.filter((m) => m.active).map((m) => m.account);
  check(active.every((m) => follows.includes(m)) && follows.length === active.length, '  it follows exactly its members on near.social', `${follows.length} follows, ${active.length} members`);
  const reposts = (await kv(id, 'repost/')).filter((row) => row.value && typeof row.value === 'object');
  check(reposts.length <= view.totals.amplified, '  every repost it shows was an amplification recorded on chain', `${reposts.length} live reposts, ${view.totals.amplified} amplified`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
