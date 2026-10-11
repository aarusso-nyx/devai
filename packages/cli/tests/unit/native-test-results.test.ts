import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  inspectNativeTestResults,
  type NativeTestResultContract,
} from '../../src/commands/sense/native-test-results.js';

const repoRoot = '/native-fixture';
const context = { repoRoot };
const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/native-test-results/${name}`, import.meta.url), 'utf8');
// Compute identities independently of the production helper. The tuple has no object keys.
const id = (file: string, title: string): string =>
  `test:v1:${encodeURIComponent(JSON.stringify(['audit-fixture', file, ['arithmetic'], title]))}`;
const declaration = (format: NativeTestResultContract['format']): NativeTestResultContract => {
  const extension = format === 'playwright-json' ? 'spec.js' : 'test.ts';
  return {
    schemaVersion: '1.0.0',
    format,
    projectId: 'audit-fixture',
    transport: { kind: 'direct' },
    executableFiles: [`tests/one.${extension}`, `tests/two.${extension}`],
    requiredTestIds: [
      id(`tests/one.${extension}`, 'adds'),
      id(`tests/two.${extension}`, 'multiplies'),
    ].sort(),
  };
};
interface VitestCapture {
  numTotalTests: number;
  numPassedTests: number;
  numPendingTests: number;
  numFailedTests: number;
  numTotalTestSuites: number;
  numPassedTestSuites: number;
  numFailedTestSuites: number;
  success: boolean;
  testResults: {
    name: string;
    status: string;
    assertionResults: { status: string; title: string; fullName: string }[];
  }[];
}
interface PlaywrightSuite {
  suites: PlaywrightSuite[];
  specs: { tests: { projectName: string; results: unknown[] }[] }[];
}
interface PlaywrightCapture {
  suites: PlaywrightSuite[];
}
const vitest = (): VitestCapture => JSON.parse(fixture('vitest-json.json')) as VitestCapture;
const playwright = (): PlaywrightCapture =>
  JSON.parse(fixture('playwright-json.json')) as PlaywrightCapture;
function fixtureEntry<T>(rows: readonly T[], index: number): T {
  const row = rows[index];
  if (row === undefined) throw new Error(`Native fixture entry missing at ${index}`);
  return row;
}
const vitestFile = (capture: VitestCapture) => fixtureEntry(capture.testResults, 0);
const vitestLeaf = (capture: VitestCapture) =>
  fixtureEntry(vitestFile(capture).assertionResults, 0);
const playwrightLeaf = (capture: PlaywrightCapture) =>
  fixtureEntry(
    fixtureEntry(fixtureEntry(fixtureEntry(capture.suites, 0).suites, 0).specs, 0).tests,
    0,
  );
const inspect = (contract: NativeTestResultContract, native: unknown, stderr = '') =>
  inspectNativeTestResults(contract, JSON.stringify(native), stderr, context);

describe('complete native result populations', () => {
  it.each(['vitest-json', 'playwright-json'] as const)(
    'binds authentic %s leaf identities, ancestors, source files and same-run final plan',
    (format) => {
      const contract = declaration(format);
      const stdout = fixture(`${format}.json`);
      const result = inspectNativeTestResults(contract, stdout, '', context);
      expect(result).toEqual({
        status: 'pass',
        testIds: contract.requiredTestIds,
        executedTestIds: contract.requiredTestIds,
        failedTestIds: [],
        skippedTestIds: [],
        executableFiles: contract.executableFiles,
        projectId: contract.projectId,
        nativePlanSha256: createHash('sha256').update(stdout.trim()).digest('hex'),
        findings: [],
      });
    },
  );

  it('accepts real Vitest nested-suite counts without equating suites to source files', () => {
    const native = vitest();
    expect(native.numTotalTestSuites).toBe(4);
    expect(native.testResults).toHaveLength(2);
    expect(inspect(declaration('vitest-json'), native).status).toBe('pass');
  });

  it('refuses authentic successful Node TAP when the reporter supplies no file provenance', () => {
    const result = inspectNativeTestResults(
      declaration('node-tap'),
      fixture('node-tap.txt'),
      '',
      context,
    );
    expect(result.status).toBe('unknown');
    expect(result.findings).toContain('NATIVE_TAP_SOURCE_PROVENANCE_UNAVAILABLE');
    expect(result.executedTestIds).toEqual([]);
  });

  it.each(['vitest-json', 'playwright-json'] as const)('refuses truncated %s output', (format) => {
    const result = inspectNativeTestResults(
      declaration(format),
      fixture(`${format}.json`).slice(0, -20),
      '',
      context,
    );
    expect(result.status).toBe('unknown');
  });

  it('refuses omitted Vitest source population even when authored counters are made self-consistent', () => {
    const native = vitest();
    native.testResults.pop();
    native.numTotalTests = native.numPassedTests = 1;
    native.numTotalTestSuites = native.numPassedTestSuites = 2;
    expect(inspect(declaration('vitest-json'), native).findings).toContain(
      'NATIVE_RESULT_POPULATION_DISAGREEMENT',
    );
  });

  it('refuses duplicate native leaf identities', () => {
    const native = vitest();
    vitestFile(native).assertionResults.push(structuredClone(vitestLeaf(native)));
    expect(inspect(declaration('vitest-json'), native).findings).toContain(
      'NATIVE_RESULT_DUPLICATE_ID',
    );
  });

  it('refuses disagreement between native counters and leaves', () => {
    const native = vitest();
    native.numPassedTests = 3;
    expect(inspect(declaration('vitest-json'), native).findings).toContain(
      'NATIVE_RESULT_COUNTER_DISAGREEMENT',
    );
  });

  it('keeps a skipped required leaf visible and refuses executed-population standing', () => {
    const native = vitest();
    vitestLeaf(native).status = 'pending';
    native.numPassedTests = 1;
    native.numPendingTests = 1;
    const result = inspect(declaration('vitest-json'), native);
    expect(result.status).toBe('unknown');
    expect(result.skippedTestIds).toEqual([id('tests/one.test.ts', 'adds')]);
    expect(result.executedTestIds).toEqual([id('tests/two.test.ts', 'multiplies')]);
    expect(result.findings).toContain('NATIVE_RESULT_UNEXECUTED_OBLIGATIONS');
  });

  it('retains exact failed IDs rather than converting an executed failure to UNKNOWN', () => {
    const native = vitest();
    vitestLeaf(native).status = 'failed';
    vitestFile(native).status = 'failed';
    native.numPassedTests = 1;
    native.numFailedTests = 1;
    native.numPassedTestSuites = 2;
    native.numFailedTestSuites = 2;
    native.success = false;
    const result = inspect(declaration('vitest-json'), native);
    expect(result.status).toBe('fail');
    expect(result.failedTestIds).toEqual([id('tests/one.test.ts', 'adds')]);
    expect(result.executedTestIds).toEqual(declaration('vitest-json').requiredTestIds);
  });

  it('refuses source paths outside the trusted candidate root', () => {
    const native = vitest();
    vitestFile(native).name = '/different-candidate/tests/one.test.ts';
    expect(inspect(declaration('vitest-json'), native).findings).toContain(
      'NATIVE_RESULT_SOURCE_OUTSIDE_CANDIDATE',
    );
  });

  it('binds only the selected Turbo stream and rejects replayed cache output', () => {
    const contract = {
      ...declaration('vitest-json'),
      transport: { kind: 'turbo' as const, prefix: 'audit:test: ' },
    };
    const stdout = fixture('vitest-json.json')
      .trim()
      .split('\n')
      .map((line) => `${contract.transport.prefix}${line}`)
      .join('\n');
    expect(
      inspectNativeTestResults(contract, `other:test: unrelated\n${stdout}`, '', context).status,
    ).toBe('pass');
    const replay = inspectNativeTestResults(
      contract,
      `audit:test: cache hit, replaying logs\n${stdout}`,
      '',
      context,
    );
    expect(replay.status).toBe('unknown');
    expect(replay.findings).toContain('NATIVE_RESULT_CACHE_REPLAY');
  });

  it('refuses duplicate declarations rather than treating a set as complete', () => {
    const contract = declaration('vitest-json');
    expect(
      inspect(
        {
          ...contract,
          requiredTestIds: [...contract.requiredTestIds, id('tests/one.test.ts', 'adds')],
        },
        vitest(),
      ).status,
    ).toBe('unknown');
  });

  it('refuses Playwright project mismatch', () => {
    const native = playwright();
    playwrightLeaf(native).projectName = 'another-project';
    expect(inspect(declaration('playwright-json'), native).findings).toContain(
      'NATIVE_RESULT_PROJECT_MISMATCH',
    );
  });

  it('keeps a logical project identity independent of the native Playwright project name', () => {
    const contract = {
      ...declaration('playwright-json'),
      projectId: 'adopter.logical-suite',
      selectionEvidence: {
        kind: 'devai-native-collection' as const,
        reporter: 'playwright-v1' as const,
        projectName: 'audit-fixture',
      },
      requiredTestIds: [
        ['tests/one.spec.js', 'adds'],
        ['tests/two.spec.js', 'multiplies'],
      ]
        .map(
          ([file, title]) =>
            `test:v1:${encodeURIComponent(JSON.stringify(['adopter.logical-suite', file, ['arithmetic'], title]))}`,
        )
        .sort(),
    };
    const result = inspect(contract, playwright());
    expect(result.status).toBe('pass');
    expect(result.projectId).toBe('adopter.logical-suite');
    expect(result.executedTestIds).toEqual(contract.requiredTestIds);
  });

  it('refuses a missing Playwright terminal attempt', () => {
    const native = playwright();
    playwrightLeaf(native).results = [];
    expect(inspect(declaration('playwright-json'), native).findings).toContain(
      'NATIVE_RESULT_ATTEMPT_PLAN_INCOMPLETE',
    );
  });

  it('binds the authentic same-execution collection frame to the trusted broker nonce', () => {
    const contract = {
      ...declaration('vitest-json'),
      selectionEvidence: {
        kind: 'devai-native-collection' as const,
        reporter: 'vitest-v1' as const,
        projectName: 'audit-fixture',
      },
    };
    const stdout = fixture('vitest-collection.json');
    const result = inspectNativeTestResults(contract, stdout, '', {
      repoRoot,
      collectionNonce: 'fixture-capture-nonce',
    });
    expect(result.status).toBe('pass');
    expect(result.executedTestIds).toEqual(contract.requiredTestIds);
    expect(
      inspectNativeTestResults(contract, stdout, '', {
        repoRoot,
        collectionNonce: 'another-execution',
      }).status,
    ).toBe('unknown');
  });

  it.each(['missing', 'omitted-file', 'omitted-leaf', 'filtered'] as const)(
    'refuses %s same-execution collection custody',
    (mode) => {
      const contract = {
        ...declaration('vitest-json'),
        selectionEvidence: {
          kind: 'devai-native-collection' as const,
          reporter: 'vitest-v1' as const,
          projectName: 'audit-fixture',
        },
      };
      const native = JSON.parse(fixture('vitest-collection.json')) as {
        devaiCollection?: { plannedFiles: string[]; tests: unknown[]; invalid: string[] };
      };
      const collection = native.devaiCollection;
      if (collection === undefined) throw new Error('Authentic collection fixture missing');
      if (mode === 'missing') delete native.devaiCollection;
      if (mode === 'omitted-file') collection.plannedFiles.pop();
      if (mode === 'omitted-leaf') collection.tests.pop();
      if (mode === 'filtered') collection.invalid.push('NATIVE_COLLECTION_FILTERED_FILE_SELECTION');
      const result = inspectNativeTestResults(contract, JSON.stringify(native), '', {
        repoRoot,
        collectionNonce: 'fixture-capture-nonce',
      });
      expect(result.status).toBe('unknown');
    },
  );

  it('does not interpret native test titles as transport cache replay facts', () => {
    const native = vitest();
    const title = 'cache hit, replaying logs';
    vitestLeaf(native).title = title;
    vitestLeaf(native).fullName = `arithmetic ${title}`;
    const contract = declaration('vitest-json');
    const requiredTestIds = [
      id('tests/one.test.ts', title),
      id('tests/two.test.ts', 'multiplies'),
    ].sort();
    const result = inspectNativeTestResults(
      { ...contract, requiredTestIds },
      JSON.stringify(native, null, 2),
      '',
      context,
    );
    expect(result.status).toBe('pass');
    expect(result.testIds).toEqual(requiredTestIds);
  });

  it('refuses globally failed Vitest suites even when their leaf counters claim success', () => {
    const native = vitest();
    vitestFile(native).status = 'failed';
    native.numPassedTestSuites = 2;
    native.numFailedTestSuites = 2;
    expect(inspect(declaration('vitest-json'), native).status).not.toBe('pass');
  });
});
