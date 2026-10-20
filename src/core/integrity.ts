/**
 * The integrity gate (design §4, menhir §3.2/§3.3).
 *
 * Two independent roots over the *same* canonical bytes:
 *   contentHash = keccak256(bytes)   — EVM-native
 *   cidDigest   = sha256(bytes)      — retrieval layer (D-9)
 *
 * The gate recomputes the keccak root from the submitted content and refuses a
 * mismatch **before** any pin or DB write. That ordering is the point: a
 * mismatched hash must not leave a pinned artifact behind, or the gateway has
 * published content it could not verify.
 */

import {
  canonicalBytes,
  cidDigest as coreCidDigest,
  contentHash as coreContentHash,
  parseMemoryContent,
  tagToBytes32,
  type MemoryContent,
} from '@menhir/core';

import { GatewayError, fromCoreError } from './errors.js';

export interface VerifiedContent {
  content: MemoryContent;
  bytes: Uint8Array;
  contentHash: `0x${string}`;
  cidDigest: `0x${string}`;
  tagBytes32: `0x${string}`[];
}

/**
 * Validate + recompute. Throws a `GatewayError` on any failure — the caller
 * does not need to translate core errors itself.
 */
export function verifyContent(input: {
  content: unknown;
  contentHash: string;
  tags: string[];
}): VerifiedContent {
  let content: MemoryContent;
  let bytes: Uint8Array;
  let tagBytes32: `0x${string}`[];

  try {
    content = parseMemoryContent(input.content);
    bytes = canonicalBytes(content);
    tagBytes32 = input.tags.map((tag) => tagToBytes32(tag));
  } catch (error) {
    throw fromCoreError(error);
  }

  // Hex shape first: comparing a malformed hash to a computed one would always
  // mismatch, and reporting INVALID_HASH for a typo'd hex string sends the
  // caller looking for a canonicalization bug.
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.contentHash)) {
    throw new GatewayError('INVALID_HEX', 'contentHash must be 32-byte hex');
  }

  const contentHash = coreContentHash(content);
  if (contentHash.toLowerCase() !== input.contentHash.toLowerCase()) {
    throw new GatewayError(
      'INVALID_HASH',
      `recomputed ${contentHash} does not match submitted ${input.contentHash}`,
    );
  }

  return { content, bytes, contentHash, cidDigest: coreCidDigest(bytes), tagBytes32 };
}
