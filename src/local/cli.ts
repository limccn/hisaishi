#!/usr/bin/env node
/**
 * `hisaishi-local` — standalone F1 server.
 *
 * Reads its configuration from the environment (never from a wallet key: the
 * gateway is keyless, and `readLocalEnv` enforces that).
 */

import { serve } from '@hono/node-server';

import { createGateway } from './gateway.js';
import { readLocalEnv } from './env.js';
import { createApp } from './serve.js';

async function main(): Promise<void> {
  const env = readLocalEnv(process.env);
  const port = Number(env.PORT ?? 8787);

  const { handle } = await createGateway({
    dbPath: env.HISAISHI_DB_PATH,
    rpcUrl: env.RPC_URL,
    registryAddress: env.REGISTRY_ADDRESS,
    ipfsGateway: env.IPFS_GATEWAY,
    pinataJwt: env.PINATA_JWT,
    devMode: env.DEV_MODE === 'true',
    deploymentId: env.HISAISHI_DEPLOYMENT_ID,
  });

  const app = createApp(handle, {
    allowedOrigins: env.HISAISHI_ALLOWED_ORIGINS,
    allowAnyOrigin: env.HISAISHI_ALLOW_ANY_ORIGIN,
  });
  serve({ fetch: app.fetch, port, hostname: env.HISAISHI_BIND }, (info) => {
    // Facts only; no secrets, no key material (the gateway has none).
    console.log(`hisaishi-local listening on http://${info.address}:${info.port}`);
    if (env.HISAISHI_BIND !== '127.0.0.1' && env.HISAISHI_BIND !== 'localhost') {
      console.warn(
        `WARNING: bound to ${env.HISAISHI_BIND}; the gateway has no authentication. ` +
          'Use 127.0.0.1 unless you have added rate limits and an authenticated proxy.',
      );
    }
    console.log(`  deployment  ${env.HISAISHI_DEPLOYMENT_ID}`);
    console.log(`  db          ${env.HISAISHI_DB_PATH}`);
    console.log(`  rpc         ${env.RPC_URL}`);
    console.log(`  gateway     ${env.IPFS_GATEWAY}`);
    console.log(`  pin         ${env.PINATA_JWT === undefined ? 'dev (offline)' : 'pinata'}`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
