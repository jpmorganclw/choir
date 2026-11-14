// Cuts the film together from a recorded take and the spoken lines. Shots are named by the marks
// the recorder left in the take.
//
//   node tools/video/compose.mjs plan                 works out the timeline from the voices
//   node tools/video/compose.mjs stills 3,20,55       renders single frames at those seconds
//   node tools/video/compose.mjs render <out.mp4>     renders the whole film (needs mix.wav)
//
// FILM_TAKE picks the take (default testnet1). FFMPEG is the path to an ffmpeg binary.
// The render draws the film in short segments and keeps each one, so running it again after a
// crash carries on where it stopped. RENDER_SEGMENT sets their length in seconds (default 8).

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.CHOIR_VIDEO_HOME ?? join(homedir(), '.choir', 'video');
const TAKE = process.env.FILM_TAKE ?? 'testnet1';
/** Which set of spoken lines to cut to: the real ones, or CHOIR_VOICES=voices-draft. */
const VOICES = process.env.CHOIR_VOICES ?? 'voices';
const FPS = 30;
const SCALE = 1.5; // the recorded layout is 1280 wide, the film is 1920 wide
const SCRIPT = JSON.parse(readFileSync(join(HERE, 'script.json'), 'utf8'));
const LINES = Object.fromEntries(SCRIPT.lines.map((line) => [line.id, line]));
const WHO = { asha: 'Asha', maya: 'Maya', sam: 'Sam', narrator: '' };

const log = JSON.parse(readFileSync(join(HOME, 'takes', TAKE, 'take.json'), 'utf8'));
const FRAMES = log.frames;
const MARKS = Object.fromEntries(log.marks.map((m) => [m.name, m]));
const LIVE = log.mode === 'testnet';
const BADGE = LIVE ? 'LIVE ON NEAR TESTNET' : 'PRACTICE CHAIN · THE REAL CONTRACTS, RUN LOCALLY';
const SMALL = `${LIVE ? 'Filmed live on NEAR testnet' : 'Filmed on a local practice chain running the real contracts'}  ·  Asha, Maya and Sam are fictional, and their voices are AI-generated`;

/** The last frame shown at or before this moment. The screencast only sends frames when the page changes. */
function frameAt(t) {
  let low = 0;
  let high = FRAMES.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (FRAMES[mid][1] <= t) low = mid;
    else high = mid - 1;
  }
  return FRAMES[low][0];
}

const WIDE = [640, 360, 1];

/** A camera position that frames one named element of a mark, clear of the caption. */
function on(markName, rect, { zoom, dy = 26, dx = 0, padding = 1.12 } = {}) {
  const mark = MARKS[markName];
  if (!mark) throw new Error(`the take has no mark ${markName}`);
  const r = mark.rects[rect];
  if (!r) throw new Error(`mark ${markName} has no rect ${rect}`);
  const fit = Math.min(1280 / (r.w * padding), 540 / (r.h * padding));
  return [r.x + r.w / 2 + dx, r.y + r.h / 2 + dy, zoom ?? Math.max(1, Math.min(2.1, fit))];
}

/** Frames the top part of a tall element. */
function head(markName, rect, { zoom = 1.6, down = 150, dx = 0 } = {}) {
  const r = MARKS[markName].rects[rect];
  return [r.x + r.w / 2 + dx, r.y + down, zoom];
}

/** Frames an element from its left edge. Full-width blocks hold their content on the left. */
function left(markName, rect, { zoom = 1.8, pad = 30, dy = 26 } = {}) {
  const r = MARKS[markName].rects[rect];
  return [r.x - pad + 1280 / zoom / 2, r.y + r.h / 2 + dy, zoom];
}

// ---- the film: what is on screen, and who speaks over it ----
// scene: one of the drawn opening scenes. hold: a mark. holds: [[from 0..1, mark], ...].
// clip: [first mark, last mark], played across the shot.
// camera: [seconds from shot start (negative counts from its end, a number in 0..1 written as a
// string like "50%" is part way), x, y, zoom].
// holds and camera may be functions of `b`: where each sentence of the spoken line starts, as a
// fraction of the shot. b[0] is the first sentence, b[1] the second, and so on.

const pc = (fraction, nudge = 0) => `${(fraction * 100 + nudge).toFixed(2)}%`;

const SHOTS = [
  { id: 'p1', chapter: 'The problem', scene: 'p1', say: ['a1'], lead: 0.5, tail: 0.35, fadeIn: 0.6 },
  { id: 'p2', chapter: 'The problem', scene: 'p2', say: ['a2'], lead: 0.2, tail: 0.3 },
  { id: 'p3', chapter: 'The problem', scene: 'p3', say: ['m1'], lead: 0.2, tail: 0.45 },

  { id: 'idea', chapter: 'The idea', hold: 'home', say: ['n1'], lead: 0.3, tail: 0.3,
    camera: [[0, ...WIDE], [-0.01, ...left('home', 'h1', { zoom: 1.45, pad: 70, dy: 70 })]] },
  // "no keys" | "nobody can make it say anything" | "it only repeats its members" | "and it pays them"
  { id: 'account', chapter: 'The idea', say: ['n2'], lead: 0.2, tail: 0.35,
    holds: (b) => [[0, 'choir'], [b[1], 'feed-before'], [b[3], 'choir']],
    camera: (b) => [
      [0, ...left('choir', 'id', { zoom: 1.7, pad: 40, dy: 10 })],
      [pc(b[1], -0.1), ...left('choir', 'chips', { zoom: 2.0, pad: 30, dy: 10 })],
      [pc(b[1]), ...head('feed-before', 'feed', { zoom: 1.5, down: 70, dx: -40 })],
      [pc(b[2]), ...head('feed-before', 'feed', { zoom: 1.62, down: 80, dx: -40 })],
      [pc(b[3], -0.1), ...on('feed-before', 'first', { zoom: 1.7, dy: 20, dx: -60 })],
      [pc(b[3]), ...on('choir', 'stats', { zoom: 1.5, dy: 0 })],
      [-0.01, ...on('choir', 'pot', { zoom: 2.0, dy: 20 })],
    ] },

  { id: 'post', chapter: 'See it work', clip: ['typing-start', 'amplify-ready'], say: ['m2'], lead: 0.2, tail: 0.25,
    camera: [[0, ...head('typing-start', 'card', { zoom: 1.75, down: 190 })], [-0.01, ...on('amplify-ready', 'mine', { zoom: 2.0, dy: 30 })]] },
  { id: 'press', chapter: 'See it work', clip: ['amplify-ready', 'amplified'], dur: 1.9,
    camera: [[0, ...on('amplify-ready', 'mine', { zoom: 2.0, dy: 30 })], [-0.01, ...on('amplified', 'mine', { zoom: 2.05, dy: 30 })]] },
  { id: 'repost', chapter: 'See it work', hold: 'repost', say: ['n3'], lead: 0.2, tail: 0.4,
    camera: [[0, ...head('repost', 'feed', { zoom: 1.5, down: 170, dx: -40 })], [-0.01, ...on('repost', 'post', { zoom: 1.8, dy: 30, dx: -60 })]] },
  // "a reader sends a tip" | "split the moment it lands" | "most to the members ... a capped cut to the seat"
  { id: 'tip', chapter: 'See it work', say: ['n4'], lead: 0.2, tail: 0.5,
    holds: (b) => [[0, 'tip-ready'], [b[1], 'tip-point'], [b[2] + (1 - b[2]) * 0.62, 'tipped']],
    camera: (b) => [
      [0, ...on('tip-ready', 'card', { zoom: 1.45, dy: 10 })],
      [pc(b[1]), ...on('tip-point', 'card', { zoom: 1.6, dy: 40 })],
      [pc(b[2] + (1 - b[2]) * 0.62, -0.1), ...on('tip-point', 'card', { zoom: 1.85, dy: 70 })],
      [pc(b[2] + (1 - b[2]) * 0.62), ...on('tipped', 'stats', { zoom: 1.5, dy: 0 })],
      [-0.01, ...on('tipped', 'pot', { zoom: 2.0, dy: 20 })],
    ] },
  // "when the round ends, the account posts its own receipt" | "nobody typed that"
  { id: 'round', chapter: 'See it work', say: ['n5'], lead: 0.2, tail: 0.5,
    holds: (b) => [[0, 'close-point'], [b[1] * 0.45, 'receipt']],
    camera: (b) => [
      [0, ...on('close-point', 'round', { zoom: 1.5, dy: 10 })],
      [pc(b[1] * 0.45, -0.1), ...on('close-point', 'button', { zoom: 1.9, dy: 0 })],
      [pc(b[1] * 0.45), ...on('receipt', 'post', { zoom: 1.55, dy: 20, dx: -60 })],
      [pc(b[1]), ...on('receipt', 'post', { zoom: 1.66, dy: 20, dx: -60 })],
      [-0.01, ...left('receipt', 'post', { zoom: 2.0, pad: 20, dy: -30 })],
    ] },
  // "and I got paid" | "for a post"
  { id: 'paid', chapter: 'See it work', say: ['m3'], lead: 0.2, tail: 0.7,
    holds: (b) => [[0, 'claim-point'], [b[1], 'books']],
    camera: (b) => [
      [0, ...on('claim-point', 'card', { zoom: 1.7, dy: 10 })],
      [pc(b[1], -0.1), ...on('claim-point', 'card', { zoom: 1.85, dy: 10 })],
      [pc(b[1]), ...head('books', 'ledger', { zoom: 1.6, down: 110, dx: -60 })],
      [-0.01, ...head('books', 'ledger', { zoom: 1.75, down: 100, dx: -60 })],
    ] },

  // "time for me to step down" | "no password to hand over" | "just the seat"
  { id: 'stepdown', chapter: 'The handover', clip: ['desk', 'handover-ready'], say: ['a3'], lead: 0.3, tail: 0.3,
    camera: (b) => [
      [0, ...left('desk', 'head', { zoom: 1.3, pad: 60, dy: 90 })],
      [pc(b[1]), ...on('desk', 'pass', { zoom: 1.5, dy: 0 })],
      [-0.01, ...on('handover-ready', 'button', { zoom: 1.9, dy: 10, dx: -140 })],
    ] },
  // "the seat is an NFT" | "one transaction, and Sam is the conductor" | "the account announces it, by itself"
  { id: 'handover', chapter: 'The handover', say: ['n6'], lead: 0.2, tail: 0.5,
    holds: (b) => [[0, 'handover-ready'], [b[1], 'handed'], [b[2], 'notice']],
    camera: (b) => [
      [0, ...on('handover-ready', 'button', { zoom: 1.9, dy: 10, dx: -140 })],
      [pc(b[1], -0.1), ...on('handover-ready', 'button', { zoom: 2.0, dy: 10, dx: -140 })],
      [pc(b[1]), ...left('handed', 'masthead', { zoom: 1.25, pad: 0, dy: -40 })],
      [pc(b[2], -0.1), ...left('handed', 'chips', { zoom: 2.0, pad: 30, dy: 10 })],
      [pc(b[2]), ...on('notice', 'post', { zoom: 1.55, dy: 20, dx: -60 })],
      [-0.01, ...on('notice', 'post', { zoom: 1.7, dy: 20, dx: -60 })],
    ] },
  { id: 'closed', chapter: 'The handover', hold: 'locked', say: ['a4'], lead: 0.25, tail: 0.45,
    camera: [[0, ...on('locked', 'card', { zoom: 1.35, dy: 20 })], [-0.01, ...on('locked', 'card', { zoom: 1.5, dy: 20 })]] },
  // "this account has no keys at all" | "and anyone can check"
  { id: 'proof', chapter: 'The handover', say: ['n7'], lead: 0.2, tail: 0.55,
    holds: (b) => [[0, 'proof'], [b[1], 'proof-pair']],
    camera: (b) => [
      [0, ...head('proof', 'card', { zoom: 1.6, down: 170, dx: -60 })],
      [pc(b[1], -0.1), ...head('proof', 'card', { zoom: 1.75, down: 190, dx: -60 })],
      [pc(b[1]), ...on('proof-pair', 'pair', { zoom: 1.6, dy: 20, dx: -60 })],
      [-0.01, ...on('proof-pair', 'keys', { zoom: 1.7, dy: 0, dx: -60 })],
    ] },

  { id: 'keep', chapter: 'Why it matters', hold: 'members', say: ['s1'], lead: 0.25, tail: 0.3,
    camera: [[0, ...on('members', 'table', { zoom: 1.5, dy: 10 })], [-0.01, ...on('members', 'table', { zoom: 1.62, dy: 10 })]] },
  { id: 'theirs', chapter: 'Why it matters', hold: 'final', say: ['a5'], lead: 0.2, tail: 0.9, fadeOut: 0.7,
    camera: [[0, ...left('final', 'masthead', { zoom: 1.35, pad: 0, dy: -40 })], [-0.01, ...WIDE]] },
  { id: 'end', card: true, dur: 5.0, badge: 0 },
];

/** Where each sentence of a line starts, as fractions of the line. A colon also starts a new beat. */
function sentenceStarts(text) {
  const parts = text.match(/[^.!?:]+[.!?:]+/g)?.map((s) => s.trim()) ?? [text];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  let at = 0;
  return parts.map((part) => {
    const from = at / total;
    at += part.length;
    return from;
  });
}

// ---- timeline ----

function report() {
  const path = join(HOME, `${VOICES}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

/** The take with the fewest wrong words. Among equals, the one with the most life in its pitch. */
function chooseTake(id, voices) {
  const overrides = existsSync(join(HERE, 'choice.json')) ? JSON.parse(readFileSync(join(HERE, 'choice.json'), 'utf8')) : {};
  if (overrides[id] !== undefined) return overrides[id];
  const options = Object.entries(voices)
    .filter(([key]) => key.startsWith(`${id}.`))
    .map(([key, value]) => ({ take: Number(key.split('.')[1]), ...value }));
  if (!options.length) return null;
  options.sort((a, b) => a.wer - b.wer || b.pitch_spread_semitones - a.pitch_spread_semitones);
  return options[0].take;
}

function plan() {
  const voices = report();
  let clock = 0;
  const lines = [];
  const missing = [];
  const shots = SHOTS.map((shot) => {
    const start = clock;
    let at = start + (shot.lead ?? 0);
    for (const [i, id] of (shot.say ?? []).entries()) {
      const chosen = chooseTake(id, voices);
      let seconds = LINES[id].text.length / 14; // an estimate until the line has been spoken
      if (chosen === null) missing.push(id);
      else seconds = voices[`${id}.${chosen}`].seconds;
      lines.push({ id, take: chosen, at: Number(at.toFixed(3)), seconds, shot: shot.id, voice: LINES[id].voice, text: LINES[id].text });
      at += seconds + (i < shot.say.length - 1 ? shot.gap ?? 0.4 : 0);
    }
    const end = shot.say ? Math.max(at + (shot.tail ?? 0.3), start + (shot.min ?? 0)) : start + shot.dur;
    clock = end;
    const resolved = { ...shot, start, end };
    if (shot.say) {
      const line = lines.find((l) => l.id === shot.say[0]);
      const length = end - start;
      const beats = sentenceStarts(line.text).map((from) => (line.at - start + from * line.seconds) / length);
      while (beats.length < 6) beats.push(1);
      if (typeof shot.holds === 'function') resolved.holds = shot.holds(beats);
      if (typeof shot.camera === 'function') resolved.camera = shot.camera(beats);
    }
    return resolved;
  });
  const startOf = (id) => shots.find((s) => s.id === id).start;
  const cues = { idea: startOf('idea'), work: startOf('post'), paid: startOf('paid'), handover: startOf('stepdown'), matters: startOf('keep'), end: startOf('end') };
  const timeline = { duration: clock, take: TAKE, mode: log.mode, voices: VOICES, lines, cues, missing };
  writeFileSync(join(HERE, 'timeline.json'), JSON.stringify(timeline, null, 1));
  console.log(`duration ${clock.toFixed(1)}s, ${lines.length} lines, missing voices: ${missing.join(' ') || 'none'}`);
  console.log(shots.map((s) => `${s.id}@${s.start.toFixed(1)}`).join(' '));
  return { shots, timeline };
}

// ---- what the screen shows at a moment ----

const smooth = (p) => p * p * (3 - 2 * p);

function cameraAt(shot, t) {
  if (!shot.camera) return { tx: 0, ty: 0, zoom: 1 };
  const length = shot.end - shot.start;
  const when = (at) => (typeof at === 'string' ? (parseFloat(at) / 100) * length : at < 0 ? length + at : at);
  const keys = shot.camera.map(([at, x, y, zoom]) => [when(at), x, y, zoom]);
  const local = t - shot.start;
  let a = keys[0];
  let b = keys[keys.length - 1];
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (local >= keys[i][0] && local <= keys[i + 1][0]) {
      a = keys[i];
      b = keys[i + 1];
      break;
    }
  }
  if (local <= keys[0][0]) b = a;
  if (local >= keys[keys.length - 1][0]) a = b;
  const span = b[0] - a[0];
  const p = span > 0 ? smooth(Math.min(1, Math.max(0, (local - a[0]) / span))) : 0;
  const zoom = Math.exp(Math.log(a[3]) + (Math.log(b[3]) - Math.log(a[3])) * p);
  const cx = (a[1] + (b[1] - a[1]) * p) * SCALE;
  const cy = (a[2] + (b[2] - a[2]) * p) * SCALE;
  const tx = Math.min(0, Math.max(1920 - 1920 * zoom, 960 - zoom * cx));
  const ty = Math.min(0, Math.max(1080 - 1080 * zoom, 540 - zoom * cy));
  return { tx: Number(tx.toFixed(2)), ty: Number(ty.toFixed(2)), zoom: Number(zoom.toFixed(4)) };
}

const frameFile = (n) => pathToFileURL(join(HOME, 'takes', TAKE, 'frames', `${String(n).padStart(6, '0')}.jpg`)).href;

function sourceAt(shot, t) {
  if (shot.scene) return undefined;
  if (shot.hold) return frameFile(frameAt(MARKS[shot.hold].t));
  const p = (t - shot.start) / (shot.end - shot.start);
  if (shot.holds) {
    const [, name] = shot.holds.findLast(([from]) => p >= from) ?? shot.holds[0];
    return frameFile(frameAt(MARKS[name].t));
  }
  const [first, last] = shot.clip;
  const from = MARKS[first].t;
  const to = MARKS[last].t;
  return frameFile(frameAt(from + (to - from) * p));
}

/** Splits a line into pieces short enough to read at a glance, timed by their length. */
function chunks(line) {
  const sentences = line.text.match(/[^.!?:]+[.!?:]+/g)?.map((s) => s.trim()) ?? [line.text];
  const merged = [];
  for (const piece of sentences) {
    const last = merged[merged.length - 1];
    if (last && `${last} ${piece}`.length <= 58) merged[merged.length - 1] = `${last} ${piece}`;
    else merged.push(piece);
  }
  const total = merged.reduce((sum, piece) => sum + piece.length, 0);
  let at = line.at;
  return merged.map((text) => {
    const seconds = (line.seconds * text.length) / total;
    const chunk = { text: text.replaceAll("'", '’'), from: at, to: at + seconds };
    at += seconds;
    return chunk;
  });
}

function stateAt(shots, captions, t) {
  const shot = shots.find((s) => t >= s.start && t < s.end) ?? shots[shots.length - 1];
  const state = { tx: 0, ty: 0, zoom: 1, badge: shot.badge ?? 1, badgeText: BADGE, fade: 0, card: 0, captionOpacity: 0, chapter: shot.chapter ?? '', scene: '', sceneShown: 0, sceneT: 0, small: SMALL };
  if (shot.card) {
    state.card = Math.min(1, (t - shot.start) / 0.7);
    state.fade = Number(Math.max(0, (t - (shot.end - 0.9)) / 0.9).toFixed(3));
    state.badge = 0;
    state.chapter = '';
    const last = shots.findLast((s) => !s.card);
    state.src = sourceAt(last, last.end - 0.01);
    Object.assign(state, cameraAt(last, last.end - 0.01));
    return state;
  }
  if (shot.scene) {
    state.scene = shot.scene;
    state.badge = 0; // the drawn opening is not footage of the app
    state.sceneT = Number(((t - shot.start) / (shot.end - shot.start)).toFixed(3));
    const into = Math.min(1, (t - shot.start) / 0.35);
    const out = Math.min(1, (shot.end - t) / 0.3);
    state.sceneShown = Number(smooth(Math.max(0, Math.min(into, out))).toFixed(3));
  } else {
    state.src = sourceAt(shot, t);
    Object.assign(state, cameraAt(shot, t));
  }
  if (shot.fadeIn) state.fade = Math.max(state.fade, 1 - (t - shot.start) / shot.fadeIn);
  if (shot.fadeOut) state.fade = Math.max(state.fade, 1 - (shot.end - t) / shot.fadeOut);
  state.fade = Number(Math.max(0, Math.min(1, state.fade)).toFixed(3));
  const caption = captions.find((c) => t >= c.from - 0.06 && t < c.to + 0.16);
  if (caption) {
    state.text = caption.text;
    state.who = caption.who;
    const rise = Math.min(1, (t - (caption.from - 0.06)) / 0.14);
    const fall = Math.min(1, (caption.to + 0.16 - t) / 0.16);
    state.captionOpacity = Number(Math.min(rise, fall).toFixed(3));
  }
  return state;
}

// ---- render ----

async function openStage() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--force-color-profile=srgb', '--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(HERE, 'stage.html')).href);
  await page.evaluate(() => window.ready());
  return { browser, page };
}

const command = process.argv[2] ?? 'plan';
const { shots, timeline } = plan();
const captions = timeline.lines.flatMap((line) => chunks(line).map((chunk) => ({ ...chunk, who: WHO[line.voice] })));

if (command === 'stills') {
  const out = join(HOME, 'stills');
  mkdirSync(out, { recursive: true });
  const { browser, page } = await openStage();
  for (const second of process.argv[3].split(',').map(Number)) {
    await page.evaluate((s) => window.draw(s), stateAt(shots, captions, second));
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(out, `t${String(Math.round(second * 10)).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 85 });
    console.log(second);
  }
  await browser.close();
}

if (command === 'render') {
  const output = process.argv[3];
  const perSegment = Number(process.env.RENDER_SEGMENT ?? 8) * FPS;
  const total = Math.ceil(timeline.duration * FPS);
  const count = Math.ceil(total / perSegment);
  const dir = join(HOME, 'segments', `${TAKE}-${VOICES}`);
  mkdirSync(dir, { recursive: true });
  // A kept segment is reused only if the same pictures would be drawn again: same states, same
  // stage, same take.
  const basis = createHash('sha256')
    .update(readFileSync(join(HERE, 'stage.html')))
    .update(String(statSync(join(HOME, 'takes', TAKE, 'take.json')).mtimeMs))
    .digest('hex');
  const statesOf = (index) => {
    const states = [];
    for (let f = index * perSegment; f < Math.min(total, (index + 1) * perSegment); f += 1) states.push(stateAt(shots, captions, f / FPS));
    return states;
  };
  const nameOf = (index, states) =>
    `seg-${String(index).padStart(3, '0')}-${createHash('sha256').update(basis).update(JSON.stringify(states)).digest('hex').slice(0, 12)}.mp4`;

  /** A screenshot can fail for a moment when the machine is short of memory. */
  const shoot = async (page) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await page.screenshot({ type: 'png' });
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      }
    }
  };

  const drawSegment = async (states, file) => {
    const part = `${file}.part.mp4`;
    const ff = spawn(process.env.FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'image2pipe', '-c:v', 'png', '-framerate', String(FPS), '-i', 'pipe:0',
      '-vf', 'unsharp=5:5:0.45:5:5:0,scale=out_range=tv:out_color_matrix=bt709:flags=lanczos,format=yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high', '-x264-params', 'deblock=-1,-1:aq-mode=3',
      '-an', part,
    ], { stdio: ['pipe', 'inherit', 'inherit'] });
    const closed = once(ff, 'close');
    ff.stdin.on('error', () => {}); // a dead encoder shows up as its exit code, below
    let stage;
    try {
      stage = await openStage();
      let lastKey = '';
      let buffer = null;
      for (const state of states) {
        const key = JSON.stringify(state);
        if (key !== lastKey) {
          await stage.page.evaluate((s) => window.draw(s), state);
          buffer = await shoot(stage.page);
          lastKey = key;
        }
        if (ff.exitCode !== null) throw new Error(`the encoder stopped early with code ${ff.exitCode}`);
        if (!ff.stdin.write(buffer)) await Promise.race([once(ff.stdin, 'drain'), closed]);
      }
      ff.stdin.end();
      const [code] = await closed;
      if (code !== 0) throw new Error(`the encoder stopped with code ${code}`);
      renameSync(part, file);
    } catch (error) {
      ff.stdin.destroy();
      ff.kill();
      await closed.catch(() => {});
      rmSync(part, { force: true });
      throw error;
    } finally {
      await stage?.browser.close().catch(() => {});
    }
  };

  const started = Date.now();
  const files = [];
  for (let index = 0; index < count; index += 1) {
    const states = statesOf(index);
    const file = join(dir, nameOf(index, states));
    files.push(file);
    if (existsSync(file)) {
      console.log(`segment ${index + 1}/${count}: kept from an earlier run`);
      continue;
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        await drawSegment(states, file);
        break;
      } catch (error) {
        console.log(`segment ${index + 1}/${count}: attempt ${attempt} failed (${String(error.message).split('\n')[0]})`);
        if (attempt === 8) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 5_000 * attempt)));
      }
    }
    console.log(`segment ${index + 1}/${count} drawn, ${Math.round((Date.now() - started) / 1000)}s`);
  }

  // Join the segments without re-encoding and lay the sound under them.
  const list = join(dir, 'list.txt');
  writeFileSync(list, files.map((file) => `file '${file.replaceAll('\\', '/')}'`).join('\n'));
  mkdirSync(dirname(output) || '.', { recursive: true });
  const joined = spawnSync(process.env.FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', list,
    '-i', join(HOME, 'mix.wav'),
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-shortest', '-movflags', '+faststart', output,
  ], { stdio: 'inherit' });
  if (joined.status !== 0) throw new Error(`joining the segments failed with code ${joined.status}`);
  // Segments from older cuts are no longer needed.
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.mp4') && !files.includes(join(dir, name))) rmSync(join(dir, name), { force: true });
  }
  console.log(`done: ${output}`);
}
