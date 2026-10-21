/**
 * F2 Worker entry.
 *
 * Wiring only. The routes are the core ones, so any behaviour that appears here
 * but not in F1 is a parity bug rather than an F2 feature.
 *
 * The app is cached per isolate. Building it inside `fetch` would reset the
 * rate limiter and the confirm cache on every request, which silently disabled
 * both protections on the only remotely exposed form.
 */

import type { Hono } from 'hono';

import { createGatewayHandle } from '../core/gateway.js';
import type { Ports } from '../core/contract.js';
import { settingsFor } from '../core/settings.js';
import { createMemoryPin } from '../core/ports/pin.js';
import { createApp } from '../local/serve.js';
import { D1DocStore, KvContentCache } from './adapters.js';
import { assertKeylessBindings, type Bindings } from './env.js';
import { createReceiptRpc } from './rpc.js';
import { createGatewayContentFetch } from './content.js';

interface CachedApp {
  key: string;
  app: Hono;
}

let cached: CachedApp | null = null;

function parseOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
}

function appFor(env: Bindings): Hono {
  assertKeylessBindings(env as unknown as Record<string, unknown>);

  const allowedOrigins = parseOrigins(env.HISAISHI_ALLOWED_ORIGINS);
  // Bindings cannot change within a deployment; the key keeps a stale cache
  // from surviving a local `wrangler dev` env edit.
  const key = [
    env.HISAISHI_DEPLOYMENT_ID,
    allowedOrigins.join(','),
    env.HISAISHI_ALLOW_ANY_ORIGIN,
  ].join('|');
  if (cached !== null && cached.key === key) return cached.app;

  const ports: Ports = {
    docStore: new D1DocStore(env.DB),
    contentCache: new KvContentCache(env.KV_HISAISHI_STAGING),
    pin: createMemoryPin(env.PINATA_JWT, env.DEV_MODE === 'true'),
    rpc: createReceiptRpc(env.RPC_URL, env.REGISTRY_ADDRESS),
    fetchContent: createGatewayContentFetch(env.IPFS_GATEWAY),
    now: () => Date.now(),
    settings: settingsFor(env.HISAISHI_DEPLOYMENT_ID),
  };

  // Reuses F1's transport: the mapping from GatewayResult to HTTP is part of
  // the contract, so a second copy would be a second place to drift.
  const app = createApp(createGatewayHandle(ports), {
    allowedOrigins,
    allowAnyOrigin: env.HISAISHI_ALLOW_ANY_ORIGIN === 'true',
  });
  cached = { key, app };
  return app;
}

export default {
  async fetch(request: Request, env: Bindings, ctx: unknown): Promise<Response> {
    void ctx;
    return appFor(env).fetch(request);
  },
};
