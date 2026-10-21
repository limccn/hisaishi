import { describe, expect, it } from 'vitest';
import {
  buildGatewayUrl,
  classifyGatewayResponse,
  readCappedBody,
} from '../src/core/gateway-url.js';

describe('dedicated gateway URL', () => {
  it('appends /ipfs for a bare host', () => {
    expect(buildGatewayUrl('https://gw.example', 'bafkrei')).toBe('https://gw.example/ipfs/bafkrei');
    expect(buildGatewayUrl('https://gw.example/', 'bafkrei')).toBe('https://gw.example/ipfs/bafkrei');
  });

  it('does not double /ipfs', () => {
    expect(buildGatewayUrl('https://gw.example/ipfs', 'bafkrei')).toBe('https://gw.example/ipfs/bafkrei');
  });

  it('substitutes a {cid} template', () => {
    expect(buildGatewayUrl('https://gw.example/p/{cid}/raw', 'abc')).toBe('https://gw.example/p/abc/raw');
  });

  it('rejects a malformed cid and an empty gateway', () => {
    expect(() => buildGatewayUrl('https://gw.example', '../etc')).toThrow(/invalid cid/);
    expect(() => buildGatewayUrl('', 'bafkrei')).toThrow(/no IPFS gateway/);
  });

  it('regression: a bare <host>/<cid> returns 400 at a Pinata gateway', () => {
    // Documented here because it was the actual failure: the old code built
    // `${gateway}/${cid}` and Pinata answered 400.
    expect(buildGatewayUrl('https://turquoise.gw', 'QmX')).toContain('/ipfs/QmX');
  });
});

describe('gateway response classification', () => {
  it('reads the conventional 404 as not found', async () => {
    expect(await classifyGatewayResponse(new Response('', { status: 404 }))).toBe('notFound');
  });

  it('reads Pinata 403 "not pinned" as not found', async () => {
    // Measured against the real gateway: a valid-but-unpinned CID is 403.
    const body = 'The owner of this gateway does not have this content pinned to their Pinata account.';
    expect(await classifyGatewayResponse(new Response(body, { status: 403 }))).toBe('notFound');
  });

  it('reads 403 without a pinning message as upstream', async () => {
    expect(await classifyGatewayResponse(new Response('forbidden', { status: 403 }))).toBe('upstream');
  });

  it('reads 400 as a client-side CID problem, not an outage', async () => {
    expect(await classifyGatewayResponse(new Response('Invalid URL', { status: 400 }))).toBe('invalidCid');
  });

  it('reads 5xx as upstream', async () => {
    expect(await classifyGatewayResponse(new Response('', { status: 503 }))).toBe('upstream');
  });
});

describe('streaming content cap', () => {
  it('accepts a body at the cap', async () => {
    const bytes = new Uint8Array(5).fill(1);
    expect(await readCappedBody(new Response(bytes), 5)).toEqual(bytes);
  });

  it('cancels a stream that crosses the cap', async () => {
    const bytes = new Uint8Array(10).fill(1);
    await expect(readCappedBody(new Response(bytes), 5)).rejects.toMatchObject({
      tooLarge: true,
    });
  });

  it('rejects a declared length above the cap before reading', async () => {
    const response = new Response(new Uint8Array(2), {
      headers: { 'content-length': '99' },
    });
    await expect(readCappedBody(response, 5)).rejects.toMatchObject({ tooLarge: true });
  });
});
