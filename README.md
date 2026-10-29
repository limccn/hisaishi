# hisaishi

Keyless memory gateway for MemoryOverEth. It owns the off-chain half of the
pipeline — staging, deduplication, pinning, batch construction, anchoring
confirmation — and **never holds a wallet key**.

Signing belongs to [longstone](../longstone); hisaishi only prepares.

Deployed gateway: `https://api.longstone.app` (health:
`https://api.longstone.app/v1/health`). The workers.dev hostname stays as a
fallback if the custom domain is unbound.

## Install

```bash
npm install @limccn/hisaishi-gateway
```

Published to npmjs and GitHub Packages (latest published: `0.1.1`). This tree
is the prepared `0.1.2` release. The root export is the keyless contract
(`createGatewayHandle`, route types); `/local` is the Node + `node:sqlite` form;
`/worker` is the Cloudflare Workers entry.

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
| `POST /v1/memories` | **requires a 128-bit `capability`**; recompute `keccak(JCS(content))`, reject on mismatch **before** any pin or write; dedup by `(owner, contentHash)`; bind the row to `sha256(deploymentId:capability)` |
| `POST /v1/batches/build` | **requires the same capability**; selects only rows staged under it; unsigned commitments with **placeholder** `prev/blockHeight/signer`, mark `batched` |
| `POST /v1/batches/confirm` | **one** receipt call; `status: anchored \| rejected \| pending`; stores the event's real `commitmentHash` on the row |
| `GET /v1/memories` | staging rows for one owner |
| `GET /v1/content?cid=` | only for a CID with a row; 1 MiB cap; digest-checked before caching |
| `GET /v1/content?cidDigest=` | resolves the pinned CID from the staged row and returns its bytes with `x-ipfs-cid`; the bridge a verifier needs when only chain state is known |
| `GET /v1/health` | operator marker (`deploymentId`, features); not a handshake |

### Staging capability

A staging session is scoped by a client-generated 128-bit token:

- the client sends it on `stage` and on the matching `build`; the gateway stores
  only `sha256(deploymentId + ':' + capability)` on the row;
- `build` can select only that capability's rows — no capability means a typed
  400, never an owner-wide selection;
- re-staging a `staged` row re-binds it to the caller's capability; a stale
  `batched` row is reclaimed after the TTL by a same-capability build or a
  new-capability stage;
- the deployment id is part of the hash, so deployments sharing one D1/KV
  database cannot select each other's rows. Changing it makes old staged rows
  invisible until re-staged.

### Limits and rate budgets

| Limit | Value |
|---|---|
| HTTP body | 256 KiB (checked before JSON parsing) |
| Canonical content | 16 KiB |
| `text` | 8 KiB UTF-8 |
| `meta` | 8 KiB canonical |
| `refs` | 16 entries, 512 bytes each |
| Tags | 16 per row, 32 UTF-8 bytes each, strings only |
| Upstream content | 1 MiB, streamed with a hard cap |
| Rate (per IP) | stage 30/min, build 30/min, confirm 60/min, content 120/min |
| Rate (per owner) | 120/hour on stage and build |

App-level limits are per isolate/process; configure Cloudflare edge rate
limiting for F2.

### Browser origins

Loopback origins are always allowed. A deployed UI must be listed in
`HISAISHI_ALLOWED_ORIGINS`; a write with a present, disallowed `Origin` gets
403. Wildcard CORS requires the explicit `HISAISHI_ALLOW_ANY_ORIGIN=true` and is
unsafe outside local development. The `DEV_MODE` flag does not imply it.

`HISAISHI_ALLOWED_ORIGINS` is a comma-separated list, and the deployed value
holds **two** origins during the domain migration:

| Origin | Why it is listed |
|---|---|
| `https://longstone.app` | Branded app (canonical target; `www` is 301'd here before a request is made, so it never appears as an Origin) |
| `https://longstone-ui.pages.dev` | Kept for already-shipped clients: `longstone-ext` and `longstone-vscode` hardcode this origin and old installs cannot be hot-updated. Dropping it breaks their staging/build calls |

Removing the pages.dev entry is a breaking change for every client built before
the branded origin shipped; do it only once those versions are no longer in use.
Both origins must also stay in sync with the Pages project serving the UI.

Error codes and their HTTP status live in one table (`src/core/errors.ts`) so a
snapshot test pins the mapping rather than each handler's memory of it.

## Run F1

```powershell
pnpm install
pnpm build

$env:RPC_URL = 'https://sepolia.base.org'
$env:IPFS_GATEWAY = 'https://your-dedicated-gateway.example'
$env:HISAISHI_DB_PATH = '.longstone/hisaishi.db'
$env:HISAISHI_DEPLOYMENT_ID = 'local'
$env:HISAISHI_BIND = '127.0.0.1'          # loopback by default; a warning otherwise
$env:HISAISHI_ALLOWED_ORIGINS = 'https://longstone-ui.pages.dev'
pnpm dev          # http://127.0.0.1:8787
```

The standalone server binds `127.0.0.1` by default and logs the **actual**
bound address. Pointing `HISAISHI_BIND` at another interface prints a warning:
the gateway has no authentication and must sit behind rate limits and an
authenticated proxy if exposed.

`PINATA_JWT` is optional: without it the gateway uses a deterministic offline
pin adapter (same CID shape, no network), which is what the tests use.

**No wallet key belongs in this environment.** `readLocalEnv` rejects any
key-shaped variable — `LONGSTONE_KEY`, `PRIVATE_KEY`, `MNEMONIC`, and by pattern
anything matching `private_key`/`seed_phrase`/`signing_key`. The type has no
field to put one in.

### Embedded

```ts
import { createGateway } from '@limccn/hisaishi-gateway/local';

const { handle } = await createGateway({
  dbPath: '.longstone/hisaishi.db',
  rpcUrl: 'https://sepolia.base.org',
  ipfsGateway: 'https://your-dedicated-gateway.example',
  // deploymentId defaults to 'local'; set a unique value per deployment.
});

const capability = 'ab'.repeat(16); // 128-bit session token, client-generated
const result = await handle.stage({
  owner, content, contentHash, tags: ['layer:deep'], capability,
});
// then build with the same capability; result.ok ? result.value : result.error.code
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
# 3. Schema (0001 + 0002; a parity test asserts F1 and the migrations agree)
npx wrangler d1 migrations apply hisaishi-staging --remote

# 4. Secrets — never in wrangler.jsonc, never in a committed file
npx wrangler secret put RPC_URL          # e.g. https://sepolia.base.org
npx wrangler secret put IPFS_GATEWAY     # dedicated gateway ONLY (M1-9)
npx wrangler secret put PINATA_JWT       # optional; omit for the offline adapter

# 4b. Required plain vars live in wrangler.jsonc: HISAISHI_DEPLOYMENT_ID and
#     HISAISHI_ALLOWED_ORIGINS. The deployment id must be unique per logical
#     deployment sharing this database; the origin list holds the branded app
#     origin and, while released clients still point at it,
#     https://longstone-ui.pages.dev (see "Browser origins").

# 5. Deploy — also applies the committed api.longstone.app route (custom domain)
pnpm build
npx wrangler deploy
```

`wrangler.jsonc` declares the Worker's public route, `api.longstone.app`, as a
`custom_domain`. That requires the `longstone.app` zone to be in the same
Cloudflare account as this Worker and takes effect on the owner's deploy; until
it is bound, the workers.dev hostname remains the endpoint. Before exposing the
gateway on a public hostname, configure Cloudflare edge rate limiting and WAF
for `/v1/memories`, `/v1/batches/*` and `/v1/content` (NV-2) — the app-level
limiter is per isolate and is a cost guard, not a quota.

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
$env:BASE_URL = "https://api.longstone.app"   # public endpoint
# fallback when the custom domain is unbound:
#   $env:BASE_URL = "https://<worker>.<subdomain>.workers.dev"
node scripts/e2e-worker.mjs
```

It checks stage, dedup, build placeholders, confirm-pending, and the three
content outcomes (pinned 200 / unpinned 404 / malformed 400). Exit code is
non-zero on the first mismatch. It needs no credentials and spends no gas.

The equivalent hand-run commands:

```powershell
$BASE = "https://api.longstone.app"   # workers.dev fallback: https://<worker>.<subdomain>.workers.dev
$OWNER = "0x" + ("11" * 20)
$CAP = "ab" * 16

# integrity gate: a wrong hash is rejected and nothing is written
curl.exe -s -X POST "$BASE/v1/memories" -H "content-type: application/json" `
  -d "{`"owner`":`"$OWNER`",`"content`":{`"text`":`"x`",`"format`":`"text.v0`"},`"contentHash`":`"0x$('00'*32)`",`"tags`":[],`"capability`":`"$CAP`"}"

# staging → build → list (the build must present the same capability)
curl.exe -s "$BASE/v1/memories?owner=$OWNER"
curl.exe -s -X POST "$BASE/v1/batches/build" -H "content-type: application/json" -d "{`"owner`":`"$OWNER`",`"capability`":`"$CAP`"}"
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
  capability_hash TEXT, batched_at INTEGER, commitment_hash TEXT,
  PRIMARY KEY (owner, content_hash)   -- not `cid`
);
CREATE TABLE batches (...);  -- one payload per batch, not per row
CREATE TABLE pins (...);     -- global digest → CID ledger
```

`(owner, content_hash)` is the primary key because identical bytes produce one
CID: a `cid` key silently drops a second owner's row. There is no separate
dedup table — this index *is* the dedup lookup. `capability_hash` is the only
staging-session state; `commitment_hash` is null until `confirm` records the
real event value. Indexes cover `(owner, capability_hash, status)` and
`cid_digest`.

WAL and `busy_timeout=5000` are enabled for the embedded case, where longstone
shares the file.

## Tests

```powershell
pnpm test        # 158 core tests (+ 10 Worker smoke tests when pnpm matches packageManager)
pnpm typecheck
```

The shared contract suite runs three times: on an in-memory harness, on the real
`node:sqlite` adapter, and on real D1 + KV from miniflare. Running both is what makes "the forms share a
contract" a test rather than an assumption — and the second run is what caught
the suite asserting against the harness's internal store instead of the adapter.

## Security status (0.1.1 → 0.1.2)

Upstream failures no longer echo their message. `PIN_FAILED`, `RPC_UNAVAILABLE`,
the upstream `SCHEMA_VIOLATION` / `CONTENT_NOT_FOUND` / `GATEWAY_UPSTREAM`
branches, and unclassified `INTERNAL` failures return fixed details; the
internal text is logged only after URL redaction (userinfo, path, query, and
fragment removed). In 0.1.1 a failed RPC or Pinata call could put a full URL —
including credentials — into the response `detail`.

## Security status (0.1.0 → 0.1.1)

The published 0.1.0 predates capability binding; 0.1.1 is the patched release.
Until the patched gateway is deployed, do not expose a shared remote gateway:
an anonymous caller can stage rows into another owner's batch and consume
unbounded pin/RPC/storage. Local single-machine use is the supported mode on
0.1.0.

## Known limits (M1)

- `KV_EMB` is unbound: reserved for M2 embedding sync, never written in M1.
- `/v1/content` is membership-gated, caps the upstream object at 1 MiB while
  streaming, and verifies the fetched bytes against the row's `cid_digest`
  before caching. An arbitrary CID that the gateway has no row for is 404.
- App-level rate limiting is per isolate/process and therefore approximate;
  Cloudflare edge rules are the real control for F2 (configure them before
  exposing the Worker). The middleware still protects F1 and non-CF deployments.
- A leaked capability can temporarily deny anchoring for that session's rows;
  the rows recover after `BATCH_TTL`. The capability is never stored raw, logged
  or placed in a URL.
- There is no legacy (capability-less) build mode: an old client gets a typed
  400 at `stage` and `build`.
- The stored CID is whatever the pin backend returns (Pinata returns CIDv0
  `Qm…`), so it will not match a locally computed CIDv1. Integrity never depends
  on it — `cidDigest` is computed from the bytes (D-9).
- **The pinned CID is not derivable from `cidDigest` for every pin backend.**
  Pinata's CIDv0 hashes its dag-pb wrapper, not the raw bytes, so `sha256(bytes)`
  cannot be turned back into the CID. `/v1/content?cidDigest=` exists for that
  case: the row maps digest → CID. Returning a different content is detectable
  (callers recompute both digests); withholding is not preventable, and direct
  CID retrieval remains available. The UI's direct-IPFS fallback (derived raw
  CIDv1) only works with backends that pin raw blocks.
- `/v1/memories` has no cursor pagination.
- F1 concurrency is WAL + one writer per process; stronger guarantees are out
  of scope.
- Without `PINATA_JWT` nothing is actually pinned (the offline adapter returns a deterministic CID).

## Operational notes

- **Owner addresses are canonical lowercase at the route boundary.** An address
  has one identity but many spellings: wagmi hands the browser the EIP-55
  checksummed form, while longstone and the chain store lowercase. Comparing the
  strings literally made the UI's staging query miss rows it had just written;
  `assertAddress` now normalizes.
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
