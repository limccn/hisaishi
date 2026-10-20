#!/usr/bin/env node
/**
 * Deployed F2 smoke — runnable, not a set of commands to paste.
 *
 *   BASE_URL=https://hisaishi.<sub>.workers.dev node scripts/e2e-worker.mjs
 *
 * Exercises the contract the deployed Worker must satisfy: stage, dedup,
 * build (placeholders + bytes32 tagLists), confirm-pending, and the three
 * content outcomes (pinned / unpinned / malformed). Uses `@menhir/core` to
 * produce the canonical bytes and hashes, so the request body is byte-exact —
 * the shell mangling CJK inline is a real trap this avoids.
 *
 * Exits non-zero on the first mismatch. No credentials required; it never
 * signs or spends gas.
 */
import { canonicalBytes, cidDigest, contentHash, parseMemoryContent } from '@menhir/core';

const BASE = (process.env.BASE_URL ?? '').replace(/\/+$/, '');
if (BASE === '') {
  console.error('BASE_URL is required, e.g. https://hisaishi.example.workers.dev');
  process.exit(2);
}

const OWNER = `0x${'66'.repeat(20)}`;
const TX_HASH = `0x${'ab'.repeat(32)}`;

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

async function post(path, body) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function main() {
  console.log(`target ${BASE}`);

  const content = parseMemoryContent({
    text: `deployed smoke ${new Date().toISOString()}`,
    format: 'text.v0',
  });
  const hash = contentHash(content);
  const digest = cidDigest(canonicalBytes(content));

  // 1. stage
  const staged = await post('/v1/memories', {
    owner: OWNER,
    content,
    contentHash: hash,
    tags: ['layer:deep'],
  });
  const stagedBody = await staged.json();
  check('stage 200', staged.status === 200, JSON.stringify(stagedBody));
  check('stage returns a cid', typeof stagedBody.cid === 'string' && stagedBody.cid.length > 10);
  check('stage echoes the digest', stagedBody.cidDigest === digest);

  // 2. dedup: same bytes → same cid, no second pin
  const again = await post('/v1/memories', {
    owner: OWNER,
    content,
    contentHash: hash,
    tags: ['layer:deep'],
  });
  const againBody = await again.json();
  check('dedup returns the same cid', againBody.cid === stagedBody.cid);

  // 3. build
  const built = await post('/v1/batches/build', { owner: OWNER });
  const builtBody = await built.json();
  check('build 200', built.status === 200, JSON.stringify(builtBody));
  const commitment = builtBody.commitments?.[0];
  check('build emits a zero signer placeholder', commitment?.signer === `0x${'0'.repeat(40)}`);
  check('build emits blockHeight 0', commitment?.blockHeight === '0');
  check(
    'tagLists are bytes32',
    /^0x[0-9a-f]{64}$/.test(String(builtBody.tagLists?.[0]?.[0] ?? '')),
  );

  // 4. confirm: unmined tx is pending, no write
  const pending = await post('/v1/batches/confirm', { owner: OWNER, txHash: TX_HASH });
  const pendingBody = await pending.json();
  check('confirm pending is 202', pending.status === 202);
  check("confirm pending says 'pending'", pendingBody.status === 'pending');

  // 5. content outcomes
  const pinned = await fetch(`${BASE}/v1/content?cid=${encodeURIComponent(stagedBody.cid)}`);
  check('content for a freshly pinned cid is 200', pinned.status === 200, `status ${pinned.status}`);

  const unpinned = await fetch(
    `${BASE}/v1/content?cid=bafkreih45p25diqccyx44fl27umvibd74kmnp7nrnybgqfh4l6zmwgwsvq`,
  );
  check('unpinned cid is 404 CONTENT_NOT_FOUND', unpinned.status === 404, `status ${unpinned.status}`);

  const malformed = await fetch(`${BASE}/v1/content?cid=notacid`);
  check('malformed cid is 400', malformed.status === 400, `status ${malformed.status}`);

  // 6. error surface
  const badOwner = await fetch(`${BASE}/v1/memories`);
  check('missing owner is 400 INVALID_HEX', badOwner.status === 400, `status ${badOwner.status}`);

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
