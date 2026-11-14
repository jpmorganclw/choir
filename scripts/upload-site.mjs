// Publishes the built app to FastFS, one testnet transaction per file.
//
//   npm run build:app
//   node scripts/upload-site.mjs
//
// A file already served with the same bytes is skipped. The page goes last, so the live site never
// points at an asset that has not arrived. Each transaction carries 1 gas and is meant to fail:
// nothing needs to run, the FastFS indexer reads the arguments.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { EXPLORER, KV, RPCS, SOCIAL, accountOf, actions, pause } from '../server/testnet.mjs';

const DIST = 'app/dist';
const deployment = JSON.parse(readFileSync('deployments/testnet.json', 'utf8'));
const SENDER = deployment.site_sender;
const RECEIVER = deployment.collection;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};
const MAX_PAYLOAD = 1_400_000;

// The hosted copy has no server behind it: visitors sign in their own wallet, and the desk's
// private notes (which need the desk server) are switched off.
writeFileSync(
  join(DIST, 'config.json'),
  JSON.stringify({
    mode: 'testnet',
    network: 'testnet',
    signer: 'wallet',
    collection: deployment.collection,
    social: SOCIAL,
    rpc: RPCS,
    kv: KV,
    explorer: EXPLORER,
    gate: null,
    personas: [],
    itemCode: deployment.item_code,
  }),
);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const urlOf = (path) => `https://test.fastfs.io/${SENDER}/${RECEIVER}/${path}`;
const u32 = (n) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(n);
  return buffer;
};
const string = (text) => Buffer.concat([u32(Buffer.byteLength(text)), Buffer.from(text)]);

async function upload(path, mime, content) {
  // borsh: FastfsData::Simple { relative_path, content: Some({ mime_type, content }) }
  const payload = Buffer.concat([Buffer.from([0]), string(path), Buffer.from([1]), string(mime), u32(content.length), content]);
  if (payload.length > MAX_PAYLOAD) throw new Error(`${path} is too large for one transaction`);
  try {
    const tx = await accountOf(SENDER).signAndSendTransaction({
      receiverId: RECEIVER,
      actions: [actions.functionCall('__fastdata_fastfs', payload, 1n, 0n)],
      waitUntil: 'INCLUDED_FINAL',
      throwOnFailure: false,
    });
    return tx.transaction?.hash ?? tx.transaction_outcome?.id;
  } catch (error) {
    const message = String(error.message ?? error);
    if (!/prepaid gas|MethodNotFound|CodeDoesNotExist/i.test(message)) throw error;
    return `sent (${message.slice(0, 80)})`;
  }
}

async function served(path) {
  // The host remembers a 404 for a while, so every probe uses a fresh query string.
  const response = await fetch(`${urlOf(path)}?v=${Date.now()}`).catch(() => null);
  return response?.ok ? sha256(Buffer.from(await response.arrayBuffer())) : null;
}

/** Stops the whole run if a file never arrives, so the page is not pointed at a missing asset. */
async function deliver(path, mime, content, hash) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    let tx;
    try {
      tx = await upload(path, mime, content);
    } catch (error) {
      console.log(`${path}: try ${attempt} was not sent: ${String(error.message).slice(0, 90)}`);
      await pause(30_000);
      continue;
    }
    await pause(10_000);
    for (let i = 0; i < 12; i += 1) {
      if ((await served(path)) === hash) return tx;
      await pause(10_000);
    }
  }
  throw new Error(`${path} did not arrive, so the page was left as it was`);
}

const files = readdirSync(DIST, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(DIST, join(entry.parentPath, entry.name)).split(sep).join('/'))
  .sort((a, b) => Number(a === 'index.html') - Number(b === 'index.html'));

for (const path of files) {
  const content = readFileSync(join(DIST, path));
  const hash = sha256(content);
  if ((await served(path)) === hash) {
    console.log(`${path}: already there`);
    continue;
  }
  const mime = MIME[extname(path)];
  if (!mime) throw new Error(`No media type for ${path}`);
  console.log(`${path}: ${content.length} bytes, served, ${await deliver(path, mime, content, hash)}`);
}

console.log(`\n${urlOf('index.html')}`);
