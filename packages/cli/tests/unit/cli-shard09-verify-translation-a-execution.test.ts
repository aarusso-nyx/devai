import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { executeTranslationValidation } from '../../src/commands/verify/translation.js';

const observations = vi.hoisted(() => ({
  isolatedArgv: [] as string[][],
  macSandboxArgs: [] as string[][],
  linuxDockerCalls: [] as { readonly args: string[]; readonly options: Record<string, unknown> }[],
}));

function isolatedResult(argv: readonly string[], linux: boolean) {
  const path = argv.find((value) => value.includes('translation-execution-fixture.')) ?? '';
  const stdout = linux ? 'DEVAI_TRANSLATION_ISOLATION_STARTED\n' : '';
  if (path.endsWith('.mjs')) {
    return { status: 1, signal: null, stdout, stderr: 'AssertionError: expected true' };
  }
  if (path.endsWith('.cjs')) {
    return { status: 1, signal: null, stdout, stderr: 'ENOENT: fixture missing' };
  }
  if (path.endsWith('.ts')) {
    return { status: 1, signal: null, stdout, stderr: 'SyntaxError: fixture invalid' };
  }
  if (path.endsWith('.tsx')) {
    const error = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    return { status: null, signal: null, stdout, stderr: '', error };
  }
  if (path.endsWith('.mts')) {
    return { status: null, signal: 'SIGTERM', stdout, stderr: '' };
  }
  return { status: 0, signal: null, stdout: `${stdout}ok`, stderr: '' };
}

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  const childProcess = await import('node:child_process');
  return {
    ...actual,
    spawnSync(command: string, args: readonly string[], options: Record<string, unknown>) {
      if (command === 'sandbox-exec') {
        const argv = args.slice(2);
        observations.macSandboxArgs.push([...args]);
        observations.isolatedArgv.push(argv);
        return isolatedResult(argv, false);
      }
      if (command === 'docker') {
        const delimiter = args.indexOf('devai-translation-isolation');
        if (delimiter < 0) throw new Error('LINUX_ISOLATION_DELIMITER_MISSING');
        const argv = args.slice(delimiter + 1);
        observations.linuxDockerCalls.push({ args: [...args], options });
        observations.isolatedArgv.push(argv);
        return isolatedResult(argv, true);
      }
      return childProcess.spawnSync(command, [...args], options);
    },
  };
});

vi.mock('#runtime-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime-core.js')>();
  return {
    ...actual,
    async provisionValidationDatabase(input: { readonly validation_id: string }) {
      return {
        ok: true,
        database: `devai_task_TV_${input.validation_id.slice('VR-'.length)}`,
      };
    },
    async dropValidationDatabase() {
      return { ok: true };
    },
  };
});

const WITNESS_PATH = 'scratch/translation-execution-witness.json';
const RECIPE_PATH = 'record/proofs/work/recipe-runs/devai-fix/test/2026-09-11T00-00-00-000Z.json';
const SOURCE_PATH = 'packages/cli/src/translation-execution-fixture.js';
const TEST_PATHS = [
  'packages/cli/tests/unit/translation-execution-fixture.js',
  'packages/cli/tests/unit/translation-execution-fixture.mjs',
  'packages/cli/tests/unit/translation-execution-fixture.cjs',
  'packages/cli/tests/unit/translation-execution-fixture.ts',
  'packages/cli/tests/unit/translation-execution-fixture.tsx',
  'packages/cli/tests/unit/translation-execution-fixture.mts',
] as const;
const REFS = TEST_PATHS.map((path) => ({
  suite: 'unit',
  path,
  names: [`executes ${path.slice(path.lastIndexOf('.') + 1)} fixture`],
}));
const INVALID_RUNNER_REFS = [
  {
    suite: 'unit',
    path: 'packages/cli/tests/unit/translation\\execution-fixture.js',
    names: ['rejects a backslash path'],
  },
  {
    suite: 'unit',
    path: 'packages/cli/tests/unit/translation-execution-fixture.txt',
    names: ['rejects an unsupported extension'],
  },
] as const;

interface Harness {
  readonly root: string;
  readonly base: string;
  readonly candidate: string;
  readonly cleanup: () => void;
  readonly validate: (
    refs?: readonly {
      readonly suite: string;
      readonly path: string;
      readonly names: readonly string[];
    }[],
    executor?: typeof executeTranslationValidation,
  ) => Promise<Record<string, unknown>>;
}

function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'devai-translation-execution-'));
  const git = (args: readonly string[]): string => {
    const result = nodeSpawnSync('git', [...args], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
    return result.stdout.trim();
  };
  const writeText = (path: string, value: string): void => {
    const absolute = resolve(root, path);
    mkdirSync(resolve(absolute, '..'), { recursive: true });
    writeFileSync(absolute, value);
  };
  const writeJson = (path: string, value: unknown): void => {
    writeText(path, `${JSON.stringify(value, null, 2)}\n`);
  };

  git(['init', '--quiet']);
  git(['config', 'user.name', 'DEVAI Translation Test']);
  git(['config', 'user.email', 'translation-test@example.invalid']);
  writeJson('law/invariants/INV-DEMO-009.json', {
    schemaVersion: '1.0.0',
    id: 'INV-DEMO-009',
    domain: 'DEMO',
    lifecycle: 'supported',
    severity: 'gate',
    type: 'validation',
    title: 'Translation execution classification',
    statement: 'Registered translation tests retain their exact execution outcomes.',
    status: 'active',
    verification: {
      required_suites: ['unit'],
      oracle: 'tests',
      strategy: {
        primary: 'regression',
        deterministic_check_available: true,
        rationale: 'The registered processes have deterministic outcomes.',
      },
    },
    authority_docs: { docs: [{ doc: 'README.md', anchor: 'testing' }] },
    scope: { components: ['cli'], code_areas: [SOURCE_PATH], modules: ['MOD-CLI'] },
    change_policy: {
      breaking_change_requires: ['test_update'],
      test_weakening_allowed: false,
      human_approval_required: false,
    },
  });
  writeJson('law/trace.json', {
    schemaVersion: '1.0.0',
    version: '1.0.0',
    invariants: [
      { id: 'INV-DEMO-009', tests: [...REFS, ...INVALID_RUNNER_REFS], code_areas: [SOURCE_PATH] },
    ],
    test_corpus: [],
  });
  for (const path of TEST_PATHS) writeText(path, '// deterministic registered fixture\n');
  writeText(SOURCE_PATH, 'export const translated = false;\n');
  git(['add', '--force', '--', 'law', 'packages']);
  git(['commit', '--quiet', '-m', 'establish translation baseline']);
  const base = git(['rev-parse', 'HEAD']);
  writeText(SOURCE_PATH, 'export const translated = true;\n');
  git(['add', '--force', '--', SOURCE_PATH]);
  git(['commit', '--quiet', '-m', 'implement translated behavior']);
  const candidate = git(['rev-parse', 'HEAD']);
  mkdirSync(resolve(root, 'node_modules/vitest'), { recursive: true });
  writeText('node_modules/vitest/vitest.mjs', '// runner presence marker\n');
  writeJson('.devai/state/tasks/TASK-9009.json', {
    schemaVersion: '2.0.0',
    id: 'TASK-9009',
    round_id: 'R-0007',
    status: 'in_progress',
    discipline: 'engineer',
    title: 'Exercise translation execution classification',
    target_modules: ['MOD-CLI'],
    target_substrates: ['F2'],
    created_at: '2026-09-11T00:00:00.000Z',
    db_isolation: 'database',
    iteration_count: 0,
    executor: {
      kind: 'agent',
      runtime: 'codex-cli',
      model: 'model-primary',
      effort: 'high',
      selection: { mode: 'exact', registry_id: 'primary' },
      recipe_name: 'devai-fix',
      recipe_variant: 'test',
      prompt_composition_id: 'PC-0123456789abcdef',
      max_iterations: 1,
      capabilities: ['fs:workspace'],
    },
    intent_diff: { planned_files: [SOURCE_PATH] },
  });
  writeJson('record/proofs/chain.json', { head: null, records: [] });

  const validate = async (
    refs: readonly {
      readonly suite: string;
      readonly path: string;
      readonly names: readonly string[];
    }[] = REFS,
    executor: typeof executeTranslationValidation = executeTranslationValidation,
  ): Promise<Record<string, unknown>> => {
    const witness = {
      schemaVersion: '1.0.0',
      id: 'TW-9900112233445566',
      trust: 'untrusted-claim',
      task_id: 'TASK-9009',
      recipe_name: 'devai-fix',
      recipe_variant: 'test',
      stage: 'invariants-tests-to-code',
      base_sha: base,
      candidate_sha: candidate,
      emitted_at: '2026-09-11T00:00:00.000Z',
      strategy: 'regression',
      implements: [
        {
          invariant_id: 'INV-DEMO-009',
          criteria: [
            {
              claim: 'The candidate runs every registered process.',
              demonstrated_by: refs.map((test_ref) => ({ kind: 'test', test_ref })),
            },
          ],
        },
      ],
      touched: [SOURCE_PATH],
      red_green: refs.map((test_ref) => ({
        test_ref,
        expected_at_base: 'assertion-fail',
        expected_at_candidate: 'pass',
      })),
      frame: {
        authority_role: 'engineer',
        spec_edits: 'none',
        test_edits: 'none',
        inventory_delta_confined_to: ['MOD-CLI'],
        effects_claimed: ['fs:plant'],
      },
    };
    writeJson(WITNESS_PATH, witness);
    writeJson(RECIPE_PATH, {
      recipe_name: 'devai-fix',
      recipe_variant: 'test',
      status: 'pass',
      evidence: { translation_witness: witness },
    });
    return withAuthorityHostTestScope(() =>
      executor({
        witness: WITNESS_PATH,
        repoRoot: root,
        databaseUrl: 'postgres://unused',
      }),
    );
  };

  return { root, base, candidate, cleanup: () => rmSync(root, { recursive: true }), validate };
}

describe('CLI shard 09 verify translation execution boundaries', () => {
  let harness: Harness;

  beforeAll(() => {
    harness = createHarness();
  });
  afterAll(() => harness.cleanup());
  beforeEach(() => {
    observations.isolatedArgv.length = 0;
    observations.macSandboxArgs.length = 0;
    observations.linuxDockerCalls.length = 0;
  });

  it('rejects a registered name prefix with an additional unregistered segment', async () => {
    const ref = REFS[0];
    await expect(
      harness.validate([{ ...ref, names: [...ref.names, 'unregistered nested case'] }]),
    ).rejects.toThrow(
      `TRANSLATION_TEST_REF_UNREGISTERED: ${ref.suite}:${ref.path}:${ref.names[0]} > unregistered nested case`,
    );
  });

  it.runIf(platform() === 'linux')(
    'binds a fresh module instance to the pinned Linux image',
    async () => {
      vi.resetModules();
      const fresh = await import('../../src/commands/verify/translation.js');
      await harness.validate([REFS[0]], fresh.executeTranslationValidation);

      expect(observations.linuxDockerCalls).toHaveLength(2);
      for (const call of observations.linuxDockerCalls) {
        expect(call.args[10]).toBe(
          'node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd',
        );
      }
    },
  );

  it('preserves exact runner argv and distinguishes every process failure class', async () => {
    const result = await harness.validate();
    expect(observations.isolatedArgv).toHaveLength(12);
    expect(observations.isolatedArgv.slice(0, 6)).toEqual([
      ['node', '--test', '--test-name-pattern', 'executes js fixture', TEST_PATHS[0]],
      ['node', '--test', '--test-name-pattern', 'executes mjs fixture', TEST_PATHS[1]],
      ['node', '--test', '--test-name-pattern', 'executes cjs fixture', TEST_PATHS[2]],
      ['node', 'node_modules/vitest/vitest.mjs', 'run', TEST_PATHS[3], '-t', 'executes ts fixture'],
      [
        'node',
        'node_modules/vitest/vitest.mjs',
        'run',
        TEST_PATHS[4],
        '-t',
        'executes tsx fixture',
      ],
      [
        'node',
        'node_modules/vitest/vitest.mjs',
        'run',
        TEST_PATHS[5],
        '-t',
        'executes mts fixture',
      ],
    ]);
    if (platform() === 'darwin') {
      expect(observations.macSandboxArgs).toHaveLength(12);
      expect(observations.linuxDockerCalls).toEqual([]);
      for (const [index, args] of observations.macSandboxArgs.entries()) {
        expect(args[0]).toBe('-p');
        expect(args[1]).toContain('(deny network*)');
        expect(args[1]).toContain('(deny file-write*');
        expect(args.slice(2)).toEqual(observations.isolatedArgv[index]);
      }
    } else if (platform() === 'linux') {
      expect(observations.macSandboxArgs).toEqual([]);
      expect(observations.linuxDockerCalls).toHaveLength(12);
      for (const [index, call] of observations.linuxDockerCalls.entries()) {
        expect(call.args.slice(0, 5)).toEqual(['run', '--rm', '--network', 'none', '--mount']);
        expect(call.args[5]).toMatch(
          /^type=bind,src=.+\/.devai\/worktrees\/WT-TV-[a-f0-9]{16},dst=\/workspace,readonly$/,
        );
        expect(call.args.slice(6, 10)).toEqual([
          '--mount',
          expect.any(String),
          '--workdir',
          '/workspace',
        ]);
        expect(call.args[7]).toMatch(
          /^type=bind,src=.+\/node_modules,dst=\/workspace\/node_modules,readonly$/,
        );
        expect(call.args.slice(10, 15)).toEqual([
          'node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd',
          'sh',
          '-c',
          'printf \'%s\\n\' DEVAI_TRANSLATION_ISOLATION_STARTED; exec "$@"',
          'devai-translation-isolation',
        ]);
        expect(call.args.slice(15)).toEqual(observations.isolatedArgv[index]);
        expect(call.options).toEqual({ encoding: 'utf8', timeout: 120_000 });
      }
    } else {
      throw new Error(`UNSUPPORTED_TEST_PLATFORM:${platform()}`);
    }
    const crashModes =
      platform() === 'linux'
        ? ['missing-file', 'load-error', 'infrastructure', 'infrastructure']
        : ['missing-file', 'load-error', 'timeout', 'signal'];
    expect(result['executions']).toEqual([
      ...['base', 'candidate'].flatMap((phase) => [
        expect.objectContaining({ phase, outcome: 'pass', failure_mode: 'none' }),
        expect.objectContaining({ phase, outcome: 'fail', failure_mode: 'assertion' }),
        ...crashModes.map((failure_mode) =>
          expect.objectContaining({ phase, outcome: 'crash', failure_mode }),
        ),
      ]),
    ]);
  });

  it('rejects backslash paths and unsupported registered runner extensions before execution', async () => {
    for (const ref of INVALID_RUNNER_REFS) {
      const result = await harness.validate([ref]);
      expect(result['executions']).toEqual([]);
      expect(result['frames']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'infrastructure',
            status: 'FAIL',
            finding: expect.stringMatching(/TEST_REF_INVALID|REGISTERED_TEST_RUNNER_UNSUPPORTED/),
          }),
        ]),
      );
    }
    expect(observations.isolatedArgv).toEqual([]);
  });
});
