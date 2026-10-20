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
    ipfsGateway: env.IPFS_GATEWAY,
    pinataJwt: env.PINATA_JWT,
  });

  const app = createApp(handle);
  serve({ fetch: app.fetch, port }, (info) => {
    // Facts only; no secrets, no key material (the gateway has none).
    console.log(`hisaishi-local listening on http://127.0.0.1:${info.port}`);
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
