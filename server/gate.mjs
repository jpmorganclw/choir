// The conductor's desk: a page only the current holder of a Choir can open.
//
// Signing in proves who someone is (a NEP-413 signature by a key that is on their account).
// Opening the desk is decided by asking the chain who holds the seat NOW, with the pair check
// pinned to one final block, on every single request. So nothing a seller keeps from before a
// sale (a session, a signature, a browser tab) opens anything afterwards.

import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { pair } from '../app/src/lib/verify.js';

export const RECIPIENT = 'choir-desk';
export const MESSAGE = "Open the conductor's desk";
const NONCE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 60 * 60 * 1000;
const NEP413_TAG = 2147484061; // 2^31 + 413
const MAX_NOTES = 4000;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58decode(text) {
  let n = 0n;
  for (const char of text) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(value);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const char of text) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

export function base58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const borshString = (text) => {
  const value = Buffer.from(text, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(value.length);
  return Buffer.concat([length, value]);
};

/** The 32 bytes a NEP-413 wallet signs for this message. */
export function nep413Hash({ message = MESSAGE, nonce, recipient = RECIPIENT, callbackUrl = null }) {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  const callback = callbackUrl === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), borshString(callbackUrl)]);
  return createHash('sha256').update(Buffer.concat([tag, borshString(message), nonce, borshString(recipient), callback])).digest();
}

export function verifyNep413({ publicKey, signature, nonce, message = MESSAGE, recipient = RECIPIENT }) {
  try {
    const [scheme, data] = String(publicKey).split(':');
    if (scheme !== 'ed25519' || !data) return false;
    const raw = base58decode(data);
    if (raw.length !== 32 || nonce.length !== 32) return false;
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
    return verify(null, nep413Hash({ message, nonce, recipient }), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

class Refused extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/**
 * `reader` is the verifier's reader (finalBlock, view, keys) plus `hasKey(accountId, publicKey)`.
 * `collection` is pinned here, from the server's own configuration.
 * `store` keeps the notes: { get(choir), set(choir, text) }.
 */
export function createGate({ reader, collection, store, now = () => Date.now() }) {
  const nonces = new Map();
  const sessions = new Map();

  function challenge() {
    for (const [nonce, expires] of nonces) if (expires < now()) nonces.delete(nonce);
    const nonce = randomBytes(32).toString('base64');
    nonces.set(nonce, now() + NONCE_TTL_MS);
    return { nonce, message: MESSAGE, recipient: RECIPIENT };
  }

  /** Who holds this Choir, as the account and the collection agree at one final block. */
  async function holder(choir) {
    const result = await pair(reader, collection, choir);
    if (!result.ok) throw new Refused(403, `This is not a Choir of ${collection}, or its two records disagree (${result.reason}).`, { reason: result.reason });
    return result;
  }

  async function enter({ choir, accountId, publicKey, signature, nonce }) {
    const expires = nonces.get(nonce);
    nonces.delete(nonce); // one use, whatever happens next
    if (!expires || expires < now()) throw new Refused(401, 'That sign-in request has expired. Try again.');
    if (!verifyNep413({ publicKey, signature, nonce: Buffer.from(String(nonce), 'base64') })) {
      throw new Refused(401, 'The signature does not match.');
    }
    if (!(await reader.hasKey(accountId, publicKey))) throw new Refused(401, `That key is not on ${accountId}.`);
    const proof = await holder(choir);
    if (proof.owner !== accountId) {
      throw new Refused(403, `Only the conductor can open this desk. The seat is held by ${proof.owner}.`, { owner: proof.owner });
    }
    const session = randomBytes(24).toString('hex');
    sessions.set(session, { accountId, choir, expires: now() + SESSION_TTL_MS });
    return { session };
  }

  /** Every request with a session asks the chain again. A session is never proof of holding. */
  async function check(session, choir) {
    const found = sessions.get(session);
    if (!found || found.expires < now() || found.choir !== choir) throw new Refused(401, 'Sign in to open the desk.');
    const proof = await holder(choir);
    if (proof.owner !== found.accountId) {
      sessions.delete(session);
      throw new Refused(403, `The seat has moved to ${proof.owner}. This desk is theirs now.`, { owner: proof.owner });
    }
    return { accountId: found.accountId, proof };
  }

  async function open(session, choir) {
    const { accountId, proof } = await check(session, choir);
    return {
      conductor: accountId,
      notes: (await store.get(choir)) ?? '',
      proof: { block: proof.block.height, owner: proof.owner, seq: proof.seq, status: proof.status },
    };
  }

  async function save(session, choir, notes) {
    await check(session, choir);
    const text = String(notes ?? '');
    if (text.length > MAX_NOTES) throw new Refused(400, `Notes can be up to ${MAX_NOTES} characters.`);
    await store.set(choir, text);
    return { saved: true };
  }

  return { challenge, enter, open, save, Refused };
}
