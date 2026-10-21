/**
 * Port interfaces (design v0.5 §1).
 *
 * Routes never import a runtime. F1 implements these with `node:sqlite`, F2
 * with D1 + KV. The interfaces are deliberately narrow: four ports, no generic
 * storage abstraction.
 *
 * Note (R10): there is **no dedup port**. Dedup is a lookup on DocStorePort by
 * `(owner, contentHash)`; F2 puts a KV read in front of it because KV and D1
 * are different media, but that is an adapter detail, not a contract.
 */

import type { Commitment } from '@limccn/menhir-core';

export type Hex = `0x${string}`;

export const STATUSES = ['staged', 'batched', 'anchored', 'rejected'] as const;
export type MemoryStatus = (typeof STATUSES)[number];

/** A staging row — the on-disk shape (design §3). */
export interface MemoryRecord {
  cid: string;
  contentHash: Hex;
  cidDigest: Hex;
  owner: Hex;
  tags: string[];
  status: MemoryStatus;
  batchId: string | null;
  txHash: Hex | null;
  /** Unsigned commitments as built, with placeholders not yet stamped. */
  batchJson: BatchPayload | null;
  createdAt: number;
  /**
   * sha256(deploymentId + ':' + capability). The only staging-session state;
   * null only for rows that predate this column.
   */
  capabilityHash: Hex | null;
  /** Set when the row is marked batched; drives stale-row recovery. */
  batchedAt: number | null;
  /** Real hash from the registry event, set by confirm; null before that. */
  commitmentHash: Hex | null;
}

/** Runtime settings the routes need without knowing the transport. */
export interface GatewaySettings {
  /** Stable identifier of this logical deployment (shared-DB isolation). */
  deploymentId: string;
  /** A batched row older than this may be reclaimed. */
  batchTtlMs: number;
  /** Staged rows older than this are swept. */
  stagingTtlMs: number;
  /** Rejected rows older than this are swept. */
  rejectedTtlMs: number;
  /** Pin-ledger entries older than this are ignored/swept. */
  pinTtlMs: number;
  /** Opportunistic sweep interval. */
  sweepIntervalMs: number;
}

export interface RetentionCutoffs {
  stagedBefore: number;
  rejectedBefore: number;
  pinsBefore: number;
  /** Current time; used to drop expired cache entries. */
  now: number;
}

export interface BatchPayload {
  commitments: Commitment[];
  tagLists: Hex[][];
}

/** The public row shape (design §4, R13). `batchJson` is never exposed. */
export interface MemoryRow {
  cid: string;
  contentHash: Hex;
  cidDigest: Hex;
  owner: Hex;
  tags: string[];
  status: MemoryStatus;
  batchId: string | null;
  txHash: Hex | null;
  createdAt: number;
  commitmentHash: Hex | null;
}

export interface StageInput {
  owner: Hex;
  contentHash: Hex;
  cidDigest: Hex;
  cid: string;
  tags: string[];
  now: number;
  /** Deployment-scoped session binding. */
  capabilityHash: Hex;
}

export interface DocStorePort {
  /** Insert or return the row that won the `(owner, contentHash)` race. */
  insertOrGet(input: StageInput): Promise<MemoryRecord>;
  findByOwnerAndHash(owner: Hex, contentHash: Hex): Promise<MemoryRecord | null>;
  findByCid(cid: string): Promise<MemoryRecord | null>;
  /**
   * Lookup by the retrieval-layer digest. Needed because the pinned CID is not
   * derivable from `sha256(bytes)` for every pin backend: Pinata's CIDv0 hashes
   * its dag-pb wrapper, so a verifier holding only chain state cannot compute
   * the CID. The row is the bridge from digest to CID; integrity still comes
   * from the client recomputing both digests over the returned bytes.
   */
  findByCidDigest(cidDigest: Hex): Promise<MemoryRecord | null>;
  /** Oldest-first `staged` rows bound to this capability, up to `limit`. */
  selectStaged(owner: Hex, capabilityHash: Hex, limit: number): Promise<MemoryRecord[]>;
  /** Re-bind a `staged` row to the caller's capability (last stager wins). */
  bindStaged(owner: Hex, contentHash: Hex, capabilityHash: Hex): Promise<void>;
  /**
   * Reclaim a stale `batched` row to `staged` and bind it to the caller's
   * capability. Returns false while the row is fresh or in another state.
   */
  reclaimBatched(
    owner: Hex,
    contentHash: Hex,
    capabilityHash: Hex,
    olderThan: number,
  ): Promise<boolean>;
  /** Reclaim this capability's stale batched rows before a build. */
  reclaimStaleBatched(owner: Hex, capabilityHash: Hex, olderThan: number): Promise<number>;
  /** Flip staged → batched and persist the built batch. */
  markBatched(
    owner: Hex,
    contentHashes: Hex[],
    batchId: string,
    batch: BatchPayload,
    now: number,
  ): Promise<void>;
  /** Rows of this owner that are `batched` and whose content_hash is in the set. */
  findBatchedByHashes(owner: Hex, contentHashes: Hex[]): Promise<MemoryRecord[]>;
  /**
   * Flip batched → anchored/rejected and record the real commitment hash from
   * the registry event for each settled row.
   */
  markSettled(
    owner: Hex,
    commits: Array<{ contentHash: Hex; commitmentHash: Hex }>,
    status: 'anchored' | 'rejected',
    txHash: Hex,
  ): Promise<number>;
  /** Re-open a rejected row so the same content can be retried (R5). */
  reopenRejected(owner: Hex, contentHash: Hex, capabilityHash: Hex): Promise<void>;
  /** Pin-ledger lookups (global, by either digest). */
  findPin(cidDigest: Hex): Promise<{ cidDigest: Hex; contentHash: Hex; cid: string; pinnedAt: number } | null>;
  recordPin(entry: { cidDigest: Hex; contentHash: Hex; cid: string; pinnedAt: number }): Promise<void>;
  /** Retention sweep; pins are deleted only when no memory row references them. */
  deleteExpired(cutoffs: RetentionCutoffs): Promise<void>;
  list(owner: Hex, status: MemoryStatus | null, limit: number): Promise<MemoryRecord[]>;
}

export interface ContentCachePort {
  get(key: string): Promise<Uint8Array | null>;
  /** `ttlMs === null` means no expiry. */
  put(key: string, bytes: Uint8Array, ttlMs: number | null): Promise<void>;
}

export interface PinPort {
  /** Pin raw bytes; returns the backend's CID (or a deterministic fake in dev). */
  pin(bytes: Uint8Array): Promise<{ cid: string }>;
}

export interface RpcPort {
  /** ONE receipt lookup. Nothing else — no subscriptions, no polling (D-10). */
  getTransactionReceipt(txHash: Hex): Promise<ReceiptLike | null>;
}

export interface ReceiptLike {
  status: 'success' | 'reverted';
  /** Decoded `MemoryCommitted` entries, including the event's real hash. */
  commits: Array<{ owner: Hex; contentHash: Hex; commitmentHash: Hex }>;
}

export interface Ports {
  docStore: DocStorePort;
  contentCache: ContentCachePort;
  pin: PinPort;
  rpc: RpcPort;
  /** Content fetch for GET /v1/content on a cache miss (dedicated gateway). */
  fetchContent(cid: string): Promise<Uint8Array>;
  /** Clock injection keeps `createdAt` deterministic in tests. */
  now(): number;
  settings: GatewaySettings;
}
