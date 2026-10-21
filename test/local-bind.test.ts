/**
 * AC-8: F1 standalone binds loopback by default and logs the actual address.
 *
 * Spawns the built CLI on port 0, reads the log line, and talks to the address
 * it reported. `HISAISHI_BIND` is absent, so the default must be loopback.
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const CLI = join(import.meta.dirname, '..', 'dist', 'local', 'cli.js');

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
}

describe('F1 standalone binding', () => {
  it('binds loopback by default and logs the real address', async () => {
    if (!existsSync(CLI)) {
      throw new Error(`build first: ${CLI} is missing`);
    }
    const dir = await mkdtemp(join(tmpdir(), 'hisaishi-bind-'));
    // A minimal env: inheriting the parent's would trip the keyless audit on
    // whatever key-shaped variables the test runner happens to carry.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      RPC_URL: 'https://rpc.invalid',
      IPFS_GATEWAY: 'https://gw.invalid/ipfs',
      REGISTRY_ADDRESS: `0x${'11'.repeat(20)}`,
      HISAISHI_DB_PATH: join(dir, 'gateway.db'),
      HISAISHI_DEPLOYMENT_ID: 'bind-test',
      PORT: '0',
      DEV_MODE: 'true',
      // No HISAISHI_BIND: the default must be loopback.
    };
    const child = spawn(process.execPath, [CLI], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    try {
      const port = await new Promise<number>((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error(`no bind log: ${buffer}`)), 20_000);
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const match = /listening on http:\/\/([^:]+):(\d+)/.exec(buffer);
          if (match !== null) {
            clearTimeout(timer);
            expect(match[1]).toBe('127.0.0.1');
            resolve(Number(match[2]));
          }
        });
        child.on('error', reject);
        child.on('exit', (code) => {
          if (code !== null && code !== 0) {
            reject(new Error(`cli exited ${code}: ${stderr}`));
          }
        });
      });

      const response = await fetch(`http://127.0.0.1:${port}/v1/health`);
      expect(response.status).toBe(200);
      expect((await response.json()) as { deploymentId: string; capabilities: boolean }).toMatchObject({
        deploymentId: 'bind-test',
        capabilities: true,
      });
    } finally {
      if (child.pid !== undefined) killTree(child.pid);
      // Windows keeps SQLite handles open for a moment after taskkill; retry
      // the temp-dir removal rather than failing a passing test.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 40_000);
});
