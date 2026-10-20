/**
 * In-memory ports — used by the shared contract suite and by F2's miniflare
 * harness where a real D1 is unavailable. This is a *test double*, not a third
 * production form: it exists so route behaviour can be proven once, in one
 * place, and then re-proven per adapter by swapping ports.
 */

import type {
  BatchPayload,
  ContentCachePort,
  DocStorePort,
  MemoryRecord,
  MemoryStatus,
  PinPort,
  Ports,
  ReceiptLike,
  RpcPort,
  StageInput,
} from '../contract.js';

export class MemoryDocStore implements DocStorePort {
  private readonly rows = new Map<string, MemoryRecord>();

  private key(owner: string, contentHash: string): string {
    return `${owner.toLowerCase()}:${contentHash.toLowerCase()}`;
  }

  async insertOrGet(input: StageInput): Promise<MemoryRecord> {
    const key = this.key(input.owner, input.contentHash);
    const existing = this.rows.get(key);
    if (existing !== undefined) return existing;
    const record: MemoryRecord = {
      cid: input.cid,
      contentHash: input.contentHash,
      cidDigest: input.cidDigest,
      owner: input.owner,
      tags: input.tags,
      status: 'staged',
      batchId: null,
      txHash: null,
      batchJson: null,
      createdAt: input.now,
    };
    this.rows.set(key, record);
    return record;
  }

  async findByOwnerAndHash(owner: string, contentHash: string): Promise<MemoryRecord | null> {
    return this.rows.get(this.key(owner, contentHash)) ?? null;
  }

  async findByCid(cid: string): Promise<MemoryRecord | null> {
    for (const row of this.rows.values()) if (row.cid === cid) return row;
    return null;
  }

  async findByCidDigest(cidDigest: string): Promise<MemoryRecord | null> {
    for (const row of this.rows.values()) {
      if (row.cidDigest.toLowerCase() === cidDigest.toLowerCase()) return row;
    }
    return null;
  }

  async selectStaged(owner: string, limit: number): Promise<MemoryRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.owner.toLowerCase() === owner.toLowerCase() && r.status === 'staged')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
  }

  async markBatched(
    owner: string,
    contentHashes: string[],
    batchId: string,
    batch: BatchPayload,
  ): Promise<void> {
    for (const hash of contentHashes) {
      const row = this.rows.get(this.key(owner, hash));
      if (row !== undefined && row.status === 'staged') {
        row.status = 'batched';
        row.batchId = batchId;
        row.batchJson = batch;
      }
    }
  }

  async findBatchedByHashes(owner: string, contentHashes: string[]): Promise<MemoryRecord[]> {
    const wanted = new Set(contentHashes.map((h) => h.toLowerCase()));
    return [...this.rows.values()].filter(
      (r) =>
        r.owner.toLowerCase() === owner.toLowerCase() &&
        r.status === 'batched' &&
        wanted.has(r.contentHash.toLowerCase()),
    );
  }

  async markSettled(
    owner: string,
    contentHashes: string[],
    status: 'anchored' | 'rejected',
    txHash: string,
  ): Promise<number> {
    let changed = 0;
    for (const hash of contentHashes) {
      const row = this.rows.get(this.key(owner, hash));
      if (row !== undefined && row.status === 'batched') {
        row.status = status;
        row.txHash = txHash as `0x${string}`;
        changed += 1;
      }
    }
    return changed;
  }

  async reopenRejected(owner: string, contentHash: string): Promise<void> {
    const row = this.rows.get(this.key(owner, contentHash));
    if (row !== undefined && row.status === 'rejected') {
      row.status = 'staged';
      row.batchId = null;
      row.txHash = null;
      row.batchJson = null;
    }
  }

  async list(owner: string, status: MemoryStatus | null, limit: number): Promise<MemoryRecord[]> {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.owner.toLowerCase() === owner.toLowerCase() && (status === null || r.status === status),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
  }
}

export class MemoryContentCache implements ContentCachePort {
  private readonly entries = new Map<string, { bytes: Uint8Array; expiresAt: number | null }>();

  async get(key: string): Promise<Uint8Array | null> {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.bytes;
  }

  async put(key: string, bytes: Uint8Array, ttlMs: number | null): Promise<void> {
    this.entries.set(key, { bytes, expiresAt: ttlMs === null ? null : Date.now() + ttlMs });
  }

  /** Test hook: expire every entry without waiting for a real TTL. */
  expireAll(): void {
    for (const [key, entry] of this.entries) {
      this.entries.set(key, { ...entry, expiresAt: 0 });
    }
  }
}

/** Deterministic dev pin: same bytes → same CID, no network (design §5, R11). */
export class MemoryPin implements PinPort {
  calls = 0;
  async pin(bytes: Uint8Array): Promise<{ cid: string }> {
    this.calls += 1;
    // Imported lazily so this double cannot be mistaken for production pinning.
    const { cidV1Raw } = await import('@limccn/menhir-core');
    return { cid: cidV1Raw(bytes) };
  }
}

export class MemoryRpc implements RpcPort {
  calls = 0;
  private receipts = new Map<string, ReceiptLike>();

  setReceipt(txHash: string, receipt: ReceiptLike): void {
    this.receipts.set(txHash.toLowerCase(), receipt);
  }

  async getTransactionReceipt(txHash: string): Promise<ReceiptLike | null> {
    this.calls += 1;
    return this.receipts.get(txHash.toLowerCase()) ?? null;
  }
}

export interface Harness {
  ports: Ports;
  /**
   * Called through a mutable holder so a test can replace the fetch behaviour
   * and have the handle observe it. Copying the function into `ports` made the
   * cache-hit assertion impossible to fail (review M2).
   */
  setFetchContent(fn: (cid: string) => Promise<Uint8Array>): void;
  docStore: MemoryDocStore;
  contentCache: MemoryContentCache;
  pin: MemoryPin;
  rpc: MemoryRpc;
  /** Content served on a cache miss. */
  setContent(cid: string, bytes: Uint8Array): void;
  setFetchFailure(cid: string, kind: 'notFound' | 'upstream'): void;
}

export function createMemoryHarness(now: () => number = () => 1_700_000_000_000): Harness {
  const docStore = new MemoryDocStore();
  const contentCache = new MemoryContentCache();
  const pin = new MemoryPin();
  const rpc = new MemoryRpc();
  const contents = new Map<string, Uint8Array>();
  const failures = new Map<string, 'notFound' | 'upstream'>();

  const defaultFetch = async (cid: string): Promise<Uint8Array> => {
    const failure = failures.get(cid);
    if (failure === 'notFound') {
      throw Object.assign(new Error(`content ${cid} not found`), { notFound: true });
    }
    if (failure === 'upstream') throw new Error(`gateway failed for ${cid}`);
    const bytes = contents.get(cid);
    if (bytes === undefined) {
      throw Object.assign(new Error(`content ${cid} not found`), { notFound: true });
    }
    return bytes;
  };

  // A mutable holder, so `setFetchContent` actually affects the handle: the
  // handle holds `ports.fetchContent`, and that function must look up the
  // current implementation on every call (review M2).
  let fetchHolder: (cid: string) => Promise<Uint8Array> = defaultFetch;

  const ports: Ports = {
    docStore,
    contentCache,
    pin,
    rpc,
    now,
    fetchContent: (cid: string) => fetchHolder(cid),
  };

  return {
    ports,
    docStore,
    contentCache,
    pin,
    rpc,
    setContent: (cid, bytes) => contents.set(cid, bytes),
    setFetchFailure: (cid, kind) => failures.set(cid, kind),
    setFetchContent: (fn) => {
      fetchHolder = fn;
    },
  };
}
