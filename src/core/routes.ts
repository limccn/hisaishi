/**
 * Form-agnostic route logic (design §4).
 *
 * Every function takes `Ports` and returns plain data or throws a
 * `GatewayError`. The F1/F2 adapters only translate transport; there is exactly
 * one implementation of each behaviour, which is what makes the parity suite
 * meaningful.
 */

import { tagToBytes32, ZERO_BYTES32, cidDigest, type Commitment } from '@limccn/menhir-core';

import type {
  BatchPayload,
  MemoryRecord,
  MemoryRow,
  Ports,
} from './contract.js';
import { GatewayError } from './errors.js';
import { verifyContent, type VerifiedContent } from './integrity.js';
import { MAX_CONTENT_BYTES } from './limits.js';

const MAX_BATCH = 64;
const CAPABILITY_PATTERN = /^[0-9a-fA-F]{32}$/;
const PIN_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Opportunistic retention sweep. At most once per `sweepIntervalMs` per
 * process; housekeeping must never fail a build.
 */
let lastSweepAt = 0;
async function maybeSweep(ports: Ports, now: number): Promise<void> {
  if (now - lastSweepAt < ports.settings.sweepIntervalMs) return;
  lastSweepAt = now;
  try {
    await ports.docStore.deleteExpired({
      stagedBefore: now - ports.settings.stagingTtlMs,
      rejectedBefore: now - ports.settings.rejectedTtlMs,
      pinsBefore: now - ports.settings.pinTtlMs,
      now,
    });
  } catch {
    // Housekeeping must not fail the request.
  }
}

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
    // Real value from the registry event, set by confirm; null before that.
    // The gateway never derives a hash from unsigned placeholder structs.
    commitmentHash: record.commitmentHash,
  };
}

/**
 * The one row state that scopes staging: sha256(deploymentId + ':' + capability).
 * Folding the deployment in keeps shared D1/KV and blue/green deployments
 * mutually invisible without another column.
 */
function hashCapability(ports: Ports, capability: string): `0x${string}` {
  const token = assertCapability(capability);
  return cidDigest(
    new TextEncoder().encode(`${ports.settings.deploymentId}:${token}`),
  ) as `0x${string}`;
}

function assertCapability(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new GatewayError('CAPABILITY_REQUIRED', 'capability is required');
  }
  if (!CAPABILITY_PATTERN.test(value)) {
    throw new GatewayError(
      'INVALID_CAPABILITY',
      'capability must be 32 hex characters (128 bits)',
    );
  }
  return value.toLowerCase();
}

function pinIsValid(
  pin: { cidDigest: string; contentHash: string; cid: string; pinnedAt: number },
  verified: VerifiedContent,
  now: number,
  ttlMs: number,
): boolean {
  return (
    pin.cidDigest.toLowerCase() === verified.cidDigest.toLowerCase() &&
    pin.contentHash.toLowerCase() === verified.contentHash.toLowerCase() &&
    /^[a-zA-Z0-9]+$/.test(pin.cid) &&
    pin.cid.length <= 128 &&
    pin.pinnedAt <= now + PIN_CLOCK_SKEW_MS &&
    pin.pinnedAt >= now - ttlMs
  );
}

export interface StageRequest {
  owner: string;
  content: unknown;
  contentHash: string;
  tags: string[];
  /** Client-generated 128-bit session token; opaque to the gateway. */
  capability: string;
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
  // Validate the session token before any expensive work; a missing capability
  // is a caller error, not an anonymous staging request.
  const capabilityHash = hashCapability(ports, req.capability);
  const verified = verifyContent({
    content: req.content,
    contentHash: req.contentHash,
    tags: req.tags,
  });
  const owner = assertAddress(req.owner);
  const now = ports.now();

  const existing = await ports.docStore.findByOwnerAndHash(owner, verified.contentHash);
  if (existing !== null) {
    switch (existing.status) {
      case 'anchored':
        return { cid: existing.cid, cidDigest: verified.cidDigest, status: 'anchored' };
      case 'staged':
        // Last stager wins. Without this, a known-content pre-stage could deny
        // the real author permanently (design §2.1).
        await ports.docStore.bindStaged(owner, verified.contentHash, capabilityHash);
        return { cid: existing.cid, cidDigest: verified.cidDigest, status: 'staged' };
      case 'rejected':
        // R5: a reverted batch must not make the content permanently unusable.
        await ports.docStore.reopenRejected(owner, verified.contentHash, capabilityHash);
        return { cid: existing.cid, cidDigest: verified.cidDigest, status: 'staged' };
      case 'batched': {
        const reclaimed = await ports.docStore.reclaimBatched(
          owner,
          verified.contentHash,
          capabilityHash,
          now - ports.settings.batchTtlMs,
        );
        // A fresh batch belongs to another session; report the truth and let
        // the caller retry after the TTL.
        return {
          cid: existing.cid,
          cidDigest: verified.cidDigest,
          status: reclaimed ? 'staged' : 'batched',
        };
      }
    }
  }

  // Global pin ledger: identical bytes under different owners upload once.
  // A hit is re-validated; the ledger is never a correctness assumption.
  let pinnedCid: string;
  const ledger = await ports.docStore.findPin(verified.cidDigest);
  if (ledger !== null && pinIsValid(ledger, verified, now, ports.settings.pinTtlMs)) {
    pinnedCid = ledger.cid;
  } else {
    try {
      pinnedCid = (await ports.pin.pin(verified.bytes)).cid;
    } catch (error) {
      throw new GatewayError('PIN_FAILED', (error as Error).message);
    }
    try {
      await ports.docStore.recordPin({
        cidDigest: verified.cidDigest,
        contentHash: verified.contentHash,
        cid: pinnedCid,
        pinnedAt: now,
      });
    } catch {
      // The ledger is an optimisation and an accounting aid; a failed write
      // must not turn a successful pin into a 500.
    }
  }

  const record = await ports.docStore.insertOrGet({
    owner,
    contentHash: verified.contentHash,
    cidDigest: verified.cidDigest,
    cid: pinnedCid,
    tags: req.tags,
    now,
    capabilityHash,
  });

  return { cid: record.cid, cidDigest: record.cidDigest, status: record.status };
}

export interface BuildRequest {
  owner: string;
  /** The staging session; only its rows are selectable. */
  capability: string;
}

export interface BuildResponse {
  batchId: string;
  commitments: Commitment[];
  tagLists: `0x${string}`[][];
}

/**
 * POST /v1/batches/build.
 *
 * Selects only rows staged under the presented capability. A same-capability
 * stale batch is reclaimed first; rows under any other capability (or another
 * deployment sharing this database) are invisible.
 */
export async function build(ports: Ports, req: BuildRequest): Promise<BuildResponse> {
  const owner = assertAddress(req.owner);
  const capabilityHash = hashCapability(ports, req.capability);
  const now = ports.now();

  await maybeSweep(ports, now);
  await ports.docStore.reclaimStaleBatched(
    owner,
    capabilityHash,
    now - ports.settings.batchTtlMs,
  );
  const staged = await ports.docStore.selectStaged(owner, capabilityHash, MAX_BATCH);
  if (staged.length === 0) {
    throw new GatewayError('NO_STAGED', `no staged memories for this capability and ${owner}`);
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
  const batchId = uuidv7(now);

  await ports.docStore.markBatched(
    owner,
    staged.map((r) => r.contentHash),
    batchId,
    { commitments, tagLists },
    now,
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

  let receipt;
  try {
    receipt = await ports.rpc.getTransactionReceipt(txHash);
  } catch (error) {
    // An RPC outage is not an internal bug. A 429 from the public endpoint is
    // the most common cause, and reporting INTERNAL sends an operator looking
    // for a defect instead of backing off (found on the deployed Worker).
    throw new GatewayError('RPC_UNAVAILABLE', (error as Error).message);
  }
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

  // Store the REAL commitment hash from the event for each settled row. It is
  // a lookup candidate for clients, never a proof; if a receipt contains two
  // commits for the same contentHash, the last one wins deterministically.
  const batchedHashes = new Set(batched.map((row) => row.contentHash.toLowerCase()));
  const byContentHash = new Map<string, `0x${string}`>();
  for (const commit of receipt.commits) {
    if (commit.owner.toLowerCase() !== owner.toLowerCase()) continue;
    if (!batchedHashes.has(commit.contentHash.toLowerCase())) continue;
    byContentHash.set(commit.contentHash.toLowerCase(), commit.commitmentHash);
  }
  const commits = [...byContentHash.entries()].map(([contentHash, commitmentHash]) => ({
    contentHash: contentHash as `0x${string}`,
    commitmentHash,
  }));

  const settled = await ports.docStore.markSettled(
    owner,
    commits,
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
 * Membership → cache → fetch → digest check → cache. The gateway is not an
 * open IPFS proxy: it only serves CIDs it has a row for, caps the upstream
 * response, and verifies the fetched bytes against the row's digest before
 * caching. A 404 upstream is `CONTENT_NOT_FOUND`; transport/5xx is
 * `GATEWAY_UPSTREAM`.
 */

export async function content(ports: Ports, cid: string): Promise<Uint8Array> {
  // Membership before any upstream work: an unknown CID must cost nothing.
  const row = await ports.docStore.findByCid(cid);
  if (row === null) {
    throw new GatewayError('CONTENT_NOT_FOUND', `${cid} is not staged or pinned`);
  }

  const key = `content:${cid}`;
  const cached = await ports.contentCache.get(key);
  if (cached !== null) {
    // Old cache entries predate the digest check; re-verify before trusting.
    if (cached.byteLength <= MAX_CONTENT_BYTES && cidDigest(cached) === row.cidDigest) {
      return cached;
    }
  }

  let bytes: Uint8Array;
  try {
    bytes = await ports.fetchContent(cid);
  } catch (error) {
    const flags = error as { notFound?: boolean; invalidCid?: boolean; tooLarge?: boolean } | null;
    if (flags?.tooLarge === true) {
      throw new GatewayError('CONTENT_TOO_LARGE', `upstream content exceeds ${MAX_CONTENT_BYTES} bytes`);
    }
    // Three distinct facts, three distinct codes: absent vs malformed vs down.
    if (flags?.invalidCid === true) {
      // A CID the gateway cannot parse is malformed input, not a hash mismatch.
      // INVALID_HASH is defined for keccak disagreement (design §6).
      throw new GatewayError('SCHEMA_VIOLATION', (error as Error).message);
    }
    throw new GatewayError(
      flags?.notFound === true ? 'CONTENT_NOT_FOUND' : 'GATEWAY_UPSTREAM',
      (error as Error).message,
    );
  }

  if (bytes.byteLength > MAX_CONTENT_BYTES) {
    throw new GatewayError(
      'CONTENT_TOO_LARGE',
      `upstream content exceeds ${MAX_CONTENT_BYTES} bytes`,
    );
  }
  if (cidDigest(bytes) !== row.cidDigest) {
    // The upstream served different bytes than the row commits to. Do not
    // cache them: a substituted object must not become the gateway's answer.
    throw new GatewayError('GATEWAY_UPSTREAM', `bytes for ${cid} do not match the row digest`);
  }

  try {
    await ports.contentCache.put(key, bytes, 7 * 24 * 60 * 60 * 1000);
  } catch {
    // A cache is an optimization. If the write fails (KV value cap, quota), the
    // bytes are still valid and must be returned (review M6).
  }
  return bytes;
}

/**
 * Content by retrieval digest.
 *
 * A verifier holding a commitment knows `cidDigest` but not the CID: Pinata
 * returns a CIDv0 hashing its dag-pb wrapper, so `sha256(bytes)` cannot be
 * turned back into the pinned CID. This route is the digest → CID bridge. It
 * returns the pinned CID alongside the bytes so the caller can report what was
 * fetched. The gateway is trusted for availability and mapping only — a caller
 * that verifies recomputes both digests over these bytes and will reject any
 * substitution.
 */
export async function contentByDigest(
  ports: Ports,
  cidDigest: string,
): Promise<{ cid: string; bytes: Uint8Array }> {
  if (typeof cidDigest !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(cidDigest)) {
    throw new GatewayError('INVALID_HEX', 'cidDigest must be 32-byte hex');
  }
  const row = await ports.docStore.findByCidDigest(cidDigest as `0x${string}`);
  if (row === null) {
    throw new GatewayError('CONTENT_NOT_FOUND', `${cidDigest} is not staged or pinned`);
  }
  return { cid: row.cid, bytes: await content(ports, row.cid) };
}

// --------------------------------------------------------------------------
// validation helpers
// --------------------------------------------------------------------------

export function assertAddress(value: string): `0x${string}` {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new GatewayError('INVALID_HEX', 'owner must be a 20-byte hex address');
  }
  // Canonical form is lowercase. An address has one identity but many string
  // spellings: wallets and wagmi hand back the EIP-55 checksummed form
  // (`0x330c…2E610…`), while longstone and the chain store lowercase. Comparing
  // the strings literally made the UI's `/v1/memories?owner=` query miss every
  // row it had just written — a failure invisible to same-case test fixtures
  // and to curl. Normalize at the single validation boundary so storage and
  // lookup cannot disagree.
  return value.toLowerCase() as `0x${string}`;
}

function assertTxHash(value: string): `0x${string}` {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new GatewayError('INVALID_HEX', 'txHash must be 32-byte hex');
  }
  return value as `0x${string}`;
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
