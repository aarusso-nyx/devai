// Malformed inventory must not cause deletion or fabricated suggestions.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { suggestInvariants } from '../../src/inv-suggest/index.js';

const NOW = '2026-09-08T00:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function bodyPath(name: string, text: string): { repoRoot: string; path: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'devai-round13-red-suggest-'));
  roots.push(repoRoot);
  const path = join(repoRoot, name);
  writeFileSync(path, text);
  return { repoRoot, path };
}

describe('suggest must not invent candidates from an invalid inventory body', () => {
  it.each([
    ['a bare string routes member', '{"unmapped":{"routes":"route-a"}}'],
    ['a bare string endpoints member', '{"unmapped":{"endpoints":"GET /a"}}'],
    ['a scalar body', '"unavailable"'],
  ])('emits nothing for coverage with %s', (_label, text) => {
    const { repoRoot, path } = bodyPath('coverage.json', text);
    const result = suggestInvariants({
      repoRoot,
      coverageBodyPath: path,
      dataHandlingBodyPath: join(repoRoot, 'missing-a.json'),
      depGraphBodyPath: join(repoRoot, 'missing-b.json'),
      rbacBodyPath: join(repoRoot, 'missing-c.json'),
      dryRun: true,
      now: NOW,
    });
    expect(result.candidates).toEqual([]);
    expect(result.summary.total).toBe(0);
  });

  it.each([
    ['tables as an object', '{"tables":{"users":{}}}'],
    ['a columns member as an object', '{"tables":[{"name":"users","columns":{}}]}'],
  ])('emits nothing for a data-handling body with %s', (_label, text) => {
    const { repoRoot, path } = bodyPath('handling.json', text);
    const result = suggestInvariants({
      repoRoot,
      coverageBodyPath: join(repoRoot, 'missing-a.json'),
      dataHandlingBodyPath: path,
      depGraphBodyPath: join(repoRoot, 'missing-b.json'),
      rbacBodyPath: join(repoRoot, 'missing-c.json'),
      dryRun: true,
      now: NOW,
    });
    expect(result.candidates).toEqual([]);
    expect(result.summary.total).toBe(0);
  });

  it('emits nothing for a dep-graph body whose adjacency list is a number', () => {
    const { repoRoot, path } = bodyPath('graph.json', '{"graph":{"packages/a/src/a.ts":3}}');
    const result = suggestInvariants({
      repoRoot,
      coverageBodyPath: join(repoRoot, 'missing-a.json'),
      dataHandlingBodyPath: join(repoRoot, 'missing-b.json'),
      depGraphBodyPath: path,
      rbacBodyPath: join(repoRoot, 'missing-c.json'),
      dryRun: true,
      now: NOW,
    });
    expect(result.candidates).toEqual([]);
    expect(result.summary.total).toBe(0);
  });

  it('emits nothing for an rbac body whose endpointsWithoutRole is a bare string', () => {
    const { repoRoot, path } = bodyPath(
      'rbac.json',
      '{"unmapped":{"endpointsWithoutRole":"POST /admin"}}',
    );
    const result = suggestInvariants({
      repoRoot,
      coverageBodyPath: join(repoRoot, 'missing-a.json'),
      dataHandlingBodyPath: join(repoRoot, 'missing-b.json'),
      depGraphBodyPath: join(repoRoot, 'missing-c.json'),
      rbacBodyPath: path,
      dryRun: true,
      now: NOW,
    });
    expect(result.candidates).toEqual([]);
    expect(result.summary.total).toBe(0);
  });
});
