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
  REGISTRY_ADDRESS: `0x${string}`;
  IPFS_GATEWAY: string;
  PINATA_JWT: string | undefined;
  PORT: string | undefined;
  DEV_MODE: string | undefined;
  /** Stable per-deployment id; part of the capability hash. */
  HISAISHI_DEPLOYMENT_ID: string;
  /** Bind host; loopback by default. */
  HISAISHI_BIND: string;
  /** Comma-separated browser origins; loopback is always allowed. */
  HISAISHI_ALLOWED_ORIGINS: string[];
  HISAISHI_ALLOW_ANY_ORIGIN: boolean;
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
    if (/(?:^|_)key$|private[_-]?key|mnemonic|seed[_-]?phrase|signing[_-]?key/i.test(name)) {
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
  const registryAddress = env.REGISTRY_ADDRESS;
  if (registryAddress === undefined || !/^0x[0-9a-fA-F]{40}$/.test(registryAddress)) {
    throw new Error('REGISTRY_ADDRESS is required (20-byte hex)');
  }
  const bind = env.HISAISHI_BIND ?? '127.0.0.1';
  if (!/^[A-Za-z0-9.:\-[\]]+$/.test(bind)) {
    throw new Error(`HISAISHI_BIND must be a host, not a URL: ${bind}`);
  }
  return {
    HISAISHI_DB_PATH: env.HISAISHI_DB_PATH ?? '.longstone/hisaishi.db',
    RPC_URL: rpcUrl,
    REGISTRY_ADDRESS: registryAddress as `0x${string}`,
    IPFS_GATEWAY: ipfsGateway,
    PINATA_JWT: env.PINATA_JWT,
    PORT: env.PORT,
    DEV_MODE: env.DEV_MODE,
    HISAISHI_DEPLOYMENT_ID: env.HISAISHI_DEPLOYMENT_ID ?? 'local',
    HISAISHI_BIND: bind,
    HISAISHI_ALLOWED_ORIGINS: (env.HISAISHI_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
    HISAISHI_ALLOW_ANY_ORIGIN: env.HISAISHI_ALLOW_ANY_ORIGIN === 'true',
  };
}
