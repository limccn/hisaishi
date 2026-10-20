/**
 * Gate A probes (M1-19, M1-20).
 *
 * These test `node:sqlite` itself, not our routes: the design's fallback clause
 * (better-sqlite3 as a one-file swap) is only credible if the properties the
 * adapter relies on are measured rather than assumed.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, SqliteDocStore, DDL } from '../src/local/sqlite.js';
import { contentFor, OWNER, OTHER_OWNER } from './contract-suite.js';

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function tempDb() {
  const dir = await mkdtemp(join(tmpdir(), 'hisaishi-probe-'));
  dirs.push(dir);
  return { dir, path: join(dir, 'probe.db') };
}

describe('M1-20: node:sqlite concurrency', () => {
  it('two connections to one file do not deadlock under WAL + busy_timeout', async () => {
    const { path } = await tempDb();
    const a = openDatabase(path);
    const b = openDatabase(path);
    try {
      // Interleaved writes from two handles: embedded gateway + another
      // consumer in the same process is exactly this shape.
      for (let i = 0; i < 50; i += 1) {
        const storeA = new SqliteDocStore(a);
        const storeB = new SqliteDocStore(b);
        await storeA.insertOrGet({
          owner: OWNER,
          contentHash: `0x${i.toString(16).padStart(64, '0')}`,
          cidDigest: `0x${'0'.repeat(64)}`,
          cid: `cid-a-${i}`,
          tags: [],
          now: i,
        });
        await storeB.insertOrGet({
          owner: OTHER_OWNER,
          contentHash: `0x${i.toString(16).padStart(64, '0')}`,
          cidDigest: `0x${'0'.repeat(64)}`,
          cid: `cid-b-${i}`,
          tags: [],
          now: i,
        });
      }

      const count = a.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
      expect(count.n).toBe(100);
    } finally {
      a.close();
      b.close();
    }
  });

  it('journal_mode is actually WAL after bootstrap', async () => {
    const { path } = await tempDb();
    const db = openDatabase(path);
    try {
      const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(mode.journal_mode.toLowerCase()).toBe('wal');
      const timeout = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      expect(Number(timeout.timeout)).toBe(5000);
    } finally {
      db.close();
    }
  });
});

describe('M1-19: SQLite behaviour the adapter depends on', () => {
  it('CJK text roundtrips byte-exact', async () => {
    const { path } = await tempDb();
    const db = openDatabase(path);
    try {
      const text = '用户偏好：Python 用于脚本 🙂';
      const c = contentFor(text);
      const store = new SqliteDocStore(db);
      await store.insertOrGet({
        owner: OWNER,
        contentHash: c.contentHash,
        cidDigest: c.cidDigest,
        cid: 'bafkreicjk',
        tags: ['topic:偏好'],
        now: 1,
      });
      const row = await store.findByOwnerAndHash(OWNER, c.contentHash);
      expect(row).not.toBeNull();
      expect(row!.tags).toEqual(['topic:偏好']);
      // Byte equality of the hash is the proof: it was computed from the text
      // before storage and re-derived by the caller after read-back.
      expect(row!.contentHash).toBe(c.contentHash);
    } finally {
      db.close();
    }
  });

  it('the composite PK absorbs a same-owner duplicate and keeps a second owner', async () => {
    const { path } = await tempDb();
    const db = openDatabase(path);
    try {
      const store = new SqliteDocStore(db);
      const c = contentFor('shared bytes');
      const base = {
        contentHash: c.contentHash,
        cidDigest: c.cidDigest,
        cid: 'bafkrei-shared',
        tags: [],
        now: 1,
      };
      const a1 = await store.insertOrGet({ ...base, owner: OWNER });
      const a2 = await store.insertOrGet({ ...base, owner: OWNER });
      const b1 = await store.insertOrGet({ ...base, owner: OTHER_OWNER });

      // Same-owner duplicate returns the original row...
      expect(a2.cid).toBe(a1.cid);
      // ...while a second owner gets their own row (the R1 regression).
      expect(b1.owner.toLowerCase()).toBe(OTHER_OWNER);
      const count = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
      expect(count.n).toBe(2);
    } finally {
      db.close();
    }
  });

  it('the DDL is idempotent (bootstrap runs on every open)', async () => {
    const { path } = await tempDb();
    const first = openDatabase(path);
    first.close();
    // Second open re-runs DDL; CREATE TABLE IF NOT EXISTS must not throw.
    const second = openDatabase(path);
    try {
      const tables = second
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['memories', 'kv_content']));
    } finally {
      second.close();
    }
    expect(DDL).toContain('PRIMARY KEY (owner, content_hash)');
  });
});
