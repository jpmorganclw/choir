// Real testnet access for the scripts and the server: pinned reads through the same reader the
// app uses, and signing with this project's own accounts from the local NEAR keychain.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from 'near-api-js';
import { rpcReader } from '../app/src/lib/reader.js';
import { nep413Hash } from './gate.mjs';

export const RPCS = (process.env.NEAR_RPC_URLS ?? 'https://rpc.testnet.fastnear.com,https://test.rpc.fastnear.com,https://near-testnet.drpc.org').split(',');
export const KV = 'https://kv.test.fastnear.com';
export const EXPLORER = 'https://testnet.nearblocks.io';
export const SOCIAL = 'social';
export const TGAS = 10n ** 12n;
export const YOCTO = 10n ** 24n;
export const near = (n) => (BigInt(Math.round(Number(n) * 1e6)) * YOCTO) / 1_000_000n;
export const toNear = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;

export const provider = new FailoverRpcProvider(RPCS.map((url) => new JsonRpcProvider({ url })));
export const reader = rpcReader(RPCS);
export { actions };

/** The local keychain may hold other accounts too. Only Choir's own demo accounts may sign here. */
const OURS = /^([a-z0-9-]+\.)*choir-[a-z0-9-]+\.testnet$/;
export const KEYCHAIN = join(homedir(), '.near-credentials', 'testnet');

export const isOurs = (id) => OURS.test(id);

/** The demo accounts are <prefix>-hall, <prefix>-asha and so on. CHOIR_PREFIX=choir-yourname makes a second, separate set. */
export const PREFIX = process.env.CHOIR_PREFIX ?? 'choir';
if (!/^choir(-[a-z0-9]+)*$/.test(PREFIX)) throw new Error('CHOIR_PREFIX has to start with "choir", for example choir-yourname');
export const demoAccount = (role) => `${PREFIX}-${role}.testnet`;

/**
 * Every key the keychain holds for an account, as public key -> secret key. near-cli keeps one in
 * `<account>.json` and one per key in `<account>/<public key>.json`.
 */
export function keysFor(id) {
  const found = new Map();
  if (!isOurs(id)) return found;
  const files = [join(KEYCHAIN, `${id}.json`)];
  const folder = join(KEYCHAIN, id);
  if (existsSync(folder) && statSync(folder).isDirectory()) {
    for (const name of readdirSync(folder)) if (name.endsWith('.json')) files.push(join(folder, name));
  }
  for (const file of files) {
    try {
      const secret = JSON.parse(readFileSync(file, 'utf8')).private_key;
      if (secret) found.set(KeyPair.fromString(secret).getPublicKey().toString(), secret);
    } catch {
      // not there, or not a key file
    }
  }
  return found;
}

// near-cli saves a new key before it asks the faucet for the account, so a refused attempt leaves
// a key behind that the account never got. Where the keychain holds more than one key for one of
// our accounts, the chain is asked once, here, which of them the account really has.
const chosen = new Map();
if (existsSync(KEYCHAIN)) {
  const ids = new Set(readdirSync(KEYCHAIN).map((name) => name.replace(/\.json$/, '')).filter(isOurs));
  for (const id of ids) {
    const found = keysFor(id);
    if (found.size < 2) continue;
    let live;
    for (const [publicKey, secret] of found) {
      if (await reader.hasKey(id, publicKey).catch(() => false)) live = secret;
    }
    chosen.set(id, live ?? null);
  }
}

export const hasKey = (id) => (chosen.has(id) ? chosen.get(id) !== null : keysFor(id).size === 1);

export function secretKeyOf(id) {
  if (!isOurs(id)) throw new Error(`${id} is not one of Choir's accounts, so this project will not sign as it`);
  if (chosen.get(id) === null) {
    throw new Error(`The local NEAR keychain has keys for ${id}, but the account on testnet has none of them. It may not have been created yet: run node scripts/accounts-testnet.mjs.`);
  }
  const secret = chosen.get(id) ?? [...keysFor(id).values()][0];
  if (!secret) throw new Error(`No key for ${id} in the local NEAR keychain. Create the account first: node scripts/accounts-testnet.mjs.`);
  return secret;
}

export const accountOf = (id) => new Account(id, provider, KeyPairSigner.fromSecretKey(secretKeyOf(id)));

/** Pulls the useful parts out of a transaction result, including every failed receipt. */
export function outcomeOf(tx) {
  const receipts = tx.receipts_outcome ?? [];
  const logs = receipts.flatMap((r) => r.outcome.logs);
  const failures = receipts
    .map((r) => ({ failure: r.outcome.status?.Failure, account: r.outcome.executor_id }))
    // A write to near.social always fails as a receipt: nothing is deployed there. That is expected.
    .filter((r) => r.failure && r.account !== SOCIAL)
    .map((r) => ({ account: r.account, error: JSON.stringify(r.failure).slice(0, 400) }));
  const success = tx.status?.SuccessValue;
  let value;
  if (success !== undefined) {
    const text = Buffer.from(success, 'base64').toString();
    try {
      value = text ? JSON.parse(text) : undefined;
    } catch {
      value = text;
    }
  }
  return {
    hash: tx.transaction_outcome?.id ?? tx.transaction?.hash,
    ok: success !== undefined,
    value,
    error: tx.status?.Failure ? JSON.stringify(tx.status.Failure).slice(0, 400) : undefined,
    failures,
    logs,
    events: logs.filter((log) => log.startsWith('EVENT_JSON:')).map((log) => JSON.parse(log.slice('EVENT_JSON:'.length))),
    gasBurnt: receipts.reduce((sum, r) => sum + r.outcome.gas_burnt, tx.transaction_outcome?.outcome?.gas_burnt ?? 0),
  };
}

export async function send(signerId, receiverId, list, waitUntil = 'FINAL') {
  const tx = await accountOf(signerId).signAndSendTransaction({ receiverId, actions: list, waitUntil, throwOnFailure: false });
  return outcomeOf(tx);
}

export async function call(signerId, receiverId, method, args = {}, { deposit = 0n, gas = 300n * TGAS } = {}) {
  // A write to near.social carries 1 gas and is meant to fail: nothing is deployed on `social`.
  if (method === '__fastdata_kv') {
    try {
      const result = await send(signerId, receiverId, [actions.functionCall(method, args, 1n, 0n)], 'INCLUDED_FINAL');
      return { ...result, ok: true, error: undefined };
    } catch (error) {
      return { ok: true, note: String(error?.message ?? error).slice(0, 200) };
    }
  }
  return send(signerId, receiverId, [actions.functionCall(method, args, BigInt(gas), BigInt(deposit))]);
}

export const transfer = (signerId, receiverId, amount) => send(signerId, receiverId, [actions.transfer(BigInt(amount))]);

export const view = (accountId, method, args = {}) => reader.view(accountId, method, args);

export function signNep413(id, nonceBase64) {
  const pair = KeyPair.fromString(secretKeyOf(id));
  const { signature } = pair.sign(nep413Hash({ nonce: Buffer.from(nonceBase64, 'base64') }));
  return { accountId: id, publicKey: pair.getPublicKey().toString(), signature: Buffer.from(signature).toString('base64') };
}

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
