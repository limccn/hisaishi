/**
 * F2 storage adapters — D1 + KV.
 *
 * Same ports, same DDL, different backend. The dedup path is the D1 composite
 * primary key; the old KV dedup mirror had no reader and is gone.
 *
 * Keyless: nothing here (or in any binding) can hold a wallet key.
 */

import type {
  BatchPayload,
  ContentCachePort,
  DocStorePort,
  MemoryRecord,
  MemoryStatus,
  RetentionCutoffs,
  StageInput,
} from '../core/contract.js';

/** The subset of `D1Database` this adapter uses. */
export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
      all<T = unknown>(): Promise<{ results: T[] }>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
  };
  batch(statements: unknown[]): Promise<unknown[]>;
}

/** The subset of `KVNamespace` this adapter uses. */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
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
    batchJson: null,
    createdAt: row.created_at,
    capabilityHash: row.capability_hash as `0x${string}` | null,
    batchedAt: row.batched_at,
    commitmentHash: row.commitment_hash as `0x${string}` | null,
  };
}

function serializeBatch(batch: BatchPayload): string {
  // D1, like SQLite, has no bigint column; the same decimal-string encoding is
  // used so an artifact written by one form can be read by the other.
  return JSON.stringify({
    commitments: batch.commitments.map((c) => ({ ...c, blockHeight: c.blockHeight.toString() })),
    tagLists: batch.tagLists,
  });
}

export class D1DocStore implements DocStorePort {
  constructor(private readonly db: D1Like) {}

  async insertOrGet(input: StageInput): Promise<MemoryRecord> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO memories
           (cid, content_hash, cid_digest, owner, tags_json, status, created_at, capability_hash)
         VALUES (?, ?, ?, ?, ?, 'staged', ?, ?)`,
      )
      .bind(
        input.cid,
        input.contentHash,
        input.cidDigest,
        input.owner,
        JSON.stringify(input.tags),
        input.now,
        input.capabilityHash,
      )
      .run();

    const row = await this.db
      .prepare('SELECT * FROM memories WHERE owner = ? AND content_hash = ?')
      .bind(input.owner, input.contentHash)
      .first<Row>();
    if (row === null) throw new Error('insertOrGet failed to read back a row');
    return toRecord(row);
  }

  async findByOwnerAndHash(owner: string, contentHash: string): Promise<MemoryRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM memories WHERE owner = ? AND content_hash = ?')
      .bind(owner, contentHash)
      .first<Row>();
    return row === null ? null : toRecord(row);
  }

  async findByCid(cid: string): Promise<MemoryRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM memories WHERE cid = ? LIMIT 1')
      .bind(cid)
      .first<Row>();
    return row === null ? null : toRecord(row);
  }

  async findByCidDigest(cidDigest: string): Promise<MemoryRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM memories WHERE cid_digest = ? LIMIT 1')
      .bind(cidDigest.toLowerCase())
      .first<Row>();
    return row === null ? null : toRecord(row);
  }

  async selectStaged(
    owner: string,
    capabilityHash: string,
    limit: number,
  ): Promise<MemoryRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM memories
          WHERE owner = ? AND status = 'staged' AND capability_hash = ?
          ORDER BY created_at ASC LIMIT ?`,
      )
      .bind(owner, capabilityHash.toLowerCase(), limit)
      .all<Row>();
    return results.map(toRecord);
  }

  async bindStaged(owner: string, contentHash: string, capabilityHash: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE memories SET capability_hash = ?
          WHERE owner = ? AND content_hash = ? AND status = 'staged'`,
      )
      .bind(capabilityHash.toLowerCase(), owner, contentHash)
      .run();
  }

  async reclaimBatched(
    owner: string,
    contentHash: string,
    capabilityHash: string,
    olderThan: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE memories
            SET status = 'staged', batch_id = NULL, batch_json = NULL,
                batched_at = NULL, capability_hash = ?
          WHERE owner = ? AND content_hash = ? AND status = 'batched'
            AND batched_at IS NOT NULL AND batched_at <= ?`,
      )
      .bind(capabilityHash.toLowerCase(), owner, contentHash, olderThan)
      .run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  async reclaimStaleBatched(
    owner: string,
    capabilityHash: string,
    olderThan: number,
  ): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE memories
            SET status = 'staged', batch_id = NULL, batch_json = NULL, batched_at = NULL
          WHERE owner = ? AND capability_hash = ? AND status = 'batched'
            AND batched_at IS NOT NULL AND batched_at <= ?`,
      )
      .bind(owner, capabilityHash.toLowerCase(), olderThan)
      .run();
    return Number(result.meta?.changes ?? 0);
  }

  async markBatched(
    owner: string,
    contentHashes: string[],
    batchId: string,
    batch: BatchPayload,
    now: number,
  ): Promise<void> {
    await this.db
      .prepare(
        'INSERT OR REPLACE INTO batches (batch_id, owner, built_at, batch_json) VALUES (?, ?, ?, ?)',
      )
      .bind(batchId, owner, now, serializeBatch(batch))
      .run();
    for (const hash of contentHashes) {
      await this.db
        .prepare(
          `UPDATE memories SET status = 'batched', batch_id = ?, batch_json = NULL, batched_at = ?
           WHERE owner = ? AND content_hash = ? AND status = 'staged'`,
        )
        .bind(batchId, now, owner, hash)
        .run();
    }
  }

  async findBatchedByHashes(owner: string, contentHashes: string[]): Promise<MemoryRecord[]> {
    if (contentHashes.length === 0) return [];
    const CHUNK = 50;
    const rows: Row[] = [];
    for (let i = 0; i < contentHashes.length; i += CHUNK) {
      const chunk = contentHashes.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const { results } = await this.db
        .prepare(
          `SELECT * FROM memories
           WHERE owner = ? AND status = 'batched' AND content_hash IN (${placeholders})`,
        )
        .bind(owner, ...chunk)
        .all<Row>();
      rows.push(...results);
    }
    return rows.map(toRecord);
  }

  async markSettled(
    owner: string,
    commits: Array<{ contentHash: string; commitmentHash: string }>,
    status: 'anchored' | 'rejected',
    txHash: string,
  ): Promise<number> {
    let changed = 0;
    for (const commit of commits) {
      const result = await this.db
        .prepare(
          `UPDATE memories SET status = ?, tx_hash = ?, commitment_hash = ?, batched_at = NULL
           WHERE owner = ? AND content_hash = ? AND status = 'batched'`,
        )
        .bind(status, txHash, commit.commitmentHash, owner, commit.contentHash)
        .run();
      changed += Number(result.meta?.changes ?? 0);
    }
    return changed;
  }

  async reopenRejected(
    owner: string,
    contentHash: string,
    capabilityHash: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE memories
            SET status = 'staged', batch_id = NULL, tx_hash = NULL, batch_json = NULL,
                batched_at = NULL, commitment_hash = NULL, capability_hash = ?
          WHERE owner = ? AND content_hash = ? AND status = 'rejected'`,
      )
      .bind(capabilityHash.toLowerCase(), owner, contentHash)
      .run();
  }

  async findPin(cidDigest: string) {
    const row = await this.db
      .prepare('SELECT * FROM pins WHERE cid_digest = ?')
      .bind(cidDigest.toLowerCase())
      .first<{
        cid_digest: string;
        content_hash: string;
        cid: string;
        pinned_at: number;
      }>();
    return row === null
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
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO pins (cid_digest, content_hash, cid, pinned_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(entry.cidDigest.toLowerCase(), entry.contentHash, entry.cid, entry.pinnedAt)
      .run();
  }

  async deleteExpired(cutoffs: RetentionCutoffs): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM memories
          WHERE status = 'staged' AND created_at < ?
             OR status = 'rejected' AND created_at < ?`,
      )
      .bind(cutoffs.stagedBefore, cutoffs.rejectedBefore)
      .run();
    await this.db
      .prepare(
        `DELETE FROM pins
          WHERE pinned_at < ?
            AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.cid_digest = pins.cid_digest)`,
      )
      .bind(cutoffs.pinsBefore)
      .run();
  }

  async list(owner: string, status: MemoryStatus | null, limit: number): Promise<MemoryRecord[]> {
    const { results } =
      status === null
        ? await this.db
            .prepare('SELECT * FROM memories WHERE owner = ? ORDER BY created_at ASC LIMIT ?')
            .bind(owner, limit)
            .all<Row>()
        : await this.db
            .prepare(
              'SELECT * FROM memories WHERE owner = ? AND status = ? ORDER BY created_at ASC LIMIT ?',
            )
            .bind(owner, status, limit)
            .all<Row>();
    return results.map(toRecord);
  }
}

export class KvContentCache implements ContentCachePort {
  constructor(private readonly kv: KVLike) {}

  async get(key: string): Promise<Uint8Array | null> {
    const stored = await this.kv.get(key);
    if (stored === null) return null;
    // KV returns a string; base64 keeps the bytes exact for any payload.
    const binary = atob(stored);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async put(key: string, bytes: Uint8Array, ttlMs: number | null): Promise<void> {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const options = ttlMs === null ? undefined : { expirationTtl: Math.ceil(ttlMs / 1000) };
    await this.kv.put(key, btoa(binary), options);
  }
}
