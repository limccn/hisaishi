// Bundled entry for the workerd smoke. Imports @menhir/core exactly as the
// Worker does, so a Node-only dependency in core fails here rather than at
// deploy time.
import {
  canonicalBytes,
  contentHash,
  cidDigest,
  tagToBytes32,
  commitmentHash,
  ZERO_BYTES32,
} from '@menhir/core';

export default {
  async fetch() {
    const content = { text: '用户偏好：Python 用于脚本 🙂', format: 'text.v0' };
    const bytes = canonicalBytes(content);
    const hash = contentHash(content);
    const digest = cidDigest(bytes);
    const tag = tagToBytes32('layer:deep');
    const ch = commitmentHash({
      owner: '0x' + '11'.repeat(20),
      contentHash: hash,
      cidDigest: digest,
      signer: '0x' + '11'.repeat(20),
      blockHeight: 1n,
      op: 0,
      prev: ZERO_BYTES32,
    });
    return Response.json({ hash, digest, tag, ch, bytes: bytes.length });
  },
};
