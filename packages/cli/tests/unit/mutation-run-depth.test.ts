import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  _resetScenarioValidator,
  classifyScenario,
  mutationRun,
  type MutationScenario,
} from '../../src/commands/mutation/run.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

const WORKSPACE = resolve(import.meta.dirname, '../../../..');
const SCHEMA = readFileSync(join(WORKSPACE, 'law/schemas/mutation-scenario.schema.json'), 'utf8');
const roots: string[] = [];

interface InvocationResult {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'devai-mutation-run-'));
  roots.push(repo);
  put(repo, 'law/schemas/mutation-scenario.schema.json', SCHEMA);
  return repo;
}

function put(repo: string, path: string, contents: string): string {
  const target = join(repo, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

function scenario(
  id: string,
  assertion: 'tests-detect' | 'tests-tolerate' = 'tests-detect',
  status?: 'Killed' | 'Survived' | 'Timeout' | 'RuntimeError',
): MutationScenario {
  return {
    schema_version: '1.0.0',
    id,
    kind: 'mutation',
    target: { file: `src/${id}.ts` },
    mutations: [{ type: 'string-replace', find: 'before', replace: 'after' }],
    expectations: [
      {
        assertion,
        specs: [`tests/${id}.test.ts`],
        ...(status !== undefined && { threshold: { status } }),
      },
    ],
  };
}

function putScenario(repo: string, path: string, value: MutationScenario): string {
  return put(repo, path, `${JSON.stringify(value)}\n`);
}

async function invoke(repo: string, args: readonly string[]): Promise<InvocationResult> {
  const cli = cac('devai-mutation-run-depth');
  mutationRun.register(cli);
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', 'mutation-run', '--repo-root', repo, ...args];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: string | number | null) => {
      process.exitCode = typeof code === 'number' ? code : 0;
      throw new Error(`TEST_PROCESS_EXIT:${String(process.exitCode)}`);
    }) as typeof process.exit;
    cli.parse(process.argv, { run: false });
    try {
      await withAuthorityHostTestScope(() => cli.runMatchedCommand());
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('TEST_PROCESS_EXIT:')) throw error;
    }
    await new Promise<void>((done) => setImmediate(done));
    return {
      exit: typeof process.exitCode === 'number' ? process.exitCode : 0,
      stdout,
      stderr,
    };
  } finally {
    process.argv = originalArgv;
    process.exit = originalExit;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

afterEach(() => {
  _resetScenarioValidator();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('mutation run deterministic boundaries', () => {
  it('retains the registered command identity and its public evidence contract', async () => {
    // Static command metadata is initialized when the module loads. Reload it
    // inside the test so mutation runners can activate a candidate first.
    vi.resetModules();
    const { mutationRun: freshMutationRun } =
      await import('../../src/commands/mutation/run.js?fresh-descriptor');
    expect(freshMutationRun).toMatchObject({
      name: 'mutation run',
      description: 'Run mutation scenarios and emit the current mutation evidence report.',
      authority: 'sensor',
    });
    expect(freshMutationRun.extended_doc).toContain('--fail-on-survivors');
    expect(freshMutationRun.extended_doc).toContain('mutation_score');
    expect(freshMutationRun.extended_doc).toContain('schema configuration error');
    const document = freshMutationRun.extended_doc as string;
    expect(document.match(/^### .+$/gmu)).toEqual([
      '### Invocation',
      '### Flags',
      '### Output shape',
      '### Exit codes',
      '### See also',
    ]);
    const blocks = [...document.matchAll(/```(?:json)?\n([\s\S]*?)\n```/gu)].map(
      (match) => match[1] as string,
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('devai evidence record --kind mutation --run');
    for (const flag of ['--scenarios', '--out', '--mutator', '--external']) {
      expect(blocks[0]).toContain(flag);
      expect(document).toContain(`\`${flag} `);
    }
    expect(document).toContain('`--report-path <path>`');
    expect(document).toContain('`--format human`');
    expect(JSON.parse(blocks[1] as string)).toEqual({
      schemaVersion: '1.0.0',
      mutation_score: 92,
      survived: 2,
      killed: 23,
      total: 25,
      metrics: {
        mutationScore: 92,
        survived: 2,
        killed: 23,
        timeout: 0,
        runtimeErrors: 0,
        total: 25,
      },
      scenarios: [{ id: 'AIT-001', status: 'Killed', ok: true }],
    });
    for (const code of ['0', '2', '65', '1']) {
      expect(document).toContain(`- \`${code}\``);
    }
    expect(document).toContain('docs/adopters/mutation-scenarios.md');
  });

  it('classifies detect and tolerate expectations including explicit status thresholds', () => {
    expect(classifyScenario(scenario('detect'), 'Killed')).toEqual({ ok: true });
    expect(classifyScenario(scenario('detect'), 'Survived')).toEqual({
      ok: false,
      reason: 'tests-detect expected Killed but observed Survived',
    });
    expect(classifyScenario(scenario('tolerate', 'tests-tolerate'), 'Survived')).toEqual({
      ok: true,
    });
    expect(classifyScenario(scenario('tolerate', 'tests-tolerate'), 'Killed')).toEqual({
      ok: false,
      reason: 'tests-tolerate expected Survived but observed Killed',
    });
    expect(classifyScenario(scenario('timeout', 'tests-detect', 'Timeout'), 'Timeout')).toEqual({
      ok: true,
    });
  });

  it('loads directories recursively, skips unrelated JSON, and emits a survivor report', async () => {
    const repo = makeRepo();
    putScenario(repo, 'scenarios/z.json', scenario('zeta'));
    putScenario(repo, 'scenarios/nested/a.json', scenario('alpha', 'tests-tolerate'));
    put(repo, 'scenarios/unrelated.json', '{"kind":"other"}\n');
    put(repo, 'scenarios/ignored.schema.json', '{not json');

    const result = await invoke(repo, [
      '--scenarios',
      'scenarios/**/*.json',
      '--out',
      'output/current.json',
      '--report-path',
      'reports/rich.json',
      '--human',
      '--fail-on-survivors',
    ]);

    expect(result).toMatchObject({ exit: 2, stderr: '' });
    expect(result.stdout).toContain('2 scenario(s) loaded; 0 killed, 2 survived');
    const report = JSON.parse(readFileSync(join(repo, 'output/current.json'), 'utf8')) as {
      mutation_score: number;
      report_path: string;
      scenarios: readonly { id: string; status: string; ok: boolean; error: string }[];
    };
    expect(report).toMatchObject({ mutation_score: 0, report_path: 'reports/rich.json' });
    expect(report.scenarios.map(({ id }) => id)).toEqual(['alpha', 'zeta']);
    expect(report.scenarios[0]).toMatchObject({ status: 'Survived', ok: true });
    expect(report.scenarios[1]).toMatchObject({
      status: 'Survived',
      ok: false,
      error: 'no --mutator or --external configured (scenarios loaded; mutations not executed)',
    });
  });

  it('normalizes external reports and computes the canonical denominator and verdicts', async () => {
    const repo = makeRepo();
    for (const value of [
      scenario('killed'),
      scenario('survived'),
      scenario('timeout', 'tests-detect', 'Timeout'),
      scenario('runtime', 'tests-detect', 'RuntimeError'),
      scenario('missing'),
    ]) {
      putScenario(repo, `scenarios/${value.id}.json`, value);
    }
    put(
      repo,
      'external.json',
      `${JSON.stringify({
        scenarios: [
          { id: 'killed', status: 'Killed', duration_ms: 4 },
          { id: 'survived', status: 'Survived' },
          { id: 'timeout', status: 'Timeout', error: 'runner timed out' },
          { id: 'runtime', status: 'RuntimeError' },
          { id: 'ignored', status: 'Unknown' },
        ],
      })}\n`,
    );

    const result = await invoke(repo, [
      '--scenarios',
      'scenarios',
      '--external',
      'external.json',
      '--out',
      'current.json',
    ]);

    expect(result).toMatchObject({ exit: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      scenarios_loaded: 5,
      killed: 1,
      survived: 1,
      mutation_score: 33.3,
    });
    const report = JSON.parse(readFileSync(join(repo, 'current.json'), 'utf8')) as {
      schemaVersion: string;
      total: number;
      report_path?: string;
      metrics: Record<string, number>;
      scenarios: readonly { id: string; status: string; ok: boolean; error?: string }[];
    };
    expect(report).toMatchObject({
      schemaVersion: '1.0.0',
      total: 5,
      metrics: {
        mutationScore: 33.3,
        killed: 1,
        survived: 1,
        timeout: 1,
        runtimeErrors: 2,
        total: 5,
      },
    });
    expect(report).not.toHaveProperty('report_path');
    expect(report.scenarios).toEqual([
      { id: 'killed', status: 'Killed', duration_ms: 4, ok: true },
      {
        id: 'missing',
        status: 'RuntimeError',
        error: "no external report for scenario 'missing'",
        ok: false,
      },
      { id: 'runtime', status: 'RuntimeError', ok: true },
      {
        id: 'survived',
        status: 'Survived',
        error: 'tests-detect expected Killed but observed Survived',
        ok: false,
      },
      { id: 'timeout', status: 'Timeout', error: 'runner timed out', ok: true },
    ]);
  });

  it('accepts id-keyed and directory external reports while ignoring malformed entries', async () => {
    const repo = makeRepo();
    putScenario(repo, 'scenario.json', scenario('only'));
    put(repo, 'keyed.json', '{"only":{"status":"Killed","duration_ms":7,"error":"detail"}}\n');
    const keyed = await invoke(repo, [
      '--scenarios',
      'scenario.json',
      '--external',
      'keyed.json',
      '--out',
      'keyed-current.json',
      '--fail-on-survivors',
    ]);
    expect(keyed.exit).toBe(0);
    expect(JSON.parse(readFileSync(join(repo, 'keyed-current.json'), 'utf8')).scenarios[0]).toEqual(
      {
        id: 'only',
        status: 'Killed',
        duration_ms: 7,
        error: 'detail',
        ok: true,
      },
    );

    put(repo, 'reports/broken.json', '{');
    put(repo, 'reports/no-id.json', '{"status":"Killed"}\n');
    put(repo, 'reports/result.json', '{"id":"only","status":"Timeout"}\n');
    const directory = await invoke(repo, [
      '--scenarios',
      'scenario.json',
      '--external',
      'reports',
      '--out',
      'directory-current.json',
    ]);
    expect(directory.exit).toBe(0);
    expect(
      JSON.parse(readFileSync(join(repo, 'directory-current.json'), 'utf8')).scenarios[0],
    ).toMatchObject({ id: 'only', status: 'Timeout', ok: false });

    put(
      repo,
      'array.json',
      `${JSON.stringify([
        null,
        { status: 'Killed' },
        { id: 'only', status: 'invalid' },
        { id: 'only', status: 'Killed', duration_ms: '7', error: 4 },
      ])}\n`,
    );
    const array = await invoke(repo, [
      '--scenarios',
      'scenario.json',
      '--external',
      'array.json',
      '--out',
      'array-current.json',
    ]);
    expect(array.exit).toBe(0);
    expect(JSON.parse(readFileSync(join(repo, 'array-current.json'), 'utf8')).scenarios[0]).toEqual(
      {
        id: 'only',
        status: 'Killed',
        ok: true,
      },
    );
  });

  it('runs a real ESM adapter and converts each rejected scenario into a runtime error', async () => {
    const repo = makeRepo();
    putScenario(repo, 'scenarios/good.json', scenario('good'));
    putScenario(repo, 'scenarios/inferred.json', scenario('inferred'));
    putScenario(repo, 'scenarios/rejected.json', scenario('rejected'));
    put(
      repo,
      'adapter.mjs',
      [
        'export default async function (scenario, context) {',
        `  if (context.repoRoot !== ${JSON.stringify(repo)}) throw new Error('bad context');`,
        "  if (scenario.id === 'rejected') throw 'string refusal';",
        "  if (scenario.id === 'inferred') return { id: scenario.id, status: 'Killed', error: 'adapter detail' };",
        "  return { id: 'untrusted-adapter-id', status: 'Killed', duration_ms: 9 };",
        '}',
      ].join('\n'),
    );

    const result = await invoke(repo, [
      '--scenarios',
      'scenarios',
      '--mutator',
      'adapter.mjs',
      '--out',
      'current.json',
    ]);

    expect(result.exit).toBe(0);
    const report = JSON.parse(readFileSync(join(repo, 'current.json'), 'utf8')) as {
      metrics: Record<string, number>;
      scenarios: readonly { readonly duration_ms?: number }[];
    };
    expect(report.metrics).toMatchObject({ mutationScore: 100, killed: 2, runtimeErrors: 1 });
    expect(report.scenarios).toEqual([
      { id: 'good', status: 'Killed', duration_ms: 9, ok: true },
      {
        id: 'inferred',
        status: 'Killed',
        duration_ms: expect.any(Number),
        error: 'adapter detail',
        ok: true,
      },
      {
        id: 'rejected',
        status: 'RuntimeError',
        duration_ms: expect.any(Number),
        error: 'string refusal',
        ok: false,
      },
    ]);
    expect(report.scenarios[1]?.duration_ms).toBeLessThan(1000);
    expect(report.scenarios[2]?.duration_ms).toBeLessThan(1000);
  });

  it('reports strict scenario, duplicate, path, and adapter configuration failures', async () => {
    const repo = makeRepo();
    const conflict = await invoke(repo, [
      '--scenarios',
      'anything',
      '--mutator',
      'adapter.mjs',
      '--external',
      'reports.json',
    ]);
    expect(conflict.exit).toBe(2);
    expect(conflict.stderr).toContain('--mutator and --external are mutually exclusive');

    put(repo, 'malformed.json', '{');
    const malformed = await invoke(repo, ['--scenarios', 'malformed.json']);
    expect(malformed.exit).toBe(2);
    expect(malformed.stderr).toContain('JSON parse error');

    for (const [name, value] of [
      ['null', 'null'],
      ['array', '[]'],
      ['string', '"value"'],
    ] as const) {
      put(repo, `${name}.json`, `${value}\n`);
      const primitive = await invoke(repo, ['--scenarios', `${name}.json`]);
      expect(primitive.exit).toBe(2);
      expect(primitive.stderr).toContain('top-level value must be a JSON object');
    }

    put(repo, 'not-scenario.json', '{"kind":"other"}\n');
    const notScenario = await invoke(repo, ['--scenarios', 'not-scenario.json']);
    expect(notScenario.exit).toBe(2);
    expect(notScenario.stderr).toContain('not a mutation scenario');

    putScenario(repo, 'duplicates/a.json', scenario('duplicate'));
    putScenario(repo, 'duplicates/b.json', scenario('duplicate'));
    const duplicate = await invoke(repo, ['--scenarios', 'duplicates']);
    expect(duplicate.exit).toBe(2);
    expect(duplicate.stderr).toContain("duplicate scenario id 'duplicate'");

    const missing = await invoke(repo, ['--scenarios', 'absent']);
    expect(missing.exit).toBe(2);
    expect(missing.stderr).toContain('scenarios path does not exist');

    const missingGlob = await invoke(repo, ['--scenarios', 'absent/**/*.json']);
    expect(missingGlob.exit).toBe(2);
    expect(missingGlob.stderr).toContain('scenarios path does not exist');

    mkdirSync(join(repo, 'empty'));
    const empty = await invoke(repo, ['--scenarios', 'empty/**/*.json']);
    expect(empty.exit).toBe(2);
    expect(empty.stderr).toContain('no scenario files matched');

    put(repo, 'invalid.json', `${JSON.stringify({ ...scenario('invalid'), mutations: [] })}\n`);
    const invalid = await invoke(repo, ['--scenarios', 'invalid.json']);
    expect(invalid.exit).toBe(2);
    expect(invalid.stderr).toContain('schema validation failed');

    putScenario(repo, 'scenario.json', scenario('adapter'));
    put(repo, 'bad-adapter.mjs', 'export const value = 1;\n');
    const badAdapter = await invoke(repo, [
      '--scenarios',
      'scenario.json',
      '--mutator',
      'bad-adapter.mjs',
    ]);
    expect(badAdapter.exit).toBe(2);
    expect(badAdapter.stderr).toContain('does not export a default function');

    const missingAdapter = await invoke(repo, [
      '--scenarios',
      'scenario.json',
      '--mutator',
      'absent-adapter.mjs',
    ]);
    expect(missingAdapter.exit).toBe(2);
    expect(missingAdapter.stderr).toContain('--mutator module not found');

    const missingExternal = await invoke(repo, [
      '--scenarios',
      'scenario.json',
      '--external',
      'absent-reports.json',
    ]);
    expect(missingExternal.exit).toBe(2);
    expect(missingExternal.stderr).toContain('--external path does not exist');

    _resetScenarioValidator();
    const nestedRepoRoot = join(repo, 'nested', 'consumer');
    mkdirSync(nestedRepoRoot, { recursive: true });
    const inheritedSchema = await invoke(nestedRepoRoot, [
      '--scenarios',
      putScenario(repo, 'absolute-scenario.json', scenario('absolute')),
      '--out',
      'inherited-current.json',
    ]);
    expect(inheritedSchema.exit).toBe(0);
    expect(
      JSON.parse(readFileSync(join(nestedRepoRoot, 'inherited-current.json'), 'utf8')).total,
    ).toBe(1);

    _resetScenarioValidator();
    const schemaLess = mkdtempSync(join(tmpdir(), 'devai-mutation-schema-less-'));
    roots.push(schemaLess);
    const noSchema = await invoke(schemaLess, ['--scenarios', 'anything']);
    // The test's process.exit sentinel is normalized by the command's outer
    // failure boundary; the emitted diagnostic proves the configuration path.
    expect(noSchema.exit).toBe(2);
    expect(noSchema.stderr).toContain('mutation-scenario schema not found');
  });
});
