/**
 * Gateway runtime settings shared by F1 and F2.
 *
 * The deployment id is part of the capability hash, so it must be a stable,
 * URL-safe token and unique per logical deployment that shares a database.
 */

import type { GatewaySettings } from './contract.js';

export const DEPLOYMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertDeploymentId(value: string | undefined): string {
  // `undefined` would coerce to the string "undefined" and pass the pattern.
  // That fail-open would silently share a capability namespace between
  // deployments whose config is missing the var.
  if (typeof value !== 'string' || !DEPLOYMENT_ID_PATTERN.test(value)) {
    throw new Error(
      `deployment id must match ${DEPLOYMENT_ID_PATTERN.source}: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

const DAY = 24 * 60 * 60 * 1000;

export const DEFAULT_TTLS = {
  batchTtlMs: 15 * 60 * 1000,
  stagingTtlMs: 30 * DAY,
  rejectedTtlMs: 7 * DAY,
  pinTtlMs: 30 * DAY,
  sweepIntervalMs: 60 * 60 * 1000,
} as const;

export function settingsFor(
  deploymentId: string | undefined,
  overrides: Partial<GatewaySettings> = {},
): GatewaySettings {
  return {
    deploymentId: assertDeploymentId(deploymentId),
    ...DEFAULT_TTLS,
    ...overrides,
  };
}
