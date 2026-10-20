/**
 * Builds the wrangler bundle the smoke test runs.
 *
 * **Rebuilt on every test run.** The first version built only when the file was
 * absent, so the smoke could pass against a bundle from an earlier commit — and
 * did: a bundle containing the pre-rename `KV_STAGING` was reused for two full
 * suite runs (review 2026-10-20, H1). A smoke that can test yesterday's code is
 * worse than no smoke.
 *
 * `dist/` is gitignored and never built by `pnpm test` on its own, so the build
 * runs here too; otherwise a fresh clone would fail with a missing entry point.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const dir = join(root, '.wrangler-smoke');

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

// TypeScript first: wrangler bundles `dist/worker/index.js`.
execFileSync('pnpm', ['build'], { cwd: root, stdio: 'ignore', shell: true });
execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', dir], {
  cwd: root,
  stdio: 'ignore',
  shell: true,
});

process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover directory is harmless (gitignored).
  }
});
