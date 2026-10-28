#!/usr/bin/env node
/**
 * Run the plugin's tests against every Vite major of the peer range.
 *
 * Usage:  npm run test:vite-matrix
 *
 * Installs each major into a temporary directory and runs the tests that
 * build with Vite, with `vite` aliased to that install.  Fails when any
 * major fails.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const peer = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).peerDependencies.vite;
const majors = [...peer.matchAll(/\^(\d+)/g)].map(([, major]) => major);
const root = mkdtempSync(join(tmpdir(), 'kal-iroh-shell-vite-'));
const failed = [];
try {
  for (const major of majors) {
    const prefix = join(root, `vite${major}`);
    execFileSync('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--silent', `vite@${major}`], {
      stdio: 'inherit',
    });
    // The ES module entry: Vite 5's CommonJS one is deprecated.
    const entry = join(prefix, 'node_modules', 'vite', 'dist', 'node', 'index.js');
    const version = JSON.parse(readFileSync(join(prefix, 'node_modules', 'vite', 'package.json'), 'utf8')).version;
    console.log(`== vite ${version}`);
    try {
      execFileSync('npx', ['vitest', 'run', 'test/plugin.test.ts', 'test/release.test.ts'], {
        stdio: 'inherit',
        env: { ...process.env, KAL_IROH_SHELL_TEST_VITE: entry, KAL_IROH_SHELL_TEST_VITE_VERSION: version },
      });
    } catch {
      failed.push(version);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
if (failed.length > 0) {
  console.error(`failed with vite ${failed.join(', ')}`);
  process.exit(1);
}
