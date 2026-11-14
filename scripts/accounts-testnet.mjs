// Creates this project's demo accounts on testnet with the public faucet.
//
//   node scripts/accounts-testnet.mjs            creates whichever are missing
//   node scripts/accounts-testnet.mjs --check    only reports what is there
//
// The faucet refuses when it is busy ("429 Too Many Requests"). This script then waits and tries
// again, so it can be left running. It is safe to stop and start again: accounts that exist are
// skipped, and a key already saved for an account is reused, never replaced.
//
// The names are choir-hall (the collection) and choir-asha, -sam, -maya, -leo, -fan (the people in
// the story). If somebody already owns those, CHOIR_PREFIX=choir-yourname makes a separate set;
// use the same setting for scripts/deploy-testnet.mjs.
//
// It asks the faucet for exactly what `near account create-account sponsor-by-faucet-service`
// asks for, and saves keys where near-cli saves them (~/.near-credentials/testnet).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { KEYCHAIN, demoAccount, keysFor, pause, reader, toNear } from '../server/testnet.mjs';

const FAUCET = process.env.NEAR_FAUCET_URL ?? 'https://helper.nearprotocol.com/account';
const ACCOUNTS = ['hall', 'asha', 'sam', 'maya', 'leo', 'fan'].map(demoAccount);
const CHECK_ONLY = process.argv.includes('--check');
const TRIES = Number(process.env.FAUCET_TRIES ?? 48);
/** The first wait after a refusal. Each later one doubles, up to MAX_WAIT_S: about ten hours in all. */
const WAIT_S = Number(process.env.FAUCET_WAIT_S ?? 120);
const MAX_WAIT_S = Number(process.env.FAUCET_MAX_WAIT_S ?? 900);

const clock = () => new Date().toTimeString().slice(0, 8);
const say = (text) => console.log(`${clock()}  ${text}`);

/** The public key the account should be created with: the one already saved, or a new one. */
function keyFor(id) {
  const file = join(KEYCHAIN, `${id}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')).public_key;
  const saved = [...keysFor(id).keys()][0];
  if (saved) return saved;
  const pair = KeyPair.fromRandom('ed25519');
  mkdirSync(KEYCHAIN, { recursive: true });
  writeFileSync(file, JSON.stringify({ account_id: id, public_key: pair.getPublicKey().toString(), private_key: pair.toString() }));
  return pair.getPublicKey().toString();
}

async function state(id) {
  const account = await reader.account(id);
  if (!account.exists) return { exists: false };
  let ours = false;
  for (const publicKey of keysFor(id).keys()) ours ||= await reader.hasKey(id, publicKey);
  return { exists: true, ours, balance: account.balance };
}

async function create(id) {
  const publicKey = keyFor(id);
  for (let attempt = 1; attempt <= TRIES; attempt += 1) {
    let status = 0;
    let wait = Math.min(WAIT_S * 2 ** (attempt - 1), MAX_WAIT_S);
    let detail = '';
    try {
      const response = await fetch(FAUCET, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newAccountId: id, newAccountPublicKey: publicKey }),
      });
      status = response.status;
      const after = Number(response.headers.get('retry-after'));
      if (after > 0) wait = Math.min(Math.max(after, 30), 1800);
      detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 160);
    } catch (error) {
      detail = String(error.message ?? error).slice(0, 160);
    }
    // The chain, not the faucet's answer, says whether the account is there.
    for (let look = 0; look < (status === 200 ? 20 : 2); look += 1) {
      const now = await state(id);
      if (now.exists) return now;
      await pause(3000);
    }
    const why = status === 429 ? 'the faucet is busy (429 Too Many Requests)' : `the faucet answered ${status || 'nothing'}${detail ? `: ${detail}` : ''}`;
    if (attempt === TRIES) throw new Error(`${id} was not created: ${why}`);
    say(`${id}: ${why}. Trying again in ${wait} s (attempt ${attempt} of ${TRIES}). Ctrl+C stops; nothing is lost.`);
    await pause(wait * 1000);
  }
  throw new Error(`${id} was not created`);
}

let ready = 0;
for (const id of ACCOUNTS) {
  let now = await state(id);
  if (!now.exists && !CHECK_ONLY) {
    say(`${id}: asking the faucet...`);
    now = await create(id);
    await pause(15_000); // go easy on the faucet between accounts
  }
  if (!now.exists) say(`${id}: not created yet`);
  else if (!now.ours) say(`${id}: exists, but this computer has no key for it. Someone else owns that name: set CHOIR_PREFIX=choir-yourname and run this again.`);
  else {
    ready += 1;
    say(`${id}: ready, ${toNear(now.balance)} NEAR`);
  }
}
console.log(`\n${ready} of ${ACCOUNTS.length} accounts are ready.${ready === ACCOUNTS.length ? ' Next: node scripts/deploy-testnet.mjs' : ''}`);
if (ready !== ACCOUNTS.length && !CHECK_ONLY) process.exit(1);
