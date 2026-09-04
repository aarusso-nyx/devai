import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalSha256 } from '@devai-nyx/utils';
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
  thresholds: { break: 60, high: 60, low: 60, scoreMin: 60, survivedMax: 50 },
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
});
