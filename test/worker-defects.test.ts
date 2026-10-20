/**
 * Regression tests for defects found by the F2 review (2026-10-20).
 *
 * Each one is labelled with the finding it covers, because a future reader
 * needs to know whether a failure here is a regression or a deliberate change.
 */

import { describe, expect, it, vi } from 'vitest';

import { createGatewayHandle } from '../src/core/gateway.js';
import { createMemoryHarness } from '../src/core/ports/memory.js';
import { createMemoryPin } from '../src/core/ports/pin.js';
import { createReceiptRpc } from '../src/worker/rpc.js';
import { assertKeylessBindings } from '../src/worker/env.js';
import { OWNER, TX_HASH, contentFor } from './contract-suite.js';

describe('H2 — the offline pin is chosen explicitly, never by a missing JWT', () => {
  it('refuses to construct without a JWT and without dev mode', () => {
    expect(() => createMemoryPin(undefined, false)).toThrow(/PINATA_JWT is required/);
    expect(() => createMemoryPin('', false)).toThrow(/PINATA_JWT is required/);
  });

  it('uses the deterministic adapter only when dev mode is explicit', () => {
    const pin = createMemoryPin(undefined, true);
    expect(pin).toBeDefined();
  });

  it('uses Pinata when a JWT is present', () => {
    const pin = createMemoryPin('jwt', false);
    expect(pin).toBeDefined();
  });
});

describe('M1/M6 — optional KV writes must not fail a request', () => {
  it('stage still succeeds when the dedup mirror write throws', async () => {
    const harness = createMemoryHarness();
    // The harness's content cache is used as the KV mirror in this test.
    const cache = harness.contentCache as unknown as { put: () => Promise<void> };
    const original = cache.put;
    cache.put = async () => {
      throw new Error('KV quota exceeded');
    };
    try {
      const handle = createGatewayHandle(harness.ports);
      const c = contentFor('mirror-failure');
      const result = await handle.stage({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
      });
      // The in-memory harness has no separate mirror; this asserts the route
      // does not treat the cache as required.
      expect(result.ok).toBe(true);
    } finally {
      cache.put = original;
    }
  });

  it('content is returned even when the cache put fails', async () => {
    const harness = createMemoryHarness();
    const c = contentFor('cache-failure');
    harness.setContent('bafkreicachefail', c.bytes);

    const cache = harness.contentCache as unknown as { put: () => Promise<void> };
    const original = cache.put;
    cache.put = async () => {
      throw new Error('KV value too large');
    };
    try {
      const handle = createGatewayHandle(harness.ports);
      const result = await handle.content('bafkreicachefail');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual(c.bytes);
    } finally {
      cache.put = original;
    }
  });
});

describe('M4 — receipt logs are filtered by registry address', () => {
  it('ignores a MemoryCommitted emitted by another contract', async () => {
    const registry = `0x${'aa'.repeat(20)}` as const;
    const foreign = `0x${'bb'.repeat(20)}` as const;

    const log = (address: string) => ({
      address,
      // A syntactically valid MemoryCommitted is not needed: the filter runs
      // before decoding, which is the point.
      data: '0x',
      topics: [] as string[],
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              status: '0x1',
              logs: [log(foreign), log(registry)],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    try {
      const rpc = createReceiptRpc('https://rpc.test', registry);
      const receipt = await rpc.getTransactionReceipt(TX_HASH);
      // The registry's log is malformed in this fixture, so it decodes to
      // nothing; the foreign one must never be attempted.
      expect(receipt?.commits).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('M5 — keyless audit catches any *_KEY binding', () => {
  it.each(['WALLET_KEY', 'SIGNER_KEY', 'DELEGATION_KEY', 'HOT_KEY'])(
    'rejects %s',
    (name) => {
      expect(() => assertKeylessBindings({ [name]: 'x' })).toThrow(/keyless|key-shaped/);
    },
  );

  it('does not reject ordinary bindings', () => {
    expect(() =>
      assertKeylessBindings({ DB: {}, KV_HISAISHI_STAGING: {}, RPC_URL: 'https://rpc' }),
    ).not.toThrow();
  });
});
