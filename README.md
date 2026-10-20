# hisaishi

Keyless memory gateway for MemoryOverEth. It owns the off-chain half of the
pipeline — staging, deduplication, pinning, batch construction, anchoring
confirmation — and **never holds a wallet key**.

Signing belongs to [longstone](../longstone); hisaishi only prepares.

## Two forms, one contract

| Form | Runtime | Status |
|---|---|---|
| **F1 local** | Node 24 + `node:sqlite` | **implemented** — M1 primary |
| **F2 remote** | Cloudflare Workers + D1 + KV | **implemented and deployed** |

Both forms expose the same HTTP JSON routes and the same error codes. F1 can run
standalone (`hisaishi-local`) or embedded in longstone's process via
`createGateway()`.

**Parity is tested, not asserted.** One shared contract suite runs on three
backends: in-memory ports, the real `node:sqlite` adapter, and real D1 + KV from
miniflare. A behaviour that differs between forms fails that suite.

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

## Deploy F2 (Cloudflare Workers)

F2 needs a Workers **Paid** plan: the Free tier allows 1,000 KV writes/day, which
staging alone exhausts (pitfall M1-11). There is no code workaround — the
deployed form simply stops working past that limit.

### One-time setup

```powershell
# 1. Authenticate (OAuth, not an API token — nothing to leak into shell history)
npx wrangler login

# 2. Provision storage
npx wrangler d1 create hisaishi-staging
npx wrangler kv namespace create KV_HISAISHI_STAGING
```

`wrangler d1 create` suggests a binding name derived from the database name
(e.g. `hisaishi_staging`). **The binding is yours to choose and must be `DB`** —
that is what the Worker reads (`env.DB`) and what the design's bindings table
says. Put the returned `database_id` and KV `id` into `wrangler.jsonc`:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "hisaishi-staging",
    "database_id": "<uuid>", "migrations_dir": "migrations" }
],
"kv_namespaces": [
  { "binding": "KV_HISAISHI_STAGING", "id": "<id>" }
]
```

`KV_EMB` is reserved for M2 embedding sync. It is declared **optional** in the
`Bindings` type and deliberately unbound in M1 — nothing reads or writes it, and
a placeholder id would fail the deploy.

### Apply the schema, set secrets, deploy

```powershell
# 3. Schema (must match F1's DDL — a test asserts it does)
npx wrangler d1 migrations apply hisaishi-staging --remote

# 4. Secrets — never in wrangler.jsonc, never in a committed file
npx wrangler secret put RPC_URL          # e.g. https://sepolia.base.org
npx wrangler secret put IPFS_GATEWAY     # dedicated gateway ONLY (M1-9)
npx wrangler secret put PINATA_JWT       # optional; omit for the offline adapter

# 5. Deploy
pnpm build
npx wrangler deploy
```

`IPFS_GATEWAY` is required for `/v1/content`. Give it a **dedicated** gateway
(e.g. `https://<name>.mypinata.cloud`); the code appends `/ipfs/<cid>`, which is
the path convention Pinata's gateways require. Leaving it empty does not fall
back to a public gateway — the route fails with `GATEWAY_UPSTREAM`, by design.
Never substitute `ipfs.io` (M1-9).

**`PINATA_JWT` is required unless `DEV_MODE=true`.** Without a JWT and without
dev mode the Worker refuses to construct, because a deterministic offline CID
for bytes that were never stored lets stage report success for content that can
never be fetched (review R17). With `DEV_MODE=true` the offline adapter is used
deliberately — fine for local tests, never for a deployment that anchors memory.

`REGISTRY_ADDRESS` is also required: confirm only trusts `MemoryCommitted` logs
emitted by that contract. Any contract can emit the same signature.

### Deployed smoke

The smoke is a script, so it is reproducible:

```powershell
$env:BASE_URL = "https://<worker>.<subdomain>.workers.dev"
node scripts/e2e-worker.mjs
```

It checks stage, dedup, build placeholders, confirm-pending, and the three
content outcomes (pinned 200 / unpinned 404 / malformed 400). Exit code is
non-zero on the first mismatch. It needs no credentials and spends no gas.

The equivalent hand-run commands:

```powershell
$BASE = "https://<worker>.<subdomain>.workers.dev"
$OWNER = "0x" + ("11" * 20)

# integrity gate: a wrong hash is rejected and nothing is written
curl.exe -s -X POST "$BASE/v1/memories" -H "content-type: application/json" `
  -d "{`"owner`":`"$OWNER`",`"content`":{`"text`":`"x`",`"format`":`"text.v0`"},`"contentHash`":`"0x$('00'*32)`",`"tags`":[]}"

# staging → build → list
curl.exe -s "$BASE/v1/memories?owner=$OWNER"
curl.exe -s -X POST "$BASE/v1/batches/build" -H "content-type: application/json" -d "{`"owner`":`"$OWNER`"}"
```

A healthy Worker answers typed errors (`INVALID_HEX`, `INVALID_HASH`,
`SCHEMA_VIOLATION`) with the matching status — never a stack trace and never a
500. A 500 means the Worker threw before reaching the shared routes.

> **Shell encoding trap.** Passing CJK content inline (`-d "{...}"`) can mangle
> the bytes before curl ever sends them, producing a genuine-looking
> `INVALID_HASH` from a correct Worker. Write the body to a file with a real
> encoder and use `--data-binary @body.json`. The hash is computed over the
> exact UTF-8 bytes; if the shell changes them, the gate is right to reject.

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
pnpm test        # 114 tests
pnpm typecheck
```

The shared contract suite runs three times: on an in-memory harness, on the real
`node:sqlite` adapter, and on real D1 + KV from miniflare. Running both is what makes "the forms share a
contract" a test rather than an assumption — and the second run is what caught
the suite asserting against the harness's internal store instead of the adapter.

## Known limits (M1)

- `KV_EMB` is unbound: reserved for M2 embedding sync, never written in M1.
- `/v1/content` does not verify fetched bytes against `cid_digest` before
  caching; clients verify both digests downstream.
- The stored CID is whatever the pin backend returns (Pinata returns CIDv0
  `Qm…`), so it will not match a locally computed CIDv1. Integrity never depends
  on it — `cidDigest` is computed from the bytes (D-9).
- `/v1/memories` has no cursor pagination.
- F1 concurrency is WAL + one writer per process; stronger guarantees are out
  of scope.
- Without `PINATA_JWT` nothing is actually pinned (the offline adapter returns a deterministic CID).

## Operational notes

- **Workers Paid is a hard requirement for F2** (M1-11). Free-tier KV write
  limits are exceeded by normal staging volume; the failure is loud, not silent.
- **`KV_HISAISHI_STAGING` is prefixed** because KV namespace names are
  account-global and a bare `KV_STAGING` risks colliding with another project.
- **A binding name may be either a var or a secret, never both.** Cloudflare
  rejects the pair with code 10053; `IPFS_GATEWAY` is a secret, so it has no
  `vars` entry in `wrangler.jsonc`.
- **Gateways disagree on "not pinned".** Pinata answers **403** with a
  "does not have this content pinned" body; a malformed CID is **400**. Both are
  classified (`core/gateway-url.ts`) so a client sees `CONTENT_NOT_FOUND` or
  `INVALID_HASH`, not a generic outage.
- **The D1 binding is `DB`, not the database name.** `wrangler d1 create`
  suggests `hisaishi_staging`; choosing it would require changing the Worker.
