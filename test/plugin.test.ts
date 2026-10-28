// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vite from 'vite';
import { build, createLogger, version, type InlineConfig, type Plugin } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MANIFEST_FILE, POINTER_FILE, kalIrohShellRelease, readPointer } from '../src/vite';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ui-plugin-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A minimal Vite app: an index page and one script. */
function app(): string {
  const root = tempDir();
  writeFileSync(join(root, 'index.html'), '<div id="app"></div><script type="module" src="./main.js"></script>');
  writeFileSync(join(root, 'main.js'), 'document.getElementById("app").textContent = "hi";');
  return root;
}

/** Messages Vite logged at warn level or above, and at info level. */
function recorder() {
  const warnings: string[] = [];
  const infos: string[] = [];
  const logger = createLogger('silent');
  logger.warn = msg => { warnings.push(msg); };
  logger.info = msg => { infos.push(msg); };
  return { logger, warnings, infos };
}

function config(root: string, plugins: Plugin[], extra: InlineConfig = {}): InlineConfig {
  return { root, configFile: false, logLevel: 'silent', plugins, build: { outDir: 'dist' }, ...extra };
}

const breaking: Plugin = {
  name: 'breaking',
  generateBundle() { throw new Error('broken on purpose'); },
};

/** A published app, then a build of it with `plugins`, which must fail. */
async function failedRebuild(plugins: (release: Plugin) => Plugin[], extra: InlineConfig = {}) {
  const root = app();
  const publish = join(tempDir(), 'releases');
  await build(config(root, [kalIrohShellRelease({ publishDir: publish })]));
  const before = readPointer(publish);
  await expect(build(config(root, plugins(kalIrohShellRelease({ publishDir: publish })), extra)))
    .rejects.toThrow(/broken on purpose/);
  return { publish, before };
}

describe('kalIrohShellRelease', () => {
  it('builds with the Vite under test', () => {
    expect(version).toBe(process.env.KAL_IROH_SHELL_TEST_VITE_VERSION ?? version);
  });

  it('writes the manifest and publishes a successful build', async () => {
    const root = app();
    const publish = join(tempDir(), 'releases');
    const { logger, infos } = recorder();
    await build(config(root, [kalIrohShellRelease({ publishDir: publish })], { customLogger: logger }));

    const manifest = JSON.parse(readFileSync(join(root, 'dist', MANIFEST_FILE), 'utf8'));
    expect(readPointer(publish)?.build_id).toBe(manifest.build_id);
    expect(readFileSync(join(publish, manifest.build_id, 'index.html'), 'utf8')).toContain('src="./assets/');
    expect(infos.some(msg => msg.includes(`published release ${manifest.build_id}`))).toBe(true);
  });

  it('publishes nothing when the build fails', async () => {
    const root = app();
    const publish = join(tempDir(), 'releases');
    await build(config(root, [kalIrohShellRelease({ publishDir: publish })]));
    const before = readPointer(publish);

    await expect(build(config(root, [kalIrohShellRelease({ publishDir: publish }), breaking])))
      .rejects.toThrow(/broken on purpose/);

    expect(readPointer(publish)).toEqual(before);
    expect(readdirSync(publish).sort()).toEqual([POINTER_FILE, before!.build_id].sort());
  });

  it("publishes nothing when another plugin's writeBundle fails", async () => {
    const failing: Plugin = { name: 'failing', writeBundle() { throw new Error('broken on purpose'); } };
    for (const order of [(r: Plugin) => [failing, r], (r: Plugin) => [r, failing]]) {
      const { publish, before } = await failedRebuild(order);
      expect(readPointer(publish)).toEqual(before);
      expect(readdirSync(publish)).toHaveLength(2);
    }
  });

  it("publishes nothing when another plugin's closeBundle fails", async () => {
    const failing: Plugin = { name: 'failing', closeBundle() { throw new Error('broken on purpose'); } };
    const { publish, before } = await failedRebuild(r => [r, failing]);
    expect(readPointer(publish)).toEqual(before);
  });

  it('publishes nothing when the last of several outputs fails', async () => {
    const lastFails: Plugin = {
      name: 'last-fails',
      generateBundle(output) {
        if (output.entryFileNames === 'b-[name].js') throw new Error('broken on purpose');
      },
    };
    const { publish, before } = await failedRebuild(r => [r, lastFails], {
      build: { outDir: 'dist', rollupOptions: { output: [{}, { entryFileNames: 'b-[name].js' }] } },
    });
    expect(readPointer(publish)).toEqual(before);
  });

  it('publishes nothing when a later output fails before it is rendered', async () => {
    const twoOutputs = (second: Record<string, unknown>): InlineConfig => ({
      build: { outDir: 'dist', rollupOptions: { output: [{}, { entryFileNames: 'b-[name].js', ...second }] } },
    });
    const outputOptionsFail: Plugin = {
      name: 'output-options-fail',
      outputOptions(output) {
        if (output.entryFileNames === 'b-[name].js') throw new Error('broken on purpose');
        return null;
      },
    };
    const renderStartFails: Plugin = {
      name: 'render-start-fails',
      renderStart: { sequential: true, handler() { throw new Error('broken on purpose'); } },
    };
    for (const [plugins, extra] of [
      [(r: Plugin) => [outputOptionsFail, r], twoOutputs({})],
      [(r: Plugin) => [renderStartFails, r], {}],
    ] as const) {
      const { publish, before } = await failedRebuild(plugins, extra);
      expect(readPointer(publish)).toEqual(before);
    }
    const root = app();
    const publish = join(tempDir(), 'releases');
    await expect(build(config(root, [kalIrohShellRelease({ publishDir: publish })], twoOutputs({ format: 'nope' }))))
      .rejects.toThrow();
    expect(existsSync(publish)).toBe(false);
  });

  it('prunes past a dangling symlink in the publish directory', async () => {
    const root = app();
    const publish = join(tempDir(), 'releases');
    const plugin = kalIrohShellRelease({ publishDir: publish });
    await build(config(root, [plugin]));
    symlinkSync(join(publish, 'nowhere'), join(publish, 'dangling'));
    const { logger, warnings } = recorder();
    await build(config(root, [plugin], { customLogger: logger }));

    expect(warnings).toEqual([]);
    expect(readdirSync(publish)).toContain('dangling');
  });

  it('publishes a build of several outputs, with every output in its manifest', async () => {
    const root = app();
    const publish = join(tempDir(), 'releases');
    await build(config(root, [kalIrohShellRelease({ publishDir: publish })], {
      build: { outDir: 'dist', rollupOptions: { output: [{}, { entryFileNames: 'b-[name].js' }] } },
    }));

    const id = readPointer(publish)!.build_id;
    const files = JSON.parse(readFileSync(join(publish, id, MANIFEST_FILE), 'utf8')).files
      .map((f: { path: string }) => f.path);
    expect(files.filter((path: string) => /^b-.*\.js$/.test(path))).toHaveLength(1);
    expect(files).toContain('index.html');
  });

  it('counts an output another plugin adds once the config is resolved', async () => {
    // What ``@vitejs/plugin-legacy`` does: a post plugin turns the output
    // into an array of two in its own ``configResolved``.
    const addsOutput = (fails: boolean): Plugin => ({
      name: 'adds-output',
      enforce: 'post',
      configResolved(resolved) {
        resolved.build.rollupOptions.output = [{}, { entryFileNames: 'legacy-[name].js' }];
      },
      generateBundle(output) {
        if (fails && output.entryFileNames === 'legacy-[name].js') throw new Error('broken on purpose');
      },
    });
    for (const order of [(r: Plugin) => [addsOutput(false), r], (r: Plugin) => [r, addsOutput(false)]]) {
      const root = app();
      const publish = join(tempDir(), 'releases');
      await build(config(root, order(kalIrohShellRelease({ publishDir: publish }))));
      expect(readPointer(publish)).not.toBeNull();
    }
    const { publish, before } = await failedRebuild(r => [r, addsOutput(true)]);
    expect(readPointer(publish)).toEqual(before);
  });

  it("publishes nothing when a post plugin listed before it fails in a post write hook", async () => {
    for (const hook of ['writeBundle', 'closeBundle'] as const) {
      const failing: Plugin = {
        name: 'failing-post',
        enforce: 'post',
        [hook]: { order: 'post', handler() { throw new Error('broken on purpose'); } },
      };
      const { publish, before } = await failedRebuild(r => [failing, r]);
      expect(readPointer(publish)).toEqual(before);
    }
  });

  it('publishes nothing for a build configured with no output', async () => {
    const root = app();
    const publish = join(tempDir(), 'releases');
    await build(config(root, [kalIrohShellRelease({ publishDir: publish })]));
    const before = readPointer(publish);
    writeFileSync(join(root, 'dist', 'stale.txt'), 'old');
    await build(config(root, [kalIrohShellRelease({ publishDir: publish })], {
      build: { outDir: 'dist', emptyOutDir: false, rollupOptions: { output: [] } },
    })).catch(() => undefined);

    expect(readPointer(publish)).toEqual(before);
  });

  it("starts each build from zero after another plugin's closeBundle failed", async () => {
    const root = app();
    const publish = join(tempDir(), 'releases');
    const plugin = kalIrohShellRelease({ publishDir: publish });
    await build(config(root, [plugin]));
    const first = readPointer(publish);
    const closeFails: Plugin = { name: 'close-fails', closeBundle() { throw new Error('broken on purpose'); } };
    await expect(build(config(root, [closeFails, plugin]))).rejects.toThrow(/broken on purpose/);
    await expect(build(config(root, [plugin, breaking]))).rejects.toThrow(/broken on purpose/);
    expect(readPointer(publish)).toEqual(first);

    await build(config(root, [plugin]));
    expect(readPointer(publish)!.build_id).not.toBe(first!.build_id);
  });

  it.runIf(typeof vite.createBuilder === 'function')(
    "starts each build of a reused builder from zero after another plugin's closeBundle failed",
    async () => {
      const root = app();
      const publish = join(tempDir(), 'releases');
      let mode: 'good' | 'close-fails' | 'generate-fails' = 'good';
      const switchable: Plugin = {
        name: 'switchable',
        generateBundle() { if (mode === 'generate-fails') throw new Error('broken on purpose'); },
        closeBundle() { if (mode === 'close-fails') throw new Error('broken on purpose'); },
      };
      const createBuilder = (vite as unknown as {
        createBuilder(config: InlineConfig): Promise<{ build(env: unknown): Promise<unknown>; environments: { client: unknown } }>;
      }).createBuilder;
      const builder = await createBuilder(config(root, [switchable, kalIrohShellRelease({ publishDir: publish })]));
      await builder.build(builder.environments.client);
      const first = readPointer(publish);
      mode = 'close-fails';
      await expect(builder.build(builder.environments.client)).rejects.toThrow(/broken on purpose/);
      mode = 'generate-fails';
      await expect(builder.build(builder.environments.client)).rejects.toThrow(/broken on purpose/);
      expect(readPointer(publish)).toEqual(first);

      mode = 'good';
      await builder.build(builder.environments.client);
      expect(readPointer(publish)!.build_id).not.toBe(first!.build_id);
    },
  );

  it('never publishes nor crashes in watch mode', async () => {
    const root = app();
    const publish = join(tempDir(), 'releases');
    const { logger, infos } = recorder();
    let closed = 0;
    const counter: Plugin = { name: 'counter', closeBundle() { closed += 1; } };
    const errors: unknown[] = [];
    const watcher = await build(config(root, [counter, kalIrohShellRelease({ publishDir: publish })], {
      customLogger: logger, build: { outDir: 'dist', watch: {} },
    })) as unknown as {
      on(event: 'event', listener: (e: { code: string; error?: unknown }) => void): void;
      close(): Promise<void>;
    };
    watcher.on('event', e => { if (e.code === 'ERROR') errors.push(e.error); });
    // Waits for build `n`, editing again every second: the watcher may
    // not be listening yet when the first edit lands.
    const until = async (n: number, edit?: () => void) => {
      for (let waited = 0; closed < n; waited += 50) {
        if (waited > 20_000) throw new Error(`only ${closed} builds`);
        if (edit && waited % 1000 === 0) edit();
        await new Promise(done => setTimeout(done, 50));
      }
    };
    try {
      await until(1);
      for (const n of [2, 3]) {
        await until(n, () => writeFileSync(join(root, 'main.js'), `document.body.textContent = "${n}";`));
      }
    } finally {
      await watcher.close();
    }

    expect(errors).toEqual([]);
    expect(existsSync(publish)).toBe(false);
    expect(existsSync(join(root, 'dist', MANIFEST_FILE))).toBe(false);
    expect(infos.some(msg => msg.includes('watch mode'))).toBe(true);
  }, 60_000);

  it('includes files other plugins write while closing the bundle', async () => {
    const root = app();
    const publish = join(tempDir(), 'releases');
    const serviceWorker: Plugin = {
      name: 'service-worker',
      async closeBundle() {
        await new Promise(done => setTimeout(done, 50));
        writeFileSync(join(root, 'dist', 'sw.js'), 'self.skipWaiting();');
      },
    };
    await build(config(root, [serviceWorker, kalIrohShellRelease({ publishDir: publish })]));

    const id = readPointer(publish)!.build_id;
    expect(readFileSync(join(publish, id, 'sw.js'), 'utf8')).toBe('self.skipWaiting();');
    const manifest = JSON.parse(readFileSync(join(publish, id, MANIFEST_FILE), 'utf8'));
    expect(manifest.files.map((f: { path: string }) => f.path)).toContain('sw.js');
  });

  it('leaves SSR builds, library builds and builds that write nothing alone', async () => {
    const root = app();
    const publish = join(tempDir(), 'releases');
    const { logger, warnings } = recorder();
    await build(config(root, [kalIrohShellRelease({ publishDir: publish })], {
      customLogger: logger, build: { outDir: 'dist-ssr', ssr: 'main.js' },
    }));
    await build(config(root, [kalIrohShellRelease({ publishDir: publish })], {
      customLogger: logger, build: { write: false },
    }));
    await build(config(root, [kalIrohShellRelease({ publishDir: publish })], {
      customLogger: logger, build: { outDir: 'dist-lib', lib: { entry: 'main.js', formats: ['es', 'cjs'] } },
    }));

    expect(existsSync(publish)).toBe(false);
    expect(existsSync(join(root, 'dist-ssr', MANIFEST_FILE))).toBe(false);
    expect(existsSync(join(root, 'dist-lib', MANIFEST_FILE))).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('publishes nothing when publishDir is empty, and expands ~/', async () => {
    const root = app();
    await build(config(root, [kalIrohShellRelease({ publishDir: '' })]));
    expect(readdirSync(root).sort()).toEqual(['dist', 'index.html', 'main.js']);

    const home = tempDir();
    vi.stubEnv('HOME', home);
    try {
      await build(config(root, [kalIrohShellRelease({ publishDir: '~/releases' })]));
    } finally {
      vi.unstubAllEnvs();
    }
    expect(readPointer(join(home, 'releases'))).not.toBeNull();
  });

  it("resolves a relative publishDir against Vite's root", async () => {
    const root = app();
    await build(config(root, [kalIrohShellRelease({ publishDir: 'releases' })]));

    expect(readPointer(join(root, 'releases'))?.build_id).toMatch(/^\d{8}T\d{6}-[0-9a-f]{6}$/);
  });

  it('gives every build of one plugin instance its own release', async () => {
    const root = app();
    const publish = join(tempDir(), 'releases');
    const plugin = kalIrohShellRelease({ publishDir: publish });
    await build(config(root, [plugin]));
    const first = readPointer(publish)!.build_id;
    await build(config(root, [plugin]));

    expect(readPointer(publish)!.build_id).not.toBe(first);
    expect(existsSync(join(publish, first))).toBe(true);
  });

  it("keeps the app's own base, with a warning", async () => {
    const root = app();
    const { logger, warnings } = recorder();
    await build(config(root, [kalIrohShellRelease()], { base: '/myapp/', customLogger: logger }));

    expect(readFileSync(join(root, 'dist', 'index.html'), 'utf8')).toContain('src="/myapp/assets/');
    expect(warnings.some(msg => msg.includes("base is '/myapp/'"))).toBe(true);
  });

  it('forgets the base of a previous build of the same plugin instance', async () => {
    const root = app();
    const { logger, warnings } = recorder();
    const plugin = kalIrohShellRelease();
    await build(config(root, [plugin], { base: '/myapp/', customLogger: logger }));
    await build(config(root, [plugin], { customLogger: logger }));

    expect(warnings).toHaveLength(1);
    expect(readFileSync(join(root, 'dist', 'index.html'), 'utf8')).toContain('src="./assets/');
  });
});
