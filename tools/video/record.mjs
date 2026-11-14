// Films the real app. Every click on screen is a real action against the contracts: on testnet
// when FILM_MODE=testnet (the demo accounts sign through the local server, with no wallet popup),
// or on the practice chain otherwise.
//
//   node tools/video/record.mjs                    practice chain
//   FILM_MODE=testnet node tools/video/record.mjs  live testnet, as the choir-* demo accounts
//
// Frames, their timestamps and named marks go to ~/.choir/video/takes/<take>. compose.mjs cuts
// them together.

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const MODE = process.env.FILM_MODE === 'testnet' ? 'testnet' : 'local';
const TAKE = process.env.FILM_TAKE ?? `${MODE}1`;
const HOME = process.env.CHOIR_VIDEO_HOME ?? join(homedir(), '.choir', 'video');
const OUT = join(HOME, 'takes', TAKE);
const FRAMES = join(OUT, 'frames');
const SHARP = Number(process.env.FILM_DSF ?? 3);
const PORT = Number(process.env.FILM_PORT ?? 28891);
const BASE = `http://127.0.0.1:${PORT}/`;
const POST = 'Our testnet faucet guide is live. Twelve steps, zero jargon.';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- the app ----

const server = spawn(process.execPath, ['server/index.mjs', ...(MODE === 'testnet' ? ['--testnet', '--personas'] : [])], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((ready, fail) => {
  server.stdout.on('data', (chunk) => {
    process.stdout.write(`[server] ${chunk}`);
    if (String(chunk).includes('Choir is at')) ready();
  });
  server.on('exit', () => fail(new Error('server stopped')));
});
const config = await (await fetch(`${BASE}config.json`)).json();
const who = Object.fromEntries(config.personas.map((p) => [p.name.toLowerCase(), p.id]));
const CHOIR = `${process.env.FILM_CHOIR ?? 'builders'}.${config.collection}`;

// ---- the camera ----

rmSync(OUT, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const log = { mode: MODE, choir: CHOIR, frames: [], marks: [], errors: [], facts: {}, sharp: SHARP };
const saveLog = () => writeFileSync(join(OUT, 'take.json'), JSON.stringify(log));
let frameNo = 0;

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--force-color-profile=srgb', '--disable-lcd-text', '--font-render-hinting=none'] });

function cursorScript() {
  const install = () => {
    if (document.getElementById('__cursor')) return;
    const style = document.createElement('style');
    style.textContent =
      '@keyframes __ring{from{transform:translate(-50%,-50%) scale(.35);opacity:.8}to{transform:translate(-50%,-50%) scale(1.5);opacity:0}}' +
      '#__cursor{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}' +
      '.__ring{position:fixed;width:34px;height:34px;border-radius:50%;border:2px solid #f2c14e;z-index:2147483646;pointer-events:none;animation:__ring .45s ease-out forwards}' +
      '.toasts{display:none!important}';
    document.documentElement.appendChild(style);
    const c = document.createElement('div');
    c.id = '__cursor';
    c.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M5 2.5l13.5 10-6.3 1 -3.5 6.2z" fill="#fff" stroke="#14213d" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    c.style.transform = 'translate(640px,380px)';
    document.documentElement.appendChild(c);
    window.addEventListener('mousemove', (e) => { c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
    window.addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.className = '__ring';
      r.style.left = `${e.clientX}px`;
      r.style.top = `${e.clientY}px`;
      document.documentElement.appendChild(r);
      setTimeout(() => r.remove(), 500);
    }, true);
  };
  if (document.documentElement && document.body) install();
  else document.addEventListener('DOMContentLoaded', install);
}

const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: SHARP });
await context.addInitScript(cursorScript);
const page = await context.newPage();
page.on('pageerror', (e) => { log.errors.push(e.message); console.log(`[pageerror] ${e.message}`); });
page.on('console', (m) => { if (m.type() === 'error' && !/403|401|404|Failed to load resource/.test(m.text())) log.errors.push(m.text().slice(0, 300)); });
const cdp = await context.newCDPSession(page);
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  frameNo += 1;
  writeFileSync(join(FRAMES, `${String(frameNo).padStart(6, '0')}.jpg`), Buffer.from(data, 'base64'));
  log.frames.push([frameNo, metadata.timestamp]);
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: 1280 * SHARP, maxHeight: 720 * SHARP, everyNthFrame: 1 });
const hand = { x: 640, y: 380 };
await page.mouse.move(hand.x, hand.y);

// ---- moving, pointing and marking ----

const film = (name) => page.locator(`[data-film="${name}"]`).first();

async function rectOf(locator) {
  const box = await locator.boundingBox().catch(() => null);
  return box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null;
}

/** Names this moment. `rects` are things the editor may want to frame: { name: locator }. */
async function mark(name, rects = {}) {
  const found = {};
  for (const [key, locator] of Object.entries(rects)) found[key] = await rectOf(locator);
  // The screencast only sends a frame when something changes, so nudge it to send one now.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await sleep(120);
  log.marks.push({ name, t: Date.now() / 1000, rects: found });
  console.log(`[mark] ${name}`);
  saveLog();
}

const pointer = (show) => page.evaluate((visible) => { const c = document.getElementById('__cursor'); if (c) c.style.display = visible ? '' : 'none'; }, show);

async function pointAt(locator, { dwell = 140 } = {}) {
  await locator.scrollIntoViewIfNeeded();
  await sleep(150);
  const box = await locator.boundingBox();
  if (!box) throw new Error('nothing to point at');
  const tx = box.x + Math.min(box.width / 2, 130);
  const ty = box.y + box.height / 2;
  const steps = 26;
  for (let i = 1; i <= steps; i += 1) {
    const p = i / steps;
    const eased = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
    await page.mouse.move(hand.x + (tx - hand.x) * eased, hand.y + (ty - hand.y) * eased);
    await sleep(15);
  }
  hand.x = tx;
  hand.y = ty;
  await sleep(dwell);
}

async function click(locator) {
  await pointAt(locator);
  await page.mouse.down();
  await sleep(70);
  await page.mouse.up();
  await sleep(250);
}

/** Scrolls smoothly so the element's top sits `offset` pixels below the top of the window. */
async function glideTo(locator, offset = 90, ms = 900) {
  const handle = await locator.elementHandle();
  await page.evaluate(async ({ element, offset: o, ms: duration }) => {
    const from = window.scrollY;
    const to = Math.max(0, from + element.getBoundingClientRect().top - o);
    const started = performance.now();
    await new Promise((done) => {
      const tick = (now) => {
        const p = Math.min(1, (now - started) / duration);
        window.scrollTo(0, from + (to - from) * (p * p * (3 - 2 * p)));
        if (p < 1) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
  }, { element: handle, offset, ms });
  await sleep(300);
}

const top = async () => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
};

/** Moves inside the app. It is a hash route, so nothing reloads. */
async function go(path, ready) {
  await page.evaluate((to) => { window.location.hash = to; }, path);
  await page.locator(ready).first().waitFor({ timeout: 120_000 });
  await sleep(500);
}

async function become(name) {
  await page.locator('.who select').selectOption(who[name]);
  await sleep(700);
}

const view = (account, method, args = {}) =>
  MODE === 'local'
    ? fetch(`${BASE}local/view`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account, method, args }) }).then((r) => r.json()).then((r) => r.value)
    : fetch(config.rpc[0], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }),
      }).then((r) => r.json()).then((r) => JSON.parse(Buffer.from(r.result.result).toString()));

/** Reloads until `locator` shows up: the near.social data layer trails the chain by a few seconds. */
async function waitFor(locator, timeout = 120_000) {
  const until = Date.now() + timeout;
  for (;;) {
    if (await locator.first().isVisible().catch(() => false)) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${locator}`);
    await sleep(1500);
  }
}

// ---- the film ----

async function shoot() {
  // 1. The idea: the front page, then the Choir itself.
  await page.goto(BASE);
  await page.locator('.tile').first().waitFor({ timeout: 120_000 });
  await become('fan');
  await pointer(false);
  await sleep(1200);
  await mark('home', { hero: page.locator('.hero'), h1: page.locator('.hero h1'), lead: page.locator('.hero .lead') });
  await sleep(2500);

  await go(`/c/${CHOIR}`, '[data-film="stats"]');
  await page.locator('.post').first().waitFor({ timeout: 120_000 });
  await top();
  await sleep(1200);
  await mark('choir', { id: film('id'), chips: film('chips'), stats: film('stats'), pot: film('pot'), intro: film('feed-intro'), feed: film('feed'), masthead: page.locator('.masthead') });
  await sleep(1500);
  await glideTo(film('tabs'), 80);
  await mark('feed-before', { intro: film('feed-intro'), feed: film('feed'), first: page.locator('.post').first() });
  await sleep(1200);

  // 2. Maya posts from her own account, then asks the Choir to repeat it.
  await top();
  await become('maya');
  await pointer(true);
  await film('myposts').waitFor({ timeout: 60_000 });
  await glideTo(film('myposts'), 70);
  await mark('maya-ready', { card: film('myposts') });
  const box = film('myposts').locator('textarea');
  await click(box);
  await mark('typing-start', { card: film('myposts'), box });
  await box.pressSequentially(POST, { delay: 38 });
  await sleep(500);
  await mark('typed', { card: film('myposts'), box });
  await click(film('myposts').getByRole('button', { name: /^Post as/ }));
  const mine = film('myposts').locator('.mine', { hasText: POST });
  await waitFor(mine);
  await sleep(700);
  await mark('posted', { card: film('myposts'), mine });
  const amplify = mine.getByRole('button', { name: 'Amplify' });
  await pointAt(amplify, { dwell: 500 });
  await mark('amplify-ready', { card: film('myposts'), mine, button: amplify });
  await click(amplify);
  await waitFor(mine.locator('.chip.good'));
  await sleep(600);
  await mark('amplified', { card: film('myposts'), mine });
  await sleep(1200);

  // The account's feed now carries her post, under her name.
  await pointer(false);
  const repeated = page.locator('.post', { hasText: POST });
  await waitFor(repeated);
  await glideTo(film('tabs'), 80);
  await sleep(900);
  await mark('repost', { post: repeated, intro: film('feed-intro'), feed: film('feed') });
  await sleep(2200);

  // 3. A reader tips.
  await top();
  await become('fan');
  await pointer(true);
  await glideTo(film('tip'), 110);
  const before = await view(CHOIR, 'get_choir');
  log.facts.potBefore = before.pot;
  await mark('tip-ready', { card: film('tip') });
  const tip = film('tip').getByRole('button', { name: /^Tip/ });
  await pointAt(tip, { dwell: 500 });
  await mark('tip-point', { card: film('tip'), button: tip });
  await click(tip);
  for (let i = 0; i < 80; i += 1) {
    if ((await view(CHOIR, 'get_choir')).pot !== before.pot) break;
    await sleep(1000);
  }
  await sleep(2500);
  await pointer(false);
  await top();
  await sleep(900);
  const afterTip = await view(CHOIR, 'get_choir');
  log.facts.potAfter = afterTip.pot;
  log.facts.seatAfter = afterTip.seat_balance;
  await mark('tipped', { stats: film('stats'), pot: film('pot'), round: film('round') });
  await sleep(2000);

  // 4. The round ends. Anyone closes it, and the account posts its own receipt.
  if (MODE === 'local') {
    await fetch(`${BASE}local/skip`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ms: Math.max(0, afterTip.round_end_ms - afterTip.now_ms) + 60_000 }) });
  } else {
    const wait = afterTip.round_end_ms - Date.now() + 5000;
    console.log(`waiting ${Math.ceil(wait / 1000)} s for the round to end`);
    if (wait > 0) await sleep(wait);
  }
  await page.reload();
  await film('round').waitFor({ timeout: 120_000 });
  const close = film('round').getByRole('button', { name: 'Close the round' });
  await waitFor(close);
  await pointer(true);
  await glideTo(film('round'), 110);
  await mark('round-over', { round: film('round') });
  await pointAt(close, { dwell: 500 });
  await mark('close-point', { round: film('round'), button: close });
  await click(close);
  const receipt = page.locator('.post.own', { hasText: 'is settled' }).first();
  await waitFor(page.locator('.post.own', { hasText: `Round ${afterTip.round + 1} is settled` }));
  await pointer(false);
  await glideTo(film('tabs'), 80);
  await sleep(900);
  log.facts.receipt = await receipt.locator('.text').innerText();
  await mark('receipt', { post: receipt, feed: film('feed') });
  await sleep(2200);

  // 5. Maya is paid.
  await top();
  await become('maya');
  await pointer(true);
  await film('earnings').waitFor({ timeout: 60_000 });
  await glideTo(film('earnings'), 150);
  log.facts.claimable = (await view(CHOIR, 'get_member', { account: who.maya })).claimable;
  await mark('earn-ready', { card: film('earnings') });
  const claim = film('earnings').getByRole('button', { name: 'Claim' });
  await pointAt(claim, { dwell: 500 });
  await mark('claim-point', { card: film('earnings'), button: claim });
  await click(claim);
  for (let i = 0; i < 80; i += 1) {
    if ((await view(CHOIR, 'get_member', { account: who.maya })).claimable !== log.facts.claimable) break;
    await sleep(1000);
  }
  await sleep(1500);
  await pointer(false);
  await mark('claimed', { card: film('earnings') });
  await page.getByRole('tab', { name: 'Books' }).click();
  await page.locator('.ledger').first().waitFor({ timeout: 60_000 });
  await glideTo(film('tabs'), 80);
  await sleep(900);
  await mark('books', { ledger: page.locator('.ledger').last(), money: page.locator('.kv').first() });
  await sleep(1800);

  // 6. Asha steps down: no password to hand over, just the seat.
  await top();
  await become('asha');
  await go(`/c/${CHOIR}/desk`, '[data-film="pass"]');
  await pointer(true);
  await top();
  await sleep(900);
  await mark('desk', { seat: film('seat'), pass: film('pass'), head: page.locator('.desk h1') });
  const to = film('pass').locator('input').first();
  await click(to);
  await to.pressSequentially(who.sam, { delay: 55 });
  await sleep(500);
  const over = film('pass').getByRole('button', { name: 'Hand over' });
  await pointAt(over, { dwell: 500 });
  await mark('handover-ready', { pass: film('pass'), button: over });
  await click(over);
  await page.locator('[data-film="chips"]', { hasText: 'Conducted by Sam' }).waitFor({ timeout: 180_000 });
  await pointer(false);
  await top();
  await sleep(1000);
  log.facts.info = await view(CHOIR, 'nft_item_info');
  await mark('handed', { chips: film('chips'), masthead: page.locator('.masthead'), id: film('id') });
  await sleep(1500);
  const notice = page.locator('.post.own', { hasText: 'seat has passed' }).first();
  await waitFor(notice);
  await glideTo(film('tabs'), 80);
  await sleep(900);
  log.facts.notice = await notice.locator('.text').innerText();
  await mark('notice', { post: notice, feed: film('feed') });
  await sleep(2200);

  // 7. Her old desk is closed.
  await pointer(true);
  await go(`/c/${CHOIR}/desk`, '[data-film="locked"]');
  await sleep(1000);
  await pointer(false);
  log.facts.locked = await film('locked').innerText();
  await mark('locked', { card: film('locked') });
  await sleep(2200);

  // 8. Anyone can check.
  await go(`/c/${CHOIR}`, '[data-film="stats"]');
  await page.getByRole('tab', { name: 'Proof' }).click();
  await film('proof').waitFor({ timeout: 120_000 });
  await glideTo(film('tabs'), 70);
  await sleep(1200);
  const checks = film('proof').locator('.check');
  log.facts.checks = `${await film('proof').locator('.check .mark:not(.no):not(.wait)').count()}/${await checks.count()}`;
  await mark('proof', { card: film('proof'), first: checks.first() });
  await sleep(1500);
  await glideTo(checks.nth(4), 150);
  await mark('proof-pair', { card: film('proof'), pair: checks.nth(4), keys: checks.nth(5) });
  await sleep(1800);

  // 9. What the members keep, and the account itself.
  await page.getByRole('tab', { name: 'Members' }).click();
  await film('members').waitFor({ timeout: 60_000 });
  await glideTo(film('tabs'), 80);
  await sleep(900);
  await mark('members', { table: film('members') });
  await sleep(1800);
  await top();
  await sleep(900);
  await mark('final', { masthead: page.locator('.masthead'), stats: film('stats') });
  await sleep(2500);
  await mark('done');
}

try {
  await shoot();
} catch (error) {
  log.errors.push(String(error.stack ?? error));
  console.log(`[failed] ${error.message}`);
  process.exitCode = 1;
} finally {
  saveLog();
  await browser.close();
  server.kill();
  console.log(`frames ${frameNo}, marks ${log.marks.length}, errors ${log.errors.length}`);
  console.log(JSON.stringify(log.facts, null, 1));
  for (const e of log.errors.slice(0, 10)) console.log(`  ${e.slice(0, 300)}`);
  process.exit();
}
