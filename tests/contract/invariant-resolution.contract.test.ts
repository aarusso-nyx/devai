// ADR-SCR-0004 IA-002 (framework contract): every invariant record under law/invariants
// resolves through law/trace.json to at least one existing test path, no trace entry
// dangles, and every readiness-bearing invariant (Constitution Article 11: severity
// `constitutional`, `hard-fail`, or `gate`) is referenced by an executable test.
//
// The records are read live, so adding or removing an invariant record changes what this
// test demands: a new record without a trace entry fails, and a trace entry whose
// invariant record was removed fails as dangling.
//
// Interface assumptions the engineer (TASK-0233) must meet in law/trace.json:
//   - `invariants[]` holds one entry `{ id, tests[] }` per record in law/invariants
//     (30 today), shaped by law/schemas/trace.schema.json; `tests[].path` is
//     repository-relative and every listed path exists as a file.
//   - At least one `tests[]` entry per invariant names an existing file; for a
//     readiness-bearing invariant at least one entry is an executable test
//     (`target_type` absent or `test`), not only a config attestation or a script.
//   - "Referenced by a test" is accepted through EITHER mechanism, whichever the
//     engineer chooses:
//       (a) the trace: an `invariants[].tests[]` entry of target_type test whose path is
//           an existing test file, or a `test_corpus[]` entry whose `invariant_ids`
//           contains the id and whose path is an existing test file; or
//       (b) a marker: the invariant id appears in the title of an it/test/describe
//           call (the "marker convention" trace.schema.json names for tests[].names)
//           in a test file under tests/ or packages/*/tests. A bare id in a fixture or
//           comment is not a marker: fixtures already mention ids like INV-AUTH-001.
//     Either mechanism satisfies the readiness assertion; the per-id trace assertion
//     still requires every invariant, readiness-bearing or not, to have a trace entry.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const INVARIANTS_DIR = join(REPO_ROOT, 'law/invariants');
const TRACE_PATH = join(REPO_ROOT, 'law/trace.json');
const READINESS_BEARING = new Set(['constitutional', 'hard-fail', 'gate']);
const TEST_FILE_RE = /\.(?:test|spec)\.(?:[cm]?[jt]s|tsx)$/;

interface InvariantRecord {
  readonly id: string;
  readonly severity: string;
}

interface TraceTest {
  readonly suite?: string;
  readonly path?: string;
  readonly target_type?: string;
}

interface TraceFile {
  readonly invariants?: ReadonlyArray<{ readonly id?: string; readonly tests?: TraceTest[] }>;
  readonly test_corpus?: ReadonlyArray<{
    readonly path?: string;
    readonly invariant_ids?: readonly string[];
  }>;
}

function loadInvariants(): InvariantRecord[] {
  return readdirSync(INVARIANTS_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(INVARIANTS_DIR, file), 'utf8')) as InvariantRecord);
}

function isFile(rel: string): boolean {
  const abs = join(REPO_ROOT, rel);
  return existsSync(abs) && statSync(abs).isFile();
}

function isTestTarget(test: TraceTest): boolean {
  return (test.target_type ?? 'test') === 'test';
}

function walkTestFiles(dir: string, sink: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'fixtures') {
      continue;
    }
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walkTestFiles(abs, sink);
    else if (TEST_FILE_RE.test(entry.name)) sink.push(abs);
  }
}

function testSources(): ReadonlyArray<{ readonly path: string; readonly source: string }> {
  const files: string[] = [];
  walkTestFiles(join(REPO_ROOT, 'tests'), files);
  const packagesDir = join(REPO_ROOT, 'packages');
  for (const pkg of readdirSync(packagesDir)) walkTestFiles(join(packagesDir, pkg, 'tests'), files);
  return files.map((path) => ({ path, source: readFileSync(path, 'utf8') }));
}

const invariants = loadInvariants();
const trace = JSON.parse(readFileSync(TRACE_PATH, 'utf8')) as TraceFile;
const traceEntries = trace.invariants ?? [];
const traceById = new Map(traceEntries.map((entry) => [entry.id ?? '', entry]));
const readinessBearing = invariants.filter((inv) => READINESS_BEARING.has(inv.severity));

describe('ADR-SCR-0004 IA-002: every invariant resolves to an existing test', () => {
  it('reads the merged invariant population, readiness-bearing set non-empty', () => {
    // Article 11: resolving an empty readiness-bearing set is never a pass.
    expect(invariants.length).toBeGreaterThanOrEqual(30);
    expect(readinessBearing.length).toBeGreaterThanOrEqual(29);
    const ids = invariants.map((inv) => inv.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(invariants.map((inv) => [inv.id]))(
    '%s has a law/trace.json entry naming at least one existing test path',
    (id) => {
      const entry = traceById.get(id);
      expect(entry, `${id} has no entry in law/trace.json invariants[]`).toBeDefined();
      const tests = entry?.tests ?? [];
      const existing = tests.filter((t) => typeof t.path === 'string' && isFile(t.path));
      expect(
        existing.length,
        `${id} names no existing test path in law/trace.json`,
      ).toBeGreaterThan(0);
    },
  );

  it('law/trace.json has no dangling entry: every id is a record and every path exists', () => {
    const recordIds = new Set(invariants.map((inv) => inv.id));
    const unknownIds = traceEntries
      .map((entry) => entry.id ?? '<missing id>')
      .filter((id) => !recordIds.has(id));
    expect(unknownIds, 'trace entries naming no invariant record').toEqual([]);

    const missingPaths = traceEntries.flatMap((entry) =>
      (entry.tests ?? [])
        .filter((t) => typeof t.path !== 'string' || !isFile(t.path))
        .map((t) => `${entry.id ?? '<missing id>'} -> ${String(t.path)}`),
    );
    expect(missingPaths, 'trace test paths that do not exist').toEqual([]);

    const corpusMissing = (trace.test_corpus ?? [])
      .filter((row) => typeof row.path !== 'string' || !isFile(row.path))
      .map((row) => String(row.path));
    expect(corpusMissing, 'test_corpus paths that do not exist').toEqual([]);

    const ids = traceEntries.map((entry) => entry.id);
    expect(new Set(ids).size, 'duplicate trace entries').toBe(ids.length);
  });

  describe('every readiness-bearing invariant is referenced by a test', () => {
    const sources = testSources();

    it.each(readinessBearing.map((inv) => [inv.id, inv.severity]))(
      '%s (%s) is referenced by an executable test through the trace or a marker',
      (id) => {
        const viaTrace = (traceById.get(id)?.tests ?? []).some(
          (t) =>
            isTestTarget(t) &&
            typeof t.path === 'string' &&
            TEST_FILE_RE.test(t.path) &&
            isFile(t.path),
        );
        const viaCorpus = (trace.test_corpus ?? []).some(
          (row) =>
            (row.invariant_ids ?? []).includes(id) &&
            typeof row.path === 'string' &&
            TEST_FILE_RE.test(row.path) &&
            isFile(row.path),
        );
        const marker = new RegExp(
          `\\b(?:it|test|describe)(?:\\.\\w+)*\\(\\s*(['"\`])(?:(?!\\1)[^\\n])*\\b${id}\\b`,
        );
        const viaMarker = sources.some(({ source }) => marker.test(source));
        expect(
          viaTrace || viaCorpus || viaMarker,
          `${id} is readiness-bearing but no executable test references it`,
        ).toBe(true);
      },
    );

    it('the warn-severity invariant is still traced but is not readiness-bearing', () => {
      const warn = invariants.filter((inv) => !READINESS_BEARING.has(inv.severity));
      expect(warn.map((inv) => inv.id)).toContain('INV-PERF-001');
      for (const inv of warn) expect(traceById.has(inv.id), inv.id).toBe(true);
    });
  });
});
