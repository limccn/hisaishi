/**
 * F1 entry point — `createGateway(opts)`.
 *
 * This file owns the handle (R9): `serve.ts` only maps a `GatewayResult` to
 * `{status, body}`. It also owns the SQLite connection, so embedded consumers
 * (longstone in-process) get one writer per process rather than one per call.
 *
 * Keyless by construction: `LocalGatewayOptions` has no key-shaped field. The
 * type-level audit in design §1 is this absence — there is nothing to strip,
 * because there is nothing that can hold a private key.
 */

import { createGatewayHandle, type GatewayHandle } from '../core/gateway.js';
import type { ContentCachePort, DocStorePort, PinPort, Ports, RpcPort } from '../core/contract.js';
import { openDatabase, SqliteContentCache, SqliteDocStore } from './sqlite.js';
import { createHisaishiClient } from './hisaishi-client.js';

import type { DatabaseSync } from 'node:sqlite';

export interface LocalGatewayOptions {
  /** `:memory:` is valid and is what the harness uses. */
  dbPath: string;
  rpcUrl: string;
  /** Dedicated IPFS gateway (M1-9). Never a public fallback. */
  ipfsGateway: string;
  /** When absent, pinning falls back to the offline dev adapter (R11). */
  pinataJwt?: string | undefined;
  /** Overrides for tests; in production the defaults below are used. */
  docStore?: DocStorePort | undefined;
  contentCache?: ContentCachePort | undefined;
  pin?: PinPort | undefined;
  rpc?: RpcPort | undefined;
  now?: (() => number) | undefined;
}

export interface OpenGateway {
  handle: GatewayHandle;
  db: DatabaseSync;
}

/** Build every F1 port over one SQLite connection. */
export async function createGateway(opts: LocalGatewayOptions): Promise<OpenGateway> {
  const db = opts.dbPath === ':memory:' ? openMemoryDatabase() : openDatabase(opts.dbPath);

  const docStore = opts.docStore ?? new SqliteDocStore(db);
  const contentCache = opts.contentCache ?? new SqliteContentCache(db);
  const rpc = opts.rpc ?? (await import('./rpc.js')).createReceiptRpc(opts.rpcUrl);
  const pin = opts.pin ?? (await import('./pin.js')).createPin(opts.pinataJwt);

  const client = createHisaishiClient({
    ipfsGateway: opts.ipfsGateway,
  });

  const ports: Ports = {
    docStore,
    contentCache,
    pin,
    rpc,
    fetchContent: (cid) => client.fetchContent(cid),
    now: opts.now ?? (() => Date.now()),
  };

  const handle = createGatewayHandle(ports, async () => {
    db.close();
  });

  return { handle, db };
}

function openMemoryDatabase(): DatabaseSync {
  // `openDatabase` takes a path; `:memory:` is a valid SQLite path and keeps the
  // same pragmas/DDL path exercised by production rather than a second setup.
  return openDatabase(':memory:');
}
