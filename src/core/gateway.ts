/**
 * The typed handle (design §0, R9).
 *
 * One discriminated result shared by the embedded handle and the HTTP routes.
 * longstone consumes either transport without a second error model: `ok:false`
 * carries the same `code` a 4xx/5xx body would.
 */

import type { MemoryRow } from './contract.js';
import { MAX_BODY_BYTES, MAX_CONTENT_BYTES } from './limits.js';
import { GatewayError } from './errors.js';
import type { Ports } from './contract.js';
import {
  build,
  confirm,
  content,
  contentByDigest,
  list,
  stage,
  type BuildRequest,
  type BuildResponse,
  type ConfirmRequest,
  type ConfirmResponse,
  type ListRequest,
  type StageRequest,
  type StageResponse,
} from './routes.js';

export type GatewayResult<T> =
  | { ok: true; status: number; value: T }
  | { ok: false; status: number; error: { code: string; detail?: string } };

export interface GatewayHandle {
  stage(req: StageRequest): Promise<GatewayResult<StageResponse>>;
  build(req: BuildRequest): Promise<GatewayResult<BuildResponse>>;
  confirm(req: ConfirmRequest): Promise<GatewayResult<ConfirmResponse>>;
  list(req: ListRequest): Promise<GatewayResult<MemoryRow[]>>;
  content(cid: string): Promise<GatewayResult<Uint8Array>>;
  /** Digest → pinned CID bridge for verifiers that know only chain state. */
  contentByDigest(cidDigest: string): Promise<GatewayResult<{ cid: string; bytes: Uint8Array }>>;
  /** Operator marker; not a handshake and clients must not gate on it. */
  health(): {
    version: string;
    capabilities: true;
    deploymentId: string;
    sweep: true;
    limits: { bodyBytes: number; contentBytes: number };
  };
  close(): Promise<void>;
}

/** Wrap a route call so every failure becomes a typed result, never a throw. */
async function attempt<T>(fn: () => Promise<T>, successStatus = 200): Promise<GatewayResult<T>> {
  try {
    const value = await fn();
    // A pending confirm is a 202, not a 200 — the caller retries.
    const status =
      typeof value === 'object' &&
      value !== null &&
      (value as { status?: string }).status === 'pending'
        ? 202
        : successStatus;
    return { ok: true, status, value };
  } catch (error) {
    if (error instanceof GatewayError) {
      return {
        ok: false,
        status: error.status,
        error:
          error.detail === undefined
            ? { code: error.code }
            : { code: error.code, detail: error.detail },
      };
    }
    return { ok: false, status: 500, error: { code: 'INTERNAL', detail: (error as Error).message } };
  }
}

/** Build a handle over any port implementation (F1, F2, or a test harness). */
export function createGatewayHandle(ports: Ports, close: () => Promise<void> = async () => {}): GatewayHandle {
  return {
    stage: (req) => attempt(() => stage(ports, req)),
    build: (req) => attempt(() => build(ports, req)),
    confirm: (req) => attempt(() => confirm(ports, req)),
    list: (req) => attempt(() => list(ports, req)),
    content: (cid) => attempt(() => content(ports, cid)),
    contentByDigest: (cidDigest) => attempt(() => contentByDigest(ports, cidDigest)),
    health: () => ({
      version: '0.1.1',
      capabilities: true,
      deploymentId: ports.settings.deploymentId,
      sweep: true,
      limits: { bodyBytes: MAX_BODY_BYTES, contentBytes: MAX_CONTENT_BYTES },
    }),
    close,
  };
}
