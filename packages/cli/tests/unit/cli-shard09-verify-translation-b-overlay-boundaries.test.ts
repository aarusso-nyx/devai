import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { executeTranslationValidation } from '../../src/commands/verify/translation.js';

/**
 * Isolation-boundary depth for the feature-overlay strategy.
 *
 * `translation-feature-overlay-depth.test.ts` stops at the strategy-frame
 * boundary: its witness never provisions a database, so the isolation runner
 * behind `runIsolated`/`runMacOs` is never entered. This sibling drives the
 * same strategy far enough to reach that runner and pins the three platform
 * branches it dispatches on, the sandbox profile it builds, and the dependency
 * mount adapters it hands the Linux runner.
 */

interface SandboxResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string | null;
  readonly stderr: string | null;
  readonly error?: Error;
}

interface LinuxResult {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly isolation_applied: boolean;
}

interface SandboxCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: Record<string, unknown>;
}

interface LinuxInput {
  readonly repo_root: string;
  readonly dependencies_root: string | undefined;
  readonly image: string;
  readonly argv: readonly string[];
  readonly timeout_ms: number;
}

const controls = vi.hoisted(() => ({
  platform: 'darwin' as string,
  sandbox: {
    status: 0,
    signal: null,
    stdout: '',
    stderr: '',
  } as SandboxResult,
  linux: {
    exit_code: 0,
    stdout: '',
    stderr: '',
    isolation_applied: true,
  } as LinuxResult,
  probeDependencyMount: false,
}));

const records = vi.hoisted(() => ({
  sandboxCalls: [] as SandboxCall[],
  linuxInputs: [] as LinuxInput[],
  mountEvents: [] as string[],
}));

/**
 * The isolation runner reads `process.env['PATH']`, and the fallback assertion
 * below deletes it. Every delegated subprocess therefore receives a captured
 * real `PATH` so that stubbing the variable observes only the code under test.
 */
const hostPath = vi.hoisted(() => process.env['PATH'] ?? '/usr/bin:/bin');

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: (): string => controls.platform };
});

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  type SpawnSync = typeof actual.spawnSync;
  const spawnSync = ((
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => {
    if (command === 'sandbox-exec') {
      records.sandboxCalls.push({ command, args: [...args], options: { ...options } });
      return { ...controls.sandbox };
    }
    const withHostPath = { ...options, env: { ...process.env, PATH: hostPath } };
    // Reaching the isolation runner needs a real worktree, and these three Git
    // subcommands write. The read-only host process gate refuses them by
    // design, so they are delegated directly; every other subprocess still
    // crosses the authority host boundary unchanged.
    const writesWorktree =
      command === 'git' &&
      args[0] === 'worktree' &&
      ['add', 'remove', 'prune'].includes(String(args[1]));
    return writesWorktree
      ? nodeSpawnSync(command, [...args], withHostPath)
      : (actual.spawnSync as SpawnSync)(command, [...args], withHostPath);
  }) as SpawnSync;
  return { ...actual, spawnSync };
});

vi.mock('#runtime-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime-core.js')>();
  return {
    ...actual,
    async provisionValidationDatabase(input: { readonly validation_id: string }) {
      return { ok: true, database: `devai_task_TV_${input.validation_id.slice('VR-'.length)}` };
    },
    async dropValidationDatabase() {
      return { ok: true };
    },
    async runLinuxIsolated(input: Parameters<typeof actual.runLinuxIsolated>[0]) {
      records.linuxInputs.push({
        repo_root: input.repo_root,
        dependencies_root: input.dependencies_root,
        image: input.image,
        argv: [...input.argv],
        timeout_ms: input.timeout_ms,
      });
      if (controls.probeDependencyMount && records.mountEvents.length === 0) {
        const mountPoint = resolve(input.repo_root, 'node_modules');
        const nested = resolve(mountPoint, 'nested/deep');
        // A nested, absent target: a non-recursive adapter cannot create it.
        input.prepare_dependency_mount_point?.(nested);
        records.mountEvents.push(existsSync(nested) ? 'prepared' : 'prepare-missed');
        writeFileSync(resolve(nested, 'occupant.txt'), 'occupant\n');
        // A populated directory: a non-recursive adapter cannot remove it.
        input.remove_dependency_mount_point?.(mountPoint);
        records.mountEvents.push(existsSync(mountPoint) ? 'remove-missed' : 'removed');
        // An absent target: only a forcing adapter tolerates the repeat.
        input.remove_dependency_mount_point?.(mountPoint);
        records.mountEvents.push('repeat-removal-tolerated');
      }
      return { ...controls.linux };
    },
  };
});

const WITNESS_PATH = 'scratch/translation-b-overlay-boundaries-witness.json';
const RECIPE_PATH = 'record/proofs/work/recipe-runs/devai-fix/test/2026-07-29T00-00-00-000Z.json';
const TEST_PATH = 'packages/cli/tests/unit/translation-b-overlay-boundaries-fixture.test.js';
const SOURCE_PATH = 'packages/cli/src/translation-b-overlay-boundaries-fixture.js';
const TEST_NAME = 'overlay boundary behavior';
const TEST_REF = { suite: 'unit', path: TEST_PATH, names: [TEST_NAME] } as const;
const EXPECTED_ARGV = ['node', '--test', '--test-name-pattern', TEST_NAME, TEST_PATH] as const;
const LINUX_IMAGE =
  'node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd';

let root: string;
let baseCommit: string;
let overlayCommit: string;
let candidateCommit: string;

function git(args: readonly string[]): string {
  const result = nodeSpawnSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: hostPath },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function writeText(path: string, value: string): void {
  const absolute = resolve(root, path);
  mkdirSync(resolve(absolute, '..'), { recursive: true });
  writeFileSync(absolute, value);
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function witness(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    schemaVersion: '1.0.0',
    id: 'TW-00b0b0b0b0b0b0b0',
    trust: 'untrusted-claim',
    task_id: 'TASK-9004',
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    stage: 'invariants-tests-to-code',
    base_sha: baseCommit,
    test_overlay_sha: overlayCommit,
    candidate_sha: candidateCommit,
    emitted_at: '2026-07-29T00:00:00.000Z',
    strategy: 'feature-overlay',
    implements: [
      {
        invariant_id: 'INV-DEMO-004',
        criteria: [
          {
            claim: 'The candidate preserves the registered overlay boundary behavior.',
            demonstrated_by: [{ kind: 'test', test_ref: TEST_REF }],
          },
        ],
      },
    ],
    touched: [SOURCE_PATH],
    red_green: [
      {
        test_ref: TEST_REF,
        expected_at_base: 'assertion-fail',
        expected_at_candidate: 'pass',
      },
    ],
    frame: {
      authority_role: 'engineer',
      spec_edits: 'none',
      test_edits: 'declared',
      inventory_delta_confined_to: ['MOD-CLI'],
      effects_claimed: ['fs:plant'],
    },
  };
  return {
    ...base,
    ...overrides,
    frame: {
      ...base.frame,
      ...((overrides['frame'] as Record<string, unknown> | undefined) ?? {}),
    },
  };
}

async function validate(value = witness()): Promise<Record<string, unknown>> {
  writeJson(WITNESS_PATH, value);
  writeJson(RECIPE_PATH, {
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    status: 'pass',
    evidence: { translation_witness: value },
  });
  return withAuthorityHostTestScope(() =>
    executeTranslationValidation({
      witness: WITNESS_PATH,
      repoRoot: root,
      databaseUrl: 'postgres://unused',
    }),
  );
}

function onlySandboxCall(): SandboxCall {
  expect(records.sandboxCalls).toHaveLength(2);
  const [first, second] = records.sandboxCalls;
  if (first === undefined || second === undefined) throw new Error('sandbox calls missing');
  // Both overlay and candidate phases reach the same sandbox invocation.
  expect(second).toEqual(first);
  return first;
}

function executionsOf(result: Record<string, unknown>): readonly Record<string, unknown>[] {
  return result['executions'] as readonly Record<string, unknown>[];
}

function frameOf(result: Record<string, unknown>, name: string): Record<string, unknown> {
  const frames = result['frames'] as readonly Record<string, unknown>[];
  const frame = frames.find((candidate) => candidate['name'] === name);
  if (frame === undefined) throw new Error(`frame ${name} missing`);
  return frame;
}

function structuralWitness(
  invariantId: string,
  demonstratedBy: readonly Record<string, unknown>[] = [
    { kind: 'structural', validator: 'check --only schema' },
  ],
): Record<string, unknown> {
  return witness({
    strategy: 'structural',
    test_overlay_sha: undefined,
    red_green: undefined,
    implements: [
      {
        invariant_id: invariantId,
        criteria: [
          {
            claim: 'A structural validator demonstrates the boundary.',
            demonstrated_by: demonstratedBy,
          },
        ],
      },
    ],
  });
}

beforeAll(() => {
  // A quoted and backslashed repository root makes the sandbox profile's
  // path escaping observable; both characters are legal POSIX path bytes.
  root = mkdtempSync(join(tmpdir(), 'devai-tv-b "overlay\\boundary-'));
  git(['init', '--quiet']);
  git(['config', 'user.name', 'DEVAI Translation Test']);
  git(['config', 'user.email', 'translation-test@example.invalid']);
  git(['config', 'commit.gpgSign', 'false']);

  const invariant = (
    id: string,
    strategy: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    schemaVersion: '1.0.0',
    id,
    domain: 'DEMO',
    lifecycle: 'supported',
    severity: 'gate',
    type: 'validation',
    title: 'Registered overlay boundary behavior',
    statement: 'The registered overlay test must exercise the candidate behavior.',
    status: 'active',
    verification: {
      required_suites: ['unit'],
      oracle: 'tests',
      strategy: {
        primary: strategy,
        deterministic_check_available: true,
        rationale: 'The registered overlay test is deterministic.',
        ...(strategy === 'semantic-review'
          ? { semantic_review_justification: 'The review rubric is the declared oracle.' }
          : {}),
      },
    },
    authority_docs: { docs: [{ doc: 'README.md', anchor: 'testing' }] },
    scope: { components: ['cli'], code_areas: [SOURCE_PATH], modules: ['MOD-CLI'] },
    change_policy: {
      breaking_change_requires: ['test_update'],
      test_weakening_allowed: false,
      human_approval_required: false,
    },
    ...overrides,
  });
  writeJson('law/invariants/INV-DEMO-004.json', invariant('INV-DEMO-004', 'feature-overlay'));
  writeJson('law/invariants/INV-DEMO-005.json', {});
  writeJson('law/invariants/INV-DEMO-006.json', invariant('INV-DEMO-007', 'structural'));
  writeJson(
    'law/invariants/INV-DEMO-008.json',
    invariant('INV-DEMO-008', 'structural', { lifecycle: 'experimental' }),
  );
  writeJson(
    'law/invariants/INV-DEMO-009.json',
    invariant('INV-DEMO-009', 'structural', { status: 'draft' }),
  );
  writeJson('law/invariants/INV-DEMO-010.json', invariant('INV-DEMO-010', 'semantic-review'));
  writeJson('law/invariants/INV-DEMO-011.json', invariant('INV-DEMO-011', 'structural'));
  writeJson('law/trace.json', {
    schemaVersion: '1.0.0',
    version: '1.0.0',
    invariants: [
      {
        id: 'INV-DEMO-004',
        tests: [{ suite: 'unit', path: TEST_PATH, names: ['decoy overlay behavior'] }, TEST_REF],
        code_areas: [SOURCE_PATH],
      },
    ],
    test_corpus: [],
  });
  writeText(SOURCE_PATH, 'export const overlayBoundary = false;\n');
  git(['add', '--force', '--', 'law/invariants', 'law/trace.json', SOURCE_PATH]);
  git(['commit', '--quiet', '-m', 'establish overlay boundary baseline']);
  baseCommit = git(['rev-parse', 'HEAD']);

  writeText(
    TEST_PATH,
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { overlayBoundary } from '../../src/translation-b-overlay-boundaries-fixture.js';",
      `test('${TEST_NAME}', () => assert.equal(overlayBoundary, true));`,
      '',
    ].join('\n'),
  );
  git(['add', '--force', '--', TEST_PATH]);
  git(['commit', '--quiet', '-m', 'add registered test overlay']);
  overlayCommit = git(['rev-parse', 'HEAD']);

  writeText(SOURCE_PATH, 'export const overlayBoundary = true;\n');
  git(['add', '--force', '--', SOURCE_PATH]);
  git(['commit', '--quiet', '-m', 'implement overlay boundary behavior']);
  candidateCommit = git(['rev-parse', 'HEAD']);

  writeJson('.devai/state/tasks/TASK-9004.json', {
    schemaVersion: '2.0.0',
    id: 'TASK-9004',
    round_id: 'R-0007',
    status: 'in_progress',
    discipline: 'engineer',
    title: 'Exercise translation isolation boundaries',
    target_modules: ['MOD-CLI'],
    target_substrates: ['F2'],
    created_at: '2026-07-29T00:00:00.000Z',
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
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  controls.platform = 'darwin';
  controls.sandbox = { status: 0, signal: null, stdout: '', stderr: '' };
  controls.linux = { exit_code: 0, stdout: '', stderr: '', isolation_applied: true };
  controls.probeDependencyMount = false;
  records.sandboxCalls.length = 0;
  records.linuxInputs.length = 0;
  records.mountEvents.length = 0;
});

describe('verify translation isolation boundaries', () => {
  it('builds the exact macOS sandbox command, escaping the worktree path it denies', async () => {
    vi.stubEnv('PATH', '/sentinel/path');
    vi.stubEnv('HOME', '/sentinel/home');
    vi.stubEnv('TMPDIR', '/sentinel/tmp');

    const result = await validate();

    expect(records.linuxInputs).toEqual([]);
    const call = onlySandboxCall();
    expect(call.command).toBe('sandbox-exec');

    const worktree = call.options['cwd'];
    expect(typeof worktree).toBe('string');
    const denied = String(worktree);
    expect(denied).toContain('"');
    expect(denied).toContain('\\');

    const escaped = denied.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    expect(call.args).toEqual([
      '-p',
      `(version 1)(deny network*)(deny file-write* (subpath "${escaped}"))(allow default)`,
      ...EXPECTED_ARGV,
    ]);
    // The raw path must never reach the profile: an unescaped quote would end
    // the subpath literal and an unescaped backslash would escape the byte
    // after it, so the denial would cover some other path.
    expect(call.args[1]).not.toContain(`(subpath "${denied}")`);
    expect(call.args[1]).toContain('\\"');
    expect(call.args[1]).toContain('\\\\');

    expect(call.options['encoding']).toBe('utf8');
    expect(call.options['timeout']).toBe(120_000);
    expect(call.options['env']).toEqual({
      PATH: '/sentinel/path',
      HOME: '/sentinel/home',
      TMPDIR: '/sentinel/tmp',
      DEVAI_VALIDATION_ISOLATED: '1',
    });

    expect(result['isolation']).toEqual({
      mode: 'macos-best-effort',
      network_egress: 'not-proven',
      database: 'per-task-database',
      readiness_eligible: false,
    });
    expect(executionsOf(result)).toEqual([
      expect.objectContaining({ phase: 'test-overlay', outcome: 'pass', failure_mode: 'none' }),
      expect.objectContaining({ phase: 'candidate', outcome: 'pass', failure_mode: 'none' }),
    ]);
  });

  it('substitutes a fixed sandbox environment when the host declares none', async () => {
    vi.stubEnv('PATH', undefined);
    vi.stubEnv('HOME', undefined);
    vi.stubEnv('TMPDIR', undefined);

    await validate();

    expect(onlySandboxCall().options['env']).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/tmp',
      TMPDIR: '/tmp',
      DEVAI_VALIDATION_ISOLATED: '1',
    });
  });

  it('classifies sandbox stdout, stderr, and spawn errors as distinct failure modes', async () => {
    controls.sandbox = {
      status: 1,
      signal: null,
      stdout: 'ENOENT: no such file or directory',
      stderr: '',
    };
    const missing = await validate();
    expect(executionsOf(missing)).toEqual([
      expect.objectContaining({ phase: 'test-overlay', outcome: 'crash' }),
      expect.objectContaining({ phase: 'candidate', outcome: 'crash' }),
    ]);
    expect(executionsOf(missing).map((execution) => execution['failure_mode'])).toEqual([
      'missing-file',
      'missing-file',
    ]);

    records.sandboxCalls.length = 0;
    controls.sandbox = {
      status: 1,
      signal: null,
      stdout: '',
      stderr: 'AssertionError [ERR_ASSERTION]: overlay boundary behavior',
    };
    const asserted = await validate();
    expect(executionsOf(asserted).map((execution) => execution['failure_mode'])).toEqual([
      'assertion',
      'assertion',
    ]);
    expect(executionsOf(asserted).map((execution) => execution['outcome'])).toEqual([
      'fail',
      'fail',
    ]);

    records.sandboxCalls.length = 0;
    const timeout: NodeJS.ErrnoException = new Error('spawnSync sandbox-exec ETIMEDOUT');
    timeout.code = 'ETIMEDOUT';
    controls.sandbox = { status: null, signal: null, stdout: '', stderr: '', error: timeout };
    const timedOut = await validate();
    expect(executionsOf(timedOut).map((execution) => execution['failure_mode'])).toEqual([
      'timeout',
      'timeout',
    ]);
  });

  it('normalizes null sandbox output while retaining a spawn error for classification', async () => {
    const asserted = new Error('AssertionError [ERR_ASSERTION]: normalized spawn failure');
    controls.sandbox = {
      status: 1,
      signal: null,
      stdout: null,
      stderr: null,
      error: asserted,
    };

    const result = await validate();

    expect(executionsOf(result)).toEqual([
      expect.objectContaining({
        phase: 'test-overlay',
        outcome: 'fail',
        failure_mode: 'assertion',
      }),
      expect.objectContaining({ phase: 'candidate', outcome: 'fail', failure_mode: 'assertion' }),
    ]);
  });

  it('requires an exact registered suite, path, and test-name tuple', async () => {
    const mismatches = [
      { suite: 'int', path: TEST_PATH, names: [TEST_NAME] },
      { suite: 'unit', path: `${TEST_PATH}.other`, names: [TEST_NAME] },
      { suite: 'unit', path: TEST_PATH, names: [`${TEST_NAME} changed`] },
    ];

    for (const testRef of mismatches) {
      await expect(
        validate(
          witness({
            red_green: [
              {
                test_ref: testRef,
                expected_at_base: 'assertion-fail',
                expected_at_candidate: 'pass',
              },
            ],
          }),
        ),
      ).rejects.toThrow(
        `TRANSLATION_TEST_REF_UNREGISTERED: ${testRef.suite}:${testRef.path}:${testRef.names.join(' > ')}`,
      );
    }
  });

  it('rejects zero and reports missing, invalid, and ineligible strategy populations exactly', async () => {
    await expect(
      validate(
        witness({
          strategy: 'structural',
          test_overlay_sha: undefined,
          red_green: undefined,
          implements: [],
        }),
      ),
    ).rejects.toThrow('TRANSLATION_WITNESS_INVALID');

    const cases = [
      {
        value: structuralWitness('INV-ABSENT-012'),
        finding: 'INV-ABSENT-012: STRATEGY_INVARIANT_MISSING',
      },
      {
        value: structuralWitness('INV-DEMO-005'),
        finding: 'INV-DEMO-005: STRATEGY_INVARIANT_INVALID',
      },
      {
        value: structuralWitness('INV-DEMO-006'),
        finding: 'INV-DEMO-006: STRATEGY_INVARIANT_INELIGIBLE',
      },
      {
        value: structuralWitness('INV-DEMO-008'),
        finding: 'INV-DEMO-008: STRATEGY_INVARIANT_INELIGIBLE',
      },
      {
        value: structuralWitness('INV-DEMO-009'),
        finding: 'INV-DEMO-009: STRATEGY_INVARIANT_INELIGIBLE',
      },
    ];

    for (const entry of cases) {
      const result = await validate(entry.value);
      expect(frameOf(result, 'strategy-coverage')).toEqual(
        expect.objectContaining({
          name: 'strategy-coverage',
          status: 'FAIL',
          finding: entry.finding,
        }),
      );
    }
  });

  it('distinguishes primary-strategy, demonstration-kind, and cited-test failures', async () => {
    const primary = await validate(structuralWitness('INV-DEMO-010'));
    expect(frameOf(primary, 'strategy-coverage')['finding']).toBe(
      'INV-DEMO-010: STRATEGY_PRIMARY_MISMATCH',
    );

    const demonstration = await validate(
      structuralWitness('INV-DEMO-011', [
        { kind: 'semantic-review', rubric_ref: 'work/audit/translation-review.md' },
      ]),
    );
    expect(frameOf(demonstration, 'strategy-coverage')['finding']).toBe(
      'INV-DEMO-011: STRATEGY_DEMONSTRATION_MISSING',
    );

    const uncitedRef = { suite: 'unit', path: TEST_PATH, names: ['decoy overlay behavior'] };
    const uncited = await validate(
      witness({
        implements: [
          {
            invariant_id: 'INV-DEMO-004',
            criteria: [
              {
                claim: 'The candidate preserves another registered behavior.',
                demonstrated_by: [{ kind: 'test', test_ref: uncitedRef }],
              },
            ],
          },
        ],
      }),
    );
    expect(frameOf(uncited, 'strategy-coverage')['finding']).toBe(
      'INV-DEMO-004: STRATEGY_TEST_UNREGISTERED',
    );
  });

  it('preserves valid structural coverage and the full inferred-effects set', async () => {
    const structural = await validate(structuralWitness('INV-DEMO-011'));
    expect(frameOf(structural, 'strategy-coverage')).toEqual(
      expect.objectContaining({ name: 'strategy-coverage', status: 'PASS' }),
    );

    const overlay = await validate(witness({ frame: { effects_claimed: ['fs:tests'] } }));
    expect(frameOf(overlay, 'strategy-coverage')['status']).toBe('PASS');
    expect(frameOf(overlay, 'effects')).toEqual(
      expect.objectContaining({
        status: 'FAIL',
        finding: 'Inferred effects exceed the witness claim.',
      }),
    );
  });

  it('hands the Linux runner the worktree, the pinned image, and recursive mount adapters', async () => {
    controls.platform = 'linux';
    controls.probeDependencyMount = true;

    const result = await validate();

    expect(records.sandboxCalls).toEqual([]);
    expect(records.linuxInputs).toHaveLength(2);
    const [first] = records.linuxInputs;
    if (first === undefined) throw new Error('linux runner input missing');
    expect(first.image).toBe(LINUX_IMAGE);
    expect(first.timeout_ms).toBe(120_000);
    expect(first.argv).toEqual([...EXPECTED_ARGV]);
    expect(first.dependencies_root).toBe(root);
    // The container mounts the worktree, never the caller's repository.
    expect(first.repo_root).not.toBe(root);
    expect(first.repo_root.startsWith(`${root}/.devai/worktrees/WT-TV-`)).toBe(true);

    expect(records.mountEvents).toEqual(['prepared', 'removed', 'repeat-removal-tolerated']);

    expect(result['isolation']).toEqual({
      mode: 'linux-container-no-network',
      network_egress: 'denied',
      database: 'per-task-database',
      readiness_eligible: true,
    });
    expect(executionsOf(result)).toEqual([
      expect.objectContaining({ phase: 'test-overlay', outcome: 'pass', failure_mode: 'none' }),
      expect.objectContaining({ phase: 'candidate', outcome: 'pass', failure_mode: 'none' }),
    ]);
  });

  it('reports the Linux runner exit code and withholds the proof it did not make', async () => {
    controls.platform = 'linux';
    controls.linux = {
      exit_code: 3,
      stdout: '',
      stderr: 'AssertionError [ERR_ASSERTION]: overlay boundary behavior',
      isolation_applied: false,
    };

    const result = await validate();

    expect(records.sandboxCalls).toEqual([]);
    expect(executionsOf(result).map((execution) => execution['failure_mode'])).toEqual([
      'assertion',
      'assertion',
    ]);
    expect(result['isolation']).toEqual(
      expect.objectContaining({ network_egress: 'not-proven', readiness_eligible: false }),
    );
    expect(result['frames']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'infrastructure',
          status: 'FAIL',
          finding: expect.stringContaining('LINUX_ISOLATION_NOT_APPLIED'),
        }),
      ]),
    );
  });

  it('refuses an unsupported platform without spawning either isolation runner', async () => {
    controls.platform = 'sunos';

    const result = await validate();

    expect(records.sandboxCalls).toEqual([]);
    expect(records.linuxInputs).toEqual([]);
    expect(executionsOf(result)).toEqual([
      expect.objectContaining({ phase: 'test-overlay', outcome: 'crash' }),
      expect.objectContaining({ phase: 'candidate', outcome: 'crash' }),
    ]);
    expect(executionsOf(result).map((execution) => execution['failure_mode'])).toEqual([
      'infrastructure',
      'infrastructure',
    ]);
    expect(result['isolation']).toEqual(
      expect.objectContaining({ mode: 'macos-best-effort', readiness_eligible: false }),
    );
    expect(result['frames']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'infrastructure',
          status: 'FAIL',
          finding: expect.stringContaining('REGISTERED_EXECUTION_INFRASTRUCTURE_FAILURE'),
        }),
      ]),
    );
    expect(frameOf(result, 'network-egress')['finding']).toBe(
      'Native isolation is best-effort; network denial is not proven.',
    );
  });
});
