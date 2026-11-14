// Serves the app and the conductor's desk.
//
//   node server/index.mjs                 practice chain in this process: no wallet, no network
//   node server/index.mjs --testnet       the live testnet deployment, signing in the user's wallet
//   node server/index.mjs --testnet --personas
//                                         testnet, signing as this project's own demo accounts from
//                                         the local keychain (how the demo video was recorded)
//
// PORT picks the port (default 8791).

import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGate } from './gate.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'app', 'dist');
const PORT = Number(process.env.PORT ?? 8791);
const TESTNET = process.argv.includes('--testnet');
const PERSONAS = process.argv.includes('--personas');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

let local = null;
let testnet = null;
let config;
let gate;

if (TESTNET) {
  testnet = await import('./testnet.mjs');
  const deployment = JSON.parse(readFileSync(join(ROOT, 'deployments', 'testnet.json'), 'utf8'));
  const personas = PERSONAS ? (deployment.personas ?? []).filter((p) => testnet.hasKey(p.id)) : [];
  config = {
    mode: 'testnet',
    network: 'testnet',
    signer: personas.length ? 'server' : 'wallet',
    collection: deployment.collection,
    social: testnet.SOCIAL,
    rpc: testnet.RPCS,
    kv: testnet.KV,
    explorer: testnet.EXPLORER,
    gate: '',
    personas,
    itemCode: deployment.item_code,
  };
  mkdirSync(join(ROOT, '.local'), { recursive: true });
  const notesFile = join(ROOT, '.local', 'desk-notes.json');
  const notes = existsSync(notesFile) ? JSON.parse(readFileSync(notesFile, 'utf8')) : {};
  gate = createGate({
    reader: testnet.reader,
    collection: config.collection,
    store: {
      get: (choir) => notes[choir],
      set: (choir, text) => {
        notes[choir] = text;
        writeFileSync(notesFile, JSON.stringify(notes, null, 2));
      },
    },
  });
} else {
  const { createLocal, COLLECTION, SOCIAL } = await import('./local.mjs');
  local = createLocal({ site: `http://localhost:${PORT}/` });
  config = {
    mode: 'local',
    network: 'local',
    signer: 'server',
    collection: COLLECTION,
    social: SOCIAL,
    rpc: [],
    kv: '/kv',
    explorer: null,
    gate: '',
    personas: local.people().map(({ id, name, role }) => ({ id, name, role })),
  };
  const notes = new Map([[`builders.${COLLECTION}`, 'Sponsor contact for demo day: ask Noor at the hub.\nThe venue wants the headcount by Wednesday.']]);
  gate = createGate({
    reader: local.reader,
    collection: COLLECTION,
    store: { get: (choir) => notes.get(choir), set: (choir, text) => notes.set(choir, text) },
  });
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 300_000) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

const bearer = (req) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = decodeURIComponent(url.pathname);
  const method = req.method;

  if (path === '/config.json') return json(res, 200, config);

  // ---- the conductor's desk ----
  if (path === '/gate/challenge' && method === 'POST') return json(res, 200, gate.challenge());
  if (path === '/gate/enter' && method === 'POST') return json(res, 200, await gate.enter(await body(req)));
  if (path.startsWith('/gate/desk/')) {
    const choir = path.slice('/gate/desk/'.length);
    if (method === 'GET') return json(res, 200, await gate.open(bearer(req), choir));
    if (method === 'PUT') return json(res, 200, await gate.save(bearer(req), choir, (await body(req)).notes));
  }

  // ---- signing as a demo person (practice chain, or --personas on testnet) ----
  if (config.signer === 'server' && method === 'POST') {
    const args = path.startsWith('/act/') ? await body(req) : null;
    const known = args && config.personas.some((p) => p.id === args.persona);
    if (args && !known) return json(res, 400, { error: 'Pick one of the listed people to act as.' });
    if (path === '/act/call') {
      if (local) return json(res, 200, local.call(args));
      return json(res, 200, await testnet.call(args.persona, args.receiver, args.method, args.args ?? {}, { deposit: BigInt(args.deposit ?? '0'), gas: BigInt(args.gas ?? '300000000000000') }));
    }
    if (path === '/act/send') {
      if (local) return json(res, 200, local.send(args));
      return json(res, 200, await testnet.transfer(args.persona, args.receiver, args.amount));
    }
    if (path === '/act/sign') {
      return json(res, 200, local ? local.signNep413(args.persona, args.nonce) : testnet.signNep413(args.persona, args.nonce));
    }
  }

  // ---- the practice chain ----
  if (local && method === 'POST') {
    if (path === '/local/view') {
      const { account, method: name, args } = await body(req);
      return json(res, 200, { value: local.view(account, name, args) });
    }
    if (path === '/local/account') return json(res, 200, local.account((await body(req)).id));
    if (path === '/local/state') return json(res, 200, local.state());
    if (path === '/local/skip') return json(res, 200, local.skip((await body(req)).ms));
    if (path === '/local/reset') {
      local.reset();
      return json(res, 200, local.state());
    }
    const kv = path.match(/^\/kv\/v0\/latest\/([^/]+)(?:\/([^/]+))?$/);
    if (kv) {
      const query = await body(req);
      return json(res, 200, kv[2] ? local.kv.byAccount(kv[1], kv[2], query) : local.kv.byKey(kv[1], query));
    }
    if (path === '/kv/v0/multi') return json(res, 200, local.kv.multi((await body(req)).keys));
  }

  // ---- the built app ----
  if (method === 'GET') {
    const file = normalize(join(DIST, path === '/' ? 'index.html' : path));
    if (file.startsWith(DIST) && existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      return createReadStream(file).pipe(res);
    }
    if (!existsSync(join(DIST, 'index.html'))) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      return res.end('The app is not built yet. Run: npm run build:app');
    }
  }
  return json(res, 404, { error: 'Not found' });
}

const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    // Anything thrown here is an answer for the person using the app: a refusal by the gate, or a
    // contract panic from the practice chain.
    const status = error.status ?? 400;
    json(res, status, { error: String(error.message ?? error), ...(error.extra ?? {}) });
  });
})
  .on('error', (error) => {
    if (error.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Pick another one: PORT=8899 npm start`);
    else console.error(error);
    process.exit(1);
  })
  .listen(PORT, () => {
    // PORT=0 asks the system for any free port, which is what the tests do.
    const how = local ? 'practice chain (no wallet, no network)' : `testnet, ${config.signer === 'server' ? 'signing as demo accounts' : 'signing in your wallet'}`;
    console.log(`Choir is at http://localhost:${server.address().port}  [${how}]`);
  });
