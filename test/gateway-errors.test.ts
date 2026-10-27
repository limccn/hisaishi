/**
 * L-1 regression: upstream failures must never echo their message.
 *
 * An RPC/Pinata/content error message can contain a full URL — including
 * userinfo and query tokens. The response `detail` is fixed text; the only
 * place the internal detail may appear is a redacted server log.
 */

import { describe, expect, it, vi } from 'vitest';

import { GatewayError } from '../src/core/errors.js';
import { createGatewayHandle } from '../src/core/gateway.js';
import { createMemoryHarness } from '../src/core/ports/memory.js';
import { createApp } from '../src/local/serve.js';
import { contentFor, OWNER, TX_HASH } from './contract-suite.js';

const SECRET = 'https://user:pass@rpc.example/v2/SECRET?token=abc';
const FORBIDDEN = ['user:pass', 'SECRET', 'token=abc', '/v2/'];
const CAPABILITY = 'ab'.repeat(16);
const CAPABILITY_HASH = `0x${'ab'.repeat(32)}` as `0x${string}`;

function makeApp() {
  const harness = createMemoryHarness();
  return {
    app: createApp(createGatewayHandle(harness.ports), {
      allowedOrigins: ['https://longstone-ui.pages.dev'],
    }),
    harness,
  };
}

function expectNoCredential(value: unknown): void {
  const text = JSON.stringify(value);
  for (const fragment of FORBIDDEN) {
    expect(text).not.toContain(fragment);
  }
}

async function stageAndBuild(app: ReturnType<typeof makeApp>['app']): Promise<void> {
  const c = contentFor('l1-rpc-down');
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
}

async function insertRow(
  harness: ReturnType<typeof makeApp>['harness'],
  cid: string,
): Promise<void> {
  await harness.docStore.insertOrGet({
    owner: OWNER,
    contentHash: `0x${'11'.repeat(32)}`,
    cidDigest: `0x${'22'.repeat(32)}`,
    cid,
    tags: [],
    now: 1,
    capabilityHash: CAPABILITY_HASH,
  });
}

describe('L-1 gateway error details', () => {
  it('PIN_FAILED returns a fixed detail and logs a redacted message', async () => {
    const { app, harness } = makeApp();
    harness.pin.pin = async () => {
      throw new Error(`pin upload failed: ${SECRET}`);
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const c = contentFor('l1-pin-down');
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
      const body = (await response.json()) as { code: string; detail?: string };
      expect(body).toEqual({ code: 'PIN_FAILED', detail: 'Pin request failed' });
      expectNoCredential(body);

      const logged = log.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).not.toContain('user:pass');
      expect(logged).not.toContain('SECRET');
      expect(logged).not.toContain('token=abc');
      expect(logged).toContain('rpc.example');
    } finally {
      log.mockRestore();
    }
  });

  it('RPC_UNAVAILABLE returns a fixed detail', async () => {
    const { app, harness } = makeApp();
    await stageAndBuild(app);
    harness.rpc.getTransactionReceipt = async () => {
      throw new Error(`rpc returned 429 from ${SECRET}`);
    };

    const response = await app.request('/v1/batches/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, txHash: TX_HASH }),
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { code: string; detail?: string };
    expect(body).toEqual({ code: 'RPC_UNAVAILABLE', detail: 'RPC unavailable' });
    expectNoCredential(body);
  });

  it('SCHEMA_VIOLATION from the upstream gateway returns a fixed detail', async () => {
    const { app, harness } = makeApp();
    await insertRow(harness, 'bafkreisecret');
    harness.setFetchContent(async () => {
      throw Object.assign(new Error(`bad cid: ${SECRET}`), { invalidCid: true });
    });

    const response = await app.request('/v1/content?cid=bafkreisecret');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; detail?: string };
    expect(body).toEqual({
      code: 'SCHEMA_VIOLATION',
      detail: 'Upstream gateway rejected the CID',
    });
    expectNoCredential(body);
  });

  it('CONTENT_NOT_FOUND upstream returns a fixed detail', async () => {
    const { app, harness } = makeApp();
    await insertRow(harness, 'bafkreimissing');
    harness.setFetchContent(async () => {
      throw Object.assign(new Error(`missing: ${SECRET}`), { notFound: true });
    });

    const response = await app.request('/v1/content?cid=bafkreimissing');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string; detail?: string };
    expect(body).toEqual({ code: 'CONTENT_NOT_FOUND', detail: 'Content not found upstream' });
    expectNoCredential(body);
  });

  it('GATEWAY_UPSTREAM returns a fixed detail', async () => {
    const { app, harness } = makeApp();
    await insertRow(harness, 'bafkreiupstream');
    harness.setFetchContent(async () => {
      throw new Error(`upstream exploded: ${SECRET}`);
    });

    const response = await app.request('/v1/content?cid=bafkreiupstream');
    expect(response.status).toBe(502);
    const body = (await response.json()) as { code: string; detail?: string };
    expect(body).toEqual({ code: 'GATEWAY_UPSTREAM', detail: 'Upstream gateway failed' });
    expectNoCredential(body);
  });

  it('an unclassified failure is INTERNAL with a fixed detail and a redacted log', async () => {
    const { app, harness } = makeApp();
    harness.docStore.findByOwnerAndHash = async () => {
      throw new Error(`store failed: ${SECRET}`);
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const c = contentFor('l1-internal');
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
      expect(response.status).toBe(500);
      const body = (await response.json()) as { code: string; detail?: string };
      expect(body).toEqual({ code: 'INTERNAL', detail: 'Internal error' });
      expectNoCredential(body);

      const logged = log.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).not.toContain('user:pass');
      expect(logged).not.toContain('SECRET');
      expect(logged).not.toContain('token=abc');
    } finally {
      log.mockRestore();
    }
  });

  it('a non-Error rejection still maps to the fixed PIN_FAILED detail', async () => {
    // A port that rejects with a string must not make the logger throw and
    // turn the typed 502 into an INTERNAL 500.
    const { app, harness } = makeApp();
    harness.pin.pin = async () => {
      throw SECRET;
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const c = contentFor('l1-pin-string');
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
      const body = (await response.json()) as { code: string; detail?: string };
      expect(body).toEqual({ code: 'PIN_FAILED', detail: 'Pin request failed' });
      expectNoCredential(body);
      const logged = log.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).not.toContain('user:pass');
      expect(logged).toContain('rpc.example');
    } finally {
      log.mockRestore();
    }
  });

  it('GatewayError redacts a URL smuggled into any detail (defence in depth)', () => {
    const error = new GatewayError('GATEWAY_UPSTREAM', `failed at ${SECRET}`);
    expect(error.detail).not.toContain('user:pass');
    expect(error.detail).not.toContain('SECRET');
    expect(error.detail).not.toContain('token=abc');
    expect(error.detail).not.toContain('/v2/');
    expect(error.detail).toContain('rpc.example');
  });
});
