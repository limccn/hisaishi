/**
 * AC-11: the pin ledger is an optimisation. Every hit is re-validated, so a
 * stale, malformed or mismatched entry causes a real upload instead of a skip.
 */

import { describe, expect, it } from 'vitest';

import { createGatewayHandle } from '../src/core/gateway.js';
import { createMemoryHarness } from '../src/core/ports/memory.js';
import type { Ports } from '../src/core/contract.js';
import { openDatabase, SqliteDocStore } from '../src/local/sqlite.js';
import { contentFor } from './contract-suite.js';

const OWNER = `0x${'11'.repeat(20)}` as const;
const OTHER = `0x${'22'.repeat(20)}` as const;
const CAP = 'ab'.repeat(16);
const CAP_B = 'cd'.repeat(16);
const CONTENT_HASH = `0x${'33'.repeat(32)}` as const;
const CID_DIGEST = `0x${'44'.repeat(32)}` as const;

function makeHandle(): {
  handle: ReturnType<typeof createGatewayHandle>;
  pinCalls: () => number;
  store: SqliteDocStore;
  now: number;
} {
  const db = openDatabase(':memory:');
  const memory = createMemoryHarness();
  const store = new SqliteDocStore(db);
  const ports: Ports = { ...memory.ports, docStore: store };
  return {
    handle: createGatewayHandle(ports),
    pinCalls: () => memory.pin.calls,
    store,
    now: memory.ports.now(),
  };
}

describe('pin ledger validation', () => {
  it('re-pins when the ledger contentHash does not match the bytes', async () => {
    const { handle, pinCalls, store, now } = makeHandle();
    const c = contentFor('ledger-mismatch');
    await store.recordPin({
      cidDigest: c.cidDigest,
      contentHash: CONTENT_HASH,
      cid: 'bafkreibogus',
      pinnedAt: now,
    });

    const result = await handle.stage({
      owner: OWNER,
      content: c.content,
      contentHash: c.contentHash,
      tags: [],
      capability: CAP,
    });
    expect(result.ok).toBe(true);
    expect(pinCalls()).toBe(1);
  });

  it('re-pins when the CID is malformed', async () => {
    const { handle, pinCalls, store, now } = makeHandle();
    const c = contentFor('ledger-cid');
    await store.recordPin({
      cidDigest: c.cidDigest,
      contentHash: c.contentHash,
      cid: 'not a cid!',
      pinnedAt: now,
    });

    const result = await handle.stage({
      owner: OWNER,
      content: c.content,
      contentHash: c.contentHash,
      tags: [],
      capability: CAP,
    });
    expect(result.ok).toBe(true);
    expect(pinCalls()).toBe(1);
  });

  it('re-pins an expired entry, then reuses the refreshed one', async () => {
    const { handle, pinCalls, store, now } = makeHandle();
    const c = contentFor('ledger-expired');
    await store.recordPin({
      cidDigest: c.cidDigest,
      contentHash: c.contentHash,
      cid: 'bafkreiexpired',
      pinnedAt: now - 31 * 24 * 60 * 60 * 1000,
    });

    const first = await handle.stage({
      owner: OWNER,
      content: c.content,
      contentHash: c.contentHash,
      tags: [],
      capability: CAP,
    });
    expect(first.ok).toBe(true);
    expect(pinCalls()).toBe(1);

    // A second owner staging the same bytes now hits the refreshed entry.
    const second = await handle.stage({
      owner: OTHER,
      content: c.content,
      contentHash: c.contentHash,
      tags: [],
      capability: CAP_B,
    });
    expect(second.ok).toBe(true);
    expect(pinCalls()).toBe(1);
  });

  it('re-pins an entry dated in the future beyond clock skew', async () => {
    const { handle, pinCalls, store, now } = makeHandle();
    const c = contentFor('ledger-future');
    await store.recordPin({
      cidDigest: c.cidDigest,
      contentHash: c.contentHash,
      cid: 'bafkreifuture',
      pinnedAt: now + 10 * 60 * 1000,
    });

    const result = await handle.stage({
      owner: OWNER,
      content: c.content,
      contentHash: c.contentHash,
      tags: [],
      capability: CAP,
    });
    expect(result.ok).toBe(true);
    expect(pinCalls()).toBe(1);
  });

  it('skips the upload for a valid, recent entry', async () => {
    const { handle, pinCalls, store, now } = makeHandle();
    const c = contentFor('ledger-valid');
    await store.recordPin({
      cidDigest: c.cidDigest,
      contentHash: c.contentHash,
      cid: 'bafkreivalid',
      pinnedAt: now,
    });

    const result = await handle.stage({
      owner: OWNER,
      content: c.content,
      contentHash: c.contentHash,
      tags: [],
      capability: CAP,
    });
    expect(result.ok).toBe(true);
    expect(pinCalls()).toBe(0);
  });
});
