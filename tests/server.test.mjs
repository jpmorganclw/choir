// The server a judge starts with `npm run demo`: its practice chain, its near.social data
// endpoints and the holder-only desk, over real HTTP.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HALL = 'choir-hall.testnet';
const BUILDERS = `builders.${HALL}`;
let server;
let base;

before(async () => {
  server = spawn(process.execPath, ['server/index.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((resolve, reject) => {
    let seen = '';
    server.stdout.on('data', (chunk) => {
      seen += chunk;
      const found = seen.match(/Choir is at (http:\/\/localhost:\d+)/);
      if (found) resolve(found[1]);
    });
    server.stderr.on('data', (chunk) => { seen += chunk; });
    server.on('exit', () => reject(new Error(`the server stopped: ${seen}`)));
  });
});
after(() => server?.kill());

async function send(path, body, { method = 'POST', headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json() };
}
const view = async (account, method, args = {}) => (await send('/local/view', { account, method, args })).body.value;
const act = (persona, receiver, method, args = {}, deposit = '0') => send('/act/call', { persona, receiver, method, args, deposit });

test('server: tells the app how it is running', async () => {
  const { body } = await send('/config.json', null, { method: 'GET' });
  assert.equal(body.mode, 'local');
  assert.equal(body.signer, 'server');
  assert.equal(body.collection, HALL);
  assert.deepEqual(body.personas.map((p) => p.name), ['Asha', 'Maya', 'Leo', 'Fan', 'Sam']);
});

test('server: a person acts through it and the account answers on near.social', async () => {
  const before = await view(BUILDERS, 'get_choir');
  const tipped = await act('fan.testnet', BUILDERS, 'tip', { memo: 'over http' }, '2005000000000000000000000');
  assert.equal(tipped.body.ok, true);
  assert.deepEqual(tipped.body.failures, []);
  const after = await view(BUILDERS, 'get_choir');
  assert.equal(BigInt(after.pot) - BigInt(before.pot), 1_800_000_000_000_000_000_000_000n);

  const joined = await act('sam.testnet', BUILDERS, 'join', {}, '10000000000000000000000');
  assert.equal(joined.body.ok, true);
  assert.deepEqual(joined.body.failures, [], 'the expected failure of the near.social receipt is not reported as a problem');
  const follows = await send(`/kv/v0/latest/social/${BUILDERS}`, { key_prefix: 'graph/follow/' });
  assert.ok(follows.body.entries.some((row) => row.key === 'graph/follow/sam.testnet' && row.predecessor_id === BUILDERS));

  const followers = await send('/kv/v0/latest/social', { key: 'graph/follow/sam.testnet' });
  assert.deepEqual(followers.body.entries.map((row) => row.predecessor_id), [BUILDERS]);
  const many = await send('/kv/v0/multi', { keys: [`social/${BUILDERS}/profile/name`, 'social/nobody.testnet/profile/name'] });
  assert.equal(many.body.entries[0].value, 'NEAR Builders');
  assert.equal(many.body.entries[1], null);
});

test('server: a refusal by the contract comes back in its own words', async () => {
  const refused = await act('maya.testnet', BUILDERS, 'withdraw_seat', {});
  assert.equal(refused.body.ok, false);
  assert.match(refused.body.error, /Only the conductor can do this/);
  const stranger = await act('mallory.testnet', BUILDERS, 'tip', {}, '1000000000000000000000000');
  assert.equal(stranger.status, 400);
  assert.match(stranger.body.error, /Pick one of the listed people/);
});

test('server: the desk opens for the conductor and for nobody else', async () => {
  const signIn = async (persona) => {
    const { body: challenge } = await send('/gate/challenge');
    const { body: signed } = await send('/act/sign', { persona, nonce: challenge.nonce });
    return send('/gate/enter', { choir: BUILDERS, ...signed, nonce: challenge.nonce });
  };
  const member = await signIn('maya.testnet');
  assert.equal(member.status, 403);
  assert.match(member.body.error, /Only the conductor can open this desk/);

  const conductor = await signIn('asha.testnet');
  assert.equal(conductor.status, 200);
  const session = { authorization: `Bearer ${conductor.body.session}` };
  const desk = await send(`/gate/desk/${BUILDERS}`, null, { method: 'GET', headers: session });
  assert.equal(desk.body.conductor, 'asha.testnet');
  assert.match(desk.body.notes, /Sponsor contact/);
  assert.equal((await send(`/gate/desk/${BUILDERS}`, { notes: 'For whoever comes next.' }, { method: 'PUT', headers: session })).body.saved, true);

  // The seat is handed over. The very next request with the old session is refused.
  const moved = await act('asha.testnet', HALL, 'nft_transfer', { receiver_id: 'sam.testnet', token_id: BUILDERS }, '1');
  assert.equal(moved.body.value, true);
  const stale = await send(`/gate/desk/${BUILDERS}`, null, { method: 'GET', headers: session });
  assert.equal(stale.status, 403);
  assert.match(stale.body.error, /The seat has moved to sam\.testnet/);
  const next = await signIn('sam.testnet');
  const theirs = await send(`/gate/desk/${BUILDERS}`, null, { method: 'GET', headers: { authorization: `Bearer ${next.body.session}` } });
  assert.equal(theirs.body.notes, 'For whoever comes next.');
});

test('server: time on the practice chain moves only when asked, and reset starts over', async () => {
  const start = (await send('/local/state')).body.nowMs;
  const later = (await send('/local/skip', { ms: 86_400_000 })).body.nowMs;
  assert.equal(later - start, 86_400_000);
  await send('/local/reset');
  assert.equal((await view(BUILDERS, 'get_choir')).conductor, 'asha.testnet', 'the handover above is gone');
});
