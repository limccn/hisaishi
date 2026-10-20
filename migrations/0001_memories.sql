-- Generated from src/local/sqlite.ts DDL. Both forms must run the SAME DDL
-- (design v0.5 section 3 parity rule), and a test asserts they match.
-- Keep this header free of semicolons: a SQL splitter divides on them.

CREATE TABLE IF NOT EXISTS memories (
  cid          TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  cid_digest   TEXT NOT NULL,
  owner        TEXT NOT NULL,
  tags_json    TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'staged',
  batch_id     TEXT,
  tx_hash      TEXT,
  batch_json   TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (owner, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_owner_status ON memories(owner, status);
CREATE INDEX IF NOT EXISTS idx_batch ON memories(batch_id);
CREATE INDEX IF NOT EXISTS idx_cid ON memories(cid);

CREATE TABLE IF NOT EXISTS kv_content (
  key        TEXT PRIMARY KEY,
  bytes      BLOB NOT NULL,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS kv_emb (
  key        TEXT PRIMARY KEY,
  bytes      BLOB NOT NULL,
  expires_at INTEGER
);
