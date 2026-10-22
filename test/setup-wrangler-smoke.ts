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
//
// Use the package manager that launched the test (`npm_execpath`) rather than
// whatever `pnpm` resolves to on PATH. A corepack shim for another pnpm major
// rejects the project's `packageManager`, which made the whole suite fail in an
// otherwise valid environment. Falling back to PATH keeps `vitest` invoked
// directly working.
const npmExecPath = process.env.npm_execpath;

function runPnpm(args: string[]): void {
  if (npmExecPath !== undefined && npmExecPath !== '') {
    // `npm_execpath` may be a JS shim (`pnpm.cjs`) or a native binary
    // (`pnpm-native.exe`); only the former goes through node.
    const isJs = npmExecPath.endsWith('.cjs') || npmExecPath.endsWith('.js') || npmExecPath.endsWith('.mjs');
    if (isJs) {
      execFileSync(process.execPath, [npmExecPath, ...args], { cwd: root, stdio: 'ignore' });
    } else {
      execFileSync(npmExecPath, args, { cwd: root, stdio: 'ignore', shell: true });
    }
    return;
  }
  execFileSync('pnpm', args, { cwd: root, stdio: 'ignore', shell: true });
}

function runWrangler(args: string[]): void {
  if (npmExecPath !== undefined && npmExecPath !== '') {
    runPnpm(['exec', 'wrangler', ...args]);
    return;
  }
  execFileSync('npx', ['wrangler', ...args], { cwd: root, stdio: 'ignore', shell: true });
}

runPnpm(['build']);
runWrangler(['deploy', '--dry-run', '--outdir', dir]);

process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover directory is harmless (gitignored).
  }
});
