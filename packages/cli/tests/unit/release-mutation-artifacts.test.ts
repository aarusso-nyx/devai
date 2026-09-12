import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { describe, expect, it, vi } from 'vitest';
import {
  finalizeReleaseMutationArtifactsV21,
  normalizeReleaseMutationPackageV21,
  type ReleaseMutationPackageInputsV21,
} from '../../src/services/release-mutation-artifacts.js';

vi.mock('node:child_process', () => ({
  execFileSync: () => {
    throw new Error('MUTATION_TEST_PROCESS_FORBIDDEN');
  },
  spawnSync: () => {
    throw new Error('MUTATION_TEST_PROCESS_FORBIDDEN');
  },
}));

const ROOT = resolve(import.meta.dirname, '../../../..');
const RAW_CWD = '/Volumes/trusted host ç/candidate/packages/package';
const STATUS = [
  'CompileError',
  'Ignored',
  'Killed',
  'NoCoverage',
  'Pending',
  'RuntimeError',
  'Survived',
  'Timeout',
] as const;
const SOURCE = "export const apiKey = 'fixture-credential-do-not-retain';\n";
const TEST_SOURCE = "expect('fixture-test-credential-do-not-retain').toBeDefined();\n";
const RAW_SECRET = 'fixture-config-credential-do-not-retain';
const RAW_REASON = `${RAW_CWD}/status-reason-do-not-retain`;
const REPLACEMENT = 'fixture-replacement-credential-do-not-retain';

interface RawMutant {
  id: string;
  mutatorName: string;
  replacement: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
  status: (typeof STATUS)[number];
  statusReason: string;
}

interface RawReport {
  schemaVersion: string;
  projectRoot: string;
  framework: { name: string; version: string; branding: { homepageUrl: string } };
  thresholds: { break: number; high: number; low: number };
  files: Record<string, { language: string; source: string; mutants: RawMutant[] }>;
  testFiles: Record<string, { source: string; tests: unknown[] }>;
  config: Record<string, unknown>;
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

const EXPECTED: ReleaseMutationPackageInputsV21 = {
  packageName: '@fixture/package',
  workspace: 'packages/package',
  inputProjection: {
    schemaVersion: '2.1.0',
    kind: 'mutation-input-projection-v2',
    packageName: '@fixture/package',
    workspace: 'packages/package',
    bindings: Object.fromEntries(
      [
        'source',
        'tests',
        'manifests',
        'mutationConfiguration',
        'runner',
        'roster',
        'thresholds',
        'sanitizer',
        'lockfile',
        'environment',
        'toolchain',
        'semanticRebind',
      ].map((name) => [
        name,
        {
          canonicalization: 'rfc8785-jcs-utf8',
          memberCount: 1,
          populationDigest: sha256(`population:${name}`),
          selectionRuleDigest: sha256(`selection:${name}`),
        },
      ]),
    ),
  },
  thresholds: {
    break: 60,
    high: 60,
    low: 60,
    scoreMin: 60,
    survivedMax: Number.MAX_SAFE_INTEGER,
  },
  toolVersions: { stryker: '9.6.1', node: '24.20.0', vitest: '4.1.10' },
};

function rawReport(statuses: readonly (typeof STATUS)[number][]): RawReport {
  return {
    schemaVersion: '1.0',
    projectRoot: RAW_CWD,
    framework: {
      name: 'StrykerJS',
      version: '9.6.1',
      branding: { homepageUrl: 'https://stryker-mutator.io' },
    },
    thresholds: { break: 60, high: 60, low: 60 },
    files: {
      'src/value.ts': {
        language: 'typescript',
        source: SOURCE,
        mutants: statuses.map((status, index) => ({
          id: String(index),
          mutatorName: 'BooleanLiteral',
          replacement: REPLACEMENT,
          location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
          status,
          statusReason: RAW_REASON,
        })),
      },
    },
    testFiles: { 'tests/value.test.ts': { source: TEST_SOURCE, tests: [] } },
    config: { secret: RAW_SECRET },
  };
}

/** Fixed instrumenter-side fixture data: never inferred from a raw result under test. */
function emittedSources(ids: readonly string[] = ['0', '1', '2']) {
  return [
    {
      path: 'src/value.ts',
      sha256: sha256(SOURCE),
      mutants: ids.map((id) => ({
        id,
        mutatorName: 'BooleanLiteral',
        replacementDigest: sha256(REPLACEMENT),
        location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
      })),
    },
  ];
}

function controls(
  report = rawReport(['Killed', 'Killed', 'Survived']),
  overrides: Record<string, unknown> = {},
  emittedIds: readonly string[] = ['0', '1', '2'],
) {
  return {
    expected: EXPECTED,
    raw_report: Buffer.from(JSON.stringify(report)),
    execution_cwd: RAW_CWD,
    process: { errorAbsent: true, signal: null, status: 0 },
    source_files: emittedSources(emittedIds),
    test_files: ['tests/value.test.ts'],
    limits: {
      maximum_raw_report_bytes: 100_000,
      maximum_document_bytes: 100_000,
      maximum_files: 10,
      maximum_mutants: 100,
    },
    ...overrides,
  };
}

function json(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
}

function normalized(
  report = rawReport(['Killed', 'Killed', 'Survived']),
  overrides: Record<string, unknown> = {},
  emittedIds: readonly string[] = ['0', '1', '2'],
) {
  return normalizeReleaseMutationPackageV21(controls(report, overrides, emittedIds));
}

function finalizerInput(artifacts = normalized()) {
  const policy = JSON.parse(
    readFileSync(join(ROOT, 'law/policy/mutation-evidence-v2.json'), 'utf8'),
  ) as Record<string, unknown>;
  return {
    candidate: { releaseUnit: 'fixture/repository', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    releasePlanReceiptDigest: 'c'.repeat(64),
    releaseProfileDigest: 'd'.repeat(64),
    policyDigest: canonicalSha256(policy),
    summaryPath: 'mutation/summary.json',
    semanticReceiptPath: 'mutation/semantic-receipt.json',
    expected: [EXPECTED],
    packages: [
      {
        packageName: EXPECTED.packageName,
        disposition: 'executed' as const,
        origin: null,
        artifacts,
      },
    ],
    maximum_document_bytes: 100_000,
  };
}

function readdressResult(artifacts: ReturnType<typeof normalized>, value: Record<string, unknown>) {
  const bytes = Buffer.from(canonicalJson(value));
  const digest = sha256(bytes);
  return {
    ...artifacts,
    result: {
      path: `.devai/state/mutation/v2/store/inputs/${artifacts.inputDigest}/objects/${digest}.result.json`,
      sha256: digest,
      bytes,
    },
  };
}

describe('release mutation artifact normalization v2.1', () => {
  it('normalizes the raw Stryker 1.0 report into canonical v2.1 addressed artifacts', () => {
    const artifacts = normalized();
    const report = json(artifacts.report.bytes);
    const result = json(artifacts.result.bytes);

    expect(artifacts.inputDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(artifacts.report.path).toBe(
      `.devai/state/mutation/v2/store/inputs/${artifacts.inputDigest}/objects/${artifacts.report.sha256}.report.json`,
    );
    expect(artifacts.result.path).toBe(
      `.devai/state/mutation/v2/store/inputs/${artifacts.inputDigest}/objects/${artifacts.result.sha256}.result.json`,
    );
    expect(report).toMatchObject({
      schemaVersion: '2.1.0',
      kind: 'mutation-normalized-stryker-report-v2',
      strykerSchemaVersion: '1',
      projectRoot: '.',
      framework: { name: 'StrykerJS' },
      config: {},
    });
    expect(result).toMatchObject({
      schemaVersion: '2.1.0',
      kind: 'mutation-package-result-v2',
      packageName: '@fixture/package',
      workspace: 'packages/package',
      inputDigest: artifacts.inputDigest,
      reportDigest: artifacts.report.sha256,
      targetCensus: { targetFileCount: 1, totalMutants: 3 },
      complete: true,
      passed: true,
    });
    expect(result.score).toBeCloseTo((2 / 3) * 100);
  });

  it('retains all eight status counts and treats incomplete statuses as nonpassing', () => {
    const artifacts = normalized(rawReport(STATUS), {}, ['0', '1', '2', '3', '4', '5', '6', '7']);
    const result = json(artifacts.result.bytes);

    expect(result.statusTotals).toEqual(Object.fromEntries(STATUS.map((status) => [status, 1])));
    expect(result.targetCensus).toEqual({ targetFileCount: 1, totalMutants: 8 });
    expect(result.complete).toBe(false);
    expect(result.passed).toBe(false);
  });

  it.each([
    { errorAbsent: false, signal: null, status: 0 },
    { errorAbsent: true, signal: 'SIGTERM', status: null },
    { errorAbsent: true, signal: null, status: 1 },
  ])('makes a failed process nonpassing: %j', (process) => {
    const result = json(normalized(rawReport(['Killed']), { process }, ['0']).result.bytes);
    expect(result.process).toEqual(process);
    expect(result.complete).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('makes a zero-mutant census unknown rather than a passing score', () => {
    const empty = rawReport([]);
    empty.files = {};
    empty.testFiles = {};
    const result = json(normalized(empty, { source_files: [], test_files: [] }).result.bytes);

    expect(result.targetCensus).toEqual({ targetFileCount: 0, totalMutants: 0 });
    expect(result.score).toBe(100);
    expect(result.complete).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('does not promote an unscored CompileError-only population despite its 100 sentinel score', () => {
    const result = json(normalized(rawReport(['CompileError']), {}, ['0']).result.bytes);

    expect(result.targetCensus).toEqual({ targetFileCount: 1, totalMutants: 1 });
    expect(result.statusTotals).toEqual({
      CompileError: 1,
      Ignored: 0,
      Killed: 0,
      NoCoverage: 0,
      Pending: 0,
      RuntimeError: 0,
      Survived: 0,
      Timeout: 0,
    });
    expect(result.score).toBe(100);
    expect(result.complete).toBe(false);
    expect(result.passed).toBe(false);
  });

  it.each([
    { statuses: ['Timeout', 'Survived'] as const, score: 50 },
    { statuses: ['Killed', 'NoCoverage'] as const, score: 50 },
  ])('computes the score-bearing population for $statuses', ({ statuses, score }) => {
    const result = json(normalized(rawReport(statuses), {}, ['0', '1']).result.bytes);
    expect(result.score).toBe(score);
    expect(result.complete).toBe(true);
  });

  it('makes a signalled status-zero process incomplete', () => {
    const result = json(
      normalized(
        rawReport(['Killed']),
        { process: { errorAbsent: true, signal: 'SIGTERM', status: 0 } },
        ['0'],
      ).result.bytes,
    );
    expect(result.complete).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('refuses a runtime error even when the scored population clears every threshold', () => {
    const result = json(
      normalized(rawReport(['Killed', 'RuntimeError']), {}, ['0', '1']).result.bytes,
    );
    expect(result.complete).toBe(true);
    expect(result.score).toBe(100);
    expect(result.passed).toBe(false);
  });

  it.each([
    {
      name: 'exact score and survivor ceilings',
      statuses: ['Killed', 'Survived'] as const,
      thresholds: { break: 50, high: 60, low: 50, scoreMin: 50, survivedMax: 1 },
      passed: true,
    },
    {
      name: 'stricter score minimum',
      statuses: ['Killed', 'Survived'] as const,
      thresholds: { break: 40, high: 60, low: 40, scoreMin: 60, survivedMax: 1 },
      passed: false,
    },
    {
      name: 'survivor ceiling exceeded',
      statuses: ['Killed', 'Survived', 'Survived'] as const,
      thresholds: { break: 0, high: 60, low: 0, scoreMin: 0, survivedMax: 1 },
      passed: false,
    },
  ])('enforces $name', ({ statuses, thresholds, passed }) => {
    const report = rawReport(statuses);
    report.thresholds = {
      break: thresholds.break,
      high: thresholds.high,
      low: thresholds.low,
    };
    const expected = { ...EXPECTED, thresholds };
    const result = json(
      normalized(
        report,
        { expected },
        statuses.map((_, index) => String(index)),
      ).result.bytes,
    );
    expect(result.passed).toBe(passed);
  });

  it('keeps survivor counts reportable but non-blocking under the current compatibility sentinel', () => {
    const statuses = [
      ...Array.from({ length: 90 }, () => 'Killed' as const),
      ...Array.from({ length: 60 }, () => 'Survived' as const),
    ];
    const ids = statuses.map((_, index) => String(index));
    const result = json(
      normalized(
        rawReport(statuses),
        {
          limits: {
            maximum_raw_report_bytes: 100_000,
            maximum_document_bytes: 100_000,
            maximum_files: 10,
            maximum_mutants: 200,
          },
        },
        ids,
      ).result.bytes,
    );

    expect(result).toMatchObject({ score: 60, passed: true });
    expect(result.statusTotals).toMatchObject({ Survived: 60 });
  });

  it.each([
    ['missing', 'MUTATION_ROSTER_MISMATCH'],
    ['added', 'MUTATION_ROSTER_MISMATCH'],
    ['id', 'MUTATION_ROSTER_MISMATCH'],
    ['mutatorName', 'MUTATION_INPUT_DIGEST_MISMATCH'],
    ['replacement', 'MUTATION_INPUT_DIGEST_MISMATCH'],
    ['location', 'MUTATION_INPUT_DIGEST_MISMATCH'],
  ] as const)(
    'refuses raw mutant %s drift against the unchanged independent census',
    (change, code) => {
      const discovery = emittedSources();
      const capturedDiscovery = canonicalSha256(discovery);
      const report = rawReport(['Killed', 'Killed', 'Survived']);
      const mutants = report.files['src/value.ts']?.mutants;
      const first = mutants?.[0];
      if (mutants === undefined || first === undefined) throw new Error('fixture mutants missing');
      switch (change) {
        case 'missing':
          mutants.pop();
          break;
        case 'added':
          mutants.push({ ...first, id: '3' });
          break;
        case 'id':
          first.id = 'different-id';
          break;
        case 'mutatorName':
          first.mutatorName = 'StringLiteral';
          break;
        case 'replacement':
          first.replacement = 'altered replacement';
          break;
        case 'location':
          first.location.end.column = 3;
          break;
      }
      expect(() => normalized(report, { source_files: discovery })).toThrow(code);
      expect(canonicalSha256(discovery)).toBe(capturedDiscovery);
    },
  );

  it('refuses duplicate, missing, empty, or extended instrumenter-side mutant declarations', () => {
    const duplicate = emittedSources(['0', '0', '2']);
    const empty = emittedSources([]);
    const missing = emittedSources().map(({ path, sha256 }) => ({ path, sha256 }));
    const extended = emittedSources().map((entry) => ({
      ...entry,
      mutants: entry.mutants.map((mutant) => ({ ...mutant, status: 'Killed' })),
    }));
    for (const source_files of [duplicate, empty, missing, extended]) {
      expect(() =>
        normalized(rawReport(['Killed', 'Killed', 'Survived']), { source_files }),
      ).toThrow('MUTATION_REPORT_INVALID');
    }
  });

  it('rejects accessors in independent discovery without evaluating them', () => {
    const discovery = emittedSources();
    const first = discovery[0]?.mutants[0];
    if (first === undefined) throw new Error('fixture discovery missing');
    const read = vi.fn(() => '0');
    Object.defineProperty(first, 'id', { enumerable: true, get: read });
    expect(() =>
      normalized(rawReport(['Killed', 'Killed', 'Survived']), { source_files: discovery }),
    ).toThrow('MUTATION_REPORT_INVALID');
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['record', 'array'] as const)(
    'recursively rejects an accessor nested in a protected input %s without evaluating it',
    (container) => {
      const read = vi.fn(() => 'forbidden');
      const member = {} as Record<string, unknown>;
      Object.defineProperty(member, 'value', { enumerable: true, get: read });
      const injected = container === 'array' ? [member] : { member };
      const expected = {
        ...EXPECTED,
        inputProjection: { ...EXPECTED.inputProjection, injected },
      };

      expect(() => normalized(undefined, { expected })).toThrow('MUTATION_REPORT_INVALID');
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each(
    (['start', 'end'] as const).flatMap((endpoint) =>
      (['line', 'column'] as const).flatMap((coordinate) =>
        [0, -1, Number.MAX_SAFE_INTEGER + 1].map((value) => ({ endpoint, coordinate, value })),
      ),
    ),
  )(
    'refuses matching raw/discovery $endpoint.$coordinate=$value before raw validation',
    ({ endpoint, coordinate, value }) => {
      const report = rawReport(['Killed', 'Killed', 'Survived']);
      const discovery = emittedSources();
      const raw = report.files['src/value.ts']?.mutants[0];
      const emitted = discovery[0]?.mutants[0];
      if (raw === undefined || emitted === undefined) throw new Error('fixture mutant missing');
      raw.location[endpoint][coordinate] = value;
      emitted.location[endpoint][coordinate] = value;
      expect(raw.location).toEqual(emitted.location);
      expect(() => normalized(report, { source_files: discovery })).toThrow(
        'MUTATION_REPORT_INVALID',
      );
      report.schemaVersion = 'unsupported';
      expect(() => normalized(report, { source_files: discovery })).toThrow(
        'MUTATION_REPORT_INVALID',
      );
    },
  );

  it.each([
    'reversed-line',
    'reversed-column',
    'extra-location',
    'extra-start',
    'extra-end',
  ] as const)('refuses matching raw/discovery %s before raw validation', (change) => {
    const report = rawReport(['Killed', 'Killed', 'Survived']);
    const discovery = emittedSources();
    const raw = report.files['src/value.ts']?.mutants[0];
    const emitted = discovery[0]?.mutants[0];
    if (raw === undefined || emitted === undefined) throw new Error('fixture mutant missing');
    for (const mutant of [raw, emitted]) {
      switch (change) {
        case 'reversed-line':
          mutant.location.start.line = 2;
          break;
        case 'reversed-column':
          mutant.location.start.column = 3;
          break;
        case 'extra-location':
          Object.assign(mutant.location, { offset: 0 });
          break;
        case 'extra-start':
          Object.assign(mutant.location.start, { offset: 0 });
          break;
        case 'extra-end':
          Object.assign(mutant.location.end, { offset: 0 });
          break;
      }
    }
    expect(raw.location).toEqual(emitted.location);
    expect(() => normalized(report, { source_files: discovery })).toThrow(
      'MUTATION_REPORT_INVALID',
    );
    report.schemaVersion = 'unsupported';
    expect(() => normalized(report, { source_files: discovery })).toThrow(
      'MUTATION_REPORT_INVALID',
    );
  });

  it.each([
    0,
    null,
    ['BooleanLiteral'],
    '',
    'x'.repeat(161),
    'Bad/Name',
    'Bad\\Name',
    'Bad\u0000Name',
  ])(
    'refuses matching raw/discovery invalid mutator name %j before raw validation',
    (mutatorName) => {
      const report = rawReport(['Killed', 'Killed', 'Survived']);
      const discovery = emittedSources();
      const raw = report.files['src/value.ts']?.mutants[0];
      const emitted = discovery[0]?.mutants[0];
      if (raw === undefined || emitted === undefined) throw new Error('fixture mutant missing');
      Object.assign(raw, { mutatorName });
      Object.assign(emitted, { mutatorName });
      expect(raw.mutatorName).toEqual(emitted.mutatorName);
      expect(() => normalized(report, { source_files: discovery })).toThrow(
        'MUTATION_REPORT_INVALID',
      );
      report.schemaVersion = 'unsupported';
      expect(() => normalized(report, { source_files: discovery })).toThrow(
        'MUTATION_REPORT_INVALID',
      );
    },
  );

  it('accepts reordered exact file and mutant censuses with identical canonical artifacts', () => {
    const report = rawReport(['Killed', 'Killed', 'Survived']);
    const otherReport = rawReport(['Killed']);
    const otherFile = otherReport.files['src/value.ts'];
    const otherMutant = otherFile?.mutants[0];
    const otherDiscovery = emittedSources(['other-0'])[0];
    if (otherFile === undefined || otherMutant === undefined || otherDiscovery === undefined)
      throw new Error('fixture other file missing');
    otherMutant.id = 'other-0';
    report.files['src/other.ts'] = otherFile;
    const discovery = [...emittedSources(), { ...otherDiscovery, path: 'src/other.ts' }];
    const initial = normalized(report, { source_files: discovery });
    report.files = Object.fromEntries(
      Object.entries(report.files)
        .reverse()
        .map(([path, file]) => [path, { ...file, mutants: [...file.mutants].reverse() }]),
    );
    const reordered = [...discovery]
      .reverse()
      .map((entry) => ({ ...entry, mutants: [...entry.mutants].reverse() }));
    expect(normalized(report, { source_files: reordered })).toEqual(initial);
  });

  it('keeps legitimately zero-emission selected source outside the emitted mutant census', () => {
    const selected = [
      { path: 'src/value.ts', sha256: sha256(SOURCE) },
      {
        path: 'src/zero.ts',
        sha256: sha256('export interface Zero { readonly value: boolean }\n'),
      },
    ];
    const bindings = EXPECTED.inputProjection['bindings'] as Record<
      string,
      Record<string, unknown>
    >;
    const expected = {
      ...EXPECTED,
      inputProjection: {
        ...EXPECTED.inputProjection,
        bindings: {
          ...bindings,
          source: {
            ...bindings['source'],
            memberCount: selected.length,
            populationDigest: canonicalSha256(selected),
          },
        },
      },
    };
    const artifacts = normalized(rawReport(['Killed', 'Killed', 'Survived']), { expected });
    expect(Object.keys(json(artifacts.report.bytes)['files'] as Record<string, unknown>)).toEqual([
      'src/value.ts',
    ]);
    expect(json(artifacts.result.bytes)).toMatchObject({
      targetCensus: { targetFileCount: 1, totalMutants: 3 },
      complete: true,
      passed: true,
    });
    expect(
      (json(artifacts.result.bytes)['inputProjection'] as Record<string, unknown>)['bindings'],
    ).toEqual(expected.inputProjection.bindings);
    expect(emittedSources().some((entry) => entry.path === 'src/zero.ts')).toBe(false);
  });

  it('refuses malformed roots, source/roster drift, duplicate mutants, and size quotas', () => {
    const malformedVersion = rawReport(['Killed']);
    malformedVersion.schemaVersion = '1.0.0';
    const duplicate = rawReport(['Killed', 'Killed']);
    const duplicateFile = duplicate.files['src/value.ts'];
    const duplicateMutant = duplicateFile?.mutants[1];
    if (duplicateMutant === undefined) throw new Error('duplicate fixture mutant missing');
    duplicateMutant.id = '0';
    const extra = rawReport(['Killed']);
    const sourceFile = extra.files['src/value.ts'];
    if (sourceFile === undefined) throw new Error('extra fixture source missing');
    extra.files['src/extra.ts'] = {
      ...sourceFile,
      source: 'export const extra = true;\n',
    };

    expect(() => normalized(malformedVersion)).toThrow('MUTATION_VERSION_UNSUPPORTED');
    expect(() => normalized(rawReport(['Killed']), { execution_cwd: '/wrong' })).toThrow(
      'MUTATION_INPUT_DIGEST_MISMATCH',
    );
    expect(() =>
      normalized(rawReport(['Killed']), {
        source_files: emittedSources(['0']).map((entry) => ({ ...entry, sha256: '0'.repeat(64) })),
      }),
    ).toThrow('MUTATION_INPUT_DIGEST_MISMATCH');
    expect(() => normalized(extra)).toThrow('MUTATION_ROSTER_MISMATCH');
    expect(() => normalized(duplicate)).toThrow('MUTATION_REPORT_INVALID');
    expect(() =>
      normalized(rawReport(['Killed', 'Survived']), {
        limits: { ...controls().limits, maximum_mutants: 1 },
      }),
    ).toThrow('MUTATION_REPORT_INVALID');
    expect(() =>
      normalized(rawReport(['Killed']), {
        limits: { ...controls().limits, maximum_raw_report_bytes: 1 },
      }),
    ).toThrow('MUTATION_REPORT_INVALID');
  });

  it('binds raw report kind, framework identity, and thresholds independently', () => {
    const withKind = rawReport(['Killed']);
    Object.assign(withKind, { kind: 'mutation-normalized-stryker-report-v2' });
    expect(() => normalized(withKind, {}, ['0'])).toThrow('MUTATION_VERSION_UNSUPPORTED');

    const wrongFramework = rawReport(['Killed']);
    wrongFramework.framework.name = 'CompatibleStryker';
    expect(() => normalized(wrongFramework, {}, ['0'])).toThrow('MUTATION_VERSION_UNSUPPORTED');

    const wrongVersion = rawReport(['Killed']);
    wrongVersion.framework.version = '9.6.2';
    expect(() => normalized(wrongVersion, {}, ['0'])).toThrow('MUTATION_VERSION_UNSUPPORTED');

    const wrongThresholds = rawReport(['Killed']);
    wrongThresholds.thresholds.high = 61;
    expect(() => normalized(wrongThresholds, {}, ['0'])).toThrow('MUTATION_THRESHOLD_MISMATCH');
  });

  it.each([
    ['relative/package', 'MUTATION_INPUT_DIGEST_MISMATCH'],
    ['/trusted/../alternate/package', 'MUTATION_REPORT_INVALID'],
  ])('refuses a matching but noncanonical execution root %j', (execution_cwd, error) => {
    const report = rawReport(['Killed']);
    report.projectRoot = execution_cwd;
    expect(() => normalized(report, { execution_cwd }, ['0'])).toThrow(error);
  });

  it('binds raw file membership, language, complete mutant ids, and test paths independently', () => {
    const emptyRoster = rawReport(['Killed']);
    emptyRoster.files = {};
    expect(() => normalized(emptyRoster, {}, ['0'])).toThrow('MUTATION_ROSTER_MISMATCH');

    const wrongLanguage = rawReport(['Killed']);
    const source = wrongLanguage.files['src/value.ts'];
    if (source === undefined) throw new Error('source fixture missing');
    source.language = 'json';
    expect(() => normalized(wrongLanguage, {}, ['0'])).toThrow('MUTATION_REPORT_INVALID');

    const javascript = rawReport(['Killed']);
    const javascriptSource = javascript.files['src/value.ts'];
    if (javascriptSource === undefined) throw new Error('source fixture missing');
    javascriptSource.language = 'javascript';
    expect(
      (json(normalized(javascript, {}, ['0']).report.bytes)['files'] as Record<string, unknown>)[
        'src/value.ts'
      ],
    ).toMatchObject({ language: 'javascript' });

    for (const id of ['/leading-slash', 'trailing-slash/']) {
      const invalidId = rawReport(['Killed']);
      const mutant = invalidId.files['src/value.ts']?.mutants[0];
      if (mutant === undefined) throw new Error('mutant fixture missing');
      mutant.id = id;
      expect(() => normalized(invalidId, {}, [id])).toThrow('MUTATION_REPORT_INVALID');
    }

    const undeclaredTest = rawReport(['Killed']);
    undeclaredTest.testFiles['tests/other.test.ts'] = { source: '', tests: [] };
    expect(() => normalized(undeclaredTest, {}, ['0'])).toThrow('MUTATION_INPUT_DIGEST_MISMATCH');
  });

  it.each([
    '',
    '/src/value.ts',
    'C:/src/value.ts',
    'src\\value.ts',
    'src/\u0000value.ts',
    'src//value.ts',
    'src/./value.ts',
    'src/../value.ts',
    'src/e\u0301.ts',
  ])('refuses noncanonical or unsafe producer path %j', (unsafePath) => {
    const report = rawReport(['Killed']);
    const file = report.files['src/value.ts'];
    const discovery = emittedSources(['0'])[0];
    if (file === undefined || discovery === undefined) throw new Error('fixture source missing');
    report.files = { [unsafePath]: file };

    expect(() =>
      normalized(report, {
        source_files: [{ ...discovery, path: unsafePath }],
      }),
    ).toThrow('MUTATION_REPORT_INVALID');
  });

  it.each([null, 'not-an-object', []])(
    'refuses non-record protected package input %j',
    (expected) => {
      expect(() => normalized(undefined, { expected })).toThrow('MUTATION_REPORT_INVALID');
    },
  );

  it('refuses exotic, oversized, and extended protected source populations', () => {
    const exotic = emittedSources(['0']);
    Object.setPrototypeOf(exotic, null);
    const extended = emittedSources(['0']);
    Object.defineProperty(extended, 'extra', { enumerable: true, value: true });

    expect(() => normalized(rawReport(['Killed']), { source_files: {} })).toThrow(
      'MUTATION_REPORT_INVALID',
    );
    expect(() => normalized(rawReport(['Killed']), { source_files: exotic })).toThrow(
      'MUTATION_REPORT_INVALID',
    );
    expect(() =>
      normalized(rawReport(['Killed']), {
        source_files: emittedSources(['0']),
        limits: { ...controls().limits, maximum_files: 1 },
        test_files: ['tests/value.test.ts', 'tests/other.test.ts'],
      }),
    ).toThrow('MUTATION_REPORT_INVALID');
    expect(() => normalized(rawReport(['Killed']), { source_files: extended })).toThrow(
      'MUTATION_REPORT_INVALID',
    );
  });

  it('accepts source and test populations exactly at the protected file quota', () => {
    expect(
      normalized(rawReport(['Killed']), {
        source_files: emittedSources(['0']),
        limits: { ...controls().limits, maximum_files: 1 },
      }),
    ).toMatchObject({ inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });

  it('accepts the inclusive upper bound for every protected artifact limit', () => {
    expect(
      normalized(undefined, {
        limits: {
          maximum_raw_report_bytes: 0x7fffffff,
          maximum_document_bytes: 0x7fffffff,
          maximum_files: 0x7fffffff,
          maximum_mutants: 0x7fffffff,
        },
      }),
    ).toMatchObject({ inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });

  it('enforces result and report document limits independently at their exact boundaries', () => {
    const compact = normalized();
    expect(compact.result.bytes.byteLength).toBeGreaterThan(compact.report.bytes.byteLength);
    expect(
      normalized(undefined, {
        limits: {
          ...controls().limits,
          maximum_document_bytes: compact.result.bytes.byteLength,
        },
      }),
    ).toEqual(compact);
    expect(() =>
      normalized(undefined, {
        limits: {
          ...controls().limits,
          maximum_document_bytes: compact.result.bytes.byteLength - 1,
        },
      }),
    ).toThrow('MUTATION_REPORT_INVALID');

    const statuses = Array.from({ length: 100 }, () => 'Killed' as const);
    const ids = statuses.map((_, index) => String(index));
    const report = rawReport(statuses);
    const expanded = normalized(report, {}, ids);
    expect(expanded.report.bytes.byteLength).toBeGreaterThan(expanded.result.bytes.byteLength);
    expect(
      normalized(
        report,
        {
          limits: {
            ...controls().limits,
            maximum_document_bytes: expanded.report.bytes.byteLength,
          },
        },
        ids,
      ),
    ).toEqual(expanded);
    expect(() =>
      normalized(
        report,
        {
          limits: {
            ...controls().limits,
            maximum_document_bytes: expanded.report.bytes.byteLength - 1,
          },
        },
        ids,
      ),
    ).toThrow('MUTATION_REPORT_INVALID');
  });

  it('accepts a raw report exactly at the protected byte quota', () => {
    const report = rawReport(['Killed']);
    const raw_report = Buffer.from(JSON.stringify(report));
    expect(
      normalized(report, {
        raw_report,
        source_files: emittedSources(['0']),
        limits: { ...controls().limits, maximum_raw_report_bytes: raw_report.byteLength },
      }),
    ).toMatchObject({ inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });

  it('refuses to coerce a string into protected raw-report bytes', () => {
    const report = rawReport(['Killed']);
    expect(() =>
      normalized(report, {
        raw_report: JSON.stringify(report),
        source_files: emittedSources(['0']),
      }),
    ).toThrow('MUTATION_REPORT_INVALID');
  });

  it('refuses malformed UTF-8 even when it occurs only in discarded raw configuration', () => {
    const report = rawReport(['Killed']);
    const raw_report = Buffer.from(JSON.stringify(report));
    const offset = raw_report.indexOf(Buffer.from(RAW_SECRET));
    if (offset < 0) throw new Error('fixture raw configuration missing');
    raw_report[offset] = 0xff;

    expect(() => normalized(report, { raw_report, source_files: emittedSources(['0']) })).toThrow(
      'MUTATION_REPORT_INVALID',
    );
  });

  it('refuses a fully matching source and test population above the protected file quota', () => {
    const report = rawReport(['Killed']);
    report.testFiles['tests/other.test.ts'] = { source: TEST_SOURCE, tests: [] };
    expect(() =>
      normalized(report, {
        source_files: emittedSources(['0']),
        test_files: ['tests/value.test.ts', 'tests/other.test.ts'],
        limits: { ...controls().limits, maximum_files: 1 },
      }),
    ).toThrow('MUTATION_REPORT_INVALID');
  });

  it('retains the machine-readable refusal code on producer-boundary failures', () => {
    try {
      normalized(rawReport(['Killed']), {
        source_files: emittedSources(['0']),
        limits: { ...controls().limits, maximum_files: 0 },
      });
      throw new Error('expected protected producer-boundary refusal');
    } catch (error) {
      expect(error).toMatchObject({
        message: 'MUTATION_REPORT_INVALID',
        code: 'MUTATION_REPORT_INVALID',
      });
    }
  });

  it('refuses malformed and duplicate independent source identities', () => {
    const malformed = emittedSources();
    if (malformed[0] === undefined) throw new Error('fixture source missing');
    malformed[0].sha256 = 'not-a-digest';
    expect(() => normalized(undefined, { source_files: malformed })).toThrow(
      'MUTATION_REPORT_INVALID',
    );

    const source = emittedSources();
    expect(() => normalized(undefined, { source_files: [...source, ...source] })).toThrow(
      'MUTATION_REPORT_INVALID',
    );
  });

  it('enforces the aggregate mutant quota across independently emitted source files', () => {
    const report = rawReport(['Killed']);
    const original = emittedSources(['0'])[0];
    if (original === undefined) throw new Error('fixture source missing');
    const otherSource = 'export const other = true;\n';
    const otherMutant = { ...original.mutants[0], id: 'other-0' };
    if (otherMutant.mutatorName === undefined) throw new Error('fixture mutant missing');
    report.files['src/other.ts'] = {
      language: 'typescript',
      source: otherSource,
      mutants: [
        {
          id: otherMutant.id,
          mutatorName: otherMutant.mutatorName,
          replacement: REPLACEMENT,
          location: otherMutant.location,
          status: 'Killed',
          statusReason: RAW_REASON,
        },
      ],
    };
    const source_files = [
      original,
      { path: 'src/other.ts', sha256: sha256(otherSource), mutants: [otherMutant] },
    ];

    expect(
      normalized(report, {
        source_files,
        limits: { ...controls().limits, maximum_mutants: 2 },
      }),
    ).toMatchObject({ inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) });

    expect(() =>
      normalized(report, {
        source_files,
        limits: { ...controls().limits, maximum_mutants: 1 },
      }),
    ).toThrow('MUTATION_REPORT_INVALID');
  });

  it('refuses a duplicate protected test population', () => {
    expect(() =>
      normalized(undefined, { test_files: ['tests/value.test.ts', 'tests/value.test.ts'] }),
    ).toThrow('MUTATION_REPORT_INVALID');
  });

  it('accepts exact coordinate and mutator-name boundaries from independent discovery', () => {
    const report = rawReport(['Killed']);
    const discovery = emittedSources(['0']);
    const raw = report.files['src/value.ts']?.mutants[0];
    const emitted = discovery[0]?.mutants[0];
    if (raw === undefined || emitted === undefined) throw new Error('fixture mutant missing');
    raw.mutatorName = 'M'.repeat(160);
    emitted.mutatorName = raw.mutatorName;
    raw.location.end = { ...raw.location.start };
    emitted.location.end = { ...emitted.location.start };

    expect(normalized(report, { source_files: discovery })).toMatchObject({
      inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it('preserves roster refusals while coercing unexpected protected-input failures', () => {
    const invalidPackage = {
      ...EXPECTED,
      packageName: 'fixture/package',
      inputProjection: { ...EXPECTED.inputProjection, packageName: 'fixture/package' },
    };
    expect(() => normalized(undefined, { expected: invalidPackage })).toThrow(
      'MUTATION_ROSTER_MISMATCH',
    );

    const hostileExpected = { ...EXPECTED };
    Object.defineProperty(hostileExpected, 'packageName', {
      enumerable: true,
      get: () => {
        throw new Error('HOSTILE_PROTECTED_INPUT');
      },
    });
    expect(() => normalized(undefined, { expected: hostileExpected })).toThrow(
      'MUTATION_REPORT_INVALID',
    );
    expect(() => normalized(undefined, { expected: hostileExpected })).not.toThrow(
      'HOSTILE_PROTECTED_INPUT',
    );
  });

  it('binds replacement digests, cross-line coordinates, and a nonempty emitted census', () => {
    const invalidDigest = emittedSources();
    const first = invalidDigest[0]?.mutants[0];
    if (first === undefined) throw new Error('fixture mutant missing');
    invalidDigest[0] = {
      ...invalidDigest[0],
      mutants: [
        { ...first, replacementDigest: 'not-a-digest' },
        ...invalidDigest[0].mutants.slice(1),
      ],
    };
    expect(() => normalized(undefined, { source_files: invalidDigest })).toThrow(
      'MUTATION_REPORT_INVALID',
    );

    const report = rawReport(['Killed']);
    const crossLine = emittedSources(['0']);
    const raw = report.files['src/value.ts']?.mutants[0];
    const discovered = crossLine[0]?.mutants[0];
    if (raw === undefined || discovered === undefined) throw new Error('fixture mutant missing');
    raw.location = { start: { line: 1, column: 20 }, end: { line: 2, column: 1 } };
    crossLine[0] = {
      ...crossLine[0],
      mutants: [{ ...discovered, location: raw.location }],
    };
    expect(normalized(report, { source_files: crossLine }, ['0'])).toMatchObject({
      inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    const empty = emittedSources(['0']);
    empty[0] = { ...empty[0], mutants: [] };
    expect(() => normalized(rawReport([]), { source_files: empty }, [])).toThrow(
      'MUTATION_REPORT_INVALID',
    );
  });

  it('refuses schema-invalid protected process fields before emitting artifacts', () => {
    expect(() =>
      normalized(rawReport(['Killed']), {
        source_files: emittedSources(['0']),
        process: { errorAbsent: 'yes', signal: null, status: 0 },
      }),
    ).toThrow('MUTATION_REPORT_INVALID');
  });

  it.each([
    ['break', -1],
    ['break', 101],
    ['high', -1],
    ['high', 101],
    ['low', -1],
    ['low', 101],
    ['scoreMin', -1],
    ['scoreMin', 101],
    ['scoreMin', '60'],
  ] as const)('refuses protected threshold %s=%j', (key, value) => {
    const expected = {
      ...EXPECTED,
      thresholds: { ...EXPECTED.thresholds, [key]: value },
    };
    expect(() => normalized(undefined, { expected })).toThrow('MUTATION_THRESHOLD_MISMATCH');
  });

  it.each([{ low: 61, high: 60 }, { survivedMax: -1 }, { survivedMax: 1.5 }])(
    'refuses inconsistent protected thresholds %j',
    (thresholds) => {
      const report = rawReport(['Killed']);
      const expected = {
        ...EXPECTED,
        thresholds: { ...EXPECTED.thresholds, ...thresholds },
      };
      report.thresholds = {
        break: expected.thresholds.break,
        high: expected.thresholds.high,
        low: expected.thresholds.low,
      };
      expect(() => normalized(report, { expected, source_files: emittedSources(['0']) })).toThrow(
        'MUTATION_THRESHOLD_MISMATCH',
      );
    },
  );

  it('accepts inclusive protected score boundaries and a zero-survivor ceiling', () => {
    const report = rawReport(['Killed']);
    report.thresholds = { break: 0, high: 100, low: 0 };
    const expected = {
      ...EXPECTED,
      thresholds: { break: 0, high: 100, low: 0, scoreMin: 100, survivedMax: 0 },
    };
    expect(normalized(report, { expected, source_files: emittedSources(['0']) })).toMatchObject({
      inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it.each(['packageName', 'workspace'] as const)(
    'refuses protected input projection %s drift',
    (field) => {
      const expected = {
        ...EXPECTED,
        inputProjection: { ...EXPECTED.inputProjection, [field]: `different-${field}` },
      };
      expect(() => normalized(undefined, { expected })).toThrow('MUTATION_INPUT_DIGEST_MISMATCH');
    },
  );

  it('requires an explicit Stryker version in the protected toolchain identity', () => {
    const expected = { ...EXPECTED, toolVersions: { node: '24.20.0', vitest: '4.1.10' } };
    expect(() => normalized(undefined, { expected })).toThrow('MUTATION_REPORT_INVALID');
  });

  it.each([
    { 'bad/name': '1.0.0' },
    { stryker: '9.6.1', plugin: 'bad/version' },
    { stryker: '9.6.1', plugin: 1 },
  ])('refuses malformed protected toolchain identity %j', (toolVersions) => {
    const expected = { ...EXPECTED, toolVersions };
    expect(() => normalized(undefined, { expected })).toThrow('MUTATION_REPORT_INVALID');
  });

  it('removes raw credential-like content and host paths while retaining only replacement digests', () => {
    const artifacts = normalized();
    const text = Buffer.concat([artifacts.report.bytes, artifacts.result.bytes]).toString('utf8');
    const report = json(artifacts.report.bytes);
    const files = report.files as Record<string, Record<string, unknown>>;
    const sourceFile = files['src/value.ts'];
    const mutants = sourceFile?.mutants as Array<Record<string, unknown>> | undefined;
    const firstMutant = mutants?.[0];
    if (firstMutant === undefined) throw new Error('normalized fixture mutant missing');

    for (const value of [
      SOURCE,
      TEST_SOURCE,
      RAW_SECRET,
      RAW_REASON,
      RAW_CWD,
      'fixture-replacement-credential-do-not-retain',
    ]) {
      expect(text).not.toContain(value);
    }
    expect(report.testFiles).toEqual({ 'tests/value.test.ts': {} });
    expect(firstMutant).not.toHaveProperty('statusReason');
    expect(firstMutant).not.toHaveProperty('replacement');
    expect(firstMutant.replacementDigest).toBe(
      sha256('fixture-replacement-credential-do-not-retain'),
    );
  });

  it('purely refinalizes the complete roster with canonical semantic-finalizer checks', async () => {
    const input = finalizerInput();
    const first = await finalizeReleaseMutationArtifactsV21(input);
    const second = await finalizeReleaseMutationArtifactsV21(input);
    expect(first).toEqual(second);
    expect(first.summary).toMatchObject({ verdict: 'pass', passed: true });
    expect(first).not.toHaveProperty('semanticReceipt');
    expect(first.materials).toHaveLength(1);

    const digestMismatch = {
      ...input,
      packages: input.packages.map((entry) => ({
        ...entry,
        artifacts: {
          ...entry.artifacts,
          report: { ...entry.artifacts.report, sha256: '0'.repeat(64) },
        },
      })),
    };
    await expect(finalizeReleaseMutationArtifactsV21(digestMismatch)).rejects.toThrow(
      'ARTIFACT_DIGEST_MISMATCH',
    );
    await expect(finalizeReleaseMutationArtifactsV21({ ...input, packages: [] })).rejects.toThrow(
      'MUTATION_ROSTER_MISMATCH',
    );
  });

  it('refuses correctly addressed but noncanonical package artifacts during finalization', async () => {
    const artifacts = normalized();
    const bytes = Buffer.from(JSON.stringify(json(artifacts.report.bytes), null, 2));
    const digest = sha256(bytes);
    const report = {
      ...artifacts.report,
      path: `.devai/state/mutation/v2/store/inputs/${artifacts.inputDigest}/objects/${digest}.report.json`,
      sha256: digest,
      bytes,
    };

    await expect(
      finalizeReleaseMutationArtifactsV21(finalizerInput({ ...artifacts, report })),
    ).rejects.toThrow('NON_CANONICAL_JSON');
  });

  it('binds finalization package labels, byte custody, addressed paths, and exact byte limits', async () => {
    const input = finalizerInput();
    const artifacts = input.packages[0]?.artifacts;
    if (artifacts === undefined) throw new Error('fixture artifacts missing');
    const maximum = Math.max(artifacts.report.bytes.byteLength, artifacts.result.bytes.byteLength);
    await expect(
      finalizeReleaseMutationArtifactsV21({ ...input, maximum_document_bytes: maximum }),
    ).resolves.toMatchObject({ summary: { verdict: 'pass', passed: true } });

    await expect(
      finalizeReleaseMutationArtifactsV21({
        ...input,
        packages: input.packages.map((entry) => ({ ...entry, packageName: '@fixture/other' })),
      }),
    ).rejects.toThrow('MUTATION_ROSTER_MISMATCH');
    await expect(
      finalizeReleaseMutationArtifactsV21({
        ...input,
        packages: input.packages.map((entry) => ({
          ...entry,
          artifacts: {
            ...entry.artifacts,
            report: {
              ...entry.artifacts.report,
              bytes: entry.artifacts.report.bytes.toString('utf8'),
            },
          },
        })),
      }),
    ).rejects.toThrow('MUTATION_REPORT_INVALID');
    await expect(
      finalizeReleaseMutationArtifactsV21({
        ...input,
        packages: input.packages.map((entry) => ({
          ...entry,
          artifacts: {
            ...entry.artifacts,
            report: { ...entry.artifacts.report, path: `${entry.artifacts.report.path}.other` },
          },
        })),
      }),
    ).rejects.toThrow('ARTIFACT_DIGEST_MISMATCH');
  });

  it.each([
    'pair-input-digest',
    'result-input-digest',
    'input-projection',
    'thresholds',
    'tool-versions',
  ] as const)('refuses re-addressed finalization %s drift', async (change) => {
    const input = finalizerInput();
    const artifacts = input.packages[0]?.artifacts;
    if (artifacts === undefined) throw new Error('fixture artifacts missing');
    let changed = artifacts;
    if (change === 'pair-input-digest') {
      changed = { ...artifacts, inputDigest: '0'.repeat(64) };
    } else {
      const result = json(artifacts.result.bytes);
      switch (change) {
        case 'result-input-digest':
          result['inputDigest'] = '0'.repeat(64);
          break;
        case 'input-projection':
          result['inputProjection'] = { ...(result['inputProjection'] as object), changed: true };
          break;
        case 'thresholds':
          result['thresholds'] = { ...(result['thresholds'] as object), scoreMin: 61 };
          break;
        case 'tool-versions':
          result['toolVersions'] = { ...(result['toolVersions'] as object), node: 'changed' };
          break;
      }
      changed = readdressResult(artifacts, result);
    }

    await expect(finalizeReleaseMutationArtifactsV21(finalizerInput(changed))).rejects.toThrow(
      'MUTATION_INPUT_DIGEST_MISMATCH',
    );
  });

  it('accepts the inclusive upper document limit during pure finalization', async () => {
    await expect(
      finalizeReleaseMutationArtifactsV21({
        ...finalizerInput(),
        maximum_document_bytes: 0x7fffffff,
      }),
    ).resolves.toMatchObject({ summary: { verdict: 'pass', passed: true } });
  });

  it('refuses an empty finalization roster', async () => {
    await expect(
      finalizeReleaseMutationArtifactsV21({
        ...finalizerInput(),
        expected: [],
        packages: [],
      }),
    ).rejects.toThrow('MUTATION_ROSTER_MISMATCH');
  });

  it('accepts a complete two-package finalization roster', async () => {
    const input = finalizerInput();
    const secondExpected = {
      ...EXPECTED,
      packageName: '@fixture/other',
      workspace: 'packages/other',
      inputProjection: {
        ...EXPECTED.inputProjection,
        packageName: '@fixture/other',
        workspace: 'packages/other',
      },
    };
    const secondArtifacts = normalized(undefined, { expected: secondExpected });

    await expect(
      finalizeReleaseMutationArtifactsV21({
        ...input,
        expected: [EXPECTED, secondExpected],
        packages: [
          ...input.packages,
          {
            packageName: secondExpected.packageName,
            disposition: 'executed',
            origin: null,
            artifacts: secondArtifacts,
          },
        ],
      }),
    ).resolves.toMatchObject({
      contract: { expectedPackageCount: 2 },
      materials: [{}, {}],
      summary: { verdict: 'pass', passed: true },
    });
  });

  it.each(['packageName', 'workspace'] as const)(
    'refuses a duplicate expected finalization %s',
    async (field) => {
      const input = finalizerInput();
      const firstPackage = input.packages[0];
      if (firstPackage === undefined) throw new Error('fixture package missing');
      const secondPackageName = '@fixture/other';
      const secondWorkspace = 'packages/other';
      const second = {
        ...EXPECTED,
        packageName: field === 'packageName' ? EXPECTED.packageName : secondPackageName,
        workspace: field === 'workspace' ? EXPECTED.workspace : secondWorkspace,
        inputProjection: {
          ...EXPECTED.inputProjection,
          packageName: field === 'packageName' ? EXPECTED.packageName : secondPackageName,
          workspace: field === 'workspace' ? EXPECTED.workspace : secondWorkspace,
        },
      };
      await expect(
        finalizeReleaseMutationArtifactsV21({
          ...input,
          expected: [EXPECTED, second],
          packages: [...input.packages, { ...firstPackage, packageName: second.packageName }],
        }),
      ).rejects.toThrow('MUTATION_ROSTER_MISMATCH');
    },
  );
});
