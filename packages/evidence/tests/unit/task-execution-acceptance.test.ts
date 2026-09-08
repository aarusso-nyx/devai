// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// Inspector acceptance: requested and resolved executor evidence remains
// immutable, exact-candidate bound, semantically total, and append-only.
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  assertTaskExecutionEvidenceBinding,
  buildTaskExecutionEvidence,
  checkTaskExecutionEvidence,
  persistTaskExecutionEvidence,
  validateTaskExecutionEvidence,
  type TaskExecutionEvidence,
  type TaskExecutionEvidenceFacts,
  type TaskExecutionEvidenceValidator,
  type TaskRecordBinding,
} from '../../src/task-execution/index.js';

const concurrentWriter = vi.hoisted(() => ({
  beforeWrite: undefined as ((path: string) => void) | undefined,
}));
// Inject the competing write at the native filesystem call, after authority checks.
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    writeFileSync: (...args: Parameters<typeof original.writeFileSync>) => {
      if (typeof args[0] === 'string' && concurrentWriter.beforeWrite !== undefined) {
        const callback = concurrentWriter.beforeWrite;
        concurrentWriter.beforeWrite = undefined;
        callback(args[0]);
      }
      return original.writeFileSync(...args);
    },
  };
});

afterEach(() => {
  concurrentWriter.beforeWrite = undefined;
});

const TARGET = mkdtempSync(join(tmpdir(), 'devai-r0007-task-evidence-'));
const SHA = 'a'.repeat(40);
const PASS_VALIDATOR = Object.assign((_value: unknown) => true, { errors: [] });
const NA = { not_applicable_reason: 'executor does not invoke a model provider' } as const;
const NO_SELECTION = {
  mode: 'not-applicable',
  considered_registry_ids: [],
  selected_registry_id: null,
  rejection_codes: [],
  fallback: false,
  fallback_reason: null,
} as const;

afterAll(() => {
  rmSync(TARGET, { recursive: true });
});

function task(id: string, executor: TaskRecordBinding['executor']): TaskRecordBinding {
  return { schemaVersion: '2.0.0', id, round_id: 'R-0007', executor };
}

function facts(
  id: string,
  resolved_executor: TaskExecutionEvidenceFacts['resolved_executor'],
  overrides: Partial<TaskExecutionEvidenceFacts> = {},
): TaskExecutionEvidenceFacts {
  return {
    id,
    candidate_sha: SHA,
    resolved_executor,
    adapter_versions: [{ id: 'adapter', version: '1.0.0' }],
    tool_versions: [{ id: 'tool', version: '1.0.0', digest_sha256: 'b'.repeat(64) }],
    input_digests: [{ id: 'input', digest_sha256: 'c'.repeat(64) }],
    output_digests: [{ id: 'output', digest_sha256: 'd'.repeat(64) }],
    selection: NO_SELECTION,
    prompt: NA,
    usage: NA,
    cost: NA,
    started_at: '2026-08-08T00:00:00.000Z',
    completed_at: '2026-08-08T00:00:01.000Z',
    verdict: 'pass',
    evidence_refs: ['EV-1'],
    ...overrides,
  };
}

function code(callback: () => unknown): string | undefined {
  try {
    callback();
    return undefined;
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      // A closed refusal code must still explain the problem to its caller.
      expect(error.name).toBe('TaskExecutionEvidenceError');
      const prefix = `${String(error.code)}: `;
      expect(error.message.startsWith(prefix)).toBe(true);
      expect(error.message.slice(prefix.length).trim().length).toBeGreaterThan(0);
    }
    return error instanceof Error && 'code' in error ? String(error.code) : undefined;
  }
}

describe('task-execution evidence acceptance', () => {
  it('builds exact routine, human, composite, and agent evidence snapshots', () => {
    const routineTask = task('TASK-7101', {
      kind: 'routine',
      argv: ['node', 'fixture.mjs'],
      cwd: '.',
      effects: ['read'],
    });
    const routine = buildTaskExecutionEvidence(
      routineTask,
      facts('TEE-7101', {
        kind: 'routine',
        action_id: null,
        argv: ['node', 'fixture.mjs'],
        cwd: '.',
        effects: ['read'],
      }),
      PASS_VALIDATOR,
    );
    expect(routine.task_id).toBe(routineTask.id);
    expect(Object.isFrozen(routine)).toBe(true);
    expect(Object.isFrozen(routine.resolved_executor)).toBe(true);

    const actionTask = task('TASK-7102', {
      kind: 'routine',
      action_id: 'check',
      cwd: '.',
      effects: ['local-write'],
    });
    expect(
      buildTaskExecutionEvidence(
        actionTask,
        facts('TEE-7102', {
          kind: 'routine',
          action_id: 'check',
          argv: [],
          cwd: '.',
          effects: ['local-write'],
        }),
        PASS_VALIDATOR,
      ).resolved_executor,
    ).toMatchObject({ action_id: 'check' });

    const humanTask = task('TASK-7103', { kind: 'human', role: 'inspector' });
    expect(
      buildTaskExecutionEvidence(
        humanTask,
        facts(
          'TEE-7103',
          { kind: 'human', role: 'inspector', completion_evidence: ['EV-HUMAN'] },
          { evidence_refs: ['EV-HUMAN'] },
        ),
        PASS_VALIDATOR,
      ).resolved_executor,
    ).toMatchObject({ kind: 'human', role: 'inspector' });

    const compositeTask = task('TASK-7104', {
      kind: 'composite',
      child_task_ids: ['TASK-7101', 'TASK-7103'],
    });
    expect(
      buildTaskExecutionEvidence(
        compositeTask,
        facts('TEE-7104', {
          kind: 'composite',
          child_task_ids: ['TASK-7101', 'TASK-7103'],
          child_execution_evidence_ids: ['TEE-7101', 'TEE-7103'],
        }),
        PASS_VALIDATOR,
      ).resolved_executor,
    ).toMatchObject({ kind: 'composite' });

    const exactTask = task('TASK-7105', {
      kind: 'agent',
      runtime: 'codex-cli',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      recipe_name: 'devai-round',
      recipe_variant: 'run',
      prompt_composition_id: 'PROMPT-7105',
      selection: { mode: 'exact', registry_id: 'codex-cli:gpt-5.6-sol' },
    });
    const exact = buildTaskExecutionEvidence(
      exactTask,
      facts(
        'TEE-7105',
        {
          kind: 'agent',
          registry_id: 'codex-cli:gpt-5.6-sol',
          runtime: 'codex-cli',
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
          recipe_name: 'devai-round',
          recipe_variant: 'run',
        },
        {
          selection: {
            mode: 'exact',
            considered_registry_ids: ['codex-cli:gpt-5.6-sol'],
            selected_registry_id: 'codex-cli:gpt-5.6-sol',
            rejection_codes: [],
            fallback: false,
            fallback_reason: null,
          },
          prompt: { prompt_composition_id: 'PROMPT-7105', prompt_sha256: 'e'.repeat(64) },
          usage: { input_tokens: 10, output_tokens: 5 },
          cost: { amount: 0.01, currency: 'USD', source: 'provider-reported' },
        },
      ),
      PASS_VALIDATOR,
    );
    expect(exact.selection.mode).toBe('exact');
  });

  it('fails closed across schema, binding, verdict, executor, and provider semantic drift', () => {
    const failingValidator = Object.assign((_value: unknown) => false, {
      errors: [null, { instancePath: '/id', message: 'is invalid' }],
    }) as TaskExecutionEvidenceValidator;
    expect(checkTaskExecutionEvidence({}, failingValidator)).toMatchObject({
      ok: false,
      code: 'TASK_EXECUTION_EVIDENCE_SCHEMA_INVALID',
      issues: ['null', '/id is invalid'],
    });
    expect(code(() => validateTaskExecutionEvidence({}, failingValidator))).toBe(
      'TASK_EXECUTION_EVIDENCE_SCHEMA_INVALID',
    );

    const routineTask = task('TASK-7301', {
      kind: 'routine',
      argv: ['node', 'fixture.mjs'],
      cwd: '.',
      effects: ['read'],
    });
    const valid = buildTaskExecutionEvidence(
      routineTask,
      facts('TEE-7301', {
        kind: 'routine',
        action_id: null,
        argv: ['node', 'fixture.mjs'],
        cwd: '.',
        effects: ['read'],
      }),
      PASS_VALIDATOR,
    );
    const mutations: ReadonlyArray<readonly [string, (value: TaskExecutionEvidence) => void]> = [
      [
        'TASK_EXECUTION_EVIDENCE_TASK_BINDING_MISMATCH',
        (value) => Object.assign(value, { task_id: 'TASK-X' }),
      ],
      [
        'TASK_EXECUTION_EVIDENCE_TASK_BINDING_MISMATCH',
        (value) => Object.assign(value, { round_id: 'R-OTHER' }),
      ],
      [
        'TASK_EXECUTION_EVIDENCE_CANDIDATE_MISMATCH',
        (value) => Object.assign(value, { candidate_sha: 'b'.repeat(40) }),
      ],
      [
        'TASK_EXECUTION_EVIDENCE_TASK_DIGEST_MISMATCH',
        (value) => Object.assign(value, { task_record_digest_sha256: '0'.repeat(64) }),
      ],
      [
        'TASK_EXECUTION_EVIDENCE_EXECUTOR_DIGEST_MISMATCH',
        (value) => Object.assign(value, { requested_executor_digest_sha256: '0'.repeat(64) }),
      ],
      [
        'TASK_EXECUTION_EVIDENCE_TIMESTAMP_INVALID',
        (value) => Object.assign(value, { completed_at: '2025-01-01T00:00:00.000Z' }),
      ],
      [
        'TASK_EXECUTION_EVIDENCE_FAILURE_MISMATCH',
        (value) => Object.assign(value, { verdict: 'fail', failure: null }),
      ],
      [
        'TASK_EXECUTION_EVIDENCE_EXECUTOR_KIND_MISMATCH',
        (value) =>
          Object.assign(value, {
            resolved_executor: { kind: 'human', role: 'inspector', completion_evidence: [] },
          }),
      ],
      [
        'TASK_EXECUTION_EVIDENCE_ROUTINE_MISMATCH',
        (value) =>
          Object.assign(value, {
            resolved_executor: { ...(value.resolved_executor as object), cwd: 'elsewhere' },
          }),
      ],
      [
        'TASK_EXECUTION_EVIDENCE_SELECTION_NOT_APPLICABLE',
        (value) => Object.assign(value, { selection: { ...value.selection, fallback: true } }),
      ],
      [
        'TASK_EXECUTION_EVIDENCE_PROVIDER_FACTS_NOT_APPLICABLE',
        (value) =>
          Object.assign(value, {
            prompt: { prompt_composition_id: 'P', prompt_sha256: '0'.repeat(64) },
          }),
      ],
    ];
    for (const [expected, mutate] of mutations) {
      const candidate = structuredClone(valid);
      mutate(candidate);
      expect(code(() => assertTaskExecutionEvidenceBinding(candidate, routineTask, SHA))).toBe(
        expected,
      );
    }
  });

  it('persists once at the exact bound relative path and rejects unsafe or repeated targets', async () => {
    const routineTask = task('TASK-7401', {
      kind: 'routine',
      argv: ['node', 'fixture.mjs'],
      cwd: '.',
      effects: ['read'],
    });
    const evidence = buildTaskExecutionEvidence(
      routineTask,
      facts('TEE-7401', {
        kind: 'routine',
        action_id: null,
        argv: ['node', 'fixture.mjs'],
        cwd: '.',
        effects: ['read'],
      }),
      PASS_VALIDATOR,
    );
    const base = {
      repoRoot: TARGET,
      task: routineTask,
      candidate_sha: SHA,
      evidence,
      validator: PASS_VALIDATOR,
    } as const;
    const persisted = await withAuthorityHostTestScope(() =>
      persistTaskExecutionEvidence({
        ...base,
        relativePath: 'record/proofs/task-execution/TEE-7401.json',
      }),
    );
    expect(persisted.relativePath).toBe('record/proofs/task-execution/TEE-7401.json');
    const originalBytes = readFileSync(persisted.path);
    expect(JSON.parse(originalBytes.toString('utf8'))).toEqual(evidence);
    expect(persisted.evidence).toEqual(evidence);
    expect(
      code(() =>
        persistTaskExecutionEvidence({
          ...base,
          relativePath: 'record/proofs/task-execution/TEE-7401.json',
        }),
      ),
    ).toBe('TASK_EXECUTION_EVIDENCE_ALREADY_EXISTS');
    expect(readFileSync(persisted.path)).toEqual(originalBytes);
    for (const relativePath of ['', '/tmp/TEE-7401.json', '../TEE-7401.json', 'wrong.json']) {
      expect(
        code(() => persistTaskExecutionEvidence({ ...base, relativePath })),
        relativePath,
      ).toMatch(/^TASK_EXECUTION_EVIDENCE_(?:PATH_INVALID|PATH_BINDING_MISMATCH)$/u);
    }
  });
});

const agentExecutor = {
  kind: 'agent',
  registry_id: 'fixture:model',
  runtime: 'fixture-runtime',
  model: 'model',
  effort: 'high',
  recipe_name: 'fixture-recipe',
  recipe_variant: 'run',
} as const;
function exactAgentTask(overrides: Record<string, unknown> = {}) {
  return task('TASK-EXACT', {
    ...agentExecutor,
    prompt_composition_id: 'PROMPT-EXACT',
    selection: { mode: 'exact', registry_id: agentExecutor.registry_id },
    ...overrides,
  });
}
function agentFacts(overrides: Partial<TaskExecutionEvidenceFacts> = {}) {
  return facts('TEE-EXACT', agentExecutor, {
    selection: {
      mode: 'exact',
      considered_registry_ids: [agentExecutor.registry_id],
      selected_registry_id: agentExecutor.registry_id,
      rejection_codes: [],
      fallback: false,
      fallback_reason: null,
    },
    prompt: { prompt_composition_id: 'PROMPT-EXACT', prompt_sha256: 'e'.repeat(64) },
    usage: { input_tokens: 10, output_tokens: 5 },
    cost: { amount: 0.01, currency: 'USD', source: 'provider-reported' },
    ...overrides,
  });
}

describe('independent exact agent execution bindings', () => {
  it.each([undefined, null, 42, 'other:model'])(
    'refuses an exact request with a missing, malformed or substituted registry identity %j',
    (registry_id) => {
      expect(() =>
        buildTaskExecutionEvidence(
          exactAgentTask({ selection: { mode: 'exact', registry_id } }),
          agentFacts(),
          PASS_VALIDATOR,
        ),
      ).toThrow(
        'TASK_EXECUTION_EVIDENCE_EXACT_SUBSTITUTION: exact selection must resolve only the exact requested registry identity',
      );
    },
  );

  it.each(['runtime', 'model', 'effort'] as const)('refuses substituted %s', (field) => {
    expect(() =>
      buildTaskExecutionEvidence(
        exactAgentTask(),
        agentFacts({
          resolved_executor: { ...agentExecutor, [field]: 'substituted' },
        }),
        PASS_VALIDATOR,
      ),
    ).toThrow(
      'TASK_EXECUTION_EVIDENCE_EXACT_SUBSTITUTION: exact selection changed requested runtime, model, or effort',
    );
  });
  it.each(['recipe_name', 'recipe_variant'] as const)('refuses substituted %s', (field) => {
    expect(() =>
      buildTaskExecutionEvidence(
        exactAgentTask(),
        agentFacts({
          resolved_executor: { ...agentExecutor, [field]: 'substituted' },
        }),
        PASS_VALIDATOR,
      ),
    ).toThrow(
      'TASK_EXECUTION_EVIDENCE_RECIPE_MISMATCH: resolved recipe identity differs from the immutable request',
    );
  });
  it.each([undefined, null, [], 'exact'])(
    'refuses missing or malformed selection %j',
    (selection) => {
      expect(() =>
        buildTaskExecutionEvidence(exactAgentTask({ selection }), agentFacts(), PASS_VALIDATOR),
      ).toThrow('TASK_EXECUTION_EVIDENCE_SELECTION_MISMATCH: agent task has no selection contract');
    },
  );
  it.each([
    { mode: 'not-applicable' as const },
    { selected_registry_id: 'other' },
    { considered_registry_ids: ['other'] },
  ])('refuses independently inconsistent selection evidence %j', (changed) => {
    expect(() =>
      buildTaskExecutionEvidence(
        exactAgentTask(),
        agentFacts({
          selection: { ...agentFacts().selection, ...changed },
        }),
        PASS_VALIDATOR,
      ),
    ).toThrow('TASK_EXECUTION_EVIDENCE_SELECTION_MISMATCH');
  });
  it.each([
    { considered_registry_ids: [agentExecutor.registry_id, 'other'] },
    { fallback: true },
    { fallback_reason: 'substituted model' },
  ])('refuses hidden substitution in exact selection %j', (changed) => {
    expect(() =>
      buildTaskExecutionEvidence(
        exactAgentTask(),
        agentFacts({
          selection: { ...agentFacts().selection, ...changed },
        }),
        PASS_VALIDATOR,
      ),
    ).toThrow(
      'TASK_EXECUTION_EVIDENCE_EXACT_SUBSTITUTION: exact selection must resolve only the exact requested registry identity',
    );
  });
  it.each([NA, { prompt_composition_id: 'OTHER', prompt_sha256: 'e'.repeat(64) }])(
    'refuses unbound prompt composition %j',
    (prompt) => {
      expect(() =>
        buildTaskExecutionEvidence(exactAgentTask(), agentFacts({ prompt }), PASS_VALIDATOR),
      ).toThrow(
        'TASK_EXECUTION_EVIDENCE_PROMPT_MISMATCH: agent evidence must bind the exact requested prompt composition',
      );
    },
  );
  it('allows exactly equal start and completion timestamps', () => {
    const evidence = buildTaskExecutionEvidence(
      exactAgentTask(),
      agentFacts({ completed_at: agentFacts().started_at }),
      PASS_VALIDATOR,
    );
    expect(evidence.started_at).toBe(evidence.completed_at);
  });
  it.each(['started_at', 'completed_at'] as const)('refuses invalid %s independently', (field) => {
    expect(() =>
      buildTaskExecutionEvidence(
        exactAgentTask(),
        agentFacts({ [field]: 'invalid' }),
        PASS_VALIDATOR,
      ),
    ).toThrow(
      'TASK_EXECUTION_EVIDENCE_TIMESTAMP_INVALID: completed_at must be at or after started_at',
    );
  });
});

describe('task evidence snapshots and schema diagnostics', () => {
  it('builds a real-schema-valid independent snapshot and freezes nested evidence', () => {
    const executor = {
      kind: 'routine' as const,
      action_id: null,
      argv: ['node', 'fixture.mjs'],
      cwd: '.',
      effects: ['read' as const],
    };
    const boundTask = task('TASK-7801', executor);
    const input = facts('TXE-1111111111111111', executor);
    const evidence = buildTaskExecutionEvidence(boundTask, input);
    const before = JSON.stringify(evidence);
    expect(checkTaskExecutionEvidence(evidence).ok).toBe(true);
    expect(Object.isFrozen(executor)).toBe(false);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.tool_versions)).toBe(true);
    expect(Object.isFrozen(evidence.tool_versions[0])).toBe(true);
    expect(Object.isFrozen(evidence.selection.considered_registry_ids)).toBe(true);
    expect(Object.isFrozen(evidence.resolved_executor)).toBe(true);
    if (evidence.resolved_executor.kind !== 'routine') throw new Error('expected routine');
    expect(Object.isFrozen(evidence.resolved_executor.argv)).toBe(true);
    executor.argv[0] = 'substituted';
    Object.assign(input.tool_versions[0] ?? {}, { version: 'changed' });
    expect(JSON.stringify(evidence)).toBe(before);
    expect(() => Object.assign(evidence.tool_versions[0] ?? {}, { version: 'changed' })).toThrow(
      TypeError,
    );
  });

  it.each([
    [undefined, ['schema validation failed without diagnostics']],
    [null, ['schema validation failed without diagnostics']],
    [{ message: 'not an array' }, ['schema validation failed without diagnostics']],
    [[{ instancePath: '', message: 'must be object' }], ['/ must be object']],
    [[{ instancePath: 1, message: 'must be object' }], ['/ must be object']],
    [[{ instancePath: '/id', message: 42 }], ['/id invalid value']],
    [[{}], ['/ invalid value']],
    [
      ['invalid member', 42, false],
      ['invalid member', '42', 'false'],
    ],
  ])('preserves actionable schema diagnostics for %j', (errors, issues) => {
    const validator = Object.assign((_value: unknown) => false, { errors });
    expect(checkTaskExecutionEvidence({}, validator)).toEqual({
      ok: false,
      code: 'TASK_EXECUTION_EVIDENCE_SCHEMA_INVALID',
      issues,
    });
    expect(() => validateTaskExecutionEvidence({}, validator)).toThrow(
      `TASK_EXECUTION_EVIDENCE_SCHEMA_INVALID: ${(issues as string[]).join('; ')}`,
    );
  });
});

describe('canonical task-evidence persistence identity', () => {
  it.each([
    './record/proofs/task-execution/TEE-CANONICAL.json',
    'record//proofs/task-execution/TEE-CANONICAL.json',
    'record/proofs/task-execution/unused/../TEE-CANONICAL.json',
  ])('refuses an alternative spelling before persistence: %s', async (relativePath) => {
    const executor = {
      kind: 'routine' as const,
      action_id: null,
      argv: ['node', 'fixture.mjs'],
      cwd: '.',
      effects: ['read' as const],
    };
    const repoRoot = mkdtempSync(join(TARGET, 'canonical-'));
    const boundTask = task('TASK-CANONICAL', executor);
    const evidence = buildTaskExecutionEvidence(
      boundTask,
      facts('TEE-CANONICAL', executor),
      PASS_VALIDATOR,
    );
    const result = await withAuthorityHostTestScope(() =>
      code(() =>
        persistTaskExecutionEvidence({
          repoRoot,
          relativePath,
          task: boundTask,
          candidate_sha: SHA,
          evidence,
          validator: PASS_VALIDATOR,
        }),
      ),
    );
    expect(result).toBe('TASK_EXECUTION_EVIDENCE_PATH_INVALID');
    expect(readdirSync(repoRoot)).toEqual([]);
  });
});

describe('non-agent execution authority bindings', () => {
  const routine = {
    kind: 'routine' as const,
    action_id: null,
    argv: ['node', 'fixture.mjs'],
    cwd: '.',
    effects: ['read' as const, 'local-write' as const],
  };
  const bound = task('TASK-NON-AGENT', routine);

  it.each([
    ['changed argument', { argv: ['node', 'other.mjs'] }],
    ['reordered arguments', { argv: ['fixture.mjs', 'node'] }],
    ['missing argument', { argv: ['node'] }],
    ['extra argument', { argv: ['node', 'fixture.mjs', '--write'] }],
    ['undeclared action', { action_id: 'check' }],
    ['changed effects', { effects: ['read', 'remote-write'] }],
    ['reordered effects', { effects: ['local-write', 'read'] }],
    ['missing effect', { effects: ['read'] }],
    ['extra effect', { effects: ['read', 'local-write', 'remote-write'] }],
  ])('refuses a routine with %s', (_label, changes) => {
    const resolved = { ...routine, ...changes } as TaskExecutionEvidenceFacts['resolved_executor'];
    expect(
      code(() =>
        buildTaskExecutionEvidence(bound, facts('TEE-NON-AGENT', resolved), PASS_VALIDATOR),
      ),
    ).toBe('TASK_EXECUTION_EVIDENCE_ROUTINE_MISMATCH');
  });

  it('refuses substitution of a declared action', () => {
    const requested = { ...routine, action_id: 'check', argv: [] };
    expect(
      code(() =>
        buildTaskExecutionEvidence(
          task('TASK-ACTION', requested),
          facts('TEE-ACTION', { ...requested, action_id: 'run' }),
          PASS_VALIDATOR,
        ),
      ),
    ).toBe('TASK_EXECUTION_EVIDENCE_ROUTINE_MISMATCH');
  });

  it.each([
    ['model-selection mode', { mode: 'exact' }],
    ['considered identity', { considered_registry_ids: ['provider:model'] }],
    ['selected identity', { selected_registry_id: 'provider:model' }],
    ['provider rejection', { rejection_codes: ['PROVIDER_UNAVAILABLE'] }],
    ['fallback reason', { fallback_reason: 'try another model' }],
  ])('refuses non-agent %s', (_label, changes) => {
    const selection = { ...NO_SELECTION, ...changes } as TaskExecutionEvidenceFacts['selection'];
    expect(
      code(() =>
        buildTaskExecutionEvidence(
          bound,
          facts('TEE-SELECTION', routine, { selection }),
          PASS_VALIDATOR,
        ),
      ),
    ).toBe('TASK_EXECUTION_EVIDENCE_SELECTION_NOT_APPLICABLE');
  });

  it.each([
    ['usage', { usage: { input_tokens: 1, output_tokens: 2 } }],
    ['cost', { cost: { amount: 1, currency: 'USD', source: 'provider-reported' } }],
  ])('refuses provider %s on a routine', (_label, changes) => {
    expect(
      code(() =>
        buildTaskExecutionEvidence(
          bound,
          facts('TEE-PROVIDER', routine, changes as Partial<TaskExecutionEvidenceFacts>),
          PASS_VALIDATOR,
        ),
      ),
    ).toBe('TASK_EXECUTION_EVIDENCE_PROVIDER_FACTS_NOT_APPLICABLE');
  });

  it.each(['fail', 'error', 'cancelled'] as const)('requires failure details for %s', (verdict) => {
    expect(
      code(() =>
        buildTaskExecutionEvidence(
          bound,
          facts('TEE-FAILURE', routine, { verdict }),
          PASS_VALIDATOR,
        ),
      ),
    ).toBe('TASK_EXECUTION_EVIDENCE_FAILURE_MISMATCH');
    const failure = {
      code: 'EXECUTION_FAILED',
      message: 'retained for repair',
      rollback_disposition: 'preserved-for-repair' as const,
    };
    expect(
      buildTaskExecutionEvidence(
        bound,
        facts('TEE-FAILURE', routine, { verdict, failure }),
        PASS_VALIDATOR,
      ).failure,
    ).toEqual(failure);
  });

  it('refuses failure details attached to a passing result', () => {
    expect(
      code(() =>
        buildTaskExecutionEvidence(
          bound,
          facts('TEE-PASS', routine, {
            failure: { code: 'FAILED', message: 'failed', rollback_disposition: 'not-required' },
          }),
          PASS_VALIDATOR,
        ),
      ),
    ).toBe('TASK_EXECUTION_EVIDENCE_FAILURE_MISMATCH');
  });

  it.each([
    ['different role', { role: 'owner' as const, completion_evidence: ['EV-1'] }],
    [
      'unbound completion',
      { role: 'inspector' as const, completion_evidence: ['EV-1', 'EV-UNBOUND'] },
    ],
  ])('refuses human evidence with %s', (_label, changes) => {
    expect(
      code(() =>
        buildTaskExecutionEvidence(
          task('TASK-HUMAN', { kind: 'human', role: 'inspector' }),
          facts('TEE-HUMAN', { kind: 'human', ...changes }),
          PASS_VALIDATOR,
        ),
      ),
    ).toBe('TASK_EXECUTION_EVIDENCE_HUMAN_MISMATCH');
  });

  it.each([
    ['reordered children', ['TASK-B', 'TASK-A'], ['TEE-B', 'TEE-A']],
    ['substituted child', ['TASK-A', 'TASK-C'], ['TEE-A', 'TEE-C']],
    ['missing child', ['TASK-A'], ['TEE-A']],
    ['missing receipt', ['TASK-A', 'TASK-B'], ['TEE-A']],
    ['extra receipt', ['TASK-A', 'TASK-B'], ['TEE-A', 'TEE-B', 'TEE-C']],
  ])('refuses a composite with %s', (_label, child_task_ids, child_execution_evidence_ids) => {
    expect(
      code(() =>
        buildTaskExecutionEvidence(
          task('TASK-COMPOSITE', { kind: 'composite', child_task_ids: ['TASK-A', 'TASK-B'] }),
          facts('TEE-COMPOSITE', {
            kind: 'composite',
            child_task_ids,
            child_execution_evidence_ids,
          }),
          PASS_VALIDATOR,
        ),
      ),
    ).toBe('TASK_EXECUTION_EVIDENCE_COMPOSITE_MISMATCH');
  });
});

it('records absent optional recipe bindings as null using the real evidence schema', () => {
  const { recipe_name: _name, recipe_variant: _variant, ...executor } = exactAgentTask().executor;
  const boundTask = task('TASK-7902', {
    ...executor,
    prompt_composition_id: 'PC-5555555555555555',
  });
  const input = {
    ...agentFacts({
      resolved_executor: { ...agentExecutor, recipe_name: null, recipe_variant: null },
    }),
    id: 'TXE-3333333333333333',
    prompt: { prompt_composition_id: 'PC-5555555555555555', prompt_sha256: 'e'.repeat(64) },
  };
  const evidence = buildTaskExecutionEvidence(boundTask, input);
  expect(evidence.resolved_executor).toMatchObject({
    kind: 'agent',
    recipe_name: null,
    recipe_variant: null,
  });
  expect(checkTaskExecutionEvidence(evidence).ok).toBe(true);
});

it.each(['recipe_name', 'recipe_variant'] as const)(
  'refuses an undeclared %s even when the rest of the exact agent binding agrees',
  (field) => {
    const { recipe_name: _name, recipe_variant: _variant, ...executor } = exactAgentTask().executor;
    const boundTask = task('TASK-7903', {
      ...executor,
      prompt_composition_id: 'PC-5555555555555555',
    });
    const input = {
      ...agentFacts({
        resolved_executor: {
          ...agentExecutor,
          recipe_name: null,
          recipe_variant: null,
          [field]: 'undeclared',
        },
      }),
      id: 'TXE-4444444444444444',
      prompt: { prompt_composition_id: 'PC-5555555555555555', prompt_sha256: 'e'.repeat(64) },
    };
    expect(() => buildTaskExecutionEvidence(boundTask, input)).toThrow(
      'TASK_EXECUTION_EVIDENCE_RECIPE_MISMATCH',
    );
  },
);

describe('task evidence append-only write race', () => {
  it.each(['regular file', 'symlink'] as const)(
    'preserves a concurrent %s created after the absence check',
    async (kind) => {
      const root = mkdtempSync(join(TARGET, 'race-'));
      const executor = {
        kind: 'routine' as const,
        action_id: null,
        argv: ['node', 'fixture.mjs'],
        cwd: '.',
        effects: ['read' as const],
      };
      const bound = task('TASK-7402', executor);
      const evidence = buildTaskExecutionEvidence(bound, facts('TXE-0000000000007402', executor));
      const target = join(root, 'concurrent-target.json');
      const retained = Buffer.from('concurrent evidence must remain byte-identical\n');
      writeFileSync(target, retained);
      let occupiedPath: string | undefined;
      concurrentWriter.beforeWrite = (path) => {
        occupiedPath = path;
        if (kind === 'symlink') symlinkSync(target, path);
        else writeFileSync(path, retained);
      };

      await expect(
        withAuthorityHostTestScope(() =>
          persistTaskExecutionEvidence({
            repoRoot: root,
            relativePath: 'record/proofs/task-execution/TXE-0000000000007402.json',
            task: bound,
            candidate_sha: SHA,
            evidence,
          }),
        ),
      ).rejects.toThrow();
      expect(occupiedPath).toBe(
        join(root, 'record/proofs/task-execution/TXE-0000000000007402.json'),
      );
      if (occupiedPath === undefined) throw new Error('concurrent writer was not reached');
      expect(readFileSync(occupiedPath)).toEqual(retained);
      expect(readFileSync(target)).toEqual(retained);
    },
  );
});

describe('task evidence path refusal diagnosis', () => {
  it.each([
    ['', 'persistence path must be nonempty and relative to the repository root'],
    [
      '/TXE-0123456789abcdef.json',
      'persistence path must be nonempty and relative to the repository root',
    ],
    ['..', 'persistence path cannot escape the repository root'],
    ['../TXE-0123456789abcdef.json', 'persistence path cannot escape the repository root'],
  ])(
    'reports the precise rejected boundary for %j before creating files',
    async (relativePath, reason) => {
      const executor = {
        kind: 'routine' as const,
        action_id: null,
        argv: ['node', 'fixture.mjs'],
        cwd: '.',
        effects: ['read' as const],
      };
      const boundTask = task('TASK-7901', executor);
      const evidence = buildTaskExecutionEvidence(
        boundTask,
        facts('TXE-0123456789abcdef', executor),
      );
      const repoRoot = mkdtempSync(join(TARGET, 'path-refusal-'));
      await withAuthorityHostTestScope(() => {
        expect(() =>
          persistTaskExecutionEvidence({
            repoRoot,
            relativePath,
            task: boundTask,
            candidate_sha: SHA,
            evidence,
          }),
        ).toThrow(`TASK_EXECUTION_EVIDENCE_PATH_INVALID: ${reason}`);
      });
      expect(readdirSync(repoRoot)).toEqual([]);
    },
  );
});
