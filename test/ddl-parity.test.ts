/**
 * DDL parity (design §3 rule, PRD AC).
 *
 * F1 bootstraps from a TypeScript constant; F2 applies a SQL migration. The
 * contract is that they are the SAME schema. Keeping two copies is unavoidable
 * (D1 migrations must be SQL files), so the guard is a test that reads both and
 * compares them rather than a comment asking nicely.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DDL } from '../src/local/sqlite.js';

const MIGRATION = join(import.meta.dirname, '..', 'migrations', '0001_memories.sql');

/** Statements, normalised for whitespace and trailing semicolons. */
function statements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) =>
      s
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('--'))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((s) => s !== '');
}

describe('F1 bootstrap DDL ≡ F2 migration', () => {
  it('declares the same statements', () => {
    const fromDdl = statements(DDL);
    const fromMigration = statements(readFileSync(MIGRATION, 'utf8'));
    expect(fromMigration).toEqual(fromDdl);
  });

  it('both use the composite primary key', () => {
    for (const sql of [DDL, readFileSync(MIGRATION, 'utf8')]) {
      expect(sql).toContain('PRIMARY KEY (owner, content_hash)');
      // The v0.2 defect: a cid PK silently drops a second owner's identical
      // bytes, because the CID does not include the owner.
      expect(sql).not.toMatch(/cid\s+TEXT[^,]*PRIMARY KEY/i);
    }
  });

  it('the migration is idempotent (IF NOT EXISTS)', () => {
    const migration = readFileSync(MIGRATION, 'utf8');
    const creates = migration.match(/CREATE\s+(TABLE|INDEX|UNIQUE INDEX)\s+(?!IF NOT EXISTS)/gi);
    expect(creates, 'every CREATE must be IF NOT EXISTS so a re-run is harmless').toBeNull();
  });
});
