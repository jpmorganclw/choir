// Publishes the Choir item code and deploys the collection to testnet.
//
//   node scripts/deploy-testnet.mjs
//
// Signs only with this project's own accounts (choir-*.testnet) from the local NEAR keychain.
// Publishing the item code as a global contract burns about 1 NEAR per 10 KB, once. The demo
// accounts chip in from their faucet balances so the collection account can pay for it.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { base58encode } from '../server/gate.mjs';
import { SOCIAL, accountOf, actions, demoAccount, hasKey, near, outcomeOf, reader, send, toNear, transfer } from '../server/testnet.mjs';

const COLLECTION = demoAccount('hall');
const SITE_SENDER = demoAccount('asha');
const SITE = `https://test.fastfs.io/${SITE_SENDER}/${COLLECTION}/index.html`;
const PERSONAS = [
  { id: demoAccount('asha'), name: 'Asha', role: 'organiser', about: 'Runs the NEAR Builders meetup.' },
  { id: demoAccount('maya'), name: 'Maya', role: 'builder', about: 'Writes Rust. Ships on Fridays.' },
  { id: demoAccount('leo'), name: 'Leo', role: 'builder', about: 'Front-end, docs and bad puns.' },
  { id: demoAccount('fan'), name: 'Fan', role: 'supporter', about: 'Reads everything, builds nothing. Yet.' },
  { id: demoAccount('sam'), name: 'Sam', role: 'organiser', about: 'Organises the monthly demo day.' },
];
/** How much each demo account keeps for its own part in the story. */
const KEEP = { [demoAccount('asha')]: near(3), [demoAccount('maya')]: near(2), [demoAccount('leo')]: near(2), [demoAccount('sam')]: near(6), [demoAccount('fan')]: near(9) };

const item = readFileSync('res/choir_item.wasm');
const registry = readFileSync('res/choir_registry.wasm');
const itemCode = base58encode(createHash('sha256').update(item).digest());
const registryCode = base58encode(createHash('sha256').update(registry).digest());

const notReady = [];
for (const id of [COLLECTION, ...PERSONAS.map((p) => p.id)]) {
  if (!(await reader.account(id)).exists) notReady.push(`${id} (not created yet)`);
  else if (!hasKey(id)) notReady.push(`${id} (no key for it on this computer)`);
}
if (notReady.length) throw new Error(`Not ready on testnet: ${notReady.join(', ')}. Run node scripts/accounts-testnet.mjs first.`);

const before = await reader.account(COLLECTION);
if (before.codeHash === registryCode) {
  console.log(`${COLLECTION} already runs this build of the collection (${registryCode}). Nothing to do.`);
  process.exit(0);
}
if (before.codeHash !== '11111111111111111111111111111111') {
  throw new Error(`${COLLECTION} already has other code on it (${before.codeHash}). Use a fresh account.`);
}

// 1. Gather what the publish will burn. 1 NEAR per 10 KB, plus room for the collection's own storage.
const burn = BigInt(item.length) * 10n ** 20n;
const need = burn + BigInt(registry.length) * 10n ** 19n + near(2);
let have = BigInt(before.balance);
console.log(`Item code: ${item.length} bytes, hash ${itemCode}. Publishing burns ${toNear(burn)} NEAR.`);
console.log(`${COLLECTION} holds ${toNear(have)} NEAR and needs about ${toNear(need)}.`);
for (const { id } of PERSONAS) {
  if (have >= need) break;
  const balance = BigInt((await reader.account(id)).balance);
  const spare = balance - KEEP[id];
  if (spare <= near(0.5)) continue;
  const give = spare < need - have ? spare : need - have;
  const sent = await transfer(id, COLLECTION, give);
  if (!sent.ok) throw new Error(`Transfer from ${id} failed: ${sent.error}`);
  have += give;
  console.log(`  ${id} sent ${toNear(give)} NEAR (${sent.hash})`);
}
if (have < need) throw new Error(`Still ${toNear(need - have)} NEAR short. Create one more choir-*.testnet account with the faucet and send its balance to ${COLLECTION}.`);

// 2. Publish the item code once, by hash. Every Choir account will point at it.
const me = accountOf(COLLECTION);
console.log('Publishing the item code as a global contract (by hash)...');
let publishTx = null;
try {
  const published = outcomeOf(await me.deployGlobalContract(item, 'codeHash'));
  publishTx = published.hash;
  console.log(`  published: ${published.hash}`);
} catch (error) {
  // Publishing the same bytes twice is refused; that only means they are already there.
  console.log(`  publish reported: ${String(error.message ?? error).slice(0, 200)}`);
}

// 3. Deploy the collection and initialise it in the same transaction, so nobody else can.
console.log(`Deploying the collection (${registry.length} bytes) and initialising it in one transaction...`);
const deployed = await send(COLLECTION, COLLECTION, [
  actions.deployContract(registry),
  actions.functionCall('new', { item_code: itemCode, social: SOCIAL, site: SITE }, 100n * 10n ** 12n, 0n),
]);
if (!deployed.ok || deployed.failures.length) throw new Error(`Deploy failed: ${deployed.error ?? JSON.stringify(deployed.failures)}`);
console.log(`  deployed: ${deployed.hash}`);

mkdirSync('deployments', { recursive: true });
writeFileSync(
  'deployments/testnet.json',
  `${JSON.stringify(
    {
      network: 'testnet',
      collection: COLLECTION,
      item_code: itemCode,
      registry_code: registryCode,
      social: SOCIAL,
      site: SITE,
      site_sender: SITE_SENDER,
      personas: PERSONAS,
      publish_tx: publishTx,
      deploy_tx: deployed.hash,
      deployed_at: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);
console.log('Wrote deployments/testnet.json');
console.log(`${COLLECTION} now holds ${toNear((await reader.account(COLLECTION)).balance)} NEAR.`);
