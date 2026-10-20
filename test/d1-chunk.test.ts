import { describe, expect, it } from 'vitest';
import { createWorkerHarness } from './worker-harness.js';

describe('M3 — D1 bound-parameter cap', () => {
  it('findBatchedByHashes accepts more hashes than D1 allows in one statement', async () => {
    // D1 caps bound parameters at 100. A receipt can carry two commitBatch
    // calls (2×64 logs), so the adapter chunks. Verified against real D1.
    const h = await createWorkerHarness();
    try {
      const hashes = Array.from({ length: 140 }, (_, i) =>
        `0x${(0x1000 + i).toString(16).padStart(64, '0')}` as `0x${string}`,
      );
      // No rows exist; the point is that the query does not throw.
      const rows = await h.docStore.findBatchedByHashes(`0x${'11'.repeat(20)}`, hashes);
      expect(rows).toEqual([]);
    } finally {
      await h.dispose();
    }
  }, 60_000);
});
