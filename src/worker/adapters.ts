/**
 * F2 storage adapters — D1 + KV.
 *
 * Same ports, same DDL, different backend. The dedup key is mirrored into KV on
 * every successful write, but **no request path reads it**: `DocStorePort` has
 * no cid-only lookup, so `stage` always resolves dedup through the D1 composite
 * PK. Earlier drafts claimed a KV fast read path; it did not exist, and the
 * method implementing it was dead code.
 *
 * Keyless: nothing here (or in any binding) can hold a wallet key.
 */

import type {
  BatchPayload,
  ContentCachePort,
  DocStorePort,
  MemoryRecord,
  MemoryStatus,
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

function serializeBatch(batch: BatchPayload): string {
  // D1, like SQLite, has no bigint column; the same decimal-string encoding is
  // used so an artifact written by one form can be read by the other.
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

function dedupKey(owner: string, contentHash: string): string {
  return `dedup:${owner.toLowerCase()}:${contentHash.toLowerCase()}`;
}

export class D1DocStore implements DocStorePort {
  constructor(
    private readonly db: D1Like,
    /** Optional mirror of the dedup key. Not read by any route today. */
    private readonly kv?: KVLike,
  ) {}

  async insertOrGet(input: StageInput): Promise<MemoryRecord> {
    // D1 has no `INSERT OR IGNORE ... RETURNING` idiom across versions that is
    // worth relying on; write then read back, exactly as F1 does.
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO memories
           (cid, content_hash, cid_digest, owner, tags_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'staged', ?)`,
      )
      .bind(
        input.cid,
        input.contentHash,
        input.cidDigest,
        input.owner,
        JSON.stringify(input.tags),
        input.now,
      )
      .run();

    const row = await this.db
      .prepare('SELECT * FROM memories WHERE owner = ? AND content_hash = ?')
      .bind(input.owner, input.contentHash)
      .first<Row>();
    if (row === null) throw new Error('insertOrGet failed to read back a row');

    // Populate the dedup key only after the D1 write succeeded, so a failed
    // write cannot leave a KV entry pointing at a row that does not exist.
    await this.rememberCid(input.owner, input.contentHash, row.cid);
    return toRecord(row);
  }

  async findByOwnerAndHash(owner: string, contentHash: string): Promise<MemoryRecord | null> {
    // Fast path: a KV hit proves the row exists, but the caller needs the full
    // record, so D1 is still consulted. KV saves nothing here — it is used by
    // `stage` below, which only needs the CID.
    const row = await this.db
      .prepare('SELECT * FROM memories WHERE owner = ? AND content_hash = ?')
      .bind(owner, contentHash)
      .first<Row>();
    return row === null ? null : toRecord(row);
  }

  /**
   * Populate the dedup fast-path key.
   *
   * Called after a successful D1 write so KV can never point at a row that does
   * not exist. Note there is **no read side yet**: `DocStorePort` has no method
   * for a cid-only lookup, so `stage` always goes through D1. The key is
   * written now so a future fast read does not have to backfill it — but it is
   * not on any request path, and the README says so rather than claiming a
   * shortcut that does not exist.
   */
  private async rememberCid(owner: string, contentHash: string, cid: string): Promise<void> {
    if (this.kv === undefined) return;
    await this.kv.put(dedupKey(owner, contentHash), cid);
  }

  async findByCid(cid: string): Promise<MemoryRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM memories WHERE cid = ? LIMIT 1')
      .bind(cid)
      .first<Row>();
    return row === null ? null : toRecord(row);
  }

  async selectStaged(owner: string, limit: number): Promise<MemoryRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM memories WHERE owner = ? AND status = 'staged'
         ORDER BY created_at ASC LIMIT ?`,
      )
      .bind(owner, limit)
      .all<Row>();
    return results.map(toRecord);
  }

  async markBatched(
    owner: string,
    contentHashes: string[],
    batchId: string,
    batch: BatchPayload,
  ): Promise<void> {
    const json = serializeBatch(batch);
    for (const hash of contentHashes) {
      await this.db
        .prepare(
          `UPDATE memories SET status = 'batched', batch_id = ?, batch_json = ?
           WHERE owner = ? AND content_hash = ? AND status = 'staged'`,
        )
        .bind(batchId, json, owner, hash)
        .run();
    }
  }

  async findBatchedByHashes(owner: string, contentHashes: string[]): Promise<MemoryRecord[]> {
    if (contentHashes.length === 0) return [];
    const placeholders = contentHashes.map(() => '?').join(',');
    const { results } = await this.db
      .prepare(
        `SELECT * FROM memories
         WHERE owner = ? AND status = 'batched' AND content_hash IN (${placeholders})`,
      )
      .bind(owner, ...contentHashes)
      .all<Row>();
    return results.map(toRecord);
  }

  async markSettled(
    owner: string,
    contentHashes: string[],
    status: 'anchored' | 'rejected',
    txHash: string,
  ): Promise<number> {
    let changed = 0;
    for (const hash of contentHashes) {
      const result = await this.db
        .prepare(
          `UPDATE memories SET status = ?, tx_hash = ?
           WHERE owner = ? AND content_hash = ? AND status = 'batched'`,
        )
        .bind(status, txHash, owner, hash)
        .run();
      changed += Number(result.meta?.changes ?? 0);
    }
    return changed;
  }

  async reopenRejected(owner: string, contentHash: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE memories
            SET status = 'staged', batch_id = NULL, tx_hash = NULL, batch_json = NULL
          WHERE owner = ? AND content_hash = ? AND status = 'rejected'`,
      )
      .bind(owner, contentHash)
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

/**
 * KV content cache (design §2: `content:{cid}` bytes, TTL 7d).
 *
 * KV stores strings; bytes are carried as base64 so arbitrary content survives.
 * Expiry is delegated to `expirationTtl` — KV enforces it, unlike F1's lazy
 * check, which is a backend difference rather than a contract one.
 */
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
