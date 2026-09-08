import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  gcStaleInvariantCandidates,
  suggestInvariants,
  type InvCandidate,
  type InvCandidateCategory,
} from '../../src/inv-suggest/index.js';

/**
 * Input-validity contract for the inventory → invariant-candidate bridge.
 *
 * GC deletes curated records, so every classification here is judged against
 * one rule: a candidate may only be called stale when the *relevant* inventory
 * body was actually read and actually no longer surfaces the target. An absent
 * or unreadable body is undecidable and must preserve the record.
 */

const NOW = '2026-09-08T00:00:00.000Z';
const ULID_BASE = '01ARZ3NDEKTSV4RRFFQ69G5FA';
const ULID_TAIL = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GC_REASON = 'target no longer surfaced by inventory body';

const KIND: Record<InvCandidateCategory, InvCandidate['target']['kind']> = {
  unmapped_route: 'route',
  unmapped_endpoint: 'endpoint',
  unbound_endpoint: 'endpoint',
  unlabeled_pii_column: 'column',
  forbidden_edge: 'edge',
};

const SENSOR: Record<InvCandidateCategory, InvCandidate['source_sensor']> = {
  unmapped_route: 'inventory_coverage',
  unmapped_endpoint: 'inventory_coverage',
  unbound_endpoint: 'inventory_rbac',
  unlabeled_pii_column: 'inventory_data_handling',
  forbidden_edge: 'inventory_dep_graph',
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-inv-input-'));
  roots.push(path);
  return path;
}

function write(repo: string, rel: string, value: unknown): string {
  const path = join(repo, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

/** A schema-valid candidate record — GC only judges records it can validate. */
function candidate(
  index: number,
  category: InvCandidateCategory,
  identifier: string,
): InvCandidate {
  return {
    schemaVersion: '1.0.0',
    id: `INV-CANDIDATE-${ULID_BASE}${ULID_TAIL[index] ?? '0'}`,
    generated_at: NOW,
    category,
    source_sensor: SENSOR[category],
    confidence: 'high',
    target: { kind: KIND[category], identifier },
    suggested_invariant: {
      title: `Candidate for ${identifier}`,
      statement: `${identifier} is still surfaced by its inventory sensor.`,
      severity_suggestion: 'gate',
    },
    status: 'proposed',
  };
}

/** Plants one candidate file per [category, identifier] pair; returns their paths by identifier. */
function plant(
  repo: string,
  pairs: readonly (readonly [InvCandidateCategory, string])[],
): { outDir: string; files: Map<string, string> } {
  const outDir = join(repo, 'candidates');
  mkdirSync(outDir, { recursive: true });
  const files = new Map<string, string>();
  pairs.forEach(([category, identifier], index) => {
    const record = candidate(index, category, identifier);
    expect(validators.invCandidate(record)).toBe(true);
    const file = join(outDir, `${record.id}.json`);
    writeFileSync(file, JSON.stringify(record));
    files.set(identifier, file);
  });
  return { outDir, files };
}

const EMPTY_BODIES = {
  'coverage.json': { unmapped: { routes: [], endpoints: [] } },
  'rbac.json': { unmapped: { endpointsWithoutRole: [] } },
  'handling.json': { tables: [] },
  'graph.json': { graph: {} },
} as const;

/** All four bodies present and readable, none of them surfacing anything. */
function claimedInventory(repo: string): {
  repoRoot: string;
  coverageBodyPath: string;
  rbacBodyPath: string;
  dataHandlingBodyPath: string;
  depGraphBodyPath: string;
  now: string;
} {
  for (const [name, value] of Object.entries(EMPTY_BODIES)) write(repo, name, value);
  return {
    repoRoot: repo,
    coverageBodyPath: join(repo, 'coverage.json'),
    rbacBodyPath: join(repo, 'rbac.json'),
    dataHandlingBodyPath: join(repo, 'handling.json'),
    depGraphBodyPath: join(repo, 'graph.json'),
    now: NOW,
  };
}

const ONE_PER_CATEGORY = [
  ['unmapped_route', 'route-a'],
  ['unmapped_endpoint', 'GET /a'],
  ['unbound_endpoint', 'POST /admin'],
  ['unlabeled_pii_column', 'users.email'],
  ['forbidden_edge', 'packages/a/src/a.ts -> packages/b/internal/secret.ts'],
] as const satisfies readonly (readonly [InvCandidateCategory, string])[];

describe('invariant candidate GC input validity', () => {
  it.each([
    ['coverage.json', ['unmapped_route', 'unmapped_endpoint']],
    ['rbac.json', ['unbound_endpoint']],
    ['handling.json', ['unlabeled_pii_column']],
    ['graph.json', ['forbidden_edge']],
  ] as const)(
    'never calls a candidate stale while its own %s body is absent or unparseable',
    (body, undecidable) => {
      for (const mode of ['absent', 'unparseable'] as const) {
        const repo = root();
        const options = claimedInventory(repo);
        const { outDir, files } = plant(repo, ONE_PER_CATEGORY);
        if (mode === 'absent') rmSync(join(repo, body));
        else write(repo, body, '{bad');

        const result = gcStaleInvariantCandidates({ ...options, outDir, dryRun: true });
        expect(result).toMatchObject({
          scanned: 5,
          kept: undecidable.length,
          stale: 5 - undecidable.length,
        });
        expect(result.evidence.map((item) => item.category).sort()).toEqual(
          ONE_PER_CATEGORY.map(([category]) => category)
            .filter((category) => !new Set<string>(undecidable).has(category))
            .sort(),
        );
        for (const file of files.values()) expect(existsSync(file)).toBe(true);
      }
    },
  );

  it('writes one evidence line per stale candidate before deleting exactly those files', async () => {
    const repo = root();
    const options = claimedInventory(repo);
    write(repo, 'coverage.json', { unmapped: { routes: ['route-live'], endpoints: [] } });
    const { outDir, files } = plant(repo, [
      ['unmapped_route', 'route-live'],
      ['unmapped_route', 'route-gone-a'],
      ['unmapped_route', 'route-gone-b'],
    ]);
    const live = files.get('route-live') ?? '';
    const liveBytes = readFileSync(live, 'utf8');

    const result = await withAuthorityHostTestScope(() =>
      gcStaleInvariantCandidates({ ...options, outDir }),
    );

    expect(result).toMatchObject({ scanned: 3, stale: 2, kept: 1 });
    expect(readFileSync(live, 'utf8')).toBe(liveBytes);
    expect(existsSync(files.get('route-gone-a') ?? '')).toBe(false);
    expect(existsSync(files.get('route-gone-b') ?? '')).toBe(false);

    const log = readFileSync(join(outDir, 'gc-evidence.jsonl'), 'utf8');
    expect(log.endsWith('\n')).toBe(true);
    const lines = log.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map((record) => record['target_identifier']).sort()).toEqual([
      'route-gone-a',
      'route-gone-b',
    ]);
    for (const record of records) {
      expect(record['gc_reason']).toBe(GC_REASON);
      expect(record['gc_timestamp']).toBe(NOW);
    }
  });

  it('reads the legacy sensor shapes rather than assuming their targets are claimed', () => {
    const repo = root();
    const options = claimedInventory(repo);
    write(repo, 'rbac.json', {
      endpointsWithoutRole: [{ id: 'POST /admin' }, {}],
    });
    write(repo, 'handling.json', {
      pii: [
        { table: 'users', column: 'email', legal_basis: null, retention: 'P1Y' },
        { table: 'users', column: 'phone', retention: null },
        { table: 'users', column: 'name', legal_basis: 'consent', retention: 'P1Y' },
      ],
    });
    write(repo, 'graph.json', {
      forbiddenEdges: [
        { from: 'packages/a/src/a.ts', to: 'packages/b/internal/secret.ts' },
        { from: 'packages/c/src/c.ts', to: 'packages/d/internal/other.ts' },
      ],
    });
    const { outDir } = plant(repo, [
      ['unbound_endpoint', 'POST /admin'],
      ['unbound_endpoint', 'DELETE /claimed'],
      ['unlabeled_pii_column', 'users.email'],
      ['unlabeled_pii_column', 'users.phone'],
      ['unlabeled_pii_column', 'users.name'],
      ['forbidden_edge', 'packages/a/src/a.ts -> packages/b/internal/secret.ts'],
      ['forbidden_edge', 'packages/a/src/a.ts -> packages/b/internal/removed.ts'],
    ]);

    const result = gcStaleInvariantCandidates({ ...options, outDir, dryRun: true });

    expect(result).toMatchObject({ scanned: 7, stale: 3, kept: 4 });
    expect(result.evidence.map((item) => item.target_identifier).sort()).toEqual([
      'DELETE /claimed',
      'packages/a/src/a.ts -> packages/b/internal/removed.ts',
      'users.name',
    ]);
  });

  it('keeps only the columns the data-handling body still leaves unlabeled', () => {
    const repo = root();
    const options = claimedInventory(repo);
    write(repo, 'handling.json', {
      tables: [
        {
          name: 'users',
          columns: [
            { name: 'id' },
            { name: 'blank', pii_class: '' },
            { name: 'partial', pii_class: 'contact', legal_basis: 'consent' },
            { name: 'full', pii_class: 'contact', legal_basis: 'consent', retention: 'P1Y' },
          ],
        },
      ],
    });
    const { outDir } = plant(repo, [
      ['unlabeled_pii_column', 'users.partial'],
      ['unlabeled_pii_column', 'users.id'],
      ['unlabeled_pii_column', 'users.blank'],
      ['unlabeled_pii_column', 'users.full'],
      ['unlabeled_pii_column', 'users.dropped'],
    ]);

    const result = gcStaleInvariantCandidates({ ...options, outDir, dryRun: true });

    expect(result).toMatchObject({ scanned: 5, stale: 4, kept: 1 });
    expect(result.evidence.map((item) => item.target_identifier).sort()).toEqual([
      'users.blank',
      'users.dropped',
      'users.full',
      'users.id',
    ]);
  });

  it('keeps only the edges the dep-graph body still makes forbidden', () => {
    const repo = root();
    const options = claimedInventory(repo);
    write(repo, 'graph.json', {
      graph: {
        'packages/a/src/a.ts': [
          'packages/b/internal/secret.ts',
          'packages/a/internal/own.ts',
          'packages/b/public.ts',
          'vendor/internal/x.ts',
        ],
        'unknown/file.ts': ['packages/b/internal/secret.ts'],
      },
    });
    const { outDir } = plant(repo, [
      ['forbidden_edge', 'packages/a/src/a.ts -> packages/b/internal/secret.ts'],
      ['forbidden_edge', 'packages/a/src/a.ts -> packages/a/internal/own.ts'],
      ['forbidden_edge', 'packages/a/src/a.ts -> packages/b/public.ts'],
      ['forbidden_edge', 'packages/a/src/a.ts -> vendor/internal/x.ts'],
      ['forbidden_edge', 'unknown/file.ts -> packages/b/internal/secret.ts'],
    ]);

    const result = gcStaleInvariantCandidates({ ...options, outDir, dryRun: true });

    expect(result).toMatchObject({ scanned: 5, stale: 4, kept: 1 });
    expect(result.evidence.map((item) => item.target_identifier).sort()).toEqual([
      'packages/a/src/a.ts -> packages/a/internal/own.ts',
      'packages/a/src/a.ts -> packages/b/public.ts',
      'packages/a/src/a.ts -> vendor/internal/x.ts',
      'unknown/file.ts -> packages/b/internal/secret.ts',
    ]);
  });

  it('deletes candidate records only, leaving neighbouring files in the output directory', async () => {
    const repo = root();
    const options = claimedInventory(repo);
    const { outDir, files } = plant(repo, [['unmapped_route', 'route-gone']]);
    const note = write(repo, 'candidates/INV-CANDIDATE-notes.txt', 'not a candidate record');
    const sibling = write(repo, 'candidates/notes.json', { note: 'not a candidate record' });

    const result = await withAuthorityHostTestScope(() =>
      gcStaleInvariantCandidates({ ...options, outDir }),
    );

    expect(result).toMatchObject({ scanned: 1, stale: 1, kept: 0 });
    expect(existsSync(files.get('route-gone') ?? '')).toBe(false);
    expect(readFileSync(note, 'utf8')).toBe('not a candidate record');
    expect(JSON.parse(readFileSync(sibling, 'utf8'))).toEqual({ note: 'not a candidate record' });
  });
});

describe('invariant candidate suggestion input validity', () => {
  it('reads present-but-empty bodies without persisting anything', () => {
    const repo = root();
    const options = claimedInventory(repo);
    const outDir = join(repo, 'candidates');

    const result = suggestInvariants({ ...options, outDir });

    expect(result.summary).toEqual({
      total: 0,
      by_category: {
        unmapped_route: 0,
        unmapped_endpoint: 0,
        unbound_endpoint: 0,
        unlabeled_pii_column: 0,
        forbidden_edge: 0,
      },
      unread_inputs: [],
    });
    expect(result.written_files).toEqual([]);
    expect(existsSync(outDir)).toBe(false);
  });
});

it('keeps legacy endpoint records when one inventory identifier has the wrong type', () => {
  const repo = root();
  const options = claimedInventory(repo);
  write(repo, 'rbac.json', { endpointsWithoutRole: [{ id: 'POST /admin' }, {}, { id: 7 }] });
  const { outDir, files } = plant(repo, [
    ['unbound_endpoint', 'POST /admin'],
    ['unbound_endpoint', 'DELETE /claimed'],
  ]);
  expect(gcStaleInvariantCandidates({ ...options, outDir, dryRun: true })).toMatchObject({
    scanned: 2,
    stale: 0,
    kept: 2,
  });
  for (const file of files.values()) expect(existsSync(file)).toBe(true);
});

it('preserves undecidable records while collecting only an independently confirmed stale category', async () => {
  const repo = root();
  const options = claimedInventory(repo);
  write(repo, 'coverage.json', { unmapped: { routes: 'route-live' } });
  const { outDir, files } = plant(repo, [
    ['unmapped_route', 'route-live'],
    ['unbound_endpoint', 'POST /claimed'],
  ]);
  const live = files.get('route-live') ?? '';
  const bytes = readFileSync(live);
  const result = await withAuthorityHostTestScope(() =>
    gcStaleInvariantCandidates({ ...options, outDir }),
  );
  expect(result).toMatchObject({ scanned: 2, kept: 1, stale: 1 });
  expect(result.evidence.map((entry) => entry.target_identifier)).toEqual(['POST /claimed']);
  expect(readFileSync(live)).toEqual(bytes);
  expect(existsSync(files.get('POST /claimed') ?? '')).toBe(false);
});

it('reports every malformed inventory input without generating or persisting candidates', () => {
  const repo = root();
  const options = claimedInventory(repo);
  write(repo, 'coverage.json', { unmapped: { routes: 'route-a' } });
  write(repo, 'handling.json', { tables: {} });
  write(repo, 'graph.json', { graph: { 'packages/a/src/a.ts': 7 } });
  write(repo, 'rbac.json', { unmapped: { endpointsWithoutRole: false } });
  const outDir = join(repo, 'candidates');
  const result = suggestInvariants({ ...options, outDir });
  expect(result.candidates).toEqual([]);
  expect(result.written_files).toEqual([]);
  expect(result.summary.unread_inputs).toEqual([
    'coverage.json',
    'handling.json',
    'graph.json',
    'rbac.json',
  ]);
  expect(existsSync(outDir)).toBe(false);
});
