/**
 * F1 transport — Hono over the typed handle (R9).
 *
 * There is no route logic here: each handler calls the handle, then maps a
 * `GatewayResult` to `{status, body}`. If a behaviour lives in this file, it is
 * unavailable to embedded consumers and will drift from the HTTP contract.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import type { GatewayHandle } from '../core/gateway.js';
import type { ConfirmResponse } from '../core/routes.js';
import {
  DEFAULT_RATE_POLICIES,
  RateLimiter,
  bodyLimit,
  isOriginAllowed,
  originPolicy,
  rateLimit,
  requireJson,
  type OriginOptions,
  type RatePolicies,
} from './middleware.js';

/** Parse JSON without throwing into a 500; a malformed body is a 400. */
async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export interface AppOptions {
  /** Origins allowed to read/write from a browser. Loopback is always allowed. */
  allowedOrigins?: readonly string[];
  /** Explicit operator opt-in; unsafe outside local development. */
  allowAnyOrigin?: boolean;
  ratePolicies?: RatePolicies;
  rateLimiter?: RateLimiter;
  /** Tests set 0 to observe an immediate receipt transition. */
  confirmPendingTtlMs?: number;
  confirmTerminalTtlMs?: number;
}

export function createApp(handle: GatewayHandle, options: AppOptions = {}): Hono {
  const app = new Hono();
  const originOptions: OriginOptions = {
    allowedOrigins: options.allowedOrigins ?? [],
    allowAnyOrigin: options.allowAnyOrigin === true,
  };
  const limiter = options.rateLimiter ?? new RateLimiter();
  const policies = options.ratePolicies ?? DEFAULT_RATE_POLICIES;

  // Order matters: an origin rejection must not consume a rate-limit token, and
  // an oversized body must not be parsed before the size check.
  app.use('*', originPolicy(originOptions));
  app.use(
    '*',
    cors({
      origin: (origin) => (origin === '' || isOriginAllowed(origin, originOptions) ? origin || '*' : ''),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['content-type'],
      // Browsers cannot read a response header unless it is exposed. The verify
      // view reports which CID the digest resolved to.
      exposeHeaders: ['x-ipfs-cid'],
      maxAge: 86400,
    }),
  );
  app.use('*', requireJson());
  app.use('*', bodyLimit());
  app.use('*', rateLimit(limiter, policies));

  // Short negative cache for confirm: clients poll, and each call is one RPC.
  const confirmCache = new Map<string, { expires: number; result: Awaited<ReturnType<GatewayHandle['confirm']>> }>();
  const CONFIRM_PENDING_TTL_MS = options.confirmPendingTtlMs ?? 12_000;
  const CONFIRM_TERMINAL_TTL_MS = options.confirmTerminalTtlMs ?? 60_000;

  app.get('/v1/health', (c) => c.json(handle.health(), 200));

  app.post('/v1/memories', async (c) => {
    const body = (await readJson(c)) as Record<string, unknown> | undefined;
    if (body === undefined) {
      return c.json({ code: 'SCHEMA_VIOLATION', detail: 'body must be JSON' }, 400);
    }
    const result = await handle.stage({
      owner: body.owner as string,
      content: body.content,
      contentHash: body.contentHash as string,
      tags: (body.tags as string[] | undefined) ?? [],
      capability: body.capability as string,
    });
    return result.ok ? c.json(result.value, 200) : c.json(result.error, result.status as never);
  });

  app.post('/v1/batches/build', async (c) => {
    const body = (await readJson(c)) as Record<string, unknown> | undefined;
    if (body === undefined) {
      return c.json({ code: 'SCHEMA_VIOLATION', detail: 'body must be JSON' }, 400);
    }
    // The capability is the whole selector; there is no owner-wide fallback.
    const result = await handle.build({
      owner: body.owner as string,
      capability: body.capability as string,
    });
    if (!result.ok) return c.json(result.error, result.status as never);
    // `blockHeight` is a bigint (it is hashed as uint64) and JSON cannot
    // serialize one. Decimal strings are the wire form everywhere else in this
    // project — the cache file, the vectors, longstone's index — so the HTTP
    // contract uses the same encoding rather than a second convention.
    const commitments = result.value.commitments.map((commitment) => ({
      ...commitment,
      blockHeight: commitment.blockHeight.toString(),
    }));
    return c.json({ ...result.value, commitments }, 200);
  });

  app.post('/v1/batches/confirm', async (c) => {
    const body = (await readJson(c)) as Record<string, unknown> | undefined;
    if (body === undefined) {
      return c.json({ code: 'SCHEMA_VIOLATION', detail: 'body must be JSON' }, 400);
    }
    const rawTxHash = body.txHash;
    const rawOwner = body.owner;
    // Validate the cache key's inputs BEFORE touching them: a missing or
    // non-string field must reach `handle.confirm` and become its typed 400,
    // not a TypeError from `.toLowerCase()`.
    const keyable = typeof rawTxHash === 'string' && typeof rawOwner === 'string';
    const cacheKey = keyable
      ? `${rawTxHash.toLowerCase()}:${rawOwner.toLowerCase()}`
      : null;
    const cached = cacheKey === null ? undefined : confirmCache.get(cacheKey);
    let result: Awaited<ReturnType<GatewayHandle['confirm']>>;
    if (cached !== undefined && cached.expires > Date.now()) {
      result = cached.result;
    } else {
      result = await handle.confirm({ owner: rawOwner as string, txHash: rawTxHash as string });
      // Cache answers and UNKNOWN_TX (the "no commits for this owner yet"
      // negative answer). Never cache an RPC failure: an outage must not pin a
      // false answer for the next client.
      const cacheable =
        cacheKey !== null &&
        (result.ok || (!result.ok && result.error.code === 'UNKNOWN_TX'));
      if (cacheable && cacheKey !== null) {
        const pending = result.ok ? result.value.status === 'pending' : true;
        const ttl = pending ? CONFIRM_PENDING_TTL_MS : CONFIRM_TERMINAL_TTL_MS;
        confirmCache.set(cacheKey, { expires: Date.now() + ttl, result });
      }
    }
    return result.ok
      ? c.json(result.value, result.status as never)
      : c.json(result.error, result.status as never);
  });

  app.get('/v1/memories', async (c) => {
    const limitRaw = c.req.query('limit');
    const statusRaw = c.req.query('status');
    // Conditional spreads keep absence out of the object: with
    // `exactOptionalPropertyTypes`, `{ status: undefined }` is not the same as
    // omitting the key, and the route treats them differently.
    const result = await handle.list({
      owner: c.req.query('owner') as string,
      ...(statusRaw === undefined ? {} : { status: statusRaw }),
      ...(limitRaw === undefined ? {} : { limit: Number(limitRaw) }),
    });
    return result.ok
      ? c.json({ rows: result.value }, 200)
      : c.json(result.error, result.status as never);
  });

  app.get('/v1/content', async (c) => {
    const cid = c.req.query('cid');
    const cidDigest = c.req.query('cidDigest');
    if ((cid === undefined || cid === '') && (cidDigest === undefined || cidDigest === '')) {
      return c.json(
        { code: 'SCHEMA_VIOLATION', detail: 'cid or cidDigest is required' },
        400,
      );
    }
    // Copy into a fresh ArrayBuffer: Hono's BodyInit excludes the
    // SharedArrayBuffer-capable `Uint8Array<ArrayBufferLike>` under TS 7.
    const stream = (bytes: Uint8Array, headers: Record<string, string> = {}) => {
      const body = new Uint8Array(bytes.byteLength);
      body.set(bytes);
      return c.newResponse(body.buffer, 200, {
        'content-type': 'application/octet-stream',
        ...headers,
      });
    };

    if (cid !== undefined && cid !== '') {
      const result = await handle.content(cid);
      if (!result.ok) return c.json(result.error, result.status as never);
      return stream(result.value);
    }
    // A commitment stores only the digest. Pinata's CIDv0 hashes its dag-pb
    // wrapper, so the CID is NOT derivable from sha256(bytes); the row is the
    // bridge. The returned CID lets a verifier report what was fetched.
    const result = await handle.contentByDigest(cidDigest!);
    if (!result.ok) return c.json(result.error, result.status as never);
    return stream(result.value.bytes, { 'x-ipfs-cid': result.value.cid });
  });

  return app;
}
