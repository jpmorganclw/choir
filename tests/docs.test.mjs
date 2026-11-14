// Keeps the documents honest: every test the threat model names must exist, and the fees the
// README and the app quote must be the ones the contract charges.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('docs: every test named in the threat model exists', () => {
  const names = [];
  for (const file of readdirSync(new URL('.', import.meta.url))) {
    if (!file.endsWith('.test.mjs')) continue;
    const source = read(`tests/${file}`);
    for (const match of source.matchAll(/\btest\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)) names.push(match[2]);
  }
  const table = read('docs/THREAT_MODEL.md').split('\n').filter((line) => /^\| \d+ \|/.test(line));
  assert.equal(table.length, 17, 'the threat model lists seventeen attacks');
  for (const row of table) {
    const cited = [...row.split('|').at(-2).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    assert.ok(cited.length > 0, `row has no test: ${row.slice(0, 60)}`);
    for (const name of cited) {
      // A row may cite the start of a longer test name, or a name that is completed per variant.
      assert.ok(names.some((actual) => actual.startsWith(name)), `the threat model cites a test that does not exist: "${name}"`);
    }
  }
});

test('docs: the fees quoted to people are the fees the contract charges', () => {
  const types = read('contracts/item/src/types.rs');
  const constant = (name) => {
    const [, expression] = types.match(new RegExp(`pub const ${name}: u128 = ([^;]+);`));
    const [top, bottom] = expression.replace(/_/g, '').replace('YOCTO', '1000000000000000000000000').split('/').map((part) => part.trim());
    const product = top.split('*').reduce((value, factor) => value * BigInt(factor.trim()), 1n);
    return bottom ? product / BigInt(bottom) : product;
  };
  const near = (yocto) => Number(yocto / 10n ** 18n) / 1e6;
  const fees = { join: near(constant('JOIN_FEE')), amplify: near(constant('AMPLIFY_FEE')), tip: near(constant('TIP_FEE')), payout: near(constant('PAYOUT_FEE')), minTip: near(constant('MIN_TIP')) };
  assert.deepEqual(fees, { join: 0.01, amplify: 0.005, tip: 0.005, payout: 0.001, minTip: 0.05 });

  const readme = read('README.md');
  assert.match(readme, /0\.01 NEAR to join,\s+0\.005 per amplification and per tip, 0\.001 per payout/);
  const api = read('app/src/api.js');
  assert.match(api, /join: YOCTO \/ 100n,\s+amplify: YOCTO \/ 200n,\s+tip: YOCTO \/ 200n,\s+payout: YOCTO \/ 1000n,\s+minTip: YOCTO \/ 20n/);
});

test('docs: the README counts the tests that exist', () => {
  let count = 0;
  for (const file of readdirSync(new URL('.', import.meta.url))) {
    if (!file.endsWith('.test.mjs')) continue;
    const source = read(`tests/${file}`);
    // Tests declared in a loop run once per variant; count the variants.
    const looped = [...source.matchAll(/^for \(const .+? of (\[.*\])\) \{\n\s*test\(/gm)];
    const inLoops = looped.reduce((sum, match) => sum + Function(`return ${match[1]}.length`)(), 0);
    const declared = [...source.matchAll(/^\s*test\(/gm)].length;
    count += declared - looped.length + inLoops;
  }
  const [, quoted] = read('README.md').match(/npm test\s+# (\d+) tests/);
  assert.equal(Number(quoted), count, `the README says ${quoted} tests; there are ${count}`);
});
