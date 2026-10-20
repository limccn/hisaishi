/**
 * Dedicated-gateway content fetch for F2 (M1-9).
 *
 * Same rule as F1: one configured gateway, no fallback chain. A 404 is
 * `notFound` (mapped to CONTENT_NOT_FOUND); everything else is an upstream
 * failure.
 */

export function createGatewayContentFetch(
  ipfsGateway: string,
  timeoutMs = 10_000,
): (cid: string) => Promise<Uint8Array> {
  const base = ipfsGateway.replace(/\/+$/, '');

  return async (cid: string): Promise<Uint8Array> => {
    if (!/^[a-zA-Z0-9]+$/.test(cid)) {
      throw new Error(`invalid cid: ${cid}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${base}/${encodeURIComponent(cid)}`, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 404) {
      throw Object.assign(new Error(`gateway reports ${cid} missing`), { notFound: true });
    }
    if (!response.ok) {
      throw new Error(`gateway returned ${response.status} for ${cid}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}
