import { afterEach } from 'vitest';

import { runContractSuite } from './contract-suite.js';
import { createSqliteHarness } from './sqlite-harness.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

// Harness B: the real F1 adapter (node:sqlite). Running the identical suite on
// both harnesses is what turns "the forms share a contract" from an assumption
// into a test (M1-19).
runContractSuite('node:sqlite (F1)', async () => {
  const created = await createSqliteHarness();
  cleanups.push(created.cleanup);
  return { handle: created.handle, harness: created.harness };
});
