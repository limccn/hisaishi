/**
 * Pin adapters (design §5).
 *
 * Production: Pinata. Dev: a deterministic offline adapter that emits
 * `cidV1RawFromDigest(sha256(bytes))`, so the CID has the same shape as a real
 * one and tests need no network (R11).
 *
 * The stored CID is always the backend's answer. The integrity roots are
 * computed by `@menhir/core` from the bytes before pinning and are never taken
 * from the backend (D-9).
 */

import { cidDigest, cidV1RawFromDigest } from '@menhir/core';

import type { PinPort } from '../core/contract.js';

/** Offline, deterministic, zero network. Used by tests and by `DEV_MODE`. */
export function createDevPin(): PinPort {
  return {
    async pin(bytes: Uint8Array): Promise<{ cid: string }> {
      return { cid: cidV1RawFromDigest(cidDigest(bytes)) };
    },
  };
}

interface PinataResponse {
  IpfsHash?: string;
  error?: unknown;
}

/** Pinata `pinFileToIPFS` with raw bytes. Requires `PINATA_JWT`. */
export function createPinataPin(jwt: string, timeoutMs = 20_000): PinPort {
  return {
    async pin(bytes: Uint8Array): Promise<{ cid: string }> {
      const form = new FormData();
      // A File is required for multipart; the name is metadata only.
      // Copy into a fresh ArrayBuffer: `Uint8Array<ArrayBufferLike>` is not
      // assignable to BlobPart under TS 7 (SharedArrayBuffer is excluded).
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      form.append('file', new Blob([copy]), 'memory.bin');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwt}` },
          body: form,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        // The route turns this into PIN_FAILED (502) and writes nothing.
        throw new Error(`pinata returned ${response.status}`);
      }
      const json = (await response.json()) as PinataResponse;
      if (typeof json.IpfsHash !== 'string') {
        throw new Error('pinata response had no IpfsHash');
      }
      return { cid: json.IpfsHash };
    },
  };
}

/** Pick the adapter from configuration; dev is the default when unkeyed. */
export function createPin(pinataJwt: string | undefined): PinPort {
  return pinataJwt === undefined || pinataJwt === '' ? createDevPin() : createPinataPin(pinataJwt);
}
