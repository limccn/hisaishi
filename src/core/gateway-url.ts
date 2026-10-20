/**
 * Build a content URL for a dedicated IPFS gateway.
 *
 * The gateway path convention is `/ipfs/<cid>` — Pinata's dedicated gateways
 * return **400** for a bare `/<cid>` path, and that is what a real gateway
 * actually did when this was first exercised (the code had been building
 * `<gateway>/<cid>`, and every test ran with the gateway unset).
 *
 * Accepted forms:
 *   https://gw.example                    → https://gw.example/ipfs/<cid>
 *   https://gw.example/ipfs               → https://gw.example/ipfs/<cid>
 *   https://gw.example/ipfs/{cid}         → template substitution
 *   https://gw.example/pre/{cid}/suffix   → template substitution anywhere
 *
 * A `{cid}` placeholder wins when present, so an operator with a non-standard
 * path can express it without code.
 */

const CID_PATTERN = /^[a-zA-Z0-9]+$/;

/**
 * Classify a dedicated-gateway response.
 *
 * Gateways do not agree on how to say "not pinned". Measured against Pinata's
 * dedicated gateway (2026-10-20):
 *   - a valid but unpinned CID → **403** with "does not have this content pinned"
 *   - a malformed CID          → **400** "Invalid URL"
 *   - a missing object         → **404** (the conventional answer)
 *
 * Collapsing all three into "upstream failure" makes ordinary absence look like
 * an outage and makes a client-side typo look like the gateway's fault.
 */
export type GatewayOutcome = 'ok' | 'notFound' | 'invalidCid' | 'upstream';

export async function classifyGatewayResponse(response: Response): Promise<GatewayOutcome> {
  if (response.ok) return 'ok';
  if (response.status === 404) return 'notFound';

  if (response.status === 403) {
    // Pinata's "not pinned to this account" answer. Read the body once; the
    // caller will not use it afterwards.
    const body = await response.text().catch(() => '');
    if (/pinned|does not have this content/i.test(body)) return 'notFound';
    return 'upstream';
  }

  if (response.status === 400) {
    // The gateway could not parse the CID. That is a client error, not an
    // outage — and it means our own alphanumeric check was too permissive.
    return 'invalidCid';
  }

  return 'upstream';
}

export function buildGatewayUrl(gateway: string, cid: string): string {
  if (!CID_PATTERN.test(cid)) {
    throw new Error(`invalid cid: ${cid}`);
  }

  const base = gateway.replace(/\/+$/, '');
  if (base === '') {
    throw Object.assign(new Error('no IPFS gateway configured'), { notConfigured: true });
  }

  if (base.includes('{cid}')) {
    return base.replaceAll('{cid}', encodeURIComponent(cid));
  }

  // Default to the standard path. Appending `/ipfs/<cid>` is correct for
  // Pinata and for any gateway following the IPFS path convention.
  if (base.endsWith('/ipfs')) {
    return `${base}/${encodeURIComponent(cid)}`;
  }
  return `${base}/ipfs/${encodeURIComponent(cid)}`;
}
