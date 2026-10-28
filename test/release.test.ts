// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KEPT_RELEASES, MANIFEST_FILE, POINTER_FILE, newBuildId, publishRelease, readPointer, writeManifest,
} from '../src/vite';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ui-release-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A fake Vite output with an index and one asset, and its manifest. */
function fakeBuild(buildId: string, mainJs = 'console.log(1)'): string {
  const dist = tempDir();
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<div id="app"></div>');
  writeFileSync(join(dist, 'assets', 'main.js'), mainJs);
  writeManifest(dist, buildId);
  return dist;
}

describe('ui release publishing', () => {
  it('describes every built file by size and sha256', () => {
    const dist = fakeBuild('20261023T000000-aaaaaa', 'abc');
    const manifest = JSON.parse(readFileSync(join(dist, MANIFEST_FILE), 'utf8'));
    expect(manifest).toEqual({
      build_id: '20261023T000000-aaaaaa',
      files: [
        { path: 'assets/main.js', size: 3,
          sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
        { path: 'index.html', size: 20, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ],
    });
  });

  it('publishes a frozen copy and points current.json at it', () => {
    const publish = tempDir();
    const id = publishRelease(fakeBuild('20261023T000000-aaaaaa'), publish, new Date('2026-10-23T00:00:00Z'));

    expect(readFileSync(join(publish, id, 'assets', 'main.js'), 'utf8')).toBe('console.log(1)');
    expect(readPointer(publish)).toEqual({ build_id: id, published_at: '2026-10-23T00:00:00.000Z' });
    expect(readdirSync(publish).sort()).toEqual([POINTER_FILE, id].sort());
  });

  it('keeps an earlier release readable after a newer one becomes current', () => {
    const publish = tempDir();
    publishRelease(fakeBuild('20261023T000000-aaaaaa', 'old'), publish);
    publishRelease(fakeBuild('20261023T000001-bbbbbb', 'new'), publish);

    expect(readPointer(publish)?.build_id).toBe('20261023T000001-bbbbbb');
    expect(readFileSync(join(publish, '20261023T000000-aaaaaa', 'assets', 'main.js'), 'utf8')).toBe('old');
  });

  it('refuses to overwrite a release that is already published', () => {
    const publish = tempDir();
    publishRelease(fakeBuild('20261023T000000-aaaaaa', 'first'), publish);

    expect(() => publishRelease(fakeBuild('20261023T000000-aaaaaa', 'second'), publish)).toThrow(/already published/);
    expect(readFileSync(join(publish, '20261023T000000-aaaaaa', 'assets', 'main.js'), 'utf8')).toBe('first');
  });

  it('prunes all but the five newest releases besides the current one', () => {
    const publish = tempDir();
    const ids = Array.from({ length: 8 }, (_, i) => `20261023T00000${i}-aaaaaa`);
    for (const id of ids) publishRelease(fakeBuild(id), publish);

    expect(readdirSync(publish).filter(n => n !== POINTER_FILE).sort()).toEqual(ids.slice(2));
  });

  it('never deletes or counts what is not one of its releases', () => {
    const publish = tempDir();
    const foreign = ['Documents', 'src', '20261023T000000-ffffff'];
    for (const name of foreign) {
      mkdirSync(join(publish, name));
      writeFileSync(join(publish, name, 'keep.txt'), name);
    }
    // A release-looking directory whose manifest names another build.
    writeFileSync(join(publish, '20261023T000000-ffffff', MANIFEST_FILE), '{"build_id":"20261023T000001-aaaaaa"}');
    writeFileSync(join(publish, POINTER_FILE), '{"build_id":"20261023T000000-eeeeee","published_at":"2026-10-23T00:00:00.000Z"}');
    const ids = Array.from({ length: 7 }, (_, i) => `20261023T10000${i}-aaaaaa`);
    for (const id of ids) publishRelease(fakeBuild(id), publish);

    expect(readdirSync(publish).filter(n => n !== POINTER_FILE).sort()).toEqual([...foreign, ...ids.slice(1)].sort());
    for (const name of foreign) expect(readFileSync(join(publish, name, 'keep.txt'), 'utf8')).toBe(name);
  });

  it('refuses to publish into a non-empty directory that has no current.json', () => {
    const publish = tempDir();
    writeFileSync(join(publish, 'notes.txt'), 'mine');

    expect(() => publishRelease(fakeBuild('20261023T000000-aaaaaa'), publish)).toThrow(/not a publish directory/);
    expect(readdirSync(publish)).toEqual(['notes.txt']);
  });

  it('refuses a directory whose current.json is not one of its pointers', () => {
    const publish = tempDir();
    writeFileSync(join(publish, POINTER_FILE), '{"theme":"dark"}');
    writeFileSync(join(publish, 'settings.json'), '{}');

    expect(() => publishRelease(fakeBuild('20261023T000000-aaaaaa'), publish)).toThrow(/not a publish directory/);
    expect(readFileSync(join(publish, POINTER_FILE), 'utf8')).toBe('{"theme":"dark"}');
  });

  it('removes the copies of interrupted publishes', () => {
    const publish = tempDir();
    mkdirSync(join(publish, '.partial-20261023T000000-cccccc'));
    mkdirSync(join(publish, '.partial-notes'));
    publishRelease(fakeBuild('20261023T000001-aaaaaa'), publish);

    expect(readdirSync(publish).sort()).toEqual(['.partial-notes', '20261023T000001-aaaaaa', POINTER_FILE].sort());
  });

  it('reports a failed pruning without failing a publish already done', () => {
    const publish = tempDir();
    const ids = Array.from({ length: KEPT_RELEASES + 2 }, (_, i) => `20261023T00000${i}-aaaaaa`);
    for (const id of ids.slice(0, -1)) publishRelease(fakeBuild(id), publish);
    const locked = join(publish, ids[0], 'assets');
    chmodSync(locked, 0o555);
    const warn = vi.fn();
    try {
      expect(publishRelease(fakeBuild(ids.at(-1)!), publish, new Date(), warn)).toBe(ids.at(-1));
    } finally {
      chmodSync(locked, 0o755);
    }

    expect(readPointer(publish)?.build_id).toBe(ids.at(-1));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/release 20261023T000006-aaaaaa published, but pruning .* failed/);
  });

  it('generates build ids usable as one URL path segment, sorted by time', () => {
    const a = newBuildId(new Date('2026-10-23T08:00:00Z'));
    const b = newBuildId(new Date('2026-10-23T09:00:00Z'));
    expect(a).toMatch(/^20261023T080000-[0-9a-f]{6}$/);
    expect([b, a].sort()).toEqual([a, b]);
  });
});
