/**
 * F1 transport tests — the Hono layer must map `GatewayResult` faithfully.
 *
 * These call `app.fetch` directly rather than binding a port: the mapping is
 * what is under test, and a real socket would add flakiness without adding
 * coverage. The e2e test below does bind a port.
 */

import { describe, expect, it } from 'vitest';

import { createGatewayHandle } from '../src/core/gateway.js';
import { OTHER_OWNER } from './contract-suite.js';
import { DEFAULT_RATE_POLICIES } from '../src/local/middleware.js';
import { createMemoryHarness } from '../src/core/ports/memory.js';
import { createApp } from '../src/local/serve.js';
import { contentFor, OWNER, TX_HASH } from './contract-suite.js';

const PAGES_ORIGIN = 'https://longstone-ui.pages.dev';
const BRANDED_ORIGIN = 'https://longstone.app';

function makeApp(allowedOrigins: readonly string[] = [PAGES_ORIGIN]) {
  const harness = createMemoryHarness();
  return {
    app: createApp(createGatewayHandle(harness.ports), {
      allowedOrigins,
    }),
    harness,
  };
}

const CAPABILITY = 'ab'.repeat(16);
const CAPABILITY_B = 'cd'.repeat(16);

describe('HTTP transport', () => {
  it('POST /v1/memories maps success and typed failures to status+body', async () => {
    const { app } = makeApp();
    const c = contentFor('http-stage');

    const ok = await app.request('/v1/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
        capability: CAPABILITY,
      }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { cid: string; status: string };
    expect(body.status).toBe('staged');

    const tampered = await app.request('/v1/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: OWNER,
        content: c.content,
        contentHash: `0x${'00'.repeat(32)}`,
        tags: [],
        capability: CAPABILITY,
      }),
    });
    expect(tampered.status).toBe(400);
    expect((await tampered.json()) as { code: string }).toMatchObject({ code: 'INVALID_HASH' });
  });

  it('malformed JSON is a 400, not a 500', async () => {
    const { app } = makeApp();
    const response = await app.request('/v1/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });

  it('POST /v1/batches/build requires the session capability', async () => {
    const { app } = makeApp();
    const c = contentFor('capability-http');
    await app.request('/v1/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
        capability: CAPABILITY,
      }),
    });

    const missing = await app.request('/v1/batches/build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OWNER }),
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()) as { code: string }).toMatchObject({ code: 'CAPABILITY_REQUIRED' });

    const other = await app.request('/v1/batches/build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, capability: CAPABILITY_B }),
    });
    expect(other.status).toBe(409);

    const ok = await app.request('/v1/batches/build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, capability: CAPABILITY }),
    });
    expect(ok.status).toBe(200);
  });

  it('POST /v1/batches/confirm returns 202 while pending', async () => {
    const { app } = makeApp();
    const c = contentFor('pending-http');
    await app.request('/v1/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
        capability: CAPABILITY,
      }),
    });
    await app.request('/v1/batches/build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, capability: CAPABILITY }),
    });

    const response = await app.request('/v1/batches/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
        capability: CAPABILITY,
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

  it('GET /v1/content is membership-gated and distinguishes 404 from 502', async () => {
    const { app, harness } = makeApp();
    const known = contentFor('known content bytes');
    const other = contentFor('a different memory');
    const capabilityHash = `0x${'ab'.repeat(32)}` as `0x${string}`;

    await harness.docStore.insertOrGet({
      owner: OWNER,
      contentHash: known.contentHash,
      cidDigest: known.cidDigest,
      cid: 'bafkreibytes',
      tags: [],
      now: 1,
      capabilityHash,
    });
    harness.setContent('bafkreibytes', known.bytes);

    const ok = await app.request('/v1/content?cid=bafkreibytes');
    expect(ok.status).toBe(200);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(known.bytes);

    // Unknown CID: no row, no upstream call.
    harness.setFetchFailure('bafkreimissing', 'notFound');
    const missing = await app.request('/v1/content?cid=bafkreimissing');
    expect(missing.status).toBe(404);

    // Known row, upstream outage.
    await harness.docStore.insertOrGet({
      owner: OWNER,
      contentHash: other.contentHash,
      cidDigest: other.cidDigest,
      cid: 'bafkreiup',
      tags: [],
      now: 2,
      capabilityHash,
    });
    harness.setFetchFailure('bafkreiup', 'upstream');
    const upstream = await app.request('/v1/content?cid=bafkreiup');
    expect(upstream.status).toBe(502);

    // Known row, upstream returns different bytes than the row commits to.
    await harness.docStore.insertOrGet({
      owner: OWNER,
      contentHash: `0x${'33'.repeat(32)}`,
      cidDigest: other.cidDigest,
      cid: 'bafkreimismatch',
      tags: [],
      now: 3,
      capabilityHash,
    });
    harness.setContent('bafkreimismatch', known.bytes);
    const mismatch = await app.request('/v1/content?cid=bafkreimismatch');
    expect(mismatch.status).toBe(502);
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
        capability: CAPABILITY,
      }),
    });
    await app.request('/v1/batches/build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, capability: CAPABILITY }),
    });

    harness.rpc.getTransactionReceipt = async () => {
      throw new Error('rpc returned 429');
    };

    const response = await app.request('/v1/batches/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
        capability: CAPABILITY,
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
  // The UI is served from Pages/the branded apex and calls this Worker on
  // api.longstone.app (workers.dev as fallback). Regression: without the
  // middleware, every staging fetch fails at the browser's preflight even
  // though curl and same-origin tests pass.
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
    expect(response.headers.get('access-control-allow-origin')).toBe('https://longstone-ui.pages.dev');
    expect(response.headers.get('access-control-allow-methods')).toContain('GET');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('attaches the origin header to actual responses', async () => {
    const { app } = makeApp();
    const response = await app.request(`/v1/memories?owner=${OWNER}`, {
      headers: { origin: 'https://longstone-ui.pages.dev' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://longstone-ui.pages.dev');
  });

  it('allows both origins when the migration list contains the apex and pages.dev', async () => {
    // The deployed config lists both: the branded apex is the new canonical
    // origin, pages.dev stays for released clients that hardcode it.
    const { app } = makeApp([BRANDED_ORIGIN, PAGES_ORIGIN]);

    for (const origin of [BRANDED_ORIGIN, PAGES_ORIGIN]) {
      const preflight = await app.request('/v1/memories', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    }

    const c = contentFor('dual-origin-stage');
    const write = await app.request('/v1/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BRANDED_ORIGIN },
      body: JSON.stringify({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
        capability: CAPABILITY,
      }),
    });
    expect(write.status).toBe(200);
    expect(write.headers.get('access-control-allow-origin')).toBe(BRANDED_ORIGIN);
  });

  it('still rejects an unlisted origin while both origins are configured', async () => {
    const { app } = makeApp([BRANDED_ORIGIN, PAGES_ORIGIN]);
    const c = contentFor('dual-origin-denied');
    const response = await app.request('/v1/memories', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
      },
      body: JSON.stringify({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
        capability: CAPABILITY,
      }),
    });
    expect(response.status).toBe(403);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: 'ORIGIN_NOT_ALLOWED',
    });
  });
});

describe('capability and content limits', () => {
  it('stage rejects a missing or malformed capability', async () => {
    const { app } = makeApp();
    const c = contentFor('stage-capability');
    const base = {
      owner: OWNER,
      content: c.content,
      contentHash: c.contentHash,
      tags: [],
    };
    const missing = await app.request('/v1/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(base),
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()) as { code: string }).toMatchObject({
      code: 'CAPABILITY_REQUIRED',
    });

    const malformed = await app.request('/v1/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, capability: 'zz' }),
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()) as { code: string }).toMatchObject({
      code: 'INVALID_CAPABILITY',
    });
  });

  it('rejects an oversized upstream object before caching', async () => {
    const { app, harness } = makeApp();
    const c = contentFor('oversized-upstream');
    const staged = await app.request('/v1/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
        capability: CAPABILITY,
      }),
    });
    expect(staged.status).toBe(200);
    const { cid } = (await staged.json()) as { cid: string };
    harness.setContent(cid, new Uint8Array(1024 * 1024 + 1));

    const response = await app.request(`/v1/content?cid=${cid}`);
    expect(response.status).toBe(413);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: 'CONTENT_TOO_LARGE',
    });
  });
});

describe('transport middleware', () => {
  it('requires a JSON content type on writes', async () => {
    const { app } = makeApp();
    const response = await app.request('/v1/memories', { method: 'POST', body: '{}' });
    expect(response.status).toBe(415);
  });

  it('rejects a body above the limit before parsing', async () => {
    const { app } = makeApp();
    const response = await app.request('/v1/memories', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(300 * 1024),
      },
      body: '{}',
    });
    expect(response.status).toBe(413);
  });

  it('rejects a disallowed origin on writes', async () => {
    const { app } = makeApp();
    const c = contentFor('origin-denied');
    const response = await app.request('/v1/memories', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
      },
      body: JSON.stringify({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
        capability: CAPABILITY,
      }),
    });
    expect(response.status).toBe(403);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: 'ORIGIN_NOT_ALLOWED',
    });
  });

  it('rate limits after the configured budget', async () => {
    const harness = createMemoryHarness();
    const app = createApp(createGatewayHandle(harness.ports), {
      allowedOrigins: ['https://longstone-ui.pages.dev'],
      ratePolicies: {
        ...DEFAULT_RATE_POLICIES,
        stage: { max: 1, windowMs: 60_000 },
      },
    });
    const c = contentFor('rate-limited');
    const body = JSON.stringify({
      owner: OWNER,
      content: c.content,
      contentHash: c.contentHash,
      tags: [],
      capability: CAPABILITY,
    });
    const first = await app.request('/v1/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(first.status).toBe(200);
    const second = await app.request('/v1/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(second.status).toBe(429);
    expect((await second.json()) as { code: string }).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('exposes the deployment id on health', async () => {
    const { app } = makeApp();
    const response = await app.request('/v1/health');
    expect(response.status).toBe(200);
    expect((await response.json()) as { deploymentId: string }).toMatchObject({
      deploymentId: 'test',
      capabilities: true,
    });
  });
});

describe('confirm cache scoping', () => {
  it("does not replay an owner's cached answer to another owner", async () => {
    const { app, harness } = makeApp();
    const c = contentFor('confirm-owner-scope');
    await app.request('/v1/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: OWNER,
        content: c.content,
        contentHash: c.contentHash,
        tags: [],
        capability: CAPABILITY,
      }),
    });
    await app.request('/v1/batches/build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, capability: CAPABILITY }),
    });
    harness.rpc.setReceipt(TX_HASH, {
      status: 'success',
      commits: [
        {
          owner: OWNER,
          contentHash: c.contentHash,
          commitmentHash: `0x${'cd'.repeat(32)}`,
        },
      ],
    });

    const first = await app.request('/v1/batches/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, txHash: TX_HASH }),
    });
    expect(first.status).toBe(200);

    // Same tx, different owner: the cached anchored answer must not leak.
    const other = await app.request('/v1/batches/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OTHER_OWNER, txHash: TX_HASH }),
    });
    expect(other.status).toBe(400);
    expect((await other.json()) as { code: string }).toMatchObject({ code: 'UNKNOWN_TX' });

    // The UNKNOWN_TX negative answer is cached: a second call costs no RPC.
    const callsBefore = harness.rpc.calls;
    const again = await app.request('/v1/batches/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OTHER_OWNER, txHash: TX_HASH }),
    });
    expect(again.status).toBe(400);
    expect(harness.rpc.calls).toBe(callsBefore);
  });
});

describe('confirm input handling', () => {
  it('returns typed 400s for missing or non-string fields, never 500', async () => {
    const { app } = makeApp();
    const noOwner = await app.request('/v1/batches/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: `0x${'ab'.repeat(32)}` }),
    });
    expect(noOwner.status).toBe(400);
    expect((await noOwner.json()) as { code: string }).toMatchObject({ code: 'INVALID_HEX' });

    const badHash = await app.request('/v1/batches/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, txHash: 123 }),
    });
    expect(badHash.status).toBe(400);
    expect((await badHash.json()) as { code: string }).toMatchObject({ code: 'INVALID_HEX' });
  });
});
