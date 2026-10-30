import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from 'vitest';

/** Immutable 2.8 predecessor; never suppress a live future entry in production. */
export function frozen280MigrationManifest(): Record<string, unknown> {
  const raw = readFileSync(
    resolve(import.meta.dirname, '../fixtures/adopter-migrations-e94070ac.json'),
    'utf8',
  );
  expect(createHash('sha256').update(raw).digest('hex')).toBe(
    '18c5f8dad26a29dc29a35aa657372ea1f89cbc6fc934c75e478ec1a966930b52',
  );
  return JSON.parse(raw) as Record<string, unknown>;
}
