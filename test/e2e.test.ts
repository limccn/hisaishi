/**
 * F1 end-to-end (PRD AC): real HTTP over a real socket, real `node:sqlite`
 * file, full stage → build → confirm → list lifecycle.
 *
 * The only doubles are the two network edges (pin backend, receipt RPC) and the
 * content gateway. Everything else — Hono, the route logic, SQLite, WAL, the
 * wire encoding — is the production path.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGatewayHandle } from '../src/core/gateway.js';
import { createMemoryHarness } from '../src/core/ports/memory.js';
import type { Ports } from '../src/core/contract.js';
import { openDatabase, SqliteContentCache, SqliteDocStore } from '../src/local/sqlite.js';
import { createApp } from '../src/local/serve.js';
import { contentFor, OWNER, TX_HASH } from './contract-suite.js';

const CJK_TEXT = '用户偏好：Python 用于脚本，TypeScript 用于库。🙂';

describe('F1 end-to-end over HTTP + SQLite', () => {
  let baseUrl = '';
  let server: { close: (cb?: () => void) => void };
  let dir = '';
  let db: ReturnType<typeof openDatabase>;
  let harness: ReturnType<typeof createMemoryHarness>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hisaishi-e2e-'));
    db = openDatabase(join(dir, 'gateway.db'));
    harness = createMemoryHarness();

    const ports: Ports = {
      ...harness.ports,
      docStore: new SqliteDocStore(db),
      contentCache: new SqliteContentCache(db),
    };
    const app = createApp(createGatewayHandle(ports));

    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        baseUrl = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('runs the full lifecycle and keeps CJK byte-exact through SQLite', async () => {
    const c = contentFor(CJK_TEXT, { source: 'agent' });

    const staged = await post('/v1/memories', {
      owner: OWNER,
      content: c.content,
      contentHash: c.contentHash,
      tags: ['layer:semantic', 'topic:偏好'],
    });
    expect(staged.status).toBe(200);
    const stagedBody = (await staged.json()) as { cid: string; status: string };
    expect(stagedBody.status).toBe('staged');

    // The CJK AC: the row read back must carry the identical hash, which can
    // only happen if the text survived the SQLite roundtrip byte-exact.
    const listed = await fetch(`${baseUrl}/v1/memories?owner=${OWNER}`);
    const rows = (await listed.json()) as { rows: Array<{ contentHash: string; tags: string[] }> };
    expect(rows.rows[0]!.contentHash).toBe(c.contentHash);
    expect(rows.rows[0]!.tags).toContain('topic:偏好');
    expect(rows.rows[0]!.tags).toContain('layer:semantic');

    const built = await post('/v1/batches/build', { owner: OWNER });
    expect(built.status).toBe(200);
    const batch = (await built.json()) as {
      commitments: Array<{ blockHeight: string; signer: string; prev: string }>;
    };
    // R15: blockHeight crosses the wire as a decimal string.
    expect(typeof batch.commitments[0]!.blockHeight).toBe('string');
    expect(batch.commitments[0]!.blockHeight).toBe('0');
    expect(batch.commitments[0]!.signer).toBe(`0x${'0'.repeat(40)}`);

    // Pending first: 202, no write.
    const pending = await post('/v1/batches/confirm', { owner: OWNER, txHash: TX_HASH });
    expect(pending.status).toBe(202);

    harness.rpc.setReceipt(TX_HASH, {
      status: 'success',
      commits: [{ owner: OWNER, contentHash: c.contentHash }],
    });
    const confirmed = await post('/v1/batches/confirm', { owner: OWNER, txHash: TX_HASH });
    expect(confirmed.status).toBe(200);
    const confirmBody = (await confirmed.json()) as { status: string; confirmed: number };
    expect(confirmBody.status).toBe('anchored');
    expect(confirmBody.confirmed).toBe(1);

    const after = await fetch(`${baseUrl}/v1/memories?owner=${OWNER}&status=anchored`);
    const anchored = (await after.json()) as { rows: Array<{ txHash: string }> };
    expect(anchored.rows).toHaveLength(1);
    expect(anchored.rows[0]!.txHash).toBe(TX_HASH);
  });

  it('survives a restart: rows persist in the SQLite file', async () => {
    // Reopen the same file in a second connection, as an embedded longstone
    // would after a restart.
    const reopened = openDatabase(join(dir, 'gateway.db'));
    try {
      const store = new SqliteDocStore(reopened);
      const rows = await store.list(OWNER, 'anchored', 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.txHash).toBe(TX_HASH);
    } finally {
      reopened.close();
    }
  });

  it('exposes no signing surface over HTTP', async () => {
    // Any endpoint that signs would have to be listed here; the route table is
    // the whole surface, and none of these exist.
    for (const path of ['/v1/sign', '/v1/keys', '/v1/account']) {
      const response = await fetch(`${baseUrl}${path}`, { method: 'POST', body: '{}' });
      expect(response.status, path).toBe(404);
    }
  });
});
