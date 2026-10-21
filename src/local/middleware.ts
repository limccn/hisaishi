/**
 * HTTP middleware shared by F1 and F2 (design §4.3/§5.2).
 *
 * These live in the transport layer, not in routes: an embedded handle call has
 * no network boundary, and a rule inside a route would be invisible to it. Both
 * forms compose the same middleware, so their browser-facing behaviour cannot
 * drift.
 */

import type { MiddlewareHandler } from 'hono';

import { MAX_BODY_BYTES } from '../core/limits.js';

function clientKey(c: {
  req: { header(name: string): string | undefined };
  env?: unknown;
}): string {
  // F1: the socket address cannot be spoofed by a header. Behind an operator's
  // own proxy, the proxy address is what appears here; trusting forwarding
  // headers is a deployment decision, not a default the code makes for them.
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  if (incoming?.socket?.remoteAddress !== undefined) return incoming.socket.remoteAddress;
  // F2: Cloudflare sets this at the edge; a client cannot choose it.
  return c.req.header('cf-connecting-ip') ?? 'unknown';
}

function loopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
      host === 'localhost' ||
      host === '::1' ||
      host.endsWith('.localhost') ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
    );
  } catch {
    return false;
  }
}

export interface OriginOptions {
  allowedOrigins: readonly string[];
  allowAnyOrigin: boolean;
}

export function isOriginAllowed(origin: string, options: OriginOptions): boolean {
  if (options.allowAnyOrigin) return true;
  if (loopbackOrigin(origin)) return true;
  return options.allowedOrigins.includes(origin);
}

/**
 * Deny a present-but-disallowed Origin on writes. Origin is a browser boundary,
 * not authentication: a request with no Origin (curl, MCP, server-to-server)
 * is allowed.
 */
export function originPolicy(options: OriginOptions): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== '') {
      if (!isOriginAllowed(origin, options) && c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS') {
        return c.json({ code: 'ORIGIN_NOT_ALLOWED', detail: origin }, 403);
      }
    }
    await next();
  };
}

/** JSON writes require a JSON content type; OPTIONS is handled by CORS first. */
export function requireJson(): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const type = (c.req.header('content-type') ?? '').toLowerCase();
      if (!type.startsWith('application/json')) {
        return c.json({ code: 'UNSUPPORTED_MEDIA_TYPE', detail: 'content-type must be application/json' }, 415);
      }
    }
    await next();
  };
}

/**
 * Stream the cloned body to count bytes without buffering the original.
 * `content-length` is checked first, but it is a hint: chunked requests omit it.
 */
export function bodyLimit(maxBytes = MAX_BODY_BYTES): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      await next();
      return;
    }
    const declared = c.req.header('content-length');
    if (declared !== undefined && Number(declared) > maxBytes) {
      return c.json({ code: 'BODY_TOO_LARGE', detail: `body exceeds ${maxBytes} bytes` }, 413);
    }
    const body = c.req.raw.clone().body;
    if (body !== null) {
      const reader = body.getReader();
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            return c.json({ code: 'BODY_TOO_LARGE', detail: `body exceeds ${maxBytes} bytes` }, 413);
          }
        }
      } catch {
        // A body read failure is the route's problem to report; do not turn it
        // into a size error.
      }
    }
    await next();
  };
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window in-process limiter.
 *
 * Per-isolate on F2 (Workers can run many isolates), so this is a cost guard,
 * not a precise quota. The edge rules documented in the README are the real
 * control; this still protects F1 and any non-CF deployment.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  take(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    if (this.buckets.size > 10_000) this.sweep(now);
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (bucket.count >= limit) return false;
    bucket.count += 1;
    return true;
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    // Hard cap: live keys can still grow under distributed-IP abuse. Drop the
    // oldest insertion entries rather than scanning a huge map on every call.
    if (this.buckets.size > 20_000) {
      for (const key of this.buckets.keys()) {
        if (this.buckets.size <= 10_000) break;
        this.buckets.delete(key);
      }
    }
  }

  reset(): void {
    this.buckets.clear();
  }
}

export interface RatePolicy {
  max: number;
  windowMs: number;
}

export interface RatePolicies {
  stage: RatePolicy;
  build: RatePolicy;
  confirm: RatePolicy;
  content: RatePolicy;
  owner: RatePolicy;
}

export const DEFAULT_RATE_POLICIES: RatePolicies = {
  stage: { max: 30, windowMs: 60_000 },
  build: { max: 30, windowMs: 60_000 },
  confirm: { max: 60, windowMs: 60_000 },
  content: { max: 120, windowMs: 60_000 },
  owner: { max: 120, windowMs: 3_600_000 },
};

function policyFor(method: string, path: string, policies: RatePolicies): RatePolicy | null {
  if (method === 'POST' && path === '/v1/memories') return policies.stage;
  if (method === 'POST' && path === '/v1/batches/build') return policies.build;
  if (method === 'POST' && path === '/v1/batches/confirm') return policies.confirm;
  if (method === 'GET' && path === '/v1/content') return policies.content;
  return null;
}

export function rateLimit(
  limiter: RateLimiter,
  policies: RatePolicies = DEFAULT_RATE_POLICIES,
): MiddlewareHandler {
  return async (c, next) => {
    const ip = clientKey(c);
    const policy = policyFor(c.req.method, c.req.path, policies);
    if (policy !== null && !limiter.take(`ip:${ip}:${c.req.path}`, policy.max, policy.windowMs)) {
      return c.json({ code: 'RATE_LIMITED', detail: 'rate limit exceeded' }, 429, {
        'retry-after': String(Math.ceil(policy.windowMs / 1000)),
      });
    }

    // Per-owner budget for the two write paths. The body is already bounded by
    // bodyLimit; parse a clone so the route still reads the original.
    if (
      c.req.method === 'POST' &&
      (c.req.path === '/v1/memories' || c.req.path === '/v1/batches/build')
    ) {
      const body = (await c.req.raw
        .clone()
        .json()
        .catch(() => null)) as { owner?: unknown } | null;
      const owner = body?.owner;
      if (typeof owner === 'string' && owner !== '') {
        if (
          !limiter.take(
            `owner:${owner.toLowerCase()}`,
            policies.owner.max,
            policies.owner.windowMs,
          )
        ) {
          return c.json({ code: 'RATE_LIMITED', detail: 'owner quota exceeded' }, 429, {
            'retry-after': String(Math.ceil(policies.owner.windowMs / 1000)),
          });
        }
      }
    }

    await next();
  };
}
