// Plays a short, real story on testnet so the hosted app has something to show: two Choirs, a
// settled round with its receipt, a payout, and a seat for sale. Every step is a real transaction
// signed by one of this project's demo accounts. Safe to run again: finished steps are skipped.
//
//   node scripts/seed-testnet.mjs

import { readFileSync } from 'node:fs';
import { SOCIAL, call, near, pause, reader, toNear, view } from '../server/testnet.mjs';

const deployment = JSON.parse(readFileSync('deployments/testnet.json', 'utf8'));
const { collection, personas } = deployment;
const [ASHA, MAYA, LEO, FAN, SAM] = personas.map((p) => p.id);
const WEEK = 7 * 86_400_000;
/** How long a round of the demo Choir lasts after the first, on testnet. */
const TRY_ROUND = 5 * 60_000;

const must = (result, what) => {
  if (!result.ok || (result.failures?.length && result.value === false)) throw new Error(`${what} failed: ${result.error ?? JSON.stringify(result.failures)}`);
  console.log(`  ${what}${result.hash ? `  ${result.hash}` : ''}`);
  return result;
};
const exists = async (id) => (await reader.account(id)).exists;
const member = (id, account) => view(id, 'get_member', { account }).catch(() => null);

let lastPost = 0;
async function post(who, text) {
  const id = Math.max(Date.now(), lastPost + 1);
  lastPost = id;
  must(await call(who, SOCIAL, '__fastdata_kv', { [`post/${id}`]: { text } }), `${who} posted on near.social`);
  return String(id);
}
async function join(id, who) {
  if ((await member(id, who))?.active) return;
  must(await call(who, id, 'join', {}, { deposit: near(0.01) }), `${who} joined ${id}`);
}
async function amplifyOwn(id, who, text) {
  const postId = await post(who, text);
  must(await call(who, id, 'amplify_own', { post_id: postId }, { deposit: near(0.005) }), `${id} amplified it`);
}

console.log('1. The five people introduce themselves on near.social');
for (const p of personas) {
  must(
    await call(p.id, SOCIAL, '__fastdata_kv', { 'profile/name': p.name, 'profile/about': `${p.about} (A demo account for the Choir project. Automated.)` }),
    `${p.id} wrote a profile`,
  );
}

const builders = `builders.${collection}`;
console.log(`\n2. ${builders}`);
if (!(await exists(builders))) {
  must(
    await call(
      ASHA,
      collection,
      'create_choir',
      {
        slug: 'builders',
        name: 'NEAR Builders',
        about: 'People who ship on NEAR. Post what you built and we will repeat it.',
        // A three-minute first round, so the story below has a settled round to show today.
        rules: { open: true, dues: '0', self_cap: 2, round_ms: 180_000, seat_bps: 1000 },
      },
      { deposit: near(0.6) },
    ),
    `${ASHA} started NEAR Builders`,
  );
}
let choir = await view(builders, 'get_choir');
if (choir.round === 0 && choir.totals.amplified === 0) {
  await join(builders, MAYA);
  await join(builders, LEO);
  await amplifyOwn(builders, MAYA, 'Shipped my first contract to testnet today. Every test green. #near');
  await amplifyOwn(builders, LEO, 'Wrote a guide to function-call access keys for people who are scared of them.');
  must(await call(FAN, builders, 'tip', { memo: 'for the guide' }, { deposit: near(4.005) }), `${FAN} tipped 4 NEAR`);
  // From the next round on, rounds last five minutes, so anyone trying the hosted app sees one
  // close. Queued now, in public, applied when round 1 closes. A real community would pick a week.
  must(await call(ASHA, builders, 'set_rules', { rules: { open: true, dues: '0', self_cap: 2, round_ms: TRY_ROUND, seat_bps: 1000 } }, { deposit: near(0.003) }), '5-minute rounds queued for round 2');
}
choir = await view(builders, 'get_choir');
if (choir.round === 0) {
  const wait = choir.round_end_ms - Date.now() + 4000;
  if (wait > 0) {
    console.log(`  waiting ${Math.ceil(wait / 1000)} s for round 1 to end...`);
    await pause(wait);
  }
  must(await call(FAN, builders, 'settle', {}), 'round 1 closed; the account posted its receipt');
  must(await call(LEO, builders, 'claim', {}), `${LEO} claimed`);
}
choir = await view(builders, 'get_choir');
if (choir.totals.amplified < 3) {
  await amplifyOwn(builders, MAYA, 'Storage staking finally clicked: your contract pays rent for every byte, so make the caller bring it.');
  must(await call(FAN, builders, 'tip', { memo: 'keep shipping' }, { deposit: near(3.005) }), `${FAN} tipped 3 NEAR into round 2`);
}

const night = `night-shift.${collection}`;
console.log(`\n3. ${night}`);
if (!(await exists(night))) {
  must(
    await call(
      SAM,
      collection,
      'create_choir',
      { slug: 'night-shift', name: 'Night Shift', about: 'For the people who deploy at 2 a.m.', rules: { open: true, dues: '0', self_cap: 2, round_ms: WEEK, seat_bps: 500 } },
      { deposit: near(0.5) },
    ),
    `${SAM} started Night Shift`,
  );
  await join(night, LEO);
  await amplifyOwn(night, LEO, 'Deployed at 2 a.m. again. It worked first time, which is how I know something is wrong.');
  must(await call(FAN, night, 'tip', {}, { deposit: near(1.005) }), `${FAN} tipped 1 NEAR`);
}
if (!(await view(collection, 'get_listing', { token_id: night }))) {
  must(await call(SAM, collection, 'list', { token_id: night, price: near(3).toString() }, { deposit: 1n }), `${SAM} listed the seat for 3 NEAR`);
}

console.log('\nBalances now');
for (const id of [collection, ...personas.map((p) => p.id), builders, night]) {
  console.log(`  ${id.padEnd(34)} ${toNear((await reader.account(id)).balance)} NEAR`);
}
