/**
 * The shared contract suite (design §7).
 *
 * One set of assertions that must hold for every adapter. It takes a `Harness`
 * rather than importing F1 or F2, so adding an adapter means calling this file
 * again with different ports — not writing a second suite that can drift.
 *
 * Each review-added row is labelled with the revision that produced it, so a
 * future reader can tell a behaviour from a regression test.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { canonicalString, contentHash, cidDigest, type MemoryContent } from '@limccn/menhir-core';

import { createGatewayHandle, type GatewayHandle } from '../src/core/gateway.js';
import { createMemoryHarness, type Harness } from '../src/core/ports/memory.js';
import type { MemoryRow } from '../src/core/contract.js';
import type { StageRequest } from '../src/core/routes.js';

export const OWNER = `0x${'11'.repeat(20)}` as const;
export const OTHER_OWNER = `0x${'22'.repeat(20)}` as const;
export const TX_HASH = `0x${'ab'.repeat(32)}` as const;

export function contentFor(text: string, meta?: Record<string, unknown>) {
  // The cast is deliberate: callers pass loosely-typed fixture data on purpose,
  // and the gateway's own schema gate is what must reject it if it is invalid.
  const content = {
    text,
    format: 'text.v0' as const,
    ...(meta === undefined ? {} : { meta }),
  } as unknown as MemoryContent;
  const canonical = canonicalString(content);
  const bytes = new TextEncoder().encode(canonical);
  return {
    content,
    contentHash: contentHash(content),
    cidDigest: cidDigest(bytes),
    bytes,
  };
}

/**
 * Run the full suite against a handle.
 *
 * `label` names the adapter in the test output; `makeHarness` builds a fresh
 * one per test so rows never leak between cases.
 */
export function runContractSuite(
  label: string,
  makeHarness: () => Promise<{ handle: GatewayHandle; harness: Harness }>,
): void {
  describe(`contract suite — ${label}`, () => {
    let handle: GatewayHandle;
    let harness: Harness;

    beforeEach(async () => {
      ({ handle, harness } = await makeHarness());
    });

    /**
     * Read back through the PUBLIC route, not the harness's internal store.
     * The SQLite harness wires the gateway to a real adapter while the harness
     * object still holds an in-memory double; asserting on the double proved
     * nothing about what the adapter wrote (found by running this suite on both).
     */
    async function rowsByStatus(status: MemoryRow['status'] | null) {
      const result = await handle.list({
        owner: OWNER,
        ...(status === null ? {} : { status }),
        limit: 200,
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      return result.ok ? result.value : [];
    }

    async function stageOk(req: Partial<StageRequest> & { text: string; owner?: string }) {
      const c = contentFor(req.text);
      const result = await handle.stage({
        owner: req.owner ?? OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: req.tags ?? [],
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      return c;
    }

    // ---------------------------------------------------------------- stage

    it('stage returns cid, cidDigest and an actual status', async () => {
      const c = contentFor('hello');
      const result = await handle.stage({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: ['layer:deep'],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('staged');
      expect(result.value.cidDigest).toBe(c.cidDigest);
      expect(result.value.cid).toMatch(/^b[a-z2-7]+$/);
    });

    it('R3: a tampered contentHash is rejected without pinning or writing', async () => {
      const c = contentFor('tamper');
      const pinsBefore = harness.pin.calls;

      const result = await handle.stage({
        owner: OWNER,
        content: c.content,
        contentHash: `0x${'00'.repeat(32)}`,
        tags: [],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(400);
      expect(result.error.code).toBe('INVALID_HASH');
      // The ordering claim: no pin, no row. Counting the adapter call is the
      // only way to prove "before any write" rather than "and then rolled back".
      expect(harness.pin.calls).toBe(pinsBefore);
      const rows = await rowsByStatus(null);
      expect(rows).toHaveLength(0);
    });

    it('R3: dedup hit returns the same cid and does not pin twice', async () => {
      const c = contentFor('dup');
      const first = await handle.stage({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
      });
      const pinsAfterFirst = harness.pin.calls;

      const second = await handle.stage({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
      });

      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.value.cid).toBe(first.value.cid);
      expect(harness.pin.calls).toBe(pinsAfterFirst);
    });

    it('R1: two owners staging identical bytes get two rows and one CID', async () => {
      const c = contentFor('shared');
      const a = await handle.stage({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
      });
      const b = await handle.stage({
        owner: OTHER_OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
      });
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(b.value.cid).toBe(a.value.cid);

      // Both must be buildable — the v0.2 `cid` PK silently dropped the second
      // owner's row, so this is the regression that matters.
      const buildB = await handle.build({ owner: OTHER_OWNER });
      expect(buildB.ok).toBe(true);
    });

    it('rejects non-NFC, unknown keys and oversized tags with typed codes', async () => {
      // The hash cannot be computed locally for invalid content — the core gate
      // throws first. That is itself the point: submit a well-formed 32-byte
      // hash so the request reaches the gateway and the gateway rejects it.
      const nfd = { text: `é`, format: 'text.v0' as const };
      const nfdResult = await handle.stage({
        owner: OWNER,
        content: nfd,
        contentHash: `0x${'44'.repeat(32)}`,
        tags: [],
      });
      expect(nfdResult.ok).toBe(false);
      if (!nfdResult.ok) {
        expect(nfdResult.status).toBe(422);
        expect(nfdResult.error.code).toBe('NON_NORMALIZED_INPUT');
      }

      const unknown = { text: 'x', format: 'text.v0', extra: 1 };
      const unknownResult = await handle.stage({
        owner: OWNER,
        content: unknown,
        contentHash: `0x${'55'.repeat(32)}`,
        tags: [],
      });
      expect(unknownResult.ok).toBe(false);
      if (!unknownResult.ok) expect(unknownResult.error.code).toBe('SCHEMA_VIOLATION');

      const c = contentFor('tags');
      const longTag = await handle.stage({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: ['x'.repeat(33)],
      });
      expect(longTag.ok).toBe(false);
      if (!longTag.ok) expect(longTag.error.code).toBe('TAG_TOO_LONG');
    });

    // ---------------------------------------------------------------- build

    it('build flips staged rows to batched and emits placeholder triple', async () => {
      await stageOk({ text: 'one' });
      await stageOk({ text: 'two' });

      const result = await handle.build({ owner: OWNER });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.commitments).toHaveLength(2);

      // R2: prev / blockHeight / signer are all placeholders. A zero signer is
      // the deliberate loud failure if longstone forgets to stamp.
      for (const c of result.value.commitments) {
        expect(c.prev).toBe(`0x${'0'.repeat(64)}`);
        expect(c.blockHeight).toBe(0n);
        expect(c.signer).toBe(`0x${'0'.repeat(40)}`);
        expect(c.op).toBe(0);
      }

      const rows = await rowsByStatus('batched');
      expect(rows).toHaveLength(2);
      expect(rows[0]!.batchId).toBe(result.value.batchId);
    });

    it('build: limit absent → 64, 0/negative/fractional/oversized → 413', async () => {
      await stageOk({ text: 'limit' });
      for (const bad of [0, -1, 1.5, 65]) {
        const result = await handle.build({ owner: OWNER, limit: bad });
        expect(result.ok, `limit ${bad}`).toBe(false);
        if (!result.ok) {
          expect(result.status, `limit ${bad}`).toBe(413);
          expect(result.error.code).toBe('INVALID_BATCH_SIZE');
        }
      }
      // Fewer staged rows than the limit is normal, not an error.
      const ok = await handle.build({ owner: OWNER, limit: 64 });
      expect(ok.ok).toBe(true);
    });

    it('build with zero staged rows → 409 NO_STAGED', async () => {
      const result = await handle.build({ owner: OWNER });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(409);
        expect(result.error.code).toBe('NO_STAGED');
      }
    });

    it('R8: batched rows never re-enter a later build (batches are disjoint)', async () => {
      await stageOk({ text: 'first' });
      const b1 = await handle.build({ owner: OWNER });
      expect(b1.ok).toBe(true);

      // A second build with nothing new staged must not re-select the batched row.
      const b2 = await handle.build({ owner: OWNER });
      expect(b2.ok).toBe(false);
      if (!b2.ok) expect(b2.error.code).toBe('NO_STAGED');

      await stageOk({ text: 'second' });
      const b3 = await handle.build({ owner: OWNER });
      expect(b3.ok).toBe(true);
      if (!b3.ok || !b1.ok) return;
      const hashes1 = new Set(b1.value.commitments.map((c) => c.contentHash));
      for (const c of b3.value.commitments) {
        expect(hashes1.has(c.contentHash)).toBe(false);
      }
    });

    // -------------------------------------------------------------- confirm

    it('confirm: exactly one receipt call, pending → 202 with no write', async () => {
      await stageOk({ text: 'pending' });
      await handle.build({ owner: OWNER });
      const callsBefore = harness.rpc.calls;

      const result = await handle.confirm({ owner: OWNER, txHash: TX_HASH });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.status).toBe(202);
      expect(result.value.status).toBe('pending');
      // D-10: the whole RPC surface is one call. A retry loop would show >1.
      expect(harness.rpc.calls - callsBefore).toBe(1);

      const rows = await rowsByStatus('batched');
      expect(rows).toHaveLength(1);
    });

    it('confirm success anchors only this owner’s matching rows', async () => {
      const c = await stageOk({ text: 'anchor' });
      await handle.build({ owner: OWNER });

      harness.rpc.setReceipt(TX_HASH, {
        status: 'success',
        commits: [{ owner: OWNER, contentHash: c.contentHash }],
      });

      const result = await handle.confirm({ owner: OWNER, txHash: TX_HASH });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('anchored');
      if (result.value.status !== 'anchored') return;
      expect(result.value.confirmed).toBe(1);

      const rows = await rowsByStatus('anchored');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.txHash).toBe(TX_HASH);
    });

    it('R7: a reverted receipt reports status rejected, not a zero count', async () => {
      const c = await stageOk({ text: 'revert' });
      await handle.build({ owner: OWNER });
      harness.rpc.setReceipt(TX_HASH, {
        status: 'reverted',
        commits: [{ owner: OWNER, contentHash: c.contentHash }],
      });

      const result = await handle.confirm({ owner: OWNER, txHash: TX_HASH });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('rejected');
      if (result.value.status !== 'rejected') return;
      expect(result.value.rejected).toBe(1);

      const rows = await rowsByStatus('rejected');
      expect(rows).toHaveLength(1);
    });

    it('R5: a rejected row is re-opened by re-staging the same content', async () => {
      const c = await stageOk({ text: 'reopen' });
      await handle.build({ owner: OWNER });
      harness.rpc.setReceipt(TX_HASH, {
        status: 'reverted',
        commits: [{ owner: OWNER, contentHash: c.contentHash }],
      });
      await handle.confirm({ owner: OWNER, txHash: TX_HASH });

      const restaged = await handle.stage({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
      });
      expect(restaged.ok).toBe(true);
      if (!restaged.ok) return;
      expect(restaged.value.status).toBe('staged');

      const rows = await rowsByStatus('staged');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.batchId).toBeNull();
    });

    it('R3: a receipt with no commits for this owner → UNKNOWN_TX, no flip', async () => {
      await stageOk({ text: 'unknown' });
      await handle.build({ owner: OWNER });
      harness.rpc.setReceipt(TX_HASH, {
        status: 'success',
        commits: [{ owner: OTHER_OWNER, contentHash: `0x${'33'.repeat(32)}` }],
      });

      const result = await handle.confirm({ owner: OWNER, txHash: TX_HASH });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('UNKNOWN_TX');

      const rows = await rowsByStatus('batched');
      expect(rows).toHaveLength(1);
    });

    it('confirm is idempotent: a second call flips nothing', async () => {
      const c = await stageOk({ text: 'idem' });
      await handle.build({ owner: OWNER });
      harness.rpc.setReceipt(TX_HASH, {
        status: 'success',
        commits: [{ owner: OWNER, contentHash: c.contentHash }],
      });
      await handle.confirm({ owner: OWNER, txHash: TX_HASH });

      const second = await handle.confirm({ owner: OWNER, txHash: TX_HASH });
      // No batched rows match any more, so the honest answer is UNKNOWN_TX
      // rather than a fake success.
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.code).toBe('UNKNOWN_TX');
    });

    // ----------------------------------------------------------------- list

    it('list returns MemoryRow with a null commitmentHash for staged rows', async () => {
      await stageOk({ text: 'list' });
      const result = await handle.list({ owner: OWNER });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      const row = result.value[0]!;
      // R13: the row shape is part of the contract, and placeholders mean there
      // is no authoritative hash until longstone stamps and signs.
      expect(row.commitmentHash).toBeNull();
      // `batch_json` stays internal: it carries placeholders, can be large, and
      // exposing it invites a caller to treat an unsigned struct as truth.
      expect(Object.keys(row)).not.toContain('batchJson');
    });

    it('owner case: an EIP-55 checksummed query finds lowercase rows', async () => {
      // Live UI regression: wagmi hands the browser the checksummed spelling
      // (`…2E610…`), while stage stored lowercase. The staging view queried
      // with the checksummed form and the gateway answered "no rows" for data
      // it had just written. Address identity is the 20 bytes, not the case.
      const lower = `0x${'aB'.repeat(20)}` as `0x${string}`;
      const checksummed = `0x${'Ab'.repeat(20)}` as `0x${string}`;
      await stageOk({ text: 'checksummed-owner', owner: lower });

      const listed = await handle.list({ owner: checksummed });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value).toHaveLength(1);
      expect(listed.value[0]!.owner).toBe(lower.toLowerCase());
    });

    it('list exposes a derived commitmentHash once batched', async () => {
      await stageOk({ text: 'batched-row' });
      await handle.build({ owner: OWNER });
      const result = await handle.list({ owner: OWNER });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]!.commitmentHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(result.value[0]!.batchId).not.toBeNull();
    });

    it('list: owner required, invalid status rejected, limit bounded', async () => {
      const missing = await handle.list({ owner: undefined as never });
      expect(missing.ok).toBe(false);

      const badStatus = await handle.list({ owner: OWNER, status: 'nope' });
      expect(badStatus.ok).toBe(false);
      if (!badStatus.ok) expect(badStatus.status).toBe(400);

      const badLimit = await handle.list({ owner: OWNER, limit: 201 });
      expect(badLimit.ok).toBe(false);
    });

    // -------------------------------------------------------------- content

    it('content: cache miss fetches, cache hit does not refetch', async () => {
      const c = contentFor('content');
      harness.setContent('bafkreitest', c.bytes);

      const first = await handle.content('bafkreitest');
      expect(first.ok).toBe(true);

      let fetches = 0;
      // Replace through the harness holder; the handle calls `ports.fetchContent`,
      // which delegates to it. Patching `harness.ports.fetchContent` directly
      // did nothing because the handle captured the original function (M2).
      harness.setFetchContent(async (cid: string) => {
        fetches += 1;
        const bytes = contentFor('content').bytes;
        void cid;
        return bytes;
      });

      const second = await handle.content('bafkreitest');
      expect(second.ok).toBe(true);
      expect(fetches).toBe(0);
    });

    it('R6: content 404 → CONTENT_NOT_FOUND; upstream failure → GATEWAY_UPSTREAM', async () => {
      harness.setFetchFailure('bafkreimissing', 'notFound');
      const missing = await handle.content('bafkreimissing');
      expect(missing.ok).toBe(false);
      if (!missing.ok) {
        expect(missing.status).toBe(404);
        expect(missing.error.code).toBe('CONTENT_NOT_FOUND');
      }

      harness.setFetchFailure('bafkreiupstream', 'upstream');
      const upstream = await handle.content('bafkreiupstream');
      expect(upstream.ok).toBe(false);
      if (!upstream.ok) {
        expect(upstream.status).toBe(502);
        expect(upstream.error.code).toBe('GATEWAY_UPSTREAM');
      }
    });

    // --------------------------------------------------------- keyless audit

    it('the embedded handle exposes no signing surface', () => {
      const names = Object.keys(handle);
      for (const name of names) {
        expect(name).not.toMatch(/sign|key|account/i);
      }
    });
  });
}

/** Convenience wrapper for the in-memory harness. */
export async function memoryHarness(): Promise<{ handle: GatewayHandle; harness: Harness }> {
  const harness = createMemoryHarness();
  const handle = createGatewayHandle(harness.ports);
  return { handle, harness };
}
