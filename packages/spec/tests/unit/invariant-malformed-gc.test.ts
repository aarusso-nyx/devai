// Malformed inventory must not cause deletion or fabricated suggestions.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { gcStaleInvariantCandidates, type InvCandidate } from '../../src/inv-suggest/index.js';

const NOW = '2026-09-08T00:00:00.000Z';
const ULID_BASE = '01ARZ3NDEKTSV4RRFFQ69G5FA';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-round13-red-'));
  roots.push(path);
  return path;
}

function candidate(
  suffix: string,
  category: InvCandidate['category'],
  kind: InvCandidate['target']['kind'],
  identifier: string,
): InvCandidate {
  return {
    schemaVersion: '1.0.0',
    id: `INV-CANDIDATE-${ULID_BASE}${suffix}`,
    generated_at: NOW,
    category,
    source_sensor: 'inventory_coverage',
    confidence: 'high',
    target: { kind, identifier },
    suggested_invariant: {
      title: `t ${identifier}`,
      statement: `s ${identifier}`,
      severity_suggestion: 'gate',
    },
    status: 'proposed',
  };
}

function seed(record: InvCandidate): { outDir: string; file: string; repoRoot: string } {
  expect(validators.invCandidate(record)).toBe(true);
  const repoRoot = root();
  const outDir = join(repoRoot, 'candidates');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${record.id}.json`);
  writeFileSync(file, JSON.stringify(record));
  return { outDir, file, repoRoot };
}

function body(repoRoot: string, name: string, text: string): string {
  const path = join(repoRoot, name);
  writeFileSync(path, text);
  return path;
}

describe('GC must not infer staleness from an invalid inventory body', () => {
  it.each([
    ['a JSON number', '42'],
    ['a JSON string', '"coverage temporarily unavailable"'],
    ['a JSON boolean', 'false'],
    ['a JSON array', '[]'],
    ['an object with a wrong-shaped unmapped member', '{"unmapped":"route-a"}'],
    ['an object whose routes member is a bare string', '{"unmapped":{"routes":"route-a"}}'],
    ['an object whose routes member is an object', '{"unmapped":{"routes":{"0":"route-a"}}}'],
  ])('keeps a route candidate when the coverage body is %s', async (_label, text) => {
    const record = candidate('0', 'unmapped_route', 'route', 'route-a');
    const { outDir, file, repoRoot } = seed(record);
    const coverageBodyPath = body(repoRoot, 'coverage.json', text);
    const options = { repoRoot, outDir, coverageBodyPath, now: NOW };

    expect(gcStaleInvariantCandidates({ ...options, dryRun: true })).toMatchObject({
      scanned: 1,
      stale: 0,
      kept: 1,
    });
    await withAuthorityHostTestScope(() => {
      expect(gcStaleInvariantCandidates(options)).toMatchObject({ stale: 0, kept: 1 });
    });
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(outDir, 'gc-evidence.jsonl'))).toBe(false);
  });

  it.each([
    ['tables is an object', '{"tables":{"users":{}}}'],
    ['a table columns member is an object', '{"tables":[{"name":"users","columns":{}}]}'],
    ['pii is an object', '{"pii":{"users":"email"}}'],
  ])('keeps a PII column candidate when the data-handling body has %s', async (_label, text) => {
    const record = candidate('1', 'unlabeled_pii_column', 'column', 'users.email');
    const { outDir, file, repoRoot } = seed(record);
    const dataHandlingBodyPath = body(repoRoot, 'handling.json', text);
    const options = { repoRoot, outDir, dataHandlingBodyPath, now: NOW };

    expect(gcStaleInvariantCandidates({ ...options, dryRun: true })).toMatchObject({
      scanned: 1,
      stale: 0,
      kept: 1,
    });
    await withAuthorityHostTestScope(() => {
      expect(gcStaleInvariantCandidates(options)).toMatchObject({ stale: 0, kept: 1 });
    });
    expect(existsSync(file)).toBe(true);
  });

  it.each([
    ['endpointsWithoutRole is a number', '{"unmapped":{"endpointsWithoutRole":7}}'],
    [
      'endpointsWithoutRole is a bare string',
      '{"unmapped":{"endpointsWithoutRole":"POST /admin"}}',
    ],
    ['the legacy endpointsWithoutRole list is an object', '{"endpointsWithoutRole":{"a":"b"}}'],
  ])('keeps an unbound endpoint candidate when %s', async (_label, text) => {
    const record = candidate('2', 'unbound_endpoint', 'endpoint', 'POST /admin');
    const { outDir, file, repoRoot } = seed(record);
    const rbacBodyPath = body(repoRoot, 'rbac.json', text);
    const options = { repoRoot, outDir, rbacBodyPath, now: NOW };

    expect(gcStaleInvariantCandidates({ ...options, dryRun: true })).toMatchObject({
      scanned: 1,
      stale: 0,
      kept: 1,
    });
    await withAuthorityHostTestScope(() => {
      expect(gcStaleInvariantCandidates(options)).toMatchObject({ stale: 0, kept: 1 });
    });
    expect(existsSync(file)).toBe(true);
  });

  it.each([
    ['graph is a string', '{"graph":"packages/a/src/a.ts"}'],
    ['a graph adjacency list is a number', '{"graph":{"packages/a/src/a.ts":3}}'],
    ['forbiddenEdges is a number', '{"forbiddenEdges":3}'],
  ])('keeps a forbidden edge candidate when %s', async (_label, text) => {
    const record = candidate(
      '3',
      'forbidden_edge',
      'edge',
      'packages/a/src/a.ts -> packages/b/internal/secret.ts',
    );
    const { outDir, file, repoRoot } = seed(record);
    const depGraphBodyPath = body(repoRoot, 'graph.json', text);
    const options = { repoRoot, outDir, depGraphBodyPath, now: NOW };

    expect(gcStaleInvariantCandidates({ ...options, dryRun: true })).toMatchObject({
      scanned: 1,
      stale: 0,
      kept: 1,
    });
    await withAuthorityHostTestScope(() => {
      expect(gcStaleInvariantCandidates(options)).toMatchObject({ stale: 0, kept: 1 });
    });
    expect(existsSync(file)).toBe(true);
  });

  it('does not delete an unrelated category when one body is invalid', async () => {
    const routeRecord = candidate('4', 'unmapped_route', 'route', 'route-a');
    const { outDir, file, repoRoot } = seed(routeRecord);
    const endpointRecord = candidate('5', 'unmapped_endpoint', 'endpoint', 'GET /a');
    writeFileSync(join(outDir, `${endpointRecord.id}.json`), JSON.stringify(endpointRecord));
    const coverageBodyPath = body(repoRoot, 'coverage.json', '"unavailable"');
    const options = { repoRoot, outDir, coverageBodyPath, now: NOW };

    const result = await withAuthorityHostTestScope(() => gcStaleInvariantCandidates(options));
    // Asserted before the counters so the failure names the data loss itself.
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(outDir, `${endpointRecord.id}.json`))).toBe(true);
    expect(existsSync(join(outDir, 'gc-evidence.jsonl'))).toBe(false);
    expect(result).toMatchObject({ scanned: 2, stale: 0, kept: 2 });
  });
});
