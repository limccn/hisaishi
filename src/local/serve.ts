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

/** Parse JSON without throwing into a 500; a malformed body is a 400. */
async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function createApp(handle: GatewayHandle): Hono {
  const app = new Hono();

  // The browser UI is served from a different origin (Pages/Vercel) than the
  // Worker (workers.dev), so every read of `/v1/memories` is cross-origin.
  // Without this middleware the gateway is functional over curl but invisible
  // to its only interactive consumer — a gap that unit tests calling
  // `app.request` cannot see, because they are same-origin by construction.
  //
  // Wildcard origin is deliberate: the gateway is keyless and the staging
  // surface is public read data. No credentials are accepted, so there is no
  // ambient authority for a hostile origin to borrow.
  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['content-type'],
      // Browsers cannot read a response header unless it is exposed. The verify
      // view reports which CID the digest resolved to.
      exposeHeaders: ['x-ipfs-cid'],
      maxAge: 86400,
    }),
  );

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
    });
    return result.ok ? c.json(result.value, 200) : c.json(result.error, result.status as never);
  });

  app.post('/v1/batches/build', async (c) => {
    const body = (await readJson(c)) as Record<string, unknown> | undefined;
    if (body === undefined) {
      return c.json({ code: 'SCHEMA_VIOLATION', detail: 'body must be JSON' }, 400);
    }
    // `limit` is passed through as-is: distinguishing "absent" from an explicit
    // value is the route's job, and `undefined` is how absence arrives.
    const result = await handle.build({ owner: body.owner as string, limit: body.limit });
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
    const result = await handle.confirm({
      owner: body.owner as string,
      txHash: body.txHash as string,
    });
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
