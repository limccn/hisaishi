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
  /** Oldest-first `staged` rows for an owner, up to `limit`. */
  selectStaged(owner: Hex, limit: number): Promise<MemoryRecord[]>;
  /** Flip staged → batched and persist the built batch. */
  markBatched(owner: Hex, contentHashes: Hex[], batchId: string, batch: BatchPayload): Promise<void>;
  /** Rows of this owner that are `batched` and whose content_hash is in the set. */
  findBatchedByHashes(owner: Hex, contentHashes: Hex[]): Promise<MemoryRecord[]>;
  /** Flip batched → anchored/rejected for the given content hashes. */
  markSettled(
    owner: Hex,
    contentHashes: Hex[],
    status: 'anchored' | 'rejected',
    txHash: Hex,
  ): Promise<number>;
  /** Re-open a rejected row so the same content can be retried (R5). */
  reopenRejected(owner: Hex, contentHash: Hex): Promise<void>;
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
  /** Decoded `MemoryCommitted` entries: owner + contentHash pairs. */
  commits: Array<{ owner: Hex; contentHash: Hex }>;
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
}
