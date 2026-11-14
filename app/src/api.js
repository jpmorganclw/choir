// One data layer for every way of running the app:
//   - the practice chain inside the local server (signer: server, mode: local)
//   - real testnet, signing as this project's demo accounts through the server (signer: server)
//   - real testnet, signing in the visitor's own wallet (signer: wallet)

import { rpcReader } from './lib/reader.js';

export const GAS = '300000000000000';
export const ONE_YOCTO = '1';
export const YOCTO = 10n ** 24n;
/** Fixed record fees the contracts ask for. They pay for the bytes each action stores. */
export const FEES = {
  join: YOCTO / 100n,
  amplify: YOCTO / 200n,
  tip: YOCTO / 200n,
  payout: YOCTO / 1000n,
  minTip: YOCTO / 20n,
  minCreate: (YOCTO * 27n) / 100n,
};

let config = null;
let connector = null;
let chainReader = null;

export async function loadConfig() {
  config = await (await fetch('./config.json', { cache: 'no-store' })).json();
  if (config.signer === 'wallet') {
    const { NearConnector } = await import('@hot-labs/near-connect');
    connector = new NearConnector({ network: config.network });
  }
  chainReader = config.mode === 'local' ? localReader() : rpcReader(config.rpc);
  return config;
}

export const cfg = () => config;
export const usesServer = () => config.signer === 'server';
export const isLocal = () => config.mode === 'local';

async function post(path, body = {}, init = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error ?? 'Request failed'), data, { status: response.status });
  return data;
}

function localReader() {
  return {
    finalBlock: () => post('/local/state'),
    view: async (account, method, args) => (await post('/local/view', { account, method, args })).value,
    keys: async (account) => (await post('/local/account', { id: account })).keys ?? 0,
    account: (id) => post('/local/account', { id }),
  };
}

/** The reader the verifier in lib/verify.js runs against. */
export const reader = () => chainReader;

export async function view(account, method, args = {}) {
  return chainReader.view(account, method, args);
}

/** A view that answers null instead of throwing, for things that may not exist. */
export async function tryView(account, method, args = {}) {
  try {
    return await view(account, method, args);
  } catch {
    return null;
  }
}

export const accountInfo = (id) => chainReader.account(id);

export async function nowMs() {
  if (isLocal()) return (await post('/local/state')).nowMs;
  return Date.now();
}

// ---- writing ----

function outcome(tx) {
  const receipts = tx.receipts_outcome ?? [];
  const success = tx.status?.SuccessValue;
  let value;
  if (success !== undefined && success !== '') {
    try {
      value = JSON.parse(atob(success));
    } catch {
      value = atob(success);
    }
  }
  const failures = receipts
    // A write to near.social always fails as a receipt: nothing is deployed there. That is expected.
    .filter((r) => r.outcome.executor_id !== config.social)
    .map((r) => r.outcome.status?.Failure)
    .filter(Boolean)
    .map((failure) => ({ error: JSON.stringify(failure) }));
  const events = receipts
    .flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith('EVENT_JSON:'))
    .map((l) => JSON.parse(l.slice(11)));
  return {
    hash: tx.transaction_outcome?.id ?? tx.transaction?.hash,
    ok: success !== undefined,
    value,
    failures,
    events,
    error: tx.status?.Failure ? JSON.stringify(tx.status.Failure) : undefined,
  };
}

/**
 * Sends one function call. Answers { ok, value, error, failures, events, hash }. It does not
 * throw when a contract refuses; use `explain` to turn the result into a sentence.
 */
export async function call(user, receiver, method, args = {}, { deposit = '0', gas = GAS } = {}) {
  if (usesServer()) {
    return post('/act/call', { persona: user, receiver, method, args, deposit: String(deposit), gas: String(gas) });
  }
  const wallet = await connector.wallet();
  try {
    const tx = await wallet.signAndSendTransaction({
      receiverId: receiver,
      actions: [{ type: 'FunctionCall', params: { methodName: method, args, gas: String(gas), deposit: String(deposit) } }],
    });
    return outcome(tx);
  } catch (error) {
    // A near.social write is meant to fail on chain: nothing is deployed on `social`.
    if (method === '__fastdata_kv') return { ok: true, value: undefined, failures: [], events: [] };
    return { ok: false, error: String(error?.message ?? error), failures: [], events: [] };
  }
}

export async function transferNear(user, receiver, amount) {
  if (usesServer()) return post('/act/send', { persona: user, receiver, amount: String(amount) });
  const wallet = await connector.wallet();
  try {
    return outcome(await wallet.signAndSendTransaction({ receiverId: receiver, actions: [{ type: 'Transfer', params: { deposit: String(amount) } }] }));
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), failures: [], events: [] };
  }
}

/** The contract's own words for why something was refused, or null if it went through. */
export function explain(result) {
  if (!result) return 'Nothing came back. Try again.';
  const raw = result.error ?? result.failures?.[0]?.error;
  if (result.ok && !result.failures?.length && result.value !== false && result.value !== null) return null;
  if (!raw) return result.value === false || result.value === null ? 'The contract refused, and everything was returned.' : null;
  const text = String(raw);
  const panic = text.match(/Smart contract panicked: ([^"\\]+)/);
  if (panic) return panic[1].trim();
  if (/NotEnoughBalance|LackBalance/i.test(text)) return 'There is not enough NEAR in the account for that.';
  if (/User (rejected|cancel)|rejected the request|closed the window/i.test(text)) return 'You cancelled it in your wallet.';
  return text.replace(/^Error: /, '').slice(0, 220);
}

// ---- time travel, on the practice chain only ----

export const skip = (ms) => post('/local/skip', { ms });
export const resetLocal = () => post('/local/reset');

// ---- wallets ----

export async function connectWallet() {
  await connector.connect();
  const wallet = await connector.wallet();
  const [account] = await wallet.getAccounts();
  return account?.accountId ?? null;
}

export async function restoreWallet() {
  if (!connector) return null;
  try {
    const wallet = await connector.wallet();
    const [account] = await wallet.getAccounts();
    return account?.accountId ?? null;
  } catch {
    return null;
  }
}

export const disconnectWallet = () => connector?.disconnect();

/** Some wallets finish signing in after the first call has returned, so follow their events too. */
export function onWalletChange(callback) {
  if (!connector) return () => {};
  const signedIn = ({ accounts }) => callback(accounts?.[0]?.accountId ?? null);
  const signedOut = () => callback(null);
  connector.on('wallet:signIn', signedIn);
  connector.on('wallet:signOut', signedOut);
  return () => {
    connector.off('wallet:signIn', signedIn);
    connector.off('wallet:signOut', signedOut);
  };
}

// ---- the conductor's desk (needs the server; a static host has none) ----

export const hasGate = () => config.gate !== null && config.gate !== undefined;
const gateUrl = (path) => `${config.gate ?? ''}${path}`;

async function gateCall(path, init = {}) {
  const response = await fetch(gateUrl(path), init);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error ?? 'Refused'), data, { status: response.status });
  return data;
}

export async function deskEnter(user, choir) {
  const { nonce, message, recipient } = await gateCall('/gate/challenge', { method: 'POST' });
  let signed;
  if (usesServer()) {
    signed = await post('/act/sign', { persona: user, nonce });
  } else {
    const wallet = await connector.wallet();
    signed = await wallet.signMessage({ message, recipient, nonce: Uint8Array.from(atob(nonce), (c) => c.charCodeAt(0)) });
  }
  const { session } = await gateCall('/gate/enter', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ choir, accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce }),
  });
  return session;
}

const bearer = (session) => ({ authorization: `Bearer ${session}` });
export const deskOpen = (choir, session) => gateCall(`/gate/desk/${choir}`, { headers: bearer(session) });
export const deskSave = (choir, session, notes) =>
  gateCall(`/gate/desk/${choir}`, { method: 'PUT', headers: { ...bearer(session), 'content-type': 'application/json' }, body: JSON.stringify({ notes }) });
