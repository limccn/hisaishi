/**
 * F1 storage adapter — `node:sqlite` (DatabaseSync).
 *
 * The DDL here is the design's §3 schema verbatim, with two review-driven
 * changes:
 *   - PK is `(owner, content_hash)`, not `cid` (R1). Identical bytes produce one
 *     CID, so a `cid` PK silently dropped a second owner's row.
 *   - there is no `kv_dedup` table (R10). The composite PK *is* the dedup index,
 *     and both live in the same file, so a second table would only add a second
 *     write and a drift risk.
 *
 * Concurrency (M1-20): the embedded gateway shares a process — and this file —
 * with longstone. WAL plus a busy timeout is the whole mitigation; writes go
 * through one connection, which the process-wide singleton below enforces.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  BatchPayload,
  ContentCachePort,
  DocStorePort,
  MemoryRecord,
  MemoryStatus,
  StageInput,
} from '../core/contract.js';

export const DDL = `
CREATE TABLE IF NOT EXISTS memories (
  cid          TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  cid_digest   TEXT NOT NULL,
  owner        TEXT NOT NULL,
  tags_json    TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'staged',
  batch_id     TEXT,
  tx_hash      TEXT,
  batch_json   TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (owner, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_owner_status ON memories(owner, status);
CREATE INDEX IF NOT EXISTS idx_batch ON memories(batch_id);
CREATE INDEX IF NOT EXISTS idx_cid ON memories(cid);

CREATE TABLE IF NOT EXISTS kv_content (
  key        TEXT PRIMARY KEY,
  bytes      BLOB NOT NULL,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS kv_emb (
  key        TEXT PRIMARY KEY,
  bytes      BLOB NOT NULL,
  expires_at INTEGER
);
`;

interface Row {
  cid: string;
  content_hash: string;
  cid_digest: string;
  owner: string;
  tags_json: string;
  status: string;
  batch_id: string | null;
  tx_hash: string | null;
  batch_json: string | null;
  created_at: number;
}

function toRecord(row: Row): MemoryRecord {
  return {
    cid: row.cid,
    contentHash: row.content_hash as `0x${string}`,
    cidDigest: row.cid_digest as `0x${string}`,
    owner: row.owner as `0x${string}`,
    tags: JSON.parse(row.tags_json) as string[],
    status: row.status as MemoryStatus,
    batchId: row.batch_id,
    txHash: row.tx_hash as `0x${string}` | null,
    batchJson: row.batch_json === null ? null : deserializeBatch(row.batch_json),
    createdAt: row.created_at,
  };
}

/** SQLite has no JSON-safe bigint; commitments carry `blockHeight`. */
function serializeBatch(batch: BatchPayload): string {
  return JSON.stringify({
    commitments: batch.commitments.map((c) => ({ ...c, blockHeight: c.blockHeight.toString() })),
    tagLists: batch.tagLists,
  });
}

function deserializeBatch(json: string): BatchPayload {
  const parsed = JSON.parse(json) as {
    commitments: Array<Record<string, unknown>>;
    tagLists: `0x${string}`[][];
  };
  return {
    commitments: parsed.commitments.map((c) => ({
      ...(c as unknown as BatchPayload['commitments'][number]),
      blockHeight: BigInt(c.blockHeight as string),
    })),
    tagLists: parsed.tagLists,
  };
}

export class SqliteDocStore implements DocStorePort {
  constructor(private readonly db: DatabaseSync) {}

  async insertOrGet(input: StageInput): Promise<MemoryRecord> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memories
           (cid, content_hash, cid_digest, owner, tags_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'staged', ?)`,
      )
      .run(
        input.cid,
        input.contentHash,
        input.cidDigest,
        input.owner,
        JSON.stringify(input.tags),
        input.now,
      );
    // INSERT OR IGNORE returns no useful count here; read back the winner so a
    // lost race returns the row that actually exists.
    const row = this.db
      .prepare('SELECT * FROM memories WHERE owner = ? AND content_hash = ?')
      .get(input.owner, input.contentHash) as Row | undefined;
    if (row === undefined) throw new Error('insertOrGet failed to read back a row');
    return toRecord(row);
  }

  async findByOwnerAndHash(owner: string, contentHash: string): Promise<MemoryRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM memories WHERE owner = ? AND content_hash = ?')
      .get(owner, contentHash) as Row | undefined;
    return row === undefined ? null : toRecord(row);
  }

  async findByCid(cid: string): Promise<MemoryRecord | null> {
    const row = this.db.prepare('SELECT * FROM memories WHERE cid = ? LIMIT 1').get(cid) as
      | Row
      | undefined;
    return row === undefined ? null : toRecord(row);
  }

  async findByCidDigest(cidDigest: string): Promise<MemoryRecord | null> {
    // Hex is hex: the on-chain digest is lowercase, while a query string can
    // arrive in any case. `cid_digest` has no index in M1 (the table is small
    // and this is a verify-path read, not the hot list path).
    const row = this.db
      .prepare('SELECT * FROM memories WHERE lower(cid_digest) = lower(?) LIMIT 1')
      .get(cidDigest) as Row | undefined;
    return row === undefined ? null : toRecord(row);
  }

  async selectStaged(owner: string, limit: number): Promise<MemoryRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE owner = ? AND status = 'staged'
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(owner, limit) as unknown as Row[];
    return rows.map(toRecord);
  }

  async markBatched(
    owner: string,
    contentHashes: string[],
    batchId: string,
    batch: BatchPayload,
  ): Promise<void> {
    const stmt = this.db.prepare(
      `UPDATE memories SET status = 'batched', batch_id = ?, batch_json = ?
       WHERE owner = ? AND content_hash = ? AND status = 'staged'`,
    );
    const json = serializeBatch(batch);
    for (const hash of contentHashes) stmt.run(batchId, json, owner, hash);
  }

  async findBatchedByHashes(owner: string, contentHashes: string[]): Promise<MemoryRecord[]> {
    if (contentHashes.length === 0) return [];
    const placeholders = contentHashes.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE owner = ? AND status = 'batched' AND content_hash IN (${placeholders})`,
      )
      .all(owner, ...contentHashes) as unknown as Row[];
    return rows.map(toRecord);
  }

  async markSettled(
    owner: string,
    contentHashes: string[],
    status: 'anchored' | 'rejected',
    txHash: string,
  ): Promise<number> {
    if (contentHashes.length === 0) return 0;
    const stmt = this.db.prepare(
      `UPDATE memories SET status = ?, tx_hash = ?
       WHERE owner = ? AND content_hash = ? AND status = 'batched'`,
    );
    let changed = 0;
    for (const hash of contentHashes) {
      const result = stmt.run(status, txHash, owner, hash);
      changed += Number(result.changes);
    }
    return changed;
  }

  async reopenRejected(owner: string, contentHash: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE memories
            SET status = 'staged', batch_id = NULL, tx_hash = NULL, batch_json = NULL
          WHERE owner = ? AND content_hash = ? AND status = 'rejected'`,
      )
      .run(owner, contentHash);
  }

  async list(owner: string, status: MemoryStatus | null, limit: number): Promise<MemoryRecord[]> {
    const rows =
      status === null
        ? (this.db
            .prepare('SELECT * FROM memories WHERE owner = ? ORDER BY created_at ASC LIMIT ?')
            .all(owner, limit) as unknown as Row[])
        : (this.db
            .prepare(
              'SELECT * FROM memories WHERE owner = ? AND status = ? ORDER BY created_at ASC LIMIT ?',
            )
            .all(owner, status, limit) as unknown as Row[]);
    return rows.map(toRecord);
  }
}

export class SqliteContentCache implements ContentCachePort {
  constructor(private readonly db: DatabaseSync) {}

  async get(key: string): Promise<Uint8Array | null> {
    const row = this.db
      .prepare('SELECT bytes, expires_at FROM kv_content WHERE key = ?')
      .get(key) as { bytes: Uint8Array; expires_at: number | null } | undefined;
    if (row === undefined) return null;
    // Lazy TTL (R5): an expired row is a miss, and may be dropped on read. A
    // background sweeper is out of scope for M1.
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      this.db.prepare('DELETE FROM kv_content WHERE key = ?').run(key);
      return null;
    }
    return new Uint8Array(row.bytes);
  }

  async put(key: string, bytes: Uint8Array, ttlMs: number | null): Promise<void> {
    const expiresAt = ttlMs === null ? null : Date.now() + ttlMs;
    this.db
      .prepare(
        `INSERT INTO kv_content (key, bytes, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET bytes = excluded.bytes, expires_at = excluded.expires_at`,
      )
      .run(key, bytes, expiresAt);
  }
}

/**
 * Open (or create) the F1 database.
 *
 * One connection per process: the embedded gateway and longstone may both be in
 * this process, and serializing writes through one handle is simpler and more
 * predictable than pooling. WAL + busy_timeout covers the multi-process case
 * (`hisaishi-local serve` plus an embedded client).
 */
export function openDatabase(path: string): DatabaseSync {
  // `DatabaseSync` will not create a missing parent directory, and the default
  // path (`.longstone/hisaishi.db`) sits in one that does not exist on a fresh
  // machine. Creating it here makes first-run work without a setup step; the
  // `:memory:` case has no directory and is skipped.
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(DDL);
  return db;
}
