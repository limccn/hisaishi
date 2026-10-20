/**
 * Dedicated-gateway content fetch (M1-9).
 *
 * One configured gateway, no fallback chain, no silent substitute hosts. A
 * missing CID and an unreachable gateway are different failures and stay
 * distinguishable all the way up: the route maps `notFound` to
 * `CONTENT_NOT_FOUND` (404) and everything else to `GATEWAY_UPSTREAM` (502).
 */

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
  const base = opts.ipfsGateway.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function fetchOnce(cid: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${base}/${encodeURIComponent(cid)}`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async fetchContent(cid: string): Promise<Uint8Array> {
      if (!/^[a-zA-Z0-9]+$/.test(cid)) {
        throw new Error(`invalid cid: ${cid}`);
      }
      const response = await fetchOnce(cid);
      if (response.status === 404) {
        throw new ContentNotFoundError(`gateway reports ${cid} missing`);
      }
      if (!response.ok) {
        throw new Error(`gateway returned ${response.status} for ${cid}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
