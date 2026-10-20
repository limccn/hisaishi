/**
 * Harness B — real D1 + KV from `miniflare`.
 *
 * The point of running the shared contract suite on a *second* real backend is
 * parity: F1 and F2 must behave identically, and "must" is worth nothing
 * without a test. An in-memory stand-in for D1 would prove nothing about D1.
 */

import { Miniflare } from 'miniflare';

import { createGatewayHandle, type GatewayHandle } from '../src/core/gateway.js';
import type { DocStorePort, Ports } from '../src/core/contract.js';
import { createMemoryHarness, type Harness } from '../src/core/ports/memory.js';
import { D1DocStore, KvContentCache, type D1Like, type KVLike } from '../src/worker/adapters.js';
import { DDL } from '../src/local/sqlite.js';

export interface WorkerHarnessResult {
  handle: GatewayHandle;
  harness: Harness;
  docStore: D1DocStore;
  dispose(): Promise<void>;
}

export async function createWorkerHarness(): Promise<WorkerHarnessResult> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    compatibilityDate: '2026-08-04',
    d1Databases: { DB: 'hisaishi-test' },
    kvNamespaces: ['KV_HISAISHI_STAGING', 'KV_EMB'],
  });

  const db = (await mf.getD1Database('DB')) as unknown as D1Like;
  const kv = (await mf.getKVNamespace('KV_HISAISHI_STAGING')) as unknown as KVLike;

  // The DDL is the F1 constant, verbatim: the parity rule is that both forms
  // run the same schema, and applying anything else would test a different one.
  for (const statement of DDL.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(statement).bind().run();
  }

  const docStore = new D1DocStore(db, kv);
  const memory = createMemoryHarness();

  const ports: Ports = {
    ...memory.ports,
    // The dedup key is mirrored into KV on write but no route reads it, so
    // the port surface is the same as F1's; the D1 lookup is the only path.
    docStore: docStore satisfies DocStorePort,
    contentCache: new KvContentCache(kv),
  };

  return {
    handle: createGatewayHandle(ports),
    harness: memory,
    docStore,
    async dispose() {
      await mf.dispose();
    },
  };
}
