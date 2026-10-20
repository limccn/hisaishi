/**
 * Harness A — real `node:sqlite` through the F1 adapter.
 *
 * Deliberately not `:memory:`: WAL, busy_timeout and the on-disk file path are
 * part of what F1 *is*, and an in-memory database silently skips them. Each test
 * gets a fresh temp file so rows never leak between cases.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGatewayHandle, type GatewayHandle } from '../src/core/gateway.js';
import type { Ports } from '../src/core/contract.js';
import { createMemoryHarness, type Harness } from '../src/core/ports/memory.js';
import { openDatabase, SqliteContentCache, SqliteDocStore } from '../src/local/sqlite.js';

export interface SqliteHarnessResult {
  handle: GatewayHandle;
  harness: Harness;
  dbPath: string;
  cleanup(): Promise<void>;
}

export async function createSqliteHarness(): Promise<SqliteHarnessResult> {
  const dir = await mkdtemp(join(tmpdir(), 'hisaishi-test-'));
  const dbPath = join(dir, 'gateway.db');
  const db = openDatabase(dbPath);

  // Real SQLite storage, in-memory doubles for the network edges. Mixing them
  // is the point: the suite must exercise the adapter that production uses,
  // not a stand-in for it.
  const memory = createMemoryHarness();
  const ports: Ports = {
    ...memory.ports,
    docStore: new SqliteDocStore(db),
    contentCache: new SqliteContentCache(db),
  };

  return {
    handle: createGatewayHandle(ports),
    harness: memory,
    dbPath,
    async cleanup() {
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
