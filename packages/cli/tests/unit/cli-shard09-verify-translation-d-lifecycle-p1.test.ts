// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync as nodeRmSync,
  writeFileSync as nodeWriteFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { createSelfContainedRepositoryFixture } from '../helpers/self-contained-repository-fixture.js';

type Strategy = 'regression' | 'feature-overlay' | 'structural';

const controls = vi.hoisted(() => ({
  provision: 'success' as 'success' | 'failure' | 'failure-without-error' | 'wrong-database',
  dropOk: true,
  dropCalls: [] as string[],
  isolatedCalls: [] as {
    readonly repo_root: string;
    readonly argv: readonly string[];
    readonly testSource: string | null;
  }[],
  frameInputs: [] as Record<string, unknown>[],
  gitWorktreeAdds: [] as string[],
  worktreeAddFailures: 0,
  worktreeAddFailureStderr: 'sentinel add failure',
  gitWorktreeRemoves: [] as string[],
  removeFailures: 0,
  removeAfterSuccessFailures: 0,
  pruneFailures: 0,
  overlayDiffTargetSha: null as string | null,
  overlayDiffExtraPath: null as string | null,
  leaseWrites: [] as { readonly path: string; readonly value: Record<string, unknown> }[],
  rmCalls: [] as { readonly path: string; readonly options: unknown }[],
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  platform: () => 'linux',
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync(
      path: Parameters<typeof actual.writeFileSync>[0],
      value: unknown,
      ...rest: unknown[]
    ) {
      const text = String(value);
      if (String(path).includes('/translation-validation/leases/') && text.startsWith('{')) {
        controls.leaseWrites.push({ path: String(path), value: JSON.parse(text) });
      }
      return Reflect.apply(actual.writeFileSync, undefined, [path, value, ...rest]);
    },
    rmSync(
      path: Parameters<typeof actual.rmSync>[0],
      options?: Parameters<typeof actual.rmSync>[1],
    ) {
      controls.rmCalls.push({ path: String(path), options });
      return actual.rmSync(path, options);
    },
  };
});

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync(
    command: string,
    args: readonly string[],
    options: Parameters<typeof nodeSpawnSync>[2],
  ) {
    if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
      controls.gitWorktreeAdds.push(String(args.at(-1)));
      if (controls.worktreeAddFailures > 0) {
        controls.worktreeAddFailures -= 1;
        return { status: 1, signal: null, stdout: '', stderr: controls.worktreeAddFailureStderr };
      }
    }
    if (command === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
      controls.gitWorktreeRemoves.push(String(args.at(-1)));
      if (controls.removeFailures > 0) {
        controls.removeFailures -= 1;
        return { status: 1, signal: null, stdout: '', stderr: 'sentinel removal failure' };
      }
      const result = nodeSpawnSync(command, [...args], options);
      if (controls.removeAfterSuccessFailures > 0) {
        controls.removeAfterSuccessFailures -= 1;
        return {
          status: 1,
          signal: result.signal,
          stdout: result.stdout,
          stderr: 'sentinel post-removal failure',
        };
      }
      return result;
    }
    if (command === 'git' && args[0] === 'worktree' && args[1] === 'prune') {
      if (controls.pruneFailures > 0) {
        controls.pruneFailures -= 1;
        return { status: 1, signal: null, stdout: '', stderr: 'sentinel prune failure' };
      }
    }
    if (command === 'git' && args[0] === 'diff' && args[1] === '--name-only') {
      const result = nodeSpawnSync(command, [...args], options);
      if (
        controls.overlayDiffExtraPath !== null &&
        controls.overlayDiffTargetSha !== null &&
        args[3] === controls.overlayDiffTargetSha
      ) {
        return {
          ...result,
          stdout: `${String(result.stdout).trimEnd()}\n${controls.overlayDiffExtraPath}\n`,
        };
      }
      return result;
    }
    if (
      command === 'git' &&
      args[0] === 'cat-file' &&
      args[1] === 'blob' &&
      controls.overlayDiffExtraPath !== null &&
      String(args[2]).endsWith(`:${controls.overlayDiffExtraPath}`)
    ) {
      return {
        status: 0,
        signal: null,
        stdout: Buffer.from(
          "import { test } from 'node:test';\ntest('unsafe overlay', () => {});\n",
        ),
        stderr: Buffer.alloc(0),
      };
    }
    return nodeSpawnSync(command, [...args], options);
  },
}));

vi.mock('#runtime-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime-core.js')>();
  return {
    ...actual,
    appendVerbEvidence: () => ({ ok: true, id: 'EV-0123456789abcdef' }),
    async provisionValidationDatabase(input: { readonly validation_id: string }) {
      if (controls.provision === 'failure')
        return { ok: false, error: 'sentinel provision failure' };
      if (controls.provision === 'failure-without-error') return { ok: false };
      if (controls.provision === 'wrong-database') return { ok: true, database: 'wrong_database' };
      return { ok: true, database: `devai_task_TV_${input.validation_id.slice(3)}` };
    },
    async dropValidationDatabase(input: { readonly database: string }) {
      controls.dropCalls.push(input.database);
      return { ok: controls.dropOk };
    },
    async runLinuxIsolated(input: {
      readonly repo_root: string;
      readonly argv: readonly string[];
    }) {
      const testPath = resolve(input.repo_root, String(input.argv.at(-1)));
      controls.isolatedCalls.push({
        repo_root: input.repo_root,
        argv: input.argv,
        testSource: existsSync(testPath) ? readFileSync(testPath, 'utf8') : null,
      });
      return { exit_code: 0, stdout: 'ok', stderr: '', isolation_applied: true };
    },
    evaluateTranslationFrames(input: Parameters<typeof actual.evaluateTranslationFrames>[0]) {
      controls.frameInputs.push(structuredClone(input) as unknown as Record<string, unknown>);
      return actual.evaluateTranslationFrames(input);
    },
  };
});

import { executeTranslationValidation } from '../../src/commands/verify/translation.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const WITNESS_PATH = 'scratch/translation-d-lifecycle-p1-witness.json';
const RECIPE_PATH = 'record/proofs/work/recipe-runs/devai-fix/test/2026-09-12T00-00-00-000Z.json';
const TEST_PATH = 'packages/cli/tests/unit/translation-d-lifecycle-p1-fixture.test.js';
const UNSAFE_OVERLAY_PATH = 'packages/cli/tests/unit/unsafe\\fixture.test.js';
const SOURCE_PATH = 'packages/cli/src/translation-d-lifecycle-p1-fixture.ts';
const TEST_REF = { suite: 'unit', path: TEST_PATH, names: ['translation D lifecycle'] } as const;
const D_P1_FINGERPRINTS = [
  965, 982, 988, 991, 993, 996, 1009, 1018, 1021, 1053, 1056, 1057, 1090, 1091, 1092, 1093, 1094,
  1098, 1100, 1106, 1107, 1108,
] as const;
const D_P2_FINGERPRINTS = [
  1008, 1010, 1011, 1012, 1013, 1019, 1023, 1024, 1027, 1029, 1032, 1037, 1070,
] as const;
const D_RESIDUAL_KILL_TARGETS = [1012, 1013, 1024, 1070, 1093, 1100, 1107] as const;

let fixture: ReturnType<typeof createSelfContainedRepositoryFixture>;
let repository: string;
let base: string;
let overlay: string;
let candidate: string;

function writeText(path: string, value: string): void {
  const absolute = resolve(repository, path);
  mkdirSync(resolve(absolute, '..'), { recursive: true });
  nodeWriteFileSync(absolute, value);
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function witness(strategy: Strategy, id = 'TW-dddddddddddddddd'): Record<string, unknown> {
  const testBacked = strategy !== 'structural';
  const value: Record<string, unknown> = {
    schemaVersion: '1.0.0',
    id,
    trust: 'untrusted-claim',
    task_id: 'TASK-9012',
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    stage: 'invariants-tests-to-code',
    base_sha: strategy === 'feature-overlay' ? base : overlay,
    candidate_sha: candidate,
    emitted_at: '2026-09-12T00:00:00.000Z',
    strategy,
    implements: [
      {
        invariant_id: 'INV-DEMO-012',
        criteria: [
          {
            claim: 'Translation D lifecycle remains exact.',
            demonstrated_by: testBacked
              ? [{ kind: 'test', test_ref: TEST_REF }]
              : [{ kind: 'structural', validator: 'check --only action-effects' }],
          },
        ],
      },
    ],
    touched: [SOURCE_PATH],
    frame: {
      authority_role: 'engineer',
      spec_edits: 'none',
      test_edits: strategy === 'feature-overlay' ? 'declared' : 'none',
      inventory_delta_confined_to: ['MOD-CLI'],
      effects_claimed: ['fs:plant'],
    },
  };
  if (testBacked) {
    value.red_green = [
      { test_ref: TEST_REF, expected_at_base: 'assertion-fail', expected_at_candidate: 'pass' },
    ];
  }
  if (strategy === 'feature-overlay') value.test_overlay_sha = overlay;
  return value;
}

async function validate(strategy: Strategy, id?: string): Promise<Record<string, unknown>> {
  const value = witness(strategy, id);
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
      repoRoot: repository,
      databaseUrl: 'postgres://unused',
    }),
  );
}

function cleanupManagedWorktrees(): void {
  const output = nodeSpawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repository,
    encoding: 'utf8',
  }).stdout;
  for (const path of String(output).match(/^worktree (.+\/WT-TV-[a-f0-9]{16})$/gmu) ?? []) {
    nodeSpawnSync('git', ['worktree', 'remove', '--force', path.slice('worktree '.length)], {
      cwd: repository,
      encoding: 'utf8',
    });
  }
  nodeSpawnSync('git', ['worktree', 'prune'], { cwd: repository, encoding: 'utf8' });
  nodeRmSync(resolve(repository, '.devai/state/translation-validation/leases'), {
    recursive: true,
    force: true,
  });
}

beforeAll(() => {
  fixture = createSelfContainedRepositoryFixture(ROOT);
  repository = fixture.root;
  writeJson('law/invariants/INV-DEMO-012.json', {
    schemaVersion: '1.0.0',
    id: 'INV-DEMO-012',
    domain: 'DEMO',
    lifecycle: 'supported',
    severity: 'gate',
    type: 'validation',
    title: 'Translation D lifecycle',
    statement: 'Validation resources retain exact identity, phase, and cleanup custody.',
    status: 'active',
    verification: {
      required_suites: ['unit'],
      oracle: 'automated_tests',
      strategy: {
        primary: 'feature-overlay',
        deterministic_check_available: true,
        rationale: 'A controlled fixture observes lifecycle state transitions.',
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
      {
        id: 'INV-DEMO-012',
        tests: [TEST_REF, { suite: 'unit', path: UNSAFE_OVERLAY_PATH, names: ['unsafe overlay'] }],
        code_areas: [SOURCE_PATH],
      },
    ],
    test_corpus: [],
  });
  writeText(SOURCE_PATH, 'export const translationDLifecycle = false;\n');
  fixture.git(['add', '--force', '--', 'law', SOURCE_PATH]);
  fixture.git(['commit', '--quiet', '-m', 'establish D lifecycle base']);
  base = fixture.git(['rev-parse', 'HEAD']);
  writeText(
    TEST_PATH,
    "import { test } from 'node:test';\ntest('translation D lifecycle', () => {});\n",
  );
  fixture.git(['add', '--force', '--', TEST_PATH]);
  fixture.git(['commit', '--quiet', '-m', 'add D lifecycle overlay']);
  overlay = fixture.git(['rev-parse', 'HEAD']);
  writeText(SOURCE_PATH, 'export const translationDLifecycle = true;\n');
  fixture.git(['add', '--force', '--', SOURCE_PATH]);
  fixture.git(['commit', '--quiet', '-m', 'implement D lifecycle candidate']);
  candidate = fixture.git(['rev-parse', 'HEAD']);
  writeJson('.devai/state/tasks/TASK-9012.json', {
    schemaVersion: '2.0.0',
    id: 'TASK-9012',
    round_id: 'R-0007',
    status: 'in_progress',
    discipline: 'engineer',
    title: 'Exercise translation D lifecycle',
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
});

beforeEach(() => {
  controls.provision = 'success';
  controls.dropOk = true;
  controls.dropCalls = [];
  controls.isolatedCalls = [];
  controls.frameInputs = [];
  controls.gitWorktreeAdds = [];
  controls.worktreeAddFailures = 0;
  controls.worktreeAddFailureStderr = 'sentinel add failure';
  controls.gitWorktreeRemoves = [];
  controls.removeFailures = 0;
  controls.removeAfterSuccessFailures = 0;
  controls.pruneFailures = 0;
  controls.overlayDiffTargetSha = null;
  controls.overlayDiffExtraPath = null;
  controls.leaseWrites = [];
  controls.rmCalls = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-12T03:00:00.000Z'));
});

afterEach(() => {
  controls.worktreeAddFailures = 0;
  controls.removeFailures = 0;
  cleanupManagedWorktrees();
  vi.useRealTimers();
});

afterAll(() => fixture?.cleanup());

describe('verify translation D lifecycle P1 and P2', () => {
  it('binds this behavioral wave to the 35 exact analyzed D fingerprints', () => {
    const targets = [...D_P1_FINGERPRINTS, ...D_P2_FINGERPRINTS];

    expect(D_P1_FINGERPRINTS).toHaveLength(22);
    expect(D_P2_FINGERPRINTS).toHaveLength(13);
    expect(new Set(targets).size).toBe(35);
    expect(D_RESIDUAL_KILL_TARGETS).toHaveLength(7);
    expect(D_RESIDUAL_KILL_TARGETS.every((target) => targets.includes(target))).toBe(true);
  });

  it('proves clean isolated executions produce passing infrastructure and network frames', async () => {
    const result = await validate('regression');
    const frames = result['frames'] as Record<string, unknown>[];

    expect(frames.find((frame) => frame['name'] === 'infrastructure')).toEqual({
      name: 'infrastructure',
      status: 'PASS',
      evidence_refs: ['EV-0123456789abcdef'],
    });
    expect(frames.find((frame) => frame['name'] === 'network-egress')).toEqual({
      name: 'network-egress',
      status: 'PASS',
      evidence_refs: ['EV-0123456789abcdef'],
    });
  });

  it('derives one linked validation identity and writes the complete lease contract', async () => {
    const first = await validate('regression', 'TW-1111111111111111');
    const second = await validate('regression', 'TW-2222222222222222');
    const firstLease = controls.leaseWrites[0];
    const suffix = String(first['id']).slice(3);

    expect(first['id']).toMatch(/^VR-[a-f0-9]{16}$/u);
    expect(second['id']).not.toBe(first['id']);
    expect(first['cleanup']).toEqual({
      lease_id: `TVL-${suffix}`,
      worktree: 'removed',
      database: 'removed',
      recovery_scan: 'clean',
    });
    expect(firstLease?.path.endsWith(`/TVL-${suffix}.json`)).toBe(true);
    expect(firstLease?.value).toEqual({
      schemaVersion: '1.0.0',
      id: `TVL-${suffix}`,
      task_id: 'TASK-9012',
      worktree_id: `WT-TV-${suffix}`,
      worktree_path: `.devai/worktrees/WT-TV-${suffix}`,
      database: `devai_task_TV_${suffix}`,
      base_sha: overlay,
      created_at: '2026-09-12T03:00:00.000Z',
    });
  });

  it('retires recovered lease files with force and preserves their exact lifecycle identity', async () => {
    const suffix = '0123456789abcdef';
    const path = `.devai/state/translation-validation/leases/TVL-${suffix}.json`;
    writeJson(path, {
      schemaVersion: '1.0.0',
      id: `TVL-${suffix}`,
      task_id: 'TASK-9012',
      worktree_id: `WT-TV-${suffix}`,
      worktree_path: `.devai/worktrees/WT-TV-${suffix}`,
      database: `devai_task_TV_${suffix}`,
      base_sha: overlay,
      created_at: '2026-09-11T00:00:00.000Z',
    });

    const result = await validate('regression');

    expect(result['cleanup']).toEqual(
      expect.objectContaining({
        recovery_scan: 'recovered',
        recovered_lease_ids: [`TVL-${suffix}`],
      }),
    );
    expect(controls.rmCalls).toContainEqual({
      path: resolve(repository, path),
      options: { force: true },
    });
    expect(controls.dropCalls[0]).toBe(`devai_task_TV_${suffix}`);
  });

  it('runs no phases for structural validation and initializes weakening as clean', async () => {
    const result = await validate('structural');
    const frame = controls.frameInputs.at(-1);

    expect(result['executions']).toEqual([]);
    expect(controls.isolatedCalls).toEqual([]);
    expect(controls.gitWorktreeAdds).toEqual([]);
    expect(frame?.['weakening_clean']).toBe(true);
    expect(result['cleanup']).toEqual(
      expect.objectContaining({ worktree: 'not-created', database: 'removed' }),
    );
  });

  it('selects exact regression and feature-overlay phase identities', async () => {
    const regression = await validate('regression');
    expect(controls.gitWorktreeAdds).toEqual([overlay, candidate]);
    expect((regression['executions'] as { phase: string }[]).map((entry) => entry.phase)).toEqual([
      'base',
      'candidate',
    ]);

    controls.gitWorktreeAdds = [];
    controls.isolatedCalls = [];
    controls.leaseWrites = [];
    const feature = await validate('feature-overlay');
    expect(controls.gitWorktreeAdds).toEqual([base, candidate]);
    expect((feature['executions'] as { phase: string }[]).map((entry) => entry.phase)).toEqual([
      'test-overlay',
      'candidate',
    ]);
    expect(controls.isolatedCalls).toHaveLength(2);
    expect(controls.isolatedCalls[0]?.repo_root).toMatch(/\.devai\/worktrees\/WT-TV-/u);
  });

  it('binds every phase execution to the registered test argv and normalized result', async () => {
    const result = await validate('regression');
    const executions = result['executions'] as Record<string, unknown>[];

    expect(controls.isolatedCalls.map((call) => call.argv)).toEqual([
      ['node', '--test', '--test-name-pattern', 'translation D lifecycle', TEST_PATH],
      ['node', '--test', '--test-name-pattern', 'translation D lifecycle', TEST_PATH],
    ]);
    expect(controls.isolatedCalls.map((call) => call.testSource)).toEqual([
      "import { test } from 'node:test';\ntest('translation D lifecycle', () => {});\n",
      "import { test } from 'node:test';\ntest('translation D lifecycle', () => {});\n",
    ]);
    expect(executions).toEqual([
      expect.objectContaining({
        phase: 'base',
        test_ref: `unit:${TEST_PATH}:translation D lifecycle`,
        outcome: 'pass',
        failure_mode: 'none',
        evidence_ref: 'EV-0123456789abcdef',
      }),
      expect.objectContaining({
        phase: 'candidate',
        test_ref: `unit:${TEST_PATH}:translation D lifecycle`,
        outcome: 'pass',
        failure_mode: 'none',
        evidence_ref: 'EV-0123456789abcdef',
      }),
    ]);
  });

  it('projects an exact worktree-add failure and still retires database and lease custody', async () => {
    controls.worktreeAddFailures = 1;
    const result = await validate('regression');

    expect(controls.gitWorktreeAdds).toEqual([overlay]);
    expect(controls.isolatedCalls).toEqual([]);
    expect(controls.dropCalls).toHaveLength(1);
    expect(result['executions']).toEqual([]);
    expect(
      (result['frames'] as { name: string; status: string; finding?: string }[]).find(
        (frame) => frame.name === 'infrastructure',
      ),
    ).toEqual({
      name: 'infrastructure',
      status: 'FAIL',
      evidence_refs: ['EV-0123456789abcdef'],
      finding:
        'Validation infrastructure failed: VALIDATION_WORKTREE_ADD_FAILED: sentinel add failure',
    });
    expect(result['cleanup']).toEqual(
      expect.objectContaining({ worktree: 'not-created', database: 'removed' }),
    );
  });

  it('normalizes worktree-add diagnostics before projecting the infrastructure finding', async () => {
    controls.worktreeAddFailures = 1;
    controls.worktreeAddFailureStderr = '  sentinel padded add failure  \n';

    const result = await validate('regression');
    const infrastructure = (result['frames'] as Record<string, unknown>[]).find(
      (frame) => frame['name'] === 'infrastructure',
    );

    expect(infrastructure).toEqual(
      expect.objectContaining({
        status: 'FAIL',
        finding:
          'Validation infrastructure failed: VALIDATION_WORKTREE_ADD_FAILED: sentinel padded add failure',
      }),
    );
  });

  it('materializes the feature overlay test into the base phase and labels it exactly', async () => {
    const result = await validate('feature-overlay');

    expect(controls.gitWorktreeAdds).toEqual([base, candidate]);
    expect(controls.isolatedCalls.map((call) => call.testSource)).toEqual([
      "import { test } from 'node:test';\ntest('translation D lifecycle', () => {});\n",
      "import { test } from 'node:test';\ntest('translation D lifecycle', () => {});\n",
    ]);
    expect((result['executions'] as { phase: string }[]).map((entry) => entry.phase)).toEqual([
      'test-overlay',
      'candidate',
    ]);
  });

  it('rejects an unsafe registered overlay path before any test execution', async () => {
    controls.overlayDiffTargetSha = overlay;
    controls.overlayDiffExtraPath = UNSAFE_OVERLAY_PATH;

    await expect(validate('feature-overlay')).rejects.toThrow('VALIDATION_RESULT_INVALID');
    expect(controls.isolatedCalls).toEqual([]);
  });

  it.each([
    ['failure', 'sentinel provision failure'],
    ['failure-without-error', 'VALIDATION_DATABASE_PROVISION_FAILED'],
    ['wrong-database', 'VALIDATION_DATABASE_PROVISION_FAILED'],
  ] as const)(
    'fails closed for %s provisioning without creating or dropping resources',
    async (mode, finding) => {
      controls.provision = mode;
      const result = await validate('regression');
      const infrastructure = (result['frames'] as Record<string, unknown>[]).find(
        (frame) => frame['name'] === 'infrastructure',
      );

      expect(infrastructure).toEqual(
        expect.objectContaining({
          status: 'FAIL',
          finding: `Validation infrastructure failed: ${finding}`,
        }),
      );
      expect(controls.gitWorktreeAdds).toEqual([]);
      expect(controls.isolatedCalls).toEqual([]);
      expect(controls.dropCalls).toEqual([]);
      expect(result['cleanup']).toEqual(
        expect.objectContaining({ worktree: 'not-created', database: 'not-created' }),
      );
    },
  );

  it('retries a failed inner worktree removal and records successful outer cleanup', async () => {
    controls.removeFailures = 1;
    const result = await validate('regression');

    expect(controls.gitWorktreeRemoves).toHaveLength(2);
    expect(result['cleanup']).toEqual(
      expect.objectContaining({ worktree: 'removed', database: 'removed' }),
    );
    expect(
      (result['frames'] as Record<string, unknown>[]).find(
        (frame) => frame['name'] === 'infrastructure',
      ),
    ).toEqual(
      expect.objectContaining({
        status: 'FAIL',
        finding:
          'Validation infrastructure failed: VALIDATION_WORKTREE_REMOVE_FAILED: sentinel removal failure',
      }),
    );
  });

  it('does not claim cleanup when removal succeeds but its authority result reports failure', async () => {
    controls.removeAfterSuccessFailures = 1;
    controls.pruneFailures = 1;

    const result = await validate('regression');

    expect(controls.gitWorktreeRemoves).toHaveLength(1);
    expect(result['cleanup']).toEqual(
      expect.objectContaining({ worktree: 'orphan-fail', database: 'removed' }),
    );
    expect(
      (result['frames'] as Record<string, unknown>[]).find(
        (frame) => frame['name'] === 'infrastructure',
      ),
    ).toEqual(
      expect.objectContaining({
        status: 'FAIL',
        finding:
          'Validation infrastructure failed: VALIDATION_WORKTREE_REMOVE_FAILED: sentinel post-removal failure',
      }),
    );
  });

  it('reports orphan cleanup when both worktree removal attempts fail', async () => {
    controls.removeFailures = 2;
    const result = await validate('regression');

    expect(controls.gitWorktreeRemoves).toHaveLength(2);
    expect(result['cleanup']).toEqual(
      expect.objectContaining({ worktree: 'orphan-fail', database: 'removed' }),
    );
  });

  it('reports database cleanup failure after successful provisioning', async () => {
    controls.dropOk = false;
    const result = await validate('regression');

    expect(controls.dropCalls).toHaveLength(1);
    expect(result['cleanup']).toEqual(
      expect.objectContaining({ worktree: 'removed', database: 'orphan-fail' }),
    );
  });
});
