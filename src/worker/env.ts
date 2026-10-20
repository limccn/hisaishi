/**
 * F2 bindings (design §2).
 *
 * Keyless audit, same as F1: this interface has **no wallet-key field**, and
 * `assertKeylessBindings` rejects a bindings object that carries one anyway.
 * the gateway never signs (model A), so a key here would be a design violation.
 */

import type { D1Like, KVLike } from './adapters.js';

export interface Bindings {
  DB: D1Like;
  /** dedup:{owner}:{contentHash} → cid, plus content:{cid} bytes. */
  KV_HISAISHI_STAGING: KVLike;
  /**
   * Reserved for M2 embedding sync. Optional and unbound in M1: nothing reads
   * or writes it yet, and binding an unused namespace is cost without purpose.
   */
  KV_EMB?: KVLike | undefined;
  RPC_URL: string;
  REGISTRY_ADDRESS: `0x${string}`;
  IPFS_GATEWAY: string;
  PINATA_JWT: string | undefined;
  DEV_MODE: string | undefined;
}

const FORBIDDEN_BINDING_NAMES = [
  'LONGSTONE_KEY',
  'LONGSTONE_OWNER_KEY',
  'PRIVATE_KEY',
  'DEPLOYER_PRIVATE_KEY',
  'MNEMONIC',
  'SEED_PHRASE',
] as const;

/** Reject anything that looks like signing material. */
export function assertKeylessBindings(env: Record<string, unknown>): void {
  for (const name of FORBIDDEN_BINDING_NAMES) {
    if (env[name] !== undefined && env[name] !== '') {
      throw new Error(
        `hisaishi is keyless (model A): ${name} must not be bound to the Worker`,
      );
    }
  }
  for (const name of Object.keys(env)) {
    if (/(?:^|_)key$|private[_-]?key|mnemonic|seed[_-]?phrase|signing[_-]?key/i.test(name)) {
      throw new Error(`hisaishi Worker bindings contain key-shaped variable: ${name}`);
    }
  }
}
