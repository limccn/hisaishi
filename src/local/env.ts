/**
 * Typed F1 environment (design §1).
 *
 * Keyless audit: this interface has **no wallet-key field**. That is not an
 * omission to be "fixed" — hisaishi never signs (model A), so a key field here
 * would be a design violation. `assertKeylessEnv` rejects an env object that
 * carries one anyway, so the audit is executable rather than a comment.
 */

// `exactOptionalPropertyTypes` means an optional field cannot be assigned
// `undefined` explicitly, so the present-but-empty case is modelled as
// `string | undefined` on a required key.
export interface LocalEnv {
  HISAISHI_DB_PATH: string;
  RPC_URL: string;
  IPFS_GATEWAY: string;
  PINATA_JWT: string | undefined;
  PORT: string | undefined;
  DEV_MODE: string | undefined;
}

const FORBIDDEN_ENV_NAMES = [
  'LONGSTONE_KEY',
  'LONGSTONE_OWNER_KEY',
  'PRIVATE_KEY',
  'DEPLOYER_PRIVATE_KEY',
  'MNEMONIC',
  'SEED_PHRASE',
] as const;

/** Reject anything that looks like signing material. */
export function assertKeylessEnv(env: Record<string, string | undefined>): void {
  for (const name of FORBIDDEN_ENV_NAMES) {
    if (env[name] !== undefined && env[name] !== '') {
      throw new Error(
        `hisaishi is keyless (model A): ${name} must not be present in the gateway environment`,
      );
    }
  }
  // Structural check: any env var whose name suggests a key. Deliberately
  // broad — a false positive is a rename, a false negative is a leaked key.
  for (const name of Object.keys(env)) {
    if (/private[_-]?key|mnemonic|seed[_-]?phrase|signing[_-]?key/i.test(name)) {
      throw new Error(`hisaishi env contains key-shaped variable: ${name}`);
    }
  }
}

export function readLocalEnv(env: Record<string, string | undefined>): LocalEnv {
  assertKeylessEnv(env);
  const rpcUrl = env.RPC_URL;
  const ipfsGateway = env.IPFS_GATEWAY;
  if (rpcUrl === undefined || rpcUrl === '') {
    throw new Error('RPC_URL is required');
  }
  if (ipfsGateway === undefined || ipfsGateway === '') {
    throw new Error('IPFS_GATEWAY is required (dedicated gateway only — M1-9)');
  }
  return {
    HISAISHI_DB_PATH: env.HISAISHI_DB_PATH ?? '.longstone/hisaishi.db',
    RPC_URL: rpcUrl,
    IPFS_GATEWAY: ipfsGateway,
    PINATA_JWT: env.PINATA_JWT,
    PORT: env.PORT,
    DEV_MODE: env.DEV_MODE,
  };
}
