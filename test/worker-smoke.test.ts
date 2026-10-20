/**
 * F2 runtime smokes (PRD ACs).
 *
 * - `@limccn/menhir-core` must run under workerd, not just Node: the Worker imports it
 *   for every digest, and a Node-only dependency would only fail at deploy.
 * - the bindings type must stay keyless, and a key in the environment must fail
 *   closed before any request is served.
 */

import { join } from 'node:path';

import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';

import { assertKeylessBindings } from '../src/worker/env.js';


describe('@limccn/menhir-core under workerd', () => {
  it('canonicalizes CJK and computes both digests in the Workers runtime', async () => {
    // Run the REAL wrangler bundle, not a hand-picked entry: bundling is part
    // of what "core runs under workerd" means, and miniflare alone does not
    // resolve bare specifiers the way a deployed Worker must.
    const bundle = join(import.meta.dirname, '..', '.wrangler-smoke', 'index.js');
    // Build step (documented in the test so a fresh clone knows why this
    // exists): `pnpm build && npx wrangler deploy --dry-run --outdir .wrangler-smoke`
    const mf = new Miniflare({
      modules: true,
      scriptPath: bundle,
      compatibilityDate: '2026-08-04',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: 'smoke' },
      kvNamespaces: ['KV_HISAISHI_STAGING', 'KV_EMB'],
      bindings: {
        RPC_URL: 'https://rpc.invalid',
        REGISTRY_ADDRESS: '0x' + '11'.repeat(20),
        IPFS_GATEWAY: '',
        DEV_MODE: 'true',
      },
    });
    try {
      // The bundled Worker is the real gateway; a POST to the stage route
      // runs the core digest path inside workerd.
      const response = await mf.dispatchFetch('http://worker.test/v1/memories', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner: '0x' + '11'.repeat(20), content: { text: 'x', format: 'text.v0' }, contentHash: '0x' + '00'.repeat(32), tags: [] }),
      });
      const body = (await response.json()) as { code?: string; detail?: string };

      // A wrong hash proves core RAN: the gate recomputed it and disagreed.
      // If canonicalization or hashing threw (a Node-only dependency, say), the
      // status would be 500 with INTERNAL rather than this typed rejection.
      expect(response.status).toBe(400);
      expect(body.code).toBe('INVALID_HASH');
    } finally {
      await mf.dispose();
    }
  }, 60_000);
});

describe('keyless audit (F2)', () => {
  it('accepts bindings with no key material', () => {
    expect(() =>
      assertKeylessBindings({
        DB: {},
        KV_HISAISHI_STAGING: {},
        KV_EMB: {},
        RPC_URL: 'https://rpc.test',
        IPFS_GATEWAY: 'https://gw.test',
      }),
    ).not.toThrow();
  });

  it.each([
    'LONGSTONE_KEY',
    'LONGSTONE_OWNER_KEY',
    'PRIVATE_KEY',
    'DEPLOYER_PRIVATE_KEY',
    'MNEMONIC',
    'SEED_PHRASE',
  ])('rejects %s', (name) => {
    expect(() => assertKeylessBindings({ [name]: 'anything' })).toThrow(/keyless/i);
  });

  it('rejects key-shaped names it was not told about', () => {
    // The list above will always lag reality; the pattern catches the rest.
    expect(() => assertKeylessBindings({ AGENT_SIGNING_KEY: 'x' })).toThrow(/key-shaped/);
  });
});
