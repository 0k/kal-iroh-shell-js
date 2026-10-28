// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as protocol from '../src/protocol';

/**
 * `pub const NAME: &str = "value";` of the Rust protocol crate, from the
 * copy `npm run sync-protocol` keeps in `test/rust-protocol/`.
 */
function rustConstants(): Record<string, string> {
  const src = readFileSync(fileURLToPath(new URL('./rust-protocol/lib.rs', import.meta.url)), 'utf8');
  return Object.fromEntries(
    [...src.matchAll(/pub const (\w+): &str = "([^"]*)";/g)].map(([, name, value]) => [name, value]),
  );
}

describe('wire names', () => {
  it('match the Rust protocol crate', () => {
    const rust = rustConstants();
    for (const [name, value] of Object.entries(protocol)) {
      expect({ name, value }).toEqual({ name, value: rust[name] });
    }
  });
});
