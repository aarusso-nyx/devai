// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// Inspector acceptance: requested and resolved executor evidence remains
// immutable, exact-candidate bound, semantically total, and append-only.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
    expect(
      code(() =>
        persistTaskExecutionEvidence({
          ...base,
          relativePath: 'record/proofs/task-execution/TEE-7401.json',
        }),
      ),
    ).toBe('TASK_EXECUTION_EVIDENCE_ALREADY_EXISTS');
    for (const relativePath of ['', '/tmp/TEE-7401.json', '../TEE-7401.json', 'wrong.json']) {
      expect(
        code(() => persistTaskExecutionEvidence({ ...base, relativePath })),
        relativePath,
      ).toMatch(/^TASK_EXECUTION_EVIDENCE_(?:PATH_INVALID|PATH_BINDING_MISMATCH)$/u);
    }
  });
});
