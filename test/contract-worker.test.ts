import { afterEach } from 'vitest';

import { runContractSuite } from './contract-suite.js';
import { createWorkerHarness } from './worker-harness.js';

const disposals: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (disposals.length > 0) await disposals.pop()!();
});

// Harness B: D1 + KV from miniflare. The identical suite on a second REAL
// backend is what makes F1↔F2 parity a test rather than a claim (M1-19).
runContractSuite('D1 + KV (F2)', async () => {
  const created = await createWorkerHarness();
  disposals.push(created.dispose);
  return { handle: created.handle, harness: created.harness };
});
