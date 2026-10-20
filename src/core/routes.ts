/**
 * Form-agnostic route logic (design §4).
 *
 * Every function takes `Ports` and returns plain data or throws a
 * `GatewayError`. The F1/F2 adapters only translate transport; there is exactly
 * one implementation of each behaviour, which is what makes the parity suite
 * meaningful.
 */

import { commitmentHash, tagToBytes32, ZERO_BYTES32, type Commitment } from '@menhir/core';

import type {
  BatchPayload,
  MemoryRecord,
  MemoryRow,
  Ports,
} from './contract.js';
import { GatewayError } from './errors.js';
import { verifyContent } from './integrity.js';

const MAX_BATCH = 64;

/** `signer` placeholder — longstone stamps the real delegation key (R2). */
const ZERO_ADDRESS = `0x${'0'.repeat(40)}` as `0x${string}`;

function toRow(record: MemoryRecord): MemoryRow {
  return {
    cid: record.cid,
    contentHash: record.contentHash,
    cidDigest: record.cidDigest,
    owner: record.owner,
    tags: record.tags,
    status: record.status,
    batchId: record.batchId,
    txHash: record.txHash,
    createdAt: record.createdAt,
    // Derived from the *placeholder* struct (R13). It is a lookup aid; the
    // authoritative hash is the one longstone computes after stamping.
    commitmentHash: record.batchJson === null
      ? null
      : commitmentHashOfFirst(record.batchJson, record.contentHash),
  };
}

function commitmentHashOfFirst(batch: BatchPayload, contentHash: `0x${string}`): `0x${string}` {
  const index = batch.commitments.findIndex(
    (c) => c.contentHash.toLowerCase() === contentHash.toLowerCase(),
  );
  if (index < 0) return ZERO_BYTES32;
  return commitmentHash(batch.commitments[index]!);
}

export interface StageRequest {
  owner: string;
  content: unknown;
  contentHash: string;
  tags: string[];
}

export interface StageResponse {
  cid: string;
  cidDigest: `0x${string}`;
  status: MemoryRow['status'];
}

/**
 * POST /v1/memories.
 *
 * Order matters: validate → integrity → dedup → pin → upsert. A failure before
 * the pin leaves nothing behind, which the suite asserts by counting pin calls.
 */
export async function stage(ports: Ports, req: StageRequest): Promise<StageResponse> {
  const verified = verifyContent({
    content: req.content,
    contentHash: req.contentHash,
    tags: req.tags,
  });
  const owner = assertAddress(req.owner);

  const existing = await ports.docStore.findByOwnerAndHash(owner, verified.contentHash);
  if (existing !== null) {
    if (existing.status === 'rejected') {
      // R5: a reverted batch must not make the content permanently unusable.
      await ports.docStore.reopenRejected(owner, verified.contentHash);
      return { cid: existing.cid, cidDigest: verified.cidDigest, status: 'staged' };
    }
    // Return the row's ACTUAL status — claiming 'staged' for an anchored row
    // would misreport on-chain state to the caller.
    return { cid: existing.cid, cidDigest: verified.cidDigest, status: existing.status };
  }

  let pinned: { cid: string };
  try {
    pinned = await ports.pin.pin(verified.bytes);
  } catch (error) {
    throw new GatewayError('PIN_FAILED', (error as Error).message);
  }

  const record = await ports.docStore.insertOrGet({
    owner,
    contentHash: verified.contentHash,
    cidDigest: verified.cidDigest,
    cid: pinned.cid,
    tags: req.tags,
    now: ports.now(),
  });

  return { cid: record.cid, cidDigest: record.cidDigest, status: record.status };
}

export interface BuildRequest {
  owner: string;
  // Omitted = "use the default". Present-but-invalid is a 413, which is why
  // absence and `undefined` must stay distinguishable at the route boundary.
  limit?: unknown;
}

export interface BuildResponse {
  batchId: string;
  commitments: Commitment[];
  tagLists: `0x${string}`[][];
}

/**
 * POST /v1/batches/build.
 *
 * `limit` absent → 64. Present must be an integer 1..64 (else 413). Fewer staged
 * rows than `limit` is normal, not an error.
 */
export async function build(ports: Ports, req: BuildRequest): Promise<BuildResponse> {
  const owner = assertAddress(req.owner);
  const limit = parseLimit(req.limit);

  const staged = await ports.docStore.selectStaged(owner, limit);
  if (staged.length === 0) {
    throw new GatewayError('NO_STAGED', `no staged memories for ${owner}`);
  }

  // Placeholders (R2): prev, blockHeight and signer are all zero. longstone
  // overwrites all three before signing; a zero signer reverts loudly, which is
  // the intended failure for a skipped stamp.
  const commitments: Commitment[] = staged.map((row) => ({
    owner,
    contentHash: row.contentHash,
    cidDigest: row.cidDigest,
    signer: ZERO_ADDRESS,
    blockHeight: 0n,
    op: 0,
    prev: ZERO_BYTES32,
  }));
  const tagLists = staged.map((row) => row.tags.map(tagToBytes32Hex));
  const batchId = uuidv7(ports.now());

  await ports.docStore.markBatched(
    owner,
    staged.map((r) => r.contentHash),
    batchId,
    { commitments, tagLists },
  );

  return { batchId, commitments, tagLists };
}

export interface ConfirmRequest {
  owner: string;
  txHash: string;
}

export type ConfirmResponse =
  | { status: 'anchored'; confirmed: number }
  | { status: 'rejected'; rejected: number }
  | { status: 'pending'; retryAfter: number };

/**
 * POST /v1/batches/confirm.
 *
 * EXACTLY ONE receipt call (D-10). Pending → 202 with no write; the caller
 * drives retries. The outcome is decided by receipt status and by which of this
 * owner's batched rows appear in the receipt's commit logs — never by `tx_hash`,
 * which is NULL until this function writes it (R3).
 */
export async function confirm(ports: Ports, req: ConfirmRequest): Promise<ConfirmResponse> {
  const owner = assertAddress(req.owner);
  const txHash = assertTxHash(req.txHash);

  const receipt = await ports.rpc.getTransactionReceipt(txHash);
  if (receipt === null) {
    return { status: 'pending', retryAfter: 12 };
  }

  // Only this owner's logs count: a sender-supplied txHash is a claim, and a
  // tx that commits someone else's memory must not flip our rows.
  const committed = new Set(
    receipt.commits
      .filter((c) => c.owner.toLowerCase() === owner.toLowerCase())
      .map((c) => c.contentHash.toLowerCase()),
  );

  if (committed.size === 0) {
    throw new GatewayError('UNKNOWN_TX', 'receipt contains no MemoryCommitted for this owner');
  }

  const batched = await ports.docStore.findBatchedByHashes(owner, [...committed] as `0x${string}`[]);
  if (batched.length === 0) {
    throw new GatewayError('UNKNOWN_TX', 'no batched rows match this receipt');
  }

  const hashes = batched.map((r) => r.contentHash);
  const settled = await ports.docStore.markSettled(
    owner,
    hashes,
    receipt.status === 'success' ? 'anchored' : 'rejected',
    txHash,
  );

  return receipt.status === 'success'
    ? { status: 'anchored', confirmed: settled }
    : { status: 'rejected', rejected: settled };
}

export interface ListRequest {
  owner: string;
  status?: string;
  limit?: unknown;
}

export async function list(ports: Ports, req: ListRequest): Promise<MemoryRow[]> {
  const owner = assertAddress(req.owner);
  const status = req.status === undefined ? null : parseStatus(req.status);
  const limit = parseListLimit(req.limit);
  const rows = await ports.docStore.list(owner, status, limit);
  return rows.map(toRow);
}

/**
 * GET /v1/content.
 *
 * Cache hit → bytes. Miss → dedicated-gateway fetch, cache it, return.
 * A 404 upstream is `CONTENT_NOT_FOUND`; transport/5xx is `GATEWAY_UPSTREAM`.
 * Collapsing them would make an outage look like permanent data loss.
 */
export async function content(ports: Ports, cid: string): Promise<Uint8Array> {
  const key = `content:${cid}`;
  const cached = await ports.contentCache.get(key);
  if (cached !== null) return cached;

  let bytes: Uint8Array;
  try {
    bytes = await ports.fetchContent(cid);
  } catch (error) {
    const flags = error as { notFound?: boolean; invalidCid?: boolean } | null;
    // Three distinct facts, three distinct codes: absent vs malformed vs down.
    if (flags?.invalidCid === true) {
      throw new GatewayError('INVALID_HASH', (error as Error).message);
    }
    throw new GatewayError(
      flags?.notFound === true ? 'CONTENT_NOT_FOUND' : 'GATEWAY_UPSTREAM',
      (error as Error).message,
    );
  }

  await ports.contentCache.put(key, bytes, 7 * 24 * 60 * 60 * 1000);
  return bytes;
}

// --------------------------------------------------------------------------
// validation helpers
// --------------------------------------------------------------------------

export function assertAddress(value: string): `0x${string}` {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new GatewayError('INVALID_HEX', 'owner must be a 20-byte hex address');
  }
  return value as `0x${string}`;
}

function assertTxHash(value: string): `0x${string}` {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new GatewayError('INVALID_HEX', 'txHash must be 32-byte hex');
  }
  return value as `0x${string}`;
}

function parseLimit(value: unknown): number {
  if (value === undefined) return MAX_BATCH;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_BATCH) {
    throw new GatewayError('INVALID_BATCH_SIZE', `limit must be an integer 1..${MAX_BATCH}`);
  }
  return value;
}

function parseListLimit(value: unknown): number {
  if (value === undefined) return 100;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 200) {
    throw new GatewayError('SCHEMA_VIOLATION', 'limit must be an integer 1..200');
  }
  return value;
}

function parseStatus(value: string): MemoryRow['status'] {
  if (value !== 'staged' && value !== 'batched' && value !== 'anchored' && value !== 'rejected') {
    throw new GatewayError('SCHEMA_VIOLATION', `unknown status: ${value}`);
  }
  return value;
}

function tagToBytes32Hex(tag: string): `0x${string}` {
  // Reuse core's encoder so tag padding can never drift between the integrity
  // gate and the batch builder.
  return tagToBytes32(tag) as `0x${string}`;
}

/**
 * UUIDv7-shaped id derived from the injected clock. Not a real v7 (no random
 * tail) — ids only need to be unique per owner batch and sortable by time, and
 * determinism keeps the tests readable.
 */
function uuidv7(nowMs: number): string {
  const hex = nowMs.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}
