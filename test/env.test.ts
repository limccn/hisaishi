import { describe, expect, it } from 'vitest';

import { assertDeploymentId, settingsFor } from '../src/core/settings.js';
import { readLocalEnv } from '../src/local/env.js';

const REQUIRED = {
  RPC_URL: 'https://rpc.example',
  IPFS_GATEWAY: 'https://gw.example/ipfs',
  REGISTRY_ADDRESS: `0x${'11'.repeat(20)}`,
};

describe('F1 env', () => {
  it('defaults deployment id, bind and origins', () => {
    const env = readLocalEnv(REQUIRED);
    expect(env.HISAISHI_DEPLOYMENT_ID).toBe('local');
    expect(env.HISAISHI_BIND).toBe('127.0.0.1');
    expect(env.HISAISHI_ALLOWED_ORIGINS).toEqual([]);
    expect(env.HISAISHI_ALLOW_ANY_ORIGIN).toBe(false);
  });

  it('parses origins and rejects a URL-shaped bind', () => {
    const env = readLocalEnv({
      ...REQUIRED,
      HISAISHI_ALLOWED_ORIGINS: 'https://ui.example, https://alt.example',
      HISAISHI_BIND: '127.0.0.1',
    });
    expect(env.HISAISHI_ALLOWED_ORIGINS).toEqual(['https://ui.example', 'https://alt.example']);

    expect(() => readLocalEnv({ ...REQUIRED, HISAISHI_BIND: 'http://0.0.0.0' })).toThrow(
      /must be a host/,
    );
  });

  it('rejects a key-shaped variable even with a valid config', () => {
    expect(() => readLocalEnv({ ...REQUIRED, LONGSTONE_KEY: 'x' })).toThrow(/keyless/);
  });
});

describe('deployment settings', () => {
  it('accepts a URL-safe id and rejects others', () => {
    expect(assertDeploymentId('hisaishi-prod-1')).toBe('hisaishi-prod-1');
    for (const bad of ['', 'Upper', 'has space', 'a/b', '-leading']) {
      expect(() => assertDeploymentId(bad)).toThrow(/deployment id/);
    }
    // Fail closed when the binding is missing: "undefined" must never become a
    // shared namespace.
    expect(() => assertDeploymentId(undefined)).toThrow(/deployment id/);
  });

  it('applies TTL defaults and overrides', () => {
    const settings = settingsFor('test', { batchTtlMs: 1 });
    expect(settings.batchTtlMs).toBe(1);
    expect(settings.stagingTtlMs).toBeGreaterThan(settings.batchTtlMs);
    expect(settings.deploymentId).toBe('test');
  });
});
