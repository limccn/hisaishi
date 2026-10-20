import { runContractSuite, memoryHarness } from './contract-suite.js';

// Harness A: in-memory ports. Proves the route logic once; the SQLite harness
// below re-proves it against the F1 adapter.
runContractSuite('in-memory ports', memoryHarness);
