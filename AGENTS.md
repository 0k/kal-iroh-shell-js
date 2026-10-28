# @0k/kal-iroh-shell

Page side of kal-iroh-shell (https://github.com/0k/kal-iroh-shell): the
page's part of the reload handshake, and the Vite plugin that publishes
interface releases.  See `README.org`.

## Layout

- `src/index.ts` and its modules — page kit (browser).
- `src/vite.ts` — Vite plugin (Node).
- `dist/` — ES modules and declarations built by `tsc -p
  tsconfig.build.json` (`npm run build`, run by `prepare`); this is what
  is published.  Relative imports carry `.js`, as Node requires.
- `test/rust-protocol/` — copy of the Rust protocol crate's `src/lib.rs`,
  and the commit it comes from (`SOURCE`).

## Rules

- **A wire name exists once per language.**  Rust: the crate
  `kal-iroh-shell-protocol`.  TypeScript: `src/protocol.ts`, imported
  by every other module.  `test/protocol.test.ts` fails when they
  disagree with `test/rust-protocol/lib.rs`.  Refresh that copy only
  with `npm run sync-protocol -- <kal-iroh-shell-checkout>`, never by
  hand, and never edit it to silence the test.
- **The reload never waits on a dead page**: the shell reloads a page
  that does not answer within 5 s or stops renewing `busy` for 30 s.
  The page renews `busy` every `BUSY_RENEW_MS`; do not lengthen it, or
  the shell's limits, to hide a page bug.
- **A release directory is immutable once published**; the plugin
  completes the copy under a temporary name, renames it, then switches
  the pointer by a rename.  A build publishes only when no plugin failed
  and every configured output was written: the plugin stays
  `enforce: 'post'`, its `writeBundle` / `closeBundle` stay
  `order: 'post', sequential: true`, and the configured outputs are read
  in `closeBundle` (other plugins add outputs after `configResolved`).
  `test/plugin.test.ts` runs real `vite build`s, failing and succeeding;
  `npm run test:vite-matrix` runs it against every Vite major of the peer
  range: run it after any change to the plugin and before widening the
  range.
- **Pruning deletes only releases**: a directory named by a build id
  whose manifest names that build id.  Never widen that test.
- The app-specific part (what to save, what means busy) stays in the
  app; this package holds no knowledge of any particular app.

## Build / test

- `npm run check` (typecheck, tests, build).
- `npm run test:vite-matrix` (plugin tests on each Vite major; needs the
  network).

## Delivery

Published to npm as `@0k/kal-iroh-shell`;
consumers depend on an exact published version.  An unreleased change is
tried in a consumer through an uncommitted local override (`npm link`
to this checkout), never by bumping the version.
