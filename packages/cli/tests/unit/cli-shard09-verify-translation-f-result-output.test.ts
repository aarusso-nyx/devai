// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { CAC } from 'cac';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  executeTranslationValidation,
  verifyTranslation,
} from '../../src/commands/verify/translation.js';
import { createSelfContainedRepositoryFixture } from '../helpers/self-contained-repository-fixture.js';

type FrameStatus = 'PASS' | 'REVIEW' | 'FAIL';

const controls = vi.hoisted(() => ({
  frameStatuses: ['PASS'] as FrameStatus[],
  omitLeaseCreate: false,
  validationErrors: undefined as unknown,
  validationResult: true,
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  platform: () => 'linux',
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: (
    command: string,
    args: readonly string[],
    options: Parameters<typeof nodeSpawnSync>[2],
  ) => nodeSpawnSync(command, [...args], options),
}));

vi.mock('@devai-nyx/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/schemas')>();
  const validationResult = () => controls.validationResult;
  Object.defineProperty(validationResult, 'errors', {
    configurable: true,
    get: () => controls.validationErrors,
  });
  return {
    ...actual,
    validators: { ...actual.validators, validationResult },
  };
});

vi.mock('#runtime-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime-core.js')>();
  return {
    ...actual,
    appendVerbEvidence: () => ({ ok: true, id: 'EV-0123456789abcdef' }),
    buildExpectedDiffManifest: (...args: Parameters<typeof actual.buildExpectedDiffManifest>) => {
      const manifest = actual.buildExpectedDiffManifest(...args);
      return controls.omitLeaseCreate ? manifest.slice(1) : manifest;
    },
    async dropValidationDatabase() {
      return { ok: true };
    },
    evaluateTranslationFrames: () => ({
      verdict: controls.frameStatuses.includes('FAIL')
        ? 'FAIL'
        : controls.frameStatuses.includes('REVIEW')
          ? 'REVIEW'
          : 'PASS',
      executed_test_refs: [],
      frames: controls.frameStatuses.map((status, index) => ({
        name: `controlled-${String(index)}`,
        status,
        evidence_refs: [],
      })),
    }),
    async provisionValidationDatabase(input: { readonly validation_id: string }) {
      return { ok: true, database: `devai_task_TV_${input.validation_id.slice(3)}` };
    },
    async runLinuxIsolated() {
      return { exit_code: 0, stdout: 'ok', stderr: '', isolation_applied: true };
    },
  };
});

const ROOT = resolve(import.meta.dirname, '../../../..');
const WITNESS_PATH = 'scratch/translation-f-result-output-witness.json';
const RECIPE_PATH = 'record/proofs/work/recipe-runs/devai-fix/test/2026-09-12T00-00-00-000Z.json';
const TEST_PATH = 'packages/cli/tests/unit/translation-f-result-output-fixture.test.js';
const SOURCE_PATH = 'packages/cli/src/translation-f-result-output-fixture.ts';
const INVARIANT_ID = 'INV-DEMO-010';
const TEST_REF = {
  suite: 'unit',
  path: TEST_PATH,
  names: ['translation changes behavior'],
} as const;

interface Options {
  readonly witness: string;
  readonly repoRoot?: string;
  readonly databaseUrl?: string;
  readonly human?: boolean;
}

interface CommandCapture {
  option(): CommandCapture;
  action(callback: (options: Options) => Promise<void>): CommandCapture;
}

let fixture: ReturnType<typeof createSelfContainedRepositoryFixture>;
let repository: string;
let witness: Record<string, unknown>;
let invoke: (options: Options) => Promise<void>;
const originalExitCode = process.exitCode;
const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;

function writeText(path: string, value: string): void {
  const absolute = resolve(repository, path);
  mkdirSync(resolve(absolute, '..'), { recursive: true });
  writeFileSync(absolute, value);
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function bindWitness(): void {
  writeJson(WITNESS_PATH, witness);
  writeJson(RECIPE_PATH, {
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    status: 'pass',
    evidence: { translation_witness: witness },
  });
}

async function validate(): Promise<Record<string, unknown>> {
  bindWitness();
  return withAuthorityHostTestScope(() =>
    executeTranslationValidation({
      witness: WITNESS_PATH,
      repoRoot: repository,
      databaseUrl: 'postgres://unused',
    }),
  );
}

async function runAction(options: Options): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}> {
  let stdout = '';
  let stderr = '';
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  await withAuthorityHostTestScope(() => invoke(options));
  return { stdout, stderr, exitCode: process.exitCode ?? 0 };
}

beforeAll(() => {
  fixture = createSelfContainedRepositoryFixture(ROOT);
  repository = fixture.root;
  writeJson(`law/invariants/${INVARIANT_ID}.json`, {
    schemaVersion: '1.0.0',
    id: INVARIANT_ID,
    domain: 'DEMO',
    lifecycle: 'supported',
    severity: 'gate',
    type: 'validation',
    title: 'Translation result output contract',
    statement: 'The report-only result exposes exact verdict, diff, evidence, and CLI output.',
    status: 'active',
    verification: {
      required_suites: ['unit'],
      oracle: 'automated_tests',
      strategy: {
        primary: 'regression',
        deterministic_check_available: true,
        rationale: 'A registered fixture exercises exact result assembly.',
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
    invariants: [{ id: INVARIANT_ID, tests: [TEST_REF], code_areas: [SOURCE_PATH] }],
    test_corpus: [],
  });
  writeText(
    TEST_PATH,
    "import { test } from 'node:test';\ntest('translation changes behavior', () => {});\n",
  );
  fixture.git([
    'add',
    '--force',
    '--',
    `law/invariants/${INVARIANT_ID}.json`,
    'law/trace.json',
    TEST_PATH,
  ]);
  fixture.git(['commit', '--quiet', '-m', 'add result output fixture']);
  const base = fixture.git(['rev-parse', 'HEAD']);
  writeText(SOURCE_PATH, 'export const translationResultOutput = true;\n');
  fixture.git(['add', '--force', '--', SOURCE_PATH]);
  fixture.git(['commit', '--quiet', '-m', 'add result output candidate']);
  const candidate = fixture.git(['rev-parse', 'HEAD']);
  witness = {
    schemaVersion: '1.0.0',
    id: 'TW-ffffffffffffffff',
    trust: 'untrusted-claim',
    task_id: 'TASK-9011',
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    stage: 'invariants-tests-to-code',
    base_sha: base,
    candidate_sha: candidate,
    emitted_at: '2026-09-12T00:00:00.000Z',
    strategy: 'regression',
    implements: [
      {
        invariant_id: INVARIANT_ID,
        criteria: [
          {
            claim: 'The result output contract remains exact.',
            demonstrated_by: [{ kind: 'test', test_ref: TEST_REF }],
          },
        ],
      },
    ],
    red_green: [
      {
        test_ref: TEST_REF,
        expected_at_base: 'assertion-fail',
        expected_at_candidate: 'pass',
      },
    ],
    touched: [SOURCE_PATH],
    frame: {
      authority_role: 'engineer',
      spec_edits: 'none',
      test_edits: 'none',
      inventory_delta_confined_to: ['MOD-CLI'],
      effects_claimed: ['fs:plant'],
    },
  };
  writeJson('.devai/state/tasks/TASK-9011.json', {
    schemaVersion: '2.0.0',
    id: 'TASK-9011',
    round_id: 'R-0007',
    status: 'in_progress',
    discipline: 'engineer',
    title: 'Exercise translation result output',
    target_modules: ['MOD-CLI'],
    target_substrates: ['F2'],
    created_at: '2026-09-12T00:00:00.000Z',
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

  const command: CommandCapture = {
    option(): CommandCapture {
      return command;
    },
    action(callback: (options: Options) => Promise<void>): CommandCapture {
      invoke = callback;
      return command;
    },
  };
  verifyTranslation.register({ command: () => command } as unknown as CAC);
});

beforeEach(() => {
  controls.frameStatuses = ['PASS'];
  controls.omitLeaseCreate = false;
  controls.validationErrors = undefined;
  controls.validationResult = true;
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
});

afterAll(() => fixture?.cleanup());

describe('verify translation F result output contract', () => {
  it('emits PASS, REVIEW, and FAIL from exact frame populations', async () => {
    controls.frameStatuses = ['PASS'];
    expect((await validate())['verdict']).toBe('PASS');

    controls.frameStatuses = ['REVIEW'];
    expect((await validate())['verdict']).toBe('REVIEW');

    controls.frameStatuses = ['PASS', 'REVIEW'];
    expect((await validate())['verdict']).toBe('REVIEW');

    controls.frameStatuses = ['PASS', 'FAIL', 'REVIEW'];
    expect((await validate())['verdict']).toBe('FAIL');
  });

  it('preserves exact unexpected changes and frame evidence references', async () => {
    controls.frameStatuses = ['PASS', 'REVIEW'];
    controls.omitLeaseCreate = true;
    const result = await validate();
    const expectedDiff = result['expected_diff'] as {
      readonly expected: readonly { readonly path: string; readonly operation: string }[];
      readonly observed: readonly { readonly path: string; readonly operation: string }[];
      readonly unexpected: readonly { readonly path: string; readonly operation: string }[];
    };
    const omitted = expectedDiff.unexpected;

    expect(omitted).toHaveLength(3);
    expect(omitted[0]).toEqual({
      path: expect.stringMatching(
        /^\.devai\/state\/translation-validation\/leases\/TVL-[a-f0-9]{16}\.json$/u,
      ),
      operation: 'create',
    });
    expect(expectedDiff.expected).not.toContainEqual(omitted[0]);
    expect(expectedDiff.observed).toContainEqual(omitted[0]);
    expect(omitted.slice(1)).toEqual([
      {
        path: expect.stringMatching(
          /^\.devai\/state\/translation-validation\/results\/VR-[a-f0-9]{16}\.json$/u,
        ),
        operation: 'create',
      },
      {
        path: expect.stringMatching(
          /^\.devai\/state\/translation-validation\/witnesses\/TW-[a-f0-9]{16}\.json$/u,
        ),
        operation: 'create',
      },
    ]);
    expect(result['frames']).toEqual([
      { name: 'controlled-0', status: 'PASS', evidence_refs: ['EV-0123456789abcdef'] },
      { name: 'controlled-1', status: 'REVIEW', evidence_refs: ['EV-0123456789abcdef'] },
      { name: 'infrastructure', status: 'PASS', evidence_refs: ['EV-0123456789abcdef'] },
      { name: 'network-egress', status: 'PASS', evidence_refs: ['EV-0123456789abcdef'] },
      { name: 'cleanup', status: 'PASS', evidence_refs: ['EV-0123456789abcdef'] },
    ]);
  });

  it('reports the validator exact schema diagnostics and empty fallback', async () => {
    controls.validationErrors = [{ instancePath: '/verdict', message: 'sentinel' }];
    controls.validationResult = false;
    await expect(validate()).rejects.toThrow(
      'VALIDATION_RESULT_INVALID: [{"instancePath":"/verdict","message":"sentinel"}]',
    );

    controls.validationErrors = undefined;
    await expect(validate()).rejects.toThrow('VALIDATION_RESULT_INVALID: []');
  });

  it('writes exact human and JSON output and maps verdicts to exit codes', async () => {
    controls.frameStatuses = ['PASS'];
    const human = await runAction({
      witness: WITNESS_PATH,
      repoRoot: repository,
      databaseUrl: 'postgres://unused',
      human: true,
    });
    expect(human).toEqual({
      stdout: 'verify translation: PASS (report-only; readiness ineligible)\n',
      stderr: '',
      exitCode: 0,
    });

    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    controls.frameStatuses = ['FAIL'];
    const json = await runAction({
      witness: WITNESS_PATH,
      repoRoot: repository,
      databaseUrl: 'postgres://unused',
      human: false,
    });
    expect(json.stderr).toBe('');
    expect(json.exitCode).toBe(2);
    expect(json.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(json.stdout).toBe(`${JSON.stringify(parsed)}\n`);
    expect(parsed['verdict']).toBe('FAIL');
  });

  it('maps action failure to one exact diagnostic and EXIT_FAIL', async () => {
    const result = await runAction({ witness: WITNESS_PATH, repoRoot: repository });
    expect(result).toEqual({
      stdout: '',
      stderr: 'devai verify translation: DATABASE_URL_REQUIRED\n',
      exitCode: 2,
    });
  });
});
