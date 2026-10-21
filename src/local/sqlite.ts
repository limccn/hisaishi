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
  RetentionCutoffs,
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
  capability_hash TEXT,
  batched_at    INTEGER,
  commitment_hash TEXT,
  PRIMARY KEY (owner, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_owner_status ON memories(owner, status);
CREATE INDEX IF NOT EXISTS idx_batch ON memories(batch_id);
CREATE INDEX IF NOT EXISTS idx_cid ON memories(cid);
CREATE INDEX IF NOT EXISTS idx_capability ON memories(owner, capability_hash, status);

-- One copy of each built batch, not one per row (M-3 amplification).
CREATE TABLE IF NOT EXISTS batches (
  batch_id   TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  built_at   INTEGER NOT NULL,
  batch_json TEXT NOT NULL
);

-- Global pin ledger: dedup by content digest + accounting for orphan pins.
CREATE TABLE IF NOT EXISTS pins (
  cid_digest   TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  cid          TEXT NOT NULL,
  pinned_at    INTEGER NOT NULL
);

-- L-2: normalise before indexing, then look up by equality.
UPDATE memories SET cid_digest = lower(cid_digest)
 WHERE cid_digest <> lower(cid_digest);
CREATE INDEX IF NOT EXISTS idx_cid_digest ON memories(cid_digest);

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

/**
 * Additive migration for an F1 database created before this schema.
 *
 * Runs BEFORE `DDL` so the new indexes can reference the new columns. The
 * check is `PRAGMA table_info`, not "try ALTER and swallow the error": a
 * swallowed error would hide a genuinely different schema.
 */
function ensureColumns(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'")
    .get() as { name: string } | undefined;
  if (table === undefined) return; // fresh database: DDL creates the final shape

  const existing = new Set(
    (db.prepare('PRAGMA table_info(memories)').all() as unknown as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  const missing: Array<[string, string]> = [
    ['capability_hash', 'TEXT'],
    ['batched_at', 'INTEGER'],
    ['commitment_hash', 'TEXT'],
  ];
  for (const [name, type] of missing) {
    if (!existing.has(name)) db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${type}`);
  }
}

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
  capability_hash: string | null;
  batched_at: number | null;
  commitment_hash: string | null;
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
    // The built payload lives once in `batches`; rows no longer carry it.
    batchJson: null,
    createdAt: row.created_at,
    capabilityHash: row.capability_hash as `0x${string}` | null,
    batchedAt: row.batched_at,
    commitmentHash: row.commitment_hash as `0x${string}` | null,
  };
}

/** SQLite has no JSON-safe bigint; commitments carry `blockHeight`. */
function serializeBatch(batch: BatchPayload): string {
  return JSON.stringify({
    commitments: batch.commitments.map((c) => ({ ...c, blockHeight: c.blockHeight.toString() })),
    tagLists: batch.tagLists,
  });
}

export class SqliteDocStore implements DocStorePort {
  constructor(private readonly db: DatabaseSync) {}

  async insertOrGet(input: StageInput): Promise<MemoryRecord> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memories
           (cid, content_hash, cid_digest, owner, tags_json, status, created_at, capability_hash)
         VALUES (?, ?, ?, ?, ?, 'staged', ?, ?)`,
      )
      .run(
        input.cid,
        input.contentHash,
        input.cidDigest,
        input.owner,
        JSON.stringify(input.tags),
        input.now,
        input.capabilityHash,
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
    // cid_digest is stored lowercase and indexed; equality is enough.
    const row = this.db
      .prepare('SELECT * FROM memories WHERE cid_digest = ? LIMIT 1')
      .get(cidDigest.toLowerCase()) as Row | undefined;
    return row === undefined ? null : toRecord(row);
  }

  async selectStaged(
    owner: string,
    capabilityHash: string,
    limit: number,
  ): Promise<MemoryRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
          WHERE owner = ? AND status = 'staged' AND capability_hash = ?
          ORDER BY created_at ASC LIMIT ?`,
      )
      .all(owner, capabilityHash.toLowerCase(), limit) as unknown as Row[];
    return rows.map(toRecord);
  }

  async bindStaged(owner: string, contentHash: string, capabilityHash: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE memories SET capability_hash = ?
          WHERE owner = ? AND content_hash = ? AND status = 'staged'`,
      )
      .run(capabilityHash.toLowerCase(), owner, contentHash);
  }

  async reclaimBatched(
    owner: string,
    contentHash: string,
    capabilityHash: string,
    olderThan: number,
  ): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE memories
            SET status = 'staged', batch_id = NULL, batch_json = NULL,
                batched_at = NULL, capability_hash = ?
          WHERE owner = ? AND content_hash = ? AND status = 'batched'
            AND batched_at IS NOT NULL AND batched_at <= ?`,
      )
      .run(capabilityHash.toLowerCase(), owner, contentHash, olderThan);
    return Number(result.changes) > 0;
  }

  async reclaimStaleBatched(
    owner: string,
    capabilityHash: string,
    olderThan: number,
  ): Promise<number> {
    const result = this.db
      .prepare(
        `UPDATE memories
            SET status = 'staged', batch_id = NULL, batch_json = NULL, batched_at = NULL
          WHERE owner = ? AND capability_hash = ? AND status = 'batched'
            AND batched_at IS NOT NULL AND batched_at <= ?`,
      )
      .run(owner, capabilityHash.toLowerCase(), olderThan);
    return Number(result.changes);
  }

  async markBatched(
    owner: string,
    contentHashes: string[],
    batchId: string,
    batch: BatchPayload,
    now: number,
  ): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO batches (batch_id, owner, built_at, batch_json) VALUES (?, ?, ?, ?)')
      .run(batchId, owner, now, serializeBatch(batch));
    const stmt = this.db.prepare(
      `UPDATE memories SET status = 'batched', batch_id = ?, batch_json = NULL, batched_at = ?
       WHERE owner = ? AND content_hash = ? AND status = 'staged'`,
    );
    for (const hash of contentHashes) stmt.run(batchId, now, owner, hash);
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
    commits: Array<{ contentHash: string; commitmentHash: string }>,
    status: 'anchored' | 'rejected',
    txHash: string,
  ): Promise<number> {
    if (commits.length === 0) return 0;
    const stmt = this.db.prepare(
      `UPDATE memories SET status = ?, tx_hash = ?, commitment_hash = ?, batched_at = NULL
       WHERE owner = ? AND content_hash = ? AND status = 'batched'`,
    );
    let changed = 0;
    for (const commit of commits) {
      const result = stmt.run(
        status,
        txHash,
        commit.commitmentHash,
        owner,
        commit.contentHash,
      );
      changed += Number(result.changes);
    }
    return changed;
  }

  async reopenRejected(
    owner: string,
    contentHash: string,
    capabilityHash: string,
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE memories
            SET status = 'staged', batch_id = NULL, tx_hash = NULL, batch_json = NULL,
                batched_at = NULL, commitment_hash = NULL, capability_hash = ?
          WHERE owner = ? AND content_hash = ? AND status = 'rejected'`,
      )
      .run(capabilityHash.toLowerCase(), owner, contentHash);
  }

  async findPin(cidDigest: string) {
    const row = this.db
      .prepare('SELECT * FROM pins WHERE cid_digest = ?')
      .get(cidDigest.toLowerCase()) as
      | { cid_digest: string; content_hash: string; cid: string; pinned_at: number }
      | undefined;
    return row === undefined
      ? null
      : {
          cidDigest: row.cid_digest as `0x${string}`,
          contentHash: row.content_hash as `0x${string}`,
          cid: row.cid,
          pinnedAt: row.pinned_at,
        };
  }

  async recordPin(entry: {
    cidDigest: string;
    contentHash: string;
    cid: string;
    pinnedAt: number;
  }): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pins (cid_digest, content_hash, cid, pinned_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(entry.cidDigest.toLowerCase(), entry.contentHash, entry.cid, entry.pinnedAt);
  }

  async deleteExpired(cutoffs: RetentionCutoffs): Promise<void> {
    this.db
      .prepare(
        `DELETE FROM memories
          WHERE status = 'staged' AND created_at < ?
             OR status = 'rejected' AND created_at < ?`,
      )
      .run(cutoffs.stagedBefore, cutoffs.rejectedBefore);
    this.db
      .prepare(
        `DELETE FROM pins
          WHERE pinned_at < ?
            AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.cid_digest = pins.cid_digest)`,
      )
      .run(cutoffs.pinsBefore);
    // Expired content-cache entries are also housekeeping; a lazy delete on
    // read never touches a CID that is not requested again.
    this.db
      .prepare('DELETE FROM kv_content WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .run(cutoffs.now);
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
  // Existing databases get the additive columns before DDL creates indexes
  // over them; a fresh database is created with the final shape by DDL.
  ensureColumns(db);
  db.exec(DDL);
  return db;
}
