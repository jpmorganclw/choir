// Removes every access key from the collection account, so only its code can ever act for it.
// This cannot be undone. A fix after this needs a new account and a new deployment.
//
//   node scripts/lock-testnet.mjs
//
// Refuses to run unless the code on chain is byte-identical to res/choir_registry.wasm.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { base58encode } from '../server/gate.mjs';
import { accountOf, provider, reader } from '../server/testnet.mjs';

const { collection } = JSON.parse(readFileSync('deployments/testnet.json', 'utf8'));
const built = base58encode(createHash('sha256').update(readFileSync('res/choir_registry.wasm')).digest());
const live = (await reader.account(collection)).codeHash;
if (built !== live) throw new Error(`On-chain code ${live} is not this build ${built}. Deploy it first.`);
console.log(`On-chain code matches this build: ${live}`);

const { keys } = await provider.query({ request_type: 'view_access_key_list', finality: 'final', account_id: collection });
if (keys.length === 0) {
  console.log(`${collection} already has no keys.`);
  process.exit(0);
}
const me = accountOf(collection);
for (const { public_key: key } of keys) {
  await me.deleteKey(key);
  console.log(`Removed ${key}`);
}
console.log(`${collection} now has ${await reader.keys(collection)} access keys.`);
