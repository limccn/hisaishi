/**
 * Pin adapter shared by both forms.
 *
 * The offline adapter is deterministic: `cidV1RawFromDigest(sha256(bytes))`.
 * That gives the same `bafkrei…` shape as production, so a test that asserts a
 * CID shape does not pass by accident on a fake.
 */

import { cidDigest, cidV1RawFromDigest } from '@menhir/core';

import type { PinPort } from '../contract.js';

export function createDevPin(): PinPort {
  return {
    async pin(bytes: Uint8Array): Promise<{ cid: string }> {
      return { cid: cidV1RawFromDigest(cidDigest(bytes)) };
    },
  };
}

interface PinataResponse {
  IpfsHash?: string;
}

export function createPinataPin(jwt: string, timeoutMs = 20_000): PinPort {
  return {
    async pin(bytes: Uint8Array): Promise<{ cid: string }> {
      const form = new FormData();
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

      if (!response.ok) throw new Error(`pinata returned ${response.status}`);
      const json = (await response.json()) as PinataResponse;
      if (typeof json.IpfsHash !== 'string') throw new Error('pinata response had no IpfsHash');
      return { cid: json.IpfsHash };
    },
  };
}

export function createMemoryPin(pinataJwt: string | undefined): PinPort {
  return pinataJwt === undefined || pinataJwt === '' ? createDevPin() : createPinataPin(pinataJwt);
}
