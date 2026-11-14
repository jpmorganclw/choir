// near.social, read straight from FastData KV (no indexer of our own) and written as plain
// `__fastdata_kv` calls. The practice chain serves the same three endpoints from memory.
//
// Everything on near.social is keyed by (receiver, writer, key). The writer of a row is the
// account whose receipt carried it, so a row written by a Choir can only have come from its code.

import { call, cfg } from './api.js';

async function kv(path, body) {
  const response = await fetch(`${cfg().kv}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`near.social data is not answering (${response.status})`);
  return (await response.json()).entries ?? [];
}

/** Latest value of every key `account` wrote under `prefix`. */
export const latest = (account, prefix) => kv(`/v0/latest/${cfg().social}/${account}`, { key_prefix: prefix });

/** Latest value of exact keys, as [row | null] in the same order. */
export async function multi(keys) {
  if (!keys.length) return [];
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    out.push(...(await kv('/v0/multi', { keys: keys.slice(i, i + 100).map((k) => `${cfg().social}/${k}`) })));
  }
  return out;
}

const toMs = (row) => Math.floor(Number(row.block_timestamp) / 1e6);

const profiles = new Map();
/** Display names for accounts, from their near.social profiles. Missing ones fall back to the id. */
export async function names(accounts) {
  const wanted = [...new Set(accounts)].filter((a) => a && !profiles.has(a));
  if (wanted.length) {
    const rows = await multi(wanted.map((a) => `${a}/profile/name`)).catch(() => []);
    wanted.forEach((a, i) => profiles.set(a, typeof rows[i]?.value === 'string' && rows[i].value ? rows[i].value : null));
  }
  return Object.fromEntries(accounts.map((a) => [a, profiles.get(a) ?? null]));
}

/**
 * What a Choir's account shows on near.social, newest first: its reposts of members' posts, and
 * the posts its own code composed (round receipts and handovers).
 */
export async function feedOf(choirId) {
  const [reposts, own] = await Promise.all([latest(choirId, 'repost/'), latest(choirId, 'post/')]);
  const live = reposts.filter((row) => row.value && typeof row.value === 'object');
  const refs = live.map((row) => row.key.slice('repost/'.length)); // author/post_id
  const originals = await multi(refs.map((ref) => ref.replace('/', '/post/')));
  const items = [];
  live.forEach((row, i) => {
    const [author, postId] = refs[i].split('/');
    const original = originals[i];
    items.push({
      kind: 'repost',
      at: toMs(row),
      author,
      postId,
      text: original?.value?.text ?? null,
      postedAt: original ? toMs(original) : null,
    });
  });
  for (const row of own) {
    if (!row.value || typeof row.value !== 'object') continue;
    items.push({ kind: 'own', at: toMs(row), author: choirId, postId: row.key.slice('post/'.length), text: row.value.text ?? '' });
  }
  items.sort((a, b) => b.at - a.at);
  const display = await names(items.map((item) => item.author));
  return items.map((item) => ({ ...item, name: display[item.author] }));
}

/** An account's own recent top-level posts, newest first. */
export async function postsOf(account, limit = 8) {
  const rows = await latest(account, 'post/');
  return rows
    .filter((row) => row.value && typeof row.value === 'object' && !row.value.reply_to && typeof row.value.text === 'string')
    .map((row) => ({ id: row.key.slice('post/'.length), text: row.value.text, at: toMs(row) }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

/** Who the Choir follows on near.social: its members, as the account itself declares them. */
export async function followsOf(choirId) {
  const rows = await latest(choirId, 'graph/follow/');
  return rows.filter((row) => row.value && typeof row.value === 'object').map((row) => row.key.slice('graph/follow/'.length));
}

export async function profileOf(account) {
  const rows = await latest(account, 'profile/');
  return Object.fromEntries(rows.map((row) => [row.key.slice('profile/'.length), row.value]));
}

let lastId = 0;
/**
 * Writes a post from the user's OWN account. The id is the time in milliseconds, as near.social
 * asks. The transaction is expected to "fail" on chain; the data layer reads its arguments.
 */
export async function writePost(user, text, atMs) {
  const id = Math.max(Math.floor(atMs ?? Date.now()), lastId + 1);
  lastId = id;
  const result = await call(user, cfg().social, '__fastdata_kv', { [`post/${id}`]: { text } }, { gas: '1' });
  if (!result.ok) throw new Error(result.error ?? 'The post was not sent.');
  return String(id);
}

/** Waits until a row shows up in the data layer (it trails the chain by a few seconds). */
export async function waitFor(account, key, tries = 12, delayMs = 1200) {
  for (let i = 0; i < tries; i += 1) {
    const [row] = await multi([`${account}/${key}`]).catch(() => [null]);
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

/** Where the same thing can be seen on near.social itself (mainnet only). */
export function socialLink(account, postId) {
  if (cfg().network !== 'mainnet') return null;
  return postId ? `https://near.social/${account}/post/${postId}` : `https://near.social/${account}`;
}
