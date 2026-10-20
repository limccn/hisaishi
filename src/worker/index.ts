/**
 * F2 Worker entry.
 *
 * Wiring only. The routes are the core ones, so any behaviour that appears here
 * but not in F1 is a parity bug rather than an F2 feature.
 */

import { createGatewayHandle } from '../core/gateway.js';
import type { Ports } from '../core/contract.js';
import { createMemoryPin } from '../core/ports/pin.js';
import { createApp } from '../local/serve.js';
import { D1DocStore, KvContentCache } from './adapters.js';
import { assertKeylessBindings, type Bindings } from './env.js';
import { createReceiptRpc } from './rpc.js';
import { createGatewayContentFetch } from './content.js';

export default {
  async fetch(request: Request, env: Bindings, ctx: unknown): Promise<Response> {
    // Fail closed before any handler runs: a key in the environment means the
    // deployment is misconfigured, not that some route is unsafe.
    assertKeylessBindings(env as unknown as Record<string, unknown>);

    const docStore = new D1DocStore(env.DB, env.KV_HISAISHI_STAGING);
    const ports: Ports = {
      docStore,
      contentCache: new KvContentCache(env.KV_HISAISHI_STAGING),
      pin: createMemoryPin(env.PINATA_JWT, env.DEV_MODE === 'true'),
      rpc: createReceiptRpc(env.RPC_URL, env.REGISTRY_ADDRESS),
      fetchContent: createGatewayContentFetch(env.IPFS_GATEWAY),
      now: () => Date.now(),
    };

    const handle = createGatewayHandle(ports);
    void ctx;
    // Reuses F1's transport: the mapping from GatewayResult to HTTP is part of
    // the contract, so a second copy would be a second place to drift.
    return createApp(handle).fetch(request);
  },
};
