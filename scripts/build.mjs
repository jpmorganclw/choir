// Builds both contracts and copies the wasm to res/, which is what the tests and deploy scripts use.
// Needs Rust and cargo-near. You do not need this to run the tests: res/ is checked in.
//
//   node scripts/build.mjs
//
// On Windows a long checkout path can pass the 260 character limit once Cargo adds its folders;
// set CARGO_TARGET_DIR to a short folder if the build cannot find its own files.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const target = process.env.CARGO_TARGET_DIR ?? 'target';
mkdirSync('res', { recursive: true });

for (const name of ['item', 'registry']) {
  execFileSync('cargo', ['near', 'build', 'non-reproducible-wasm', '--no-abi'], {
    cwd: join('contracts', name),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const file = `choir_${name}.wasm`;
  copyFileSync(join(target, 'near', `choir_${name}`, file), join('res', file));
  const bytes = readFileSync(join('res', file));
  console.log(`res/${file}  ${bytes.length} bytes  sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
}
