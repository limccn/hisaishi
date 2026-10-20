/**
 * Builds the wrangler bundle the smoke test runs.
 *
 * Kept as a vitest setup step rather than a committed artifact: the bundle is
 * 213 KiB of generated code, and committing it would let the test pass against
 * a stale copy of the Worker.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', '.wrangler-smoke');

if (!existsSync(join(dir, 'index.js'))) {
  mkdirSync(dir, { recursive: true });
  execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', dir], {
    cwd: join(import.meta.dirname, '..'),
    stdio: 'ignore',
    shell: true,
  });
}

process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover directory is harmless (gitignored).
  }
});
