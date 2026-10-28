/**
 * Publishing interface releases, from a Vite build.
 *
 * Every successful production build gets a BUILD ID and a
 * `ui-manifest.json` (path, size and sha256 of every file).  With a
 * publish directory, the build is then PUBLISHED: copied into
 * `<dir>/<build-id>/`, a frozen copy that is never written again, and
 * `<dir>/current.json` is switched to it.  The release server
 * (`kal-iroh-shell-releases`) serves that directory.
 *
 * - A device never sees a half-written release: the copy is completed
 *   under a temporary name and renamed, and only then is the pointer
 *   replaced, itself by a rename.  A failed build publishes nothing.
 * - A page that is already open keeps loading ITS OWN release's lazy
 *   chunks, because each release lives under its own directory and the
 *   newest few are kept.
 * - Only releases are ever deleted: a directory is a release when its
 *   name is a build id and its manifest names that build id.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { Logger, Plugin, ResolvedConfig } from 'vite';
import { MANIFEST_FILE, POINTER_FILE } from './protocol.js';

export { MANIFEST_FILE, POINTER_FILE };

/** Releases kept besides the current one, for pages still running them. */
export const KEPT_RELEASES = 5;

/** One file of a build, as listed in its manifest. */
export interface ManifestEntry { path: string; size: number; sha256: string }
/** Content of `ui-manifest.json`. */
export interface UiManifest { build_id: string; files: ManifestEntry[] }
/** Content of `current.json`. */
export interface UiPointer { build_id: string; published_at: string }

/**
 * Build ids, as made by {@link newBuildId}: UTC timestamp plus random
 * suffix.  They are also directory names and URL path segments.
 */
const BUILD_ID_RE = /^\d{8}T\d{6}-[0-9a-f]{6}$/;

/** A fresh build id: sortable UTC timestamp plus random suffix. */
export function newBuildId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** Manifest of every file under `dist`, the manifest itself excluded. */
export function buildManifest(dist: string, buildId: string): UiManifest {
  if (!BUILD_ID_RE.test(buildId)) throw new Error(`invalid build id: ${buildId}`);
  const files = walk(dist)
    .map(full => relative(dist, full).split(sep).join('/'))
    .filter(path => path !== MANIFEST_FILE)
    .sort()
    .map(path => {
      const bytes = readFileSync(join(dist, path));
      return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
  return { build_id: buildId, files };
}

/** Write `ui-manifest.json` into `dist`. */
export function writeManifest(dist: string, buildId: string): UiManifest {
  const manifest = buildManifest(dist, buildId);
  writeFileSync(join(dist, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/** Replace `path` by a rename. */
function writeAtomically(path: string, contents: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

/** The release `current.json` names, or null. */
export function readPointer(publishDir: string): UiPointer | null {
  const path = join(publishDir, POINTER_FILE);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as UiPointer;
}

/**
 * Whether `publishDir` may receive a release: it does not exist yet, is
 * empty (but for interrupted copies), or has a `current.json` naming a
 * build id.
 */
function isPublishDir(publishDir: string): boolean {
  if (!existsSync(publishDir)) return true;
  if (existsSync(join(publishDir, POINTER_FILE))) {
    try {
      return BUILD_ID_RE.test(readPointer(publishDir)?.build_id ?? '');
    } catch {
      return false;
    }
  }
  return readdirSync(publishDir).every(name => name.startsWith('.partial-'));
}

/** Whether `<publishDir>/<name>` is a release published by this plugin. */
function isRelease(publishDir: string, name: string): boolean {
  if (!BUILD_ID_RE.test(name)) return false;
  const manifest = join(publishDir, name, MANIFEST_FILE);
  if (!existsSync(manifest)) return false;
  try {
    return (JSON.parse(readFileSync(manifest, 'utf8')) as UiManifest).build_id === name;
  } catch {
    return false;
  }
}

/**
 * Publish the build in `dist` (which must hold its manifest) and make it
 * current.  Returns the build id.  Fails, publishing nothing, when the
 * manifest is missing, the release already exists, `publishDir` is not a
 * publish directory (it holds other files, and no `current.json` naming a
 * build id), or the copy does not match the manifest.
 *
 * Once `current.json` is switched, the release is published: pruning the
 * old ones is then best effort, and its failure is only reported to `warn`.
 */
export function publishRelease(
  dist: string,
  publishDir: string,
  now: Date = new Date(),
  warn: (message: string) => void = message => console.warn(message),
): string {
  const manifest = JSON.parse(readFileSync(join(dist, MANIFEST_FILE), 'utf8')) as UiManifest;
  const id = manifest.build_id;
  if (!BUILD_ID_RE.test(id)) throw new Error(`invalid build id in manifest: ${id}`);
  if (!isPublishDir(publishDir)) {
    throw new Error(`${publishDir} is not empty and has no valid ${POINTER_FILE}: not a publish directory`);
  }
  mkdirSync(publishDir, { recursive: true });
  const target = join(publishDir, id);
  if (existsSync(target)) throw new Error(`release ${id} is already published`);
  const partial = join(publishDir, `.partial-${id}`);
  rmSync(partial, { recursive: true, force: true });
  cpSync(dist, partial, { recursive: true });
  // Another publisher's pruning may have removed files under our feet.
  const copied = buildManifest(partial, id).files;
  if (JSON.stringify(copied) !== JSON.stringify(manifest.files)) {
    rmSync(partial, { recursive: true, force: true });
    throw new Error(`release ${id}: the copy in ${publishDir} does not match its manifest`);
  }
  renameSync(partial, target);
  writeAtomically(
    join(publishDir, POINTER_FILE),
    JSON.stringify({ build_id: id, published_at: now.toISOString() }) + '\n',
  );
  try {
    pruneReleases(publishDir, KEPT_RELEASES);
  } catch (e) {
    warn(`kal-iroh-shell: release ${id} published, but pruning ${publishDir} failed: ${String(e)}`);
  }
  return id;
}

/**
 * Delete all but the `keep` newest releases besides the current one, and
 * the copies of interrupted publishes (`.partial-<build-id>`).  Anything
 * else is left alone.  Returns the deleted build ids.
 */
export function pruneReleases(publishDir: string, keep: number): string[] {
  for (const name of readdirSync(publishDir)) {
    if (name.startsWith('.partial-') && BUILD_ID_RE.test(name.slice('.partial-'.length))) {
      rmSync(join(publishDir, name), { recursive: true, force: true });
    }
  }
  const current = readPointer(publishDir)?.build_id;
  const releases = readdirSync(publishDir)
    .filter(name => name !== current && isRelease(publishDir, name))
    .sort()
    .reverse();
  const removed = releases.slice(keep);
  for (const name of removed) rmSync(join(publishDir, name), { recursive: true, force: true });
  return removed;
}

/** Options of {@link kalIrohShellRelease}. */
export interface KalIrohShellReleaseOptions {
  /**
   * Publish directory: relative to Vite's `root`, `~/` expanded to the
   * home directory.  Without it, or when it is empty, nothing is published.
   */
  publishDir?: string;
}

/**
 * Vite plugin: relative asset URLs (`base: './'`, so a release works
 * under any prefix), a manifest in every successful build, and a publish
 * when `publishDir` is given.
 *
 * An app that sets its own `base` keeps it, with a warning: its releases
 * then only work under that prefix.  SSR builds, library builds, watch
 * mode and builds that write no files are left alone.
 *
 * Its write hooks run last, after every other plugin's: list it last
 * among the plugins, so that files other plugins add while closing the
 * bundle are part of the release.  A build in which any plugin fails
 * publishes nothing.
 *
 * One plugin instance per Vite config: an instance shared by several
 * environments of one programmatic builder keeps the last one's settings.
 * Watch mode (`vite build --watch`) never writes a manifest nor publishes.
 */
export function kalIrohShellRelease(options: KalIrohShellReleaseOptions = {}): Plugin {
  let outDir = 'dist';
  let publishDir: string | undefined;
  let logger: Logger | undefined;
  let ownBase: string | undefined;
  let skip = false;
  let watching = false;
  let resolved: ResolvedConfig | undefined;
  let written = 0;
  return {
    name: 'kal-iroh-shell-release',
    apply: 'build',
    // After every normal plugin, whatever the listing order.
    enforce: 'post',
    config(config) {
      ownBase = config.base;
      return ownBase === undefined ? { base: './' } : undefined;
    },
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      publishDir = options.publishDir
        ? resolve(config.root, options.publishDir.replace(/^~(?=\/|$)/, homedir()))
        : undefined;
      logger = config.logger;
      resolved = config;
      skip = Boolean(config.build.ssr) || Boolean(config.build.lib) || config.build.write === false;
      // Watch mode never publishes: every save would push a release to
      // every device, and Vite's watcher neither re-runs the per-build
      // hooks reliably (Vite 8) nor waits for the previous build's
      // `closeBundle` before starting the next one.
      watching = !skip && Boolean(config.build.watch);
      if (watching) logger.info('kal-iroh-shell: watch mode: no manifest written and nothing published');
      if (!skip && ownBase !== undefined && ownBase !== './' && ownBase !== '') {
        logger.warn(`kal-iroh-shell: base is '${ownBase}', not './': releases only work under that prefix`);
      }
    },
    // Called once per build, every output included, on Rollup and
    // Rolldown alike (Vite 8 calls `buildStart` once per output), and
    // again for each `build()` of a reused builder: a new build has
    // written nothing yet, even when the previous build's `closeBundle`
    // was skipped because another plugin's threw.
    options() {
      written = 0;
      return null;
    },
    // Sequential and last: runs only once every other plugin's
    // `writeBundle` has succeeded, after the output's files are written.
    writeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        written += 1;
      },
    },
    // Sequential and last: runs only once every other plugin's
    // `closeBundle` has succeeded.  Vite calls it after a failed write
    // too, without an error: the build succeeded only when every output
    // was written.
    closeBundle: {
      order: 'post',
      sequential: true,
      handler(error?: Error) {
        const done = written;
        written = 0;
        if (skip || watching) return;
        // Read now: plugins such as `@vitejs/plugin-legacy` add outputs
        // after this plugin's `configResolved`.  Vite 8 reads
        // `rolldownOptions`, with `rollupOptions` as its alias.
        const build = resolved?.build as { rolldownOptions?: { output?: unknown } } & ResolvedConfig['build'];
        const bundler = build?.rolldownOptions ?? build?.rollupOptions;
        const outputs = Array.isArray(bundler?.output) ? bundler.output.length : 1;
        if (error || outputs === 0 || done !== outputs) {
          logger?.warn('kal-iroh-shell: build failed, no manifest written and nothing published');
          return;
        }
        const buildId = newBuildId();
        writeManifest(outDir, buildId);
        if (publishDir) {
          publishRelease(outDir, publishDir, new Date(), message => logger?.warn(message));
          logger?.info(`kal-iroh-shell: published release ${buildId} to ${publishDir}`);
        }
      },
    },
  };
}
