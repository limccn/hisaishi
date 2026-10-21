/**
 * Dedicated-gateway content fetch (M1-9).
 *
 * One configured gateway, no fallback chain, no silent substitute hosts. A
 * missing CID and an unreachable gateway are different failures and stay
 * distinguishable all the way up: the route maps `notFound` to
 * `CONTENT_NOT_FOUND` (404) and everything else to `GATEWAY_UPSTREAM` (502).
 */

import {
  buildGatewayUrl,
  classifyGatewayResponse,
  readCappedBody,
} from '../core/gateway-url.js';

export interface HisaishiClientOptions {
  ipfsGateway: string;
  timeoutMs?: number;
}

export interface HisaishiClient {
  fetchContent(cid: string): Promise<Uint8Array>;
}

/** A gateway that says "no such CID" — not an outage. */
class ContentNotFoundError extends Error {
  readonly notFound = true;
}

export function createHisaishiClient(opts: HisaishiClientOptions): HisaishiClient {
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function fetchOnce(cid: string): Promise<Response> {
    // Gateway path is `/ipfs/<cid>`: a bare `/<cid>` returns 400 from Pinata's
    // dedicated gateways (found by running with a real gateway).
    const url = buildGatewayUrl(opts.ipfsGateway, cid);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async fetchContent(cid: string): Promise<Uint8Array> {
      const response = await fetchOnce(cid);
      const outcome = await classifyGatewayResponse(response);
      if (outcome === 'notFound') {
        throw new ContentNotFoundError(`gateway reports ${cid} missing`);
      }
      if (outcome === 'invalidCid') {
        throw Object.assign(new Error(`gateway rejected cid: ${cid}`), { invalidCid: true });
      }
      if (outcome === 'upstream') {
        throw new Error(`gateway returned ${response.status} for ${cid}`);
      }
      return readCappedBody(response);
    },
  };
}
