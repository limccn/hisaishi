/**
 * Dedicated-gateway content fetch for F2 (M1-9).
 *
 * Same rule as F1: one configured gateway, no fallback chain. A 404 is
 * `notFound` (mapped to CONTENT_NOT_FOUND); everything else is an upstream
 * failure.
 */

import {
  buildGatewayUrl,
  classifyGatewayResponse,
  readCappedBody,
} from '../core/gateway-url.js';

export function createGatewayContentFetch(
  ipfsGateway: string,
  timeoutMs = 10_000,
): (cid: string) => Promise<Uint8Array> {
  return async (cid: string): Promise<Uint8Array> => {
    // Same `/ipfs/<cid>` rule as F1; see core/gateway-url.ts for why.
    const url = buildGatewayUrl(ipfsGateway, cid);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const outcome = await classifyGatewayResponse(response);
    if (outcome === 'notFound') {
      throw Object.assign(new Error(`gateway reports ${cid} missing at ${url}`), { notFound: true });
    }
    if (outcome === 'invalidCid') {
      throw Object.assign(new Error(`gateway rejected cid: ${cid}`), { invalidCid: true });
    }
    if (outcome === 'upstream') {
      throw new Error(`gateway returned ${response.status} for ${url}`);
    }
    return readCappedBody(response);
  };
}
