/**
 * URL redaction for the gateway error surface (L-1).
 *
 * Upstream error messages (RPC providers, Pinata, the content gateway) may
 * embed the full request URL, including userinfo and query tokens. Responses
 * carry fixed text; these helpers keep the host in server logs without the
 * credential-bearing parts.
 */

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;

/** Keep `scheme://host[:port]`; drop userinfo, path, query, and fragment. */
export function redactEndpoint(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}/<redacted>`;
  } catch {
    return '<redacted-url>';
  }
}

/** Replace every absolute URL in a free-text message. */
export function redactText(text: string): string {
  return text.replace(URL_PATTERN, (match) => redactEndpoint(match));
}

/**
 * Message of any thrown value. A catch-site logger must not throw itself: a
 * port that rejects with a string would otherwise turn a typed 502 into a 500.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
