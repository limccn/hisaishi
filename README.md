# hisaishi

Keyless memory gateway for MemoryOverEth. It owns the off-chain half of the
pipeline — staging, deduplication, pinning, batch construction, anchoring
confirmation — and **never holds a wallet key**.

Signing belongs to [longstone](../longstone); hisaishi only prepares.

## Two forms, one contract

| Form | Runtime | Status |
|---|---|---|
| **F1 local** | Node 24 + `node:sqlite` | **implemented** — M1 primary |
| **F2 remote** | Cloudflare Workers + D1 + KV | **deferred** — see below |

Both forms expose the same HTTP JSON routes and the same error codes. F1 can run
standalone (`hisaishi-local`) or embedded in longstone's process via
`createGateway()`.

> **F2 is deferred, not partial.** No Workers implementation exists. It trails
> F1 landfall by design (it needs a Workers Paid plan and Cloudflare
> credentials); the deferral is recorded in the task PRD with a resume
> condition rather than left implicit.

## Routes

| Route | Behaviour |
|---|---|
| `POST /v1/memories` | recompute `keccak(JCS(content))`, reject on mismatch **before** any pin or write; dedup by `(owner, contentHash)` |
| `POST /v1/batches/build` | staged rows → unsigned commitments with **placeholder** `prev/blockHeight/signer`, mark `batched` |
| `POST /v1/batches/confirm` | **one** receipt call; `status: anchored \| rejected \| pending` |
| `GET /v1/memories` | staging rows for one owner |
| `GET /v1/content` | pinned bytes via the dedicated gateway, cache-backed |

Error codes and their HTTP status live in one table (`src/core/errors.ts`) so a
snapshot test pins the mapping rather than each handler's memory of it.

## Run F1

```powershell
pnpm install
pnpm build

$env:RPC_URL = 'https://sepolia.base.org'
$env:IPFS_GATEWAY = 'https://your-dedicated-gateway.example'
$env:HISAISHI_DB_PATH = '.longstone/hisaishi.db'
pnpm dev          # http://127.0.0.1:8787
```

`PINATA_JWT` is optional: without it the gateway uses a deterministic offline
pin adapter (same CID shape, no network), which is what the tests use.

**No wallet key belongs in this environment.** `readLocalEnv` rejects any
key-shaped variable — `LONGSTONE_KEY`, `PRIVATE_KEY`, `MNEMONIC`, and by pattern
anything matching `private_key`/`seed_phrase`/`signing_key`. The type has no
field to put one in.

### Embedded

```ts
import { createGateway } from '@hisaishi/gateway/local';

const { handle } = await createGateway({
  dbPath: '.longstone/hisaishi.db',
  rpcUrl: 'https://sepolia.base.org',
  ipfsGateway: 'https://your-dedicated-gateway.example',
});

const result = await handle.stage({
  owner, content, contentHash, tags: ['layer:deep'],
});
// result.ok ? result.value : result.error.code
```

The handle returns a discriminated `GatewayResult` — the same shape the HTTP
layer produces, so a caller never carries two error models.

## Storage

One SQLite file holds everything:

```sql
CREATE TABLE memories (
  cid TEXT NOT NULL, content_hash TEXT NOT NULL, cid_digest TEXT NOT NULL,
  owner TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'staged',
  batch_id TEXT, tx_hash TEXT, batch_json TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (owner, content_hash)   -- not `cid`
);
```

`(owner, content_hash)` is the primary key because identical bytes produce one
CID: a `cid` key silently drops a second owner's row. There is no separate
dedup table — this index *is* the dedup lookup.

WAL and `busy_timeout=5000` are enabled for the embedded case, where longstone
shares the file.

## Tests

```powershell
pnpm test        # 57 tests
pnpm typecheck
```

The shared contract suite runs twice: once on an in-memory harness, once on the
real `node:sqlite` adapter. Running both is what makes "the forms share a
contract" a test rather than an assumption — and the second run is what caught
the suite asserting against the harness's internal store instead of the adapter.

## Known limits (M1)

- F2 not implemented (Workers/D1/KV).
- `/v1/content` does not verify fetched bytes against `cid_digest` before
  caching; clients verify both digests downstream.
- `/v1/memories` has no cursor pagination.
- Concurrency stronger than WAL + one writer per process is out of scope.
