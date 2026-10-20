/**
 * F1 transport — Hono over the typed handle (R9).
 *
 * There is no route logic here: each handler calls the handle, then maps a
 * `GatewayResult` to `{status, body}`. If a behaviour lives in this file, it is
 * unavailable to embedded consumers and will drift from the HTTP contract.
 */

import { Hono } from 'hono';

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
    if (cid === undefined || cid === '') {
      return c.json({ code: 'SCHEMA_VIOLATION', detail: 'cid is required' }, 400);
    }
    const result = await handle.content(cid);
    if (!result.ok) return c.json(result.error, result.status as never);
    // Copy into a fresh ArrayBuffer: Hono's BodyInit excludes the
    // SharedArrayBuffer-capable `Uint8Array<ArrayBufferLike>` under TS 7.
    const body = new Uint8Array(result.value.byteLength);
    body.set(result.value);
    return c.newResponse(body.buffer, 200, { 'content-type': 'application/octet-stream' });
  });

  return app;
}
