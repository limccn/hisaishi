-- 0002: minimal staging capability, batch storage, pin ledger, digest index.
--
-- Additive only. F1 creates the final shape from DDL; an existing F1 database
-- runs the same ALTERs via `ensureColumns`. D1 applies this file once.

ALTER TABLE memories ADD COLUMN capability_hash TEXT;
ALTER TABLE memories ADD COLUMN batched_at INTEGER;
ALTER TABLE memories ADD COLUMN commitment_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_capability ON memories(owner, capability_hash, status);

-- One copy of each built batch, not one per row (M-3 amplification).
CREATE TABLE IF NOT EXISTS batches (
  batch_id   TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  built_at   INTEGER NOT NULL,
  batch_json TEXT NOT NULL
);

-- Global pin ledger: dedup by content digest + accounting for orphan pins.
CREATE TABLE IF NOT EXISTS pins (
  cid_digest   TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  cid          TEXT NOT NULL,
  pinned_at    INTEGER NOT NULL
);

-- L-2: normalise before indexing, then look up by equality.
UPDATE memories SET cid_digest = lower(cid_digest)
 WHERE cid_digest <> lower(cid_digest);
CREATE INDEX IF NOT EXISTS idx_cid_digest ON memories(cid_digest);
