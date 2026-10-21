/**
 * AC-15: the deployment id is part of the capability hash. Two deployments
 * sharing one database cannot select each other's staged rows, and re-staging
 * moves a row into the caller's namespace.
 */

import { describe, expect, it } from 'vitest';

import { createGatewayHandle } from '../src/core/gateway.js';
import { createMemoryHarness } from '../src/core/ports/memory.js';
import type { Ports } from '../src/core/contract.js';
import { openDatabase, SqliteDocStore } from '../src/local/sqlite.js';
import { contentFor } from './contract-suite.js';

const OWNER = `0x${'11'.repeat(20)}` as const;
const CAP = 'ab'.repeat(16);

describe('deployment scoping', () => {
  it('isolates rows and moves them on re-stage', async () => {
    const db = openDatabase(':memory:');
    const memory = createMemoryHarness();
    const store = new SqliteDocStore(db);
    const base: Ports = { ...memory.ports, docStore: store };
    const a = createGatewayHandle({
      ...base,
      settings: { ...base.settings, deploymentId: 'deployment-a' },
    });
    const b = createGatewayHandle({
      ...base,
      settings: { ...base.settings, deploymentId: 'deployment-b' },
    });

    const c = contentFor('deployment-scope');
    const staged = await a.stage({
      owner: OWNER,
      content: c.content,
      contentHash: c.contentHash,
      tags: [],
      capability: CAP,
    });
    expect(staged.ok).toBe(true);

    // B cannot see A's row with the same capability.
    const bWrong = await b.build({ owner: OWNER, capability: CAP });
    expect(bWrong.ok).toBe(false);
    if (!bWrong.ok) expect(bWrong.error.code).toBe('NO_STAGED');

    // Re-staging through B moves the row into B's namespace.
    const moved = await b.stage({
      owner: OWNER,
      content: c.content,
      contentHash: c.contentHash,
      tags: [],
      capability: CAP,
    });
    expect(moved.ok).toBe(true);
    const bOk = await b.build({ owner: OWNER, capability: CAP });
    expect(bOk.ok).toBe(true);

    // A no longer sees the (now batched) row under its own namespace.
    const aGone = await a.build({ owner: OWNER, capability: CAP });
    expect(aGone.ok).toBe(false);
    if (!aGone.ok) expect(aGone.error.code).toBe('NO_STAGED');
  });
});
