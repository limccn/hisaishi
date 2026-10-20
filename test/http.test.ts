/**
 * F1 transport tests — the Hono layer must map `GatewayResult` faithfully.
 *
 * These call `app.fetch` directly rather than binding a port: the mapping is
 * what is under test, and a real socket would add flakiness without adding
 * coverage. The e2e test below does bind a port.
 */

import { describe, expect, it } from 'vitest';

import { createGatewayHandle } from '../src/core/gateway.js';
import { createMemoryHarness } from '../src/core/ports/memory.js';
import { createApp } from '../src/local/serve.js';
import { contentFor, OWNER, TX_HASH } from './contract-suite.js';

function makeApp() {
  const harness = createMemoryHarness();
  return { app: createApp(createGatewayHandle(harness.ports)), harness };
}

describe('HTTP transport', () => {
  it('POST /v1/memories maps success and typed failures to status+body', async () => {
    const { app } = makeApp();
    const c = contentFor('http-stage');

    const ok = await app.request('/v1/memories', {
      method: 'POST',
      body: JSON.stringify({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
      }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { cid: string; status: string };
    expect(body.status).toBe('staged');

    const tampered = await app.request('/v1/memories', {
      method: 'POST',
      body: JSON.stringify({
        owner: OWNER,
        content: c.content,
        contentHash: `0x${'00'.repeat(32)}`,
        tags: [],
      }),
    });
    expect(tampered.status).toBe(400);
    expect((await tampered.json()) as { code: string }).toMatchObject({ code: 'INVALID_HASH' });
  });

  it('malformed JSON is a 400, not a 500', async () => {
    const { app } = makeApp();
    const response = await app.request('/v1/memories', { method: 'POST', body: 'not json' });
    expect(response.status).toBe(400);
  });

  it('POST /v1/batches/build distinguishes absent limit from an explicit zero', async () => {
    const { app } = makeApp();
    const c = contentFor('limit-http');
    await app.request('/v1/memories', {
      method: 'POST',
      body: JSON.stringify({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
      }),
    });

    const absent = await app.request('/v1/batches/build', {
      method: 'POST',
      body: JSON.stringify({ owner: OWNER }),
    });
    expect(absent.status).toBe(200);

    const zero = await app.request('/v1/batches/build', {
      method: 'POST',
      body: JSON.stringify({ owner: OWNER, limit: 0 }),
    });
    expect(zero.status).toBe(413);
  });

  it('POST /v1/batches/confirm returns 202 while pending', async () => {
    const { app } = makeApp();
    const c = contentFor('pending-http');
    await app.request('/v1/memories', {
      method: 'POST',
      body: JSON.stringify({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
      }),
    });
    await app.request('/v1/batches/build', { method: 'POST', body: JSON.stringify({ owner: OWNER }) });

    const response = await app.request('/v1/batches/confirm', {
      method: 'POST',
      body: JSON.stringify({ owner: OWNER, txHash: TX_HASH }),
    });
    expect(response.status).toBe(202);
    expect((await response.json()) as { status: string }).toMatchObject({ status: 'pending' });
  });

  it('GET /v1/memories returns { rows } and rejects a missing owner', async () => {
    const { app } = makeApp();
    const missing = await app.request('/v1/memories');
    expect(missing.status).toBe(400);

    const ok = await app.request(`/v1/memories?owner=${OWNER}`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  it('GET /v1/content?cidDigest= returns the pinned CID and bytes', async () => {
    // The verify path starts from chain state (commitment.cidDigest) and cannot
    // derive Pinata's CIDv0 locally, since that CID hashes the dag-pb wrapper.
    // The row is the bridge; the header names the CID that was fetched.
    const { app, harness } = makeApp();
    const c = contentFor('digest-content');
    const staged = await app.request('/v1/memories', {
      method: 'POST',
      body: JSON.stringify({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
      }),
    });
    const body = (await staged.json()) as { cid: string };
    harness.setContent(body.cid, c.bytes);

    const response = await app.request(`/v1/content?cidDigest=${c.cidDigest}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-ipfs-cid')).toBe(body.cid);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(c.bytes);

    const unknown = await app.request(`/v1/content?cidDigest=0x${'00'.repeat(32)}`);
    expect(unknown.status).toBe(404);
  });

  it('GET /v1/content serves bytes and distinguishes 404 from 502', async () => {
    const { app, harness } = makeApp();
    harness.setContent('bafkreibytes', new Uint8Array([1, 2, 3]));

    const ok = await app.request('/v1/content?cid=bafkreibytes');
    expect(ok.status).toBe(200);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    harness.setFetchFailure('bafkreimissing', 'notFound');
    const missing = await app.request('/v1/content?cid=bafkreimissing');
    expect(missing.status).toBe(404);

    harness.setFetchFailure('bafkreiup', 'upstream');
    const upstream = await app.request('/v1/content?cid=bafkreiup');
    expect(upstream.status).toBe(502);
  });
});

describe('RPC failure during confirm', () => {
  it('maps an upstream RPC outage to 502 RPC_UNAVAILABLE, not 500', async () => {
    // Found on the deployed Worker: the public Base Sepolia endpoint returned
    // 429 and the gateway reported INTERNAL, which reads as a code defect.
    const { app, harness } = makeApp();
    const c = contentFor('rpc-down');
    await app.request('/v1/memories', {
      method: 'POST',
      body: JSON.stringify({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
      }),
    });
    await app.request('/v1/batches/build', {
      method: 'POST',
      body: JSON.stringify({ owner: OWNER }),
    });

    harness.rpc.getTransactionReceipt = async () => {
      throw new Error('rpc returned 429');
    };

    const response = await app.request('/v1/batches/confirm', {
      method: 'POST',
      body: JSON.stringify({ owner: OWNER, txHash: TX_HASH }),
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('RPC_UNAVAILABLE');
  });
});

describe('pin failure and D1 chunking', () => {
  it('PIN_FAILED: a failing pin is 502 and writes nothing', async () => {
    const { app, harness } = makeApp();
    const c = contentFor('pin-down');
    harness.pin.pin = async () => {
      throw new Error('pinata 500');
    };
    const response = await app.request('/v1/memories', {
      method: 'POST',
      body: JSON.stringify({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
      }),
    });
    expect(response.status).toBe(502);
    expect((await response.json()) as { code: string }).toMatchObject({ code: 'PIN_FAILED' });

    // Nothing staged: the gate refuses to leave a row without pinned bytes.
    const list = await app.request(`/v1/memories?owner=${OWNER}`);
    const body = (await list.json()) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });
});

describe('browser reachability (CORS)', () => {
  // The UI is served from Pages/Vercel and calls this Worker on workers.dev.
  // Regression: without the middleware, every staging fetch fails at the
  // browser's preflight even though curl and same-origin tests pass.
  it('answers the preflight with the methods the UI uses', async () => {
    const { app } = makeApp();
    const response = await app.request('/v1/memories?owner=0x0', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://longstone-ui.pages.dev',
        'access-control-request-method': 'GET',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toContain('GET');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('attaches the origin header to actual responses', async () => {
    const { app } = makeApp();
    const response = await app.request(`/v1/memories?owner=${OWNER}`, {
      headers: { origin: 'https://longstone-ui.pages.dev' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});
