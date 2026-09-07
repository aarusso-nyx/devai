import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);

interface MutationReport {
  files: Record<string, { mutants: { static?: boolean; status: string; statusReason?: string }[] }>;
  testFiles: Record<string, { tests: unknown[] }>;
}
function runFixture(
  source: string,
  tests: Record<string, string>,
  mutate: string[],
  inspect: (root: string, status: number | null, log: string) => void,
) {
  const repo = resolve('.');
  const root = mkdtempSync(join(tmpdir(), 'devai static activation ç-'));
  let passed = false;
  try {
    mkdirSync(join(root, 'node_modules'));
    for (const entry of readdirSync(join(repo, 'node_modules'))) {
      symlinkSync(join(repo, 'node_modules', entry), join(root, 'node_modules', entry));
    }
    mkdirSync(join(root, 'tests'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'static-activation-fixture', private: true, type: 'module' }),
    );
    writeFileSync(join(root, 'value.js'), source);
    for (const [name, content] of Object.entries(tests))
      writeFileSync(join(root, 'tests', name), content);
    writeFileSync(
      join(root, 'vitest.config.mjs'),
      "export default { test: { include: ['tests/*.test.js'], maxWorkers: 1 } };\n",
    );
    // Only relocate the installed dependency lookup; execute the real wrapper.
    const plugin = readFileSync(
      join(repo, 'scripts/release-host/mutation-vitest-plugin.mjs'),
      'utf8',
    );
    expect(plugin).toContain("createRequire('/workspace/candidate/package.json')");
    writeFileSync(
      join(root, 'mutation-vitest-plugin.mjs'),
      plugin.replace(
        "createRequire('/workspace/candidate/package.json')",
        `createRequire(${JSON.stringify(join(root, 'package.json'))})`,
      ),
    );
    writeFileSync(
      join(root, 'mutation-workspace-aliases.mjs'),
      readFileSync(join(repo, 'scripts/release-host/mutation-workspace-aliases.mjs')),
    );
    writeFileSync(
      join(root, 'stryker.config.json'),
      JSON.stringify({
        mutate,
        testFiles: Object.keys(tests).map((name) => `tests/${name}`),
        plugins: [join(root, 'mutation-vitest-plugin.mjs')],
        testRunner: 'devai-vitest',
        coverageAnalysis: 'perTest',
        concurrency: 1,
        reporters: ['json'],
        vitest: { configFile: 'vitest.config.mjs', related: false },
        symlinkNodeModules: true,
        tempDirName: 'sandbox',
        cleanTempDir: false,
        incremental: false,
        timeoutMS: 10000,
        dryRunTimeoutMinutes: 1,
        jsonReporter: { fileName: 'report.json' },
      }),
    );
    const cli = join(
      dirname(require.resolve('@stryker-mutator/core/package.json')),
      'bin/stryker.js',
    );
    const result = spawnSync(process.execPath, [cli, 'run', 'stryker.config.json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 45000,
      maxBuffer: 4 * 1024 * 1024,
    });
    writeFileSync(join(root, 'runner.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    expect(result.error, `Retained fixture: ${root}`).toBeUndefined();
    inspect(root, result.status, readFileSync(join(root, 'runner.log'), 'utf8'));
    passed = true;
  } finally {
    if (passed) rmSync(root, { recursive: true, force: true });
  }
}

it('activates static mutants before imports while retaining the explicit test-file population', () => {
  const source = `export const REQUIRED = 'must-match';
export const HEX = /^[a-f0-9]{64}$/;
export const OPTIONS = { dot: true, nocase: false };
export function next(value) { return value + 1; }
`;
  const test = `import { expect, it } from 'vitest';
import { REQUIRED, HEX, OPTIONS, next } from '../value.js';
it('retains the static value', () => expect(REQUIRED).toBe('must-match'));
it('accepts hex digests', () => expect(HEX.test('a'.repeat(64))).toBe(true));
it('rejects non-hex digests', () => expect(HEX.test('g'.repeat(64))).toBe(false));
it('requires the complete digest length', () => { expect(HEX.test('a'.repeat(63))).toBe(false); expect(HEX.test('a'.repeat(65))).toBe(false); });
it('retains static options', () => expect(OPTIONS).toEqual({ dot: true, nocase: false }));
it('executes the runtime mutation target', () => { expect(next(2)).toBe(3); expect(next(-2)).toBe(-1); });
`;
  runFixture(
    source,
    { 'value.test.js': test, 'other.test.js': test },
    ['value.js'],
    (root, status) => {
      expect(status, `Retained fixture: ${root}`).toBe(0);
      const report = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8')) as MutationReport;
      const mutants = Object.values(report.files).flatMap((file) => file.mutants);
      expect(mutants.filter((mutant) => mutant.static).length).toBeGreaterThanOrEqual(8);
      expect(mutants.some((mutant) => !mutant.static)).toBe(true);
      expect(
        mutants.map((mutant) => mutant.status),
        `Retained fixture: ${root}`,
      ).toEqual(mutants.map(() => 'Killed'));
      expect(Object.keys(report.testFiles).sort()).toEqual([
        'tests/other.test.js',
        'tests/value.test.js',
      ]);
      expect(Object.values(report.testFiles).map((file) => file.tests.length)).toEqual([6, 6]);
    },
  );
}, 60000);

it.each([true, false])(
  'accounts for module-loading failures with READY=%s',
  (ready) => {
    const source = `export const READY = ${ready};
if (!READY) throw new Error('FIXTURE_STARTUP_REFUSED');
`;
    const population = {
      'passing.test.js':
        "import {it,expect} from 'vitest'; it('unrelated test passes',()=>expect(true).toBe(true));",
      'startup.test.js':
        "import {it,expect} from 'vitest'; import {READY} from '../value.js'; it('initializes the required control',()=>expect(READY).toBe(true));",
    };
    runFixture(source, population, ['value.js:1-1'], (root, status, log) => {
      if (!ready) {
        expect(status, `Retained fixture: ${root}`).not.toBe(0);
        expect(log).toContain('A test suite failed during the unmutated baseline.');
        return;
      }
      expect(status, `Retained fixture: ${root}`).toBe(0);
      const report = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8')) as MutationReport;
      const mutants = Object.values(report.files).flatMap((file) => file.mutants);
      expect(mutants, `Retained fixture: ${root}`).toHaveLength(1);
      expect(mutants[0]).toMatchObject({
        status: 'Killed',
        static: true,
        statusReason: 'A test suite failed during mutation execution.',
      });
      expect(Object.keys(report.testFiles).sort()).toEqual([
        'tests/passing.test.js',
        'tests/startup.test.js',
      ]);
    });
  },
  60000,
);

it('preserves collected assertion failures instead of hiding them behind a suite error', () => {
  runFixture(
    'export const READY = true;\n',
    {
      'assertion.test.js':
        "import {it,expect} from 'vitest'; import {READY} from '../value.js'; it('required readiness assertion',()=>expect(READY,'FIXTURE_ASSERTION_DETAILS').toBe(false));",
    },
    ['value.js'],
    (root, status, log) => {
      expect(status, `Retained fixture: ${root}`).not.toBe(0);
      expect(log).toContain('required readiness assertion');
      expect(log).toContain('FIXTURE_ASSERTION_DETAILS');
      expect(log).not.toContain('A test suite failed during the unmutated baseline.');
    },
  );
}, 60000);
