/**
 * DDL parity (design §3 rule, PRD AC).
 *
 * F1 creates its schema from a TypeScript constant; F2 (and an existing F1
 * database) applies the SQL migrations. The contract is that both paths end at
 * the SAME schema. Comparing statement text would be weaker now that 0002 is
 * additive (`ALTER`): compare the resulting schema instead.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DDL, openDatabase } from '../src/local/sqlite.js';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function applyMigrations(db: DatabaseSync): void {
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // Strip line comments before splitting: a comment may contain a semicolon.
    const withoutComments = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    for (const statement of withoutComments
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s !== '')) {
      db.exec(statement);
    }
  }
}

interface Column {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

function schemaOf(db: DatabaseSync): {
  tables: string[];
  columns: Record<string, Column[]>;
  indexes: Record<string, string[]>;
} {
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as unknown as Array<{ name: string }>
  ).map((row) => row.name);

  const columns: Record<string, Column[]> = {};
  const indexes: Record<string, string[]> = {};
  for (const table of tables) {
    columns[table] = (
      db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Column[]
    ).map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }));
    indexes[table] = (
      db.prepare(`PRAGMA index_list(${table})`).all() as unknown as Array<{ name: string }>
    )
      .map((row) => row.name)
      .filter((name) => !name.startsWith('sqlite_autoindex_'))
      .sort();
  }
  return { tables, columns, indexes };
}

describe('F1 bootstrap DDL ≡ SQL migrations', () => {
  it('ends at the same schema, table for table', () => {
    const fresh = openDatabase(':memory:');
    const migrated = new DatabaseSync(':memory:');
    try {
      applyMigrations(migrated);
      expect(schemaOf(migrated)).toEqual(schemaOf(fresh));
    } finally {
      fresh.close();
      migrated.close();
    }
  });

  it('both paths have every capability column', () => {
    const fresh = openDatabase(':memory:');
    const migrated = new DatabaseSync(':memory:');
    try {
      applyMigrations(migrated);
      for (const db of [fresh, migrated]) {
        const names = (
          db.prepare('PRAGMA table_info(memories)').all() as unknown as Array<{ name: string }>
        ).map((row) => row.name);
        expect(names).toEqual(
          expect.arrayContaining(['capability_hash', 'batched_at', 'commitment_hash']),
        );
      }
    } finally {
      fresh.close();
      migrated.close();
    }
  });

  it('both declarations use the composite primary key', () => {
    const declarations = [
      DDL,
      readFileSync(join(MIGRATIONS_DIR, '0001_memories.sql'), 'utf8'),
    ];
    for (const sql of declarations) {
      expect(sql).toContain('PRIMARY KEY (owner, content_hash)');
      expect(sql).not.toMatch(/cid\s+TEXT[^,]*PRIMARY KEY/i);
    }
  });

  it('backfills lowercase cid_digest before creating its index', () => {
    const statements = [
      DDL,
      readFileSync(join(MIGRATIONS_DIR, '0002_capability_batches_pins.sql'), 'utf8'),
    ];
    for (const sql of statements) {
      const update = sql.search(/UPDATE\s+memories\s+SET\s+cid_digest\s*=\s*lower/i);
      const index = sql.search(/CREATE INDEX IF NOT EXISTS idx_cid_digest/i);
      expect(update).toBeGreaterThanOrEqual(0);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(update).toBeLessThan(index);
    }
  });

  it('0001 is re-runnable; 0002 is additive', () => {
    const first = readFileSync(join(MIGRATIONS_DIR, '0001_memories.sql'), 'utf8');
    const creates = first.match(/CREATE\s+(TABLE|INDEX|UNIQUE INDEX)\s+(?!IF NOT EXISTS)/gi);
    expect(creates, '0001 must use IF NOT EXISTS').toBeNull();
    const second = readFileSync(join(MIGRATIONS_DIR, '0002_capability_batches_pins.sql'), 'utf8');
    expect(second).toMatch(/ALTER TABLE memories ADD COLUMN/);
  });
});
