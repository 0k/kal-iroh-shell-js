#!/usr/bin/env node
/**
 * Refresh the copy of the Rust protocol crate that `test/protocol.test.ts`
 * compares this package's wire names with.
 *
 * Usage:  npm run sync-protocol -- <kal-iroh-shell-checkout>
 *
 * Copies `crates/kal-iroh-shell-protocol/src/lib.rs` of the checkout's
 * committed HEAD (never its working tree) into `test/rust-protocol/lib.rs`,
 * and records the commit in `test/rust-protocol/SOURCE`.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'https://github.com/0k/kal-iroh-shell';
const PROTOCOL_FILE = 'crates/kal-iroh-shell-protocol/src/lib.rs';
const TARGET = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'rust-protocol');

const [checkout, ...rest] = process.argv.slice(2);
if (!checkout || rest.length > 0) {
  console.error('usage: npm run sync-protocol -- <kal-iroh-shell-checkout>');
  process.exit(2);
}

function git(...args) {
  return execFileSync('git', ['-C', resolve(checkout), ...args], { encoding: 'utf8' });
}

const commit = git('rev-parse', 'HEAD').trim();
writeFileSync(join(TARGET, 'lib.rs'), git('show', `${commit}:${PROTOCOL_FILE}`));
writeFileSync(join(TARGET, 'SOURCE'), `${REPOSITORY} ${commit} ${PROTOCOL_FILE}\n`);
console.log(`test/rust-protocol: ${PROTOCOL_FILE} at ${commit}`);
