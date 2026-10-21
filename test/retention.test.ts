/**
 * Retention: staged/rejected rows and expired cache entries are swept; anchored
 * rows and referenced pins are never removed.
 */

import { describe, expect, it } from 'vitest';

import { openDatabase, SqliteDocStore } from '../src/local/sqlite.js';

const OWNER = `0x${'11'.repeat(20)}` as const;
const NOW = 2_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function storeWithRows() {
  const db = openDatabase(':memory:');
  const store = new SqliteDocStore(db);
  const insert = db.prepare(
    `INSERT INTO memories
       (cid, content_hash, cid_digest, owner, tags_json, status, created_at, capability_hash)
     VALUES (?, ?, ?, ?, '[]', ?, ?, ?)`,
  );
  const row = (n: number, status: string, createdAt: number) =>
    insert.run(
      `cid-${n}`,
      `0x${n.toString(16).padStart(64, '0')}`,
      `0x${(n + 100).toString(16).padStart(64, '0')}`,
      OWNER,
      status,
      createdAt,
      `0x${'ab'.repeat(32)}`,
    );
  row(1, 'staged', NOW - 31 * DAY);
  row(2, 'rejected', NOW - 8 * DAY);
  row(3, 'anchored', NOW - 400 * DAY);
  row(4, 'staged', NOW - 1 * DAY);

  db.prepare('INSERT INTO pins (cid_digest, content_hash, cid, pinned_at) VALUES (?, ?, ?, ?)').run(
    `0x${(103).toString(16).padStart(64, '0')}`,
    `0x${'1'.padStart(64, '0')}`,
    'bafkreipin1',
    NOW - 31 * DAY,
  );
  db.prepare('INSERT INTO pins (cid_digest, content_hash, cid, pinned_at) VALUES (?, ?, ?, ?)').run(
    `0x${'99'.repeat(32)}`,
    `0x${'2'.padStart(64, '0')}`,
    'bafkreipin2',
    NOW - 31 * DAY,
  );
  db.prepare('INSERT INTO kv_content (key, bytes, expires_at) VALUES (?, ?, ?)').run(
    'content:expired',
    new Uint8Array([1]),
    NOW - 1,
  );
  db.prepare('INSERT INTO kv_content (key, bytes, expires_at) VALUES (?, ?, ?)').run(
    'content:live',
    new Uint8Array([2]),
    NOW + DAY,
  );
  return { db, store };
}

describe('retention sweep', () => {
  it('drops stale staged/rejected rows, expired cache, and unreferenced old pins', async () => {
    const { db, store } = storeWithRows();
    await store.deleteExpired({
      stagedBefore: NOW - 30 * DAY,
      rejectedBefore: NOW - 7 * DAY,
      pinsBefore: NOW - 30 * DAY,
      now: NOW,
    });

    const rows = db.prepare('SELECT cid, status FROM memories ORDER BY cid').all() as Array<{
      cid: string;
      status: string;
    }>;
    expect(rows.map((r) => r.status)).toEqual(['anchored', 'staged']);
    expect(rows.map((r) => r.cid)).toEqual(['cid-3', 'cid-4']);

    const pins = db.prepare('SELECT cid FROM pins').all() as Array<{ cid: string }>;
    // The referenced pin (matches row 1's cidDigest) is retained even when old.
    expect(pins.map((p) => p.cid)).toEqual(['bafkreipin1']);

    const cache = db.prepare('SELECT key FROM kv_content ORDER BY key').all() as Array<{
      key: string;
    }>;
    expect(cache.map((c) => c.key)).toEqual(['content:live']);
    db.close();
  });
});
