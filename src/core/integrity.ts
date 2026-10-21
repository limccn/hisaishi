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
} from '@limccn/menhir-core';

import { GatewayError, fromCoreError } from './errors.js';

export interface VerifiedContent {
  content: MemoryContent;
  bytes: Uint8Array;
  contentHash: `0x${string}`;
  cidDigest: `0x${string}`;
  tagBytes32: `0x${string}`[];
}

const MAX_CONTENT_BYTES = 16 * 1024;
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_META_BYTES = 8 * 1024;
const MAX_REFS = 16;
const MAX_REF_BYTES = 512;
const MAX_TAGS = 16;

const encoder = new TextEncoder();

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

  // Tags are untrusted input too: the type says string[], the wire does not.
  if (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== 'string')) {
    throw new GatewayError('SCHEMA_VIOLATION', 'tags must be an array of strings');
  }
  if (input.tags.length > MAX_TAGS) {
    throw new GatewayError('SCHEMA_VIOLATION', `at most ${MAX_TAGS} tags are allowed`);
  }

  try {
    content = parseMemoryContent(input.content);
    bytes = canonicalBytes(content);
    tagBytes32 = input.tags.map((tag) => tagToBytes32(tag));
  } catch (error) {
    throw fromCoreError(error);
  }

  if (encoder.encode(content.text).byteLength > MAX_TEXT_BYTES) {
    throw new GatewayError('CONTENT_TOO_LARGE', `text exceeds ${MAX_TEXT_BYTES} bytes`);
  }
  if (content.meta !== undefined) {
    // Measure the canonical meta member without the fixed wrapper around it.
    const withMeta = canonicalBytes({ text: 'x', format: 'text.v0', meta: content.meta });
    const empty = canonicalBytes({ text: 'x', format: 'text.v0', meta: {} });
    // `{}` contributes two bytes; remove them from the delta.
    if (withMeta.byteLength - empty.byteLength + 2 > MAX_META_BYTES) {
      throw new GatewayError('CONTENT_TOO_LARGE', `meta exceeds ${MAX_META_BYTES} bytes`);
    }
  }
  if (content.refs !== undefined) {
    if (content.refs.length > MAX_REFS) {
      throw new GatewayError('SCHEMA_VIOLATION', `at most ${MAX_REFS} refs are allowed`);
    }
    for (const ref of content.refs) {
      if (encoder.encode(ref).byteLength > MAX_REF_BYTES) {
        throw new GatewayError('CONTENT_TOO_LARGE', `a ref exceeds ${MAX_REF_BYTES} bytes`);
      }
    }
  }
  if (bytes.byteLength > MAX_CONTENT_BYTES) {
    throw new GatewayError('CONTENT_TOO_LARGE', `content exceeds ${MAX_CONTENT_BYTES} bytes`);
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
