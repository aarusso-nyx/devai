// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// Task-execution boundaries the acceptance suite only observes through generic
// refusal codes or never reaches: the exact fact each selection refusal names,
// an agent request that never authorised host selection, advisory failure
// detail retained on a non-failing verdict, provider facts that are absent
// rather than marked not-applicable, and a canonical relative persistence path
// whose first segment merely begins with two dots.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  assertTaskExecutionEvidenceBinding,
  buildTaskExecutionEvidence,
  checkTaskExecutionEvidence,
  persistTaskExecutionEvidence,
  type TaskExecutionEvidence,
  type TaskExecutionEvidenceFacts,
  type TaskRecordBinding,
} from '../../src/task-execution/index.js';

// Every record in this file is built and validated against the real evidence
// schema; no validator is stubbed and no schema-invalid record is persisted.
const CANDIDATE = 'a'.repeat(40);
const ROUND = 'R-0012';
const NOT_APPLICABLE = {
  not_applicable_reason: 'routine executor does not call a model provider',
} as const;
const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function task(id: string, executor: TaskRecordBinding['executor']): TaskRecordBinding {
  return { schemaVersion: '2.0.0', id, round_id: ROUND, executor };
}

function facts(
  id: string,
  resolved_executor: TaskExecutionEvidenceFacts['resolved_executor'],
  overrides: Partial<TaskExecutionEvidenceFacts> = {},
): TaskExecutionEvidenceFacts {
  return {
    id,
    candidate_sha: CANDIDATE,
    resolved_executor,
    adapter_versions: [{ id: 'routine-argv-adapter', version: '1.0.0' }],
    tool_versions: [{ id: 'node', version: '22.0.0' }],
    input_digests: [{ id: 'input', digest_sha256: 'c'.repeat(64) }],
    output_digests: [{ id: 'output', digest_sha256: 'd'.repeat(64) }],
    selection: {
      mode: 'not-applicable',
      considered_registry_ids: [],
      selected_registry_id: null,
      rejection_codes: [],
      fallback: false,
      fallback_reason: null,
    },
    prompt: NOT_APPLICABLE,
    usage: NOT_APPLICABLE,
    cost: NOT_APPLICABLE,
    started_at: '2026-09-08T00:00:00.000Z',
    completed_at: '2026-09-08T00:00:02.000Z',
    verdict: 'pass',
    evidence_refs: ['EV-9201'],
    ...overrides,
  };
}

function refusal(callback: () => unknown): { readonly code: string; readonly message: string } {
  try {
    callback();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // A closed refusal, not a crash: the caller must receive a coded error.
    expect(error.name).toBe('TaskExecutionEvidenceError');
    return { code: String((error as { readonly code?: unknown }).code), message: error.message };
  }
  return expect.fail('expected a task-execution evidence refusal');
}

function succeeds<T>(callback: () => T): T {
  let value: T | undefined;
  expect(() => {
    value = callback();
  }).not.toThrow();
  if (value === undefined) return expect.fail('expected a successful result');
  return value;
}

const AGENT = {
  kind: 'agent',
  registry_id: 'codex-cli:gpt-5.6-sol',
  runtime: 'codex-cli',
  model: 'gpt-5.6-sol',
  effort: 'xhigh',
  recipe_name: 'devai-round',
  recipe_variant: 'run',
} as const;
const PROMPT_ID = 'PC-00000000000092a1';
const EXACT_SELECTION = {
  mode: 'exact',
  considered_registry_ids: [AGENT.registry_id],
  selected_registry_id: AGENT.registry_id,
  rejection_codes: [],
  fallback: false,
  fallback_reason: null,
} as const;

function agentTask(selection: unknown): TaskRecordBinding {
  return task('TASK-9201', { ...AGENT, prompt_composition_id: PROMPT_ID, selection });
}

function agentFacts(overrides: Partial<TaskExecutionEvidenceFacts> = {}) {
  return facts('TXE-0000000000009201', AGENT, {
    selection: EXACT_SELECTION,
    prompt: { prompt_composition_id: PROMPT_ID, prompt_sha256: 'e'.repeat(64) },
    usage: { input_tokens: 1200, output_tokens: 340 },
    cost: { amount: 0.42, currency: 'USD', source: 'provider-reported' },
    ...overrides,
  });
}

const ROUTINE = {
  kind: 'routine',
  action_id: null,
  argv: ['node', 'fixture.mjs'],
  cwd: '.',
  effects: ['read'],
} as const;

function routineTask(id = 'TASK-9301'): TaskRecordBinding {
  return task(id, { kind: 'routine', argv: [...ROUTINE.argv], cwd: '.', effects: ['read'] });
}

describe('agent selection refusals name the exact drifted fact', () => {
  it.each([
    [
      'the recorded selection mode',
      { mode: 'not-applicable' },
      'recorded selection mode differs from the immutable request',
    ],
    [
      'the selected identity',
      { selected_registry_id: 'codex-cli:substitute' },
      'selected registry identity differs from the resolved executor',
    ],
    [
      'the considered identities',
      { considered_registry_ids: ['codex-cli:substitute'] },
      'selected registry identity was not recorded as considered',
    ],
  ])('names %s', (_label, changed, message) => {
    const selection = { ...EXACT_SELECTION, ...changed } as TaskExecutionEvidenceFacts['selection'];
    expect(
      refusal(() =>
        buildTaskExecutionEvidence(
          agentTask({ mode: 'exact', registry_id: AGENT.registry_id }),
          agentFacts({ selection }),
        ),
      ),
    ).toEqual({
      code: 'TASK_EXECUTION_EVIDENCE_SELECTION_MISMATCH',
      message: `TASK_EXECUTION_EVIDENCE_SELECTION_MISMATCH: ${message}`,
    });
  });

  it('refuses an agent execution whose request never authorised exact host selection', () => {
    // The request and the evidence agree on a not-applicable selection, every
    // resolved identity matches, and the recipe and prompt bindings hold: the
    // only defect is that an agent ran without an exact host contract.
    expect(
      refusal(() =>
        buildTaskExecutionEvidence(
          agentTask({ mode: 'not-applicable' }),
          agentFacts({ selection: { ...EXACT_SELECTION, mode: 'not-applicable' } }),
        ),
      ),
    ).toEqual({
      code: 'TASK_EXECUTION_EVIDENCE_SELECTION_MISMATCH',
      message:
        'TASK_EXECUTION_EVIDENCE_SELECTION_MISMATCH: agent execution requires exact host selection',
    });
  });
});

describe('failure detail on verdicts that neither passed nor failed', () => {
  const detail = {
    code: 'REVIEW_REQUIRED',
    message: 'reviewer must confirm the retained diff',
    rollback_disposition: 'preserved-for-repair',
  } as const;

  it.each(['review', 'unknown'] as const)('retains failure detail on a %s verdict', (verdict) => {
    const bound = routineTask();
    const evidence = succeeds(() =>
      buildTaskExecutionEvidence(
        bound,
        facts('TXE-0000000000009302', ROUTINE, { verdict, failure: detail }),
      ),
    );
    expect(evidence.verdict).toBe(verdict);
    expect(evidence.failure).toEqual(detail);
    expect(checkTaskExecutionEvidence(evidence).ok).toBe(true);
  });

  it('still accepts a review verdict that carries no failure detail', () => {
    expect(
      buildTaskExecutionEvidence(
        routineTask(),
        facts('TXE-0000000000009303', ROUTINE, { verdict: 'review' }),
      ).failure,
    ).toBeNull();
  });
});

describe('exported binding assertion on provider facts that are absent', () => {
  it.each(['prompt', 'usage', 'cost'] as const)(
    'refuses a routine whose %s is null rather than crashing on it',
    (field) => {
      const bound = routineTask();
      const evidence = buildTaskExecutionEvidence(bound, facts('TXE-0000000000009304', ROUTINE));
      const absent = { ...evidence, [field]: null } as unknown as TaskExecutionEvidence;
      expect(refusal(() => assertTaskExecutionEvidenceBinding(absent, bound, CANDIDATE))).toEqual({
        code: 'TASK_EXECUTION_EVIDENCE_PROVIDER_FACTS_NOT_APPLICABLE',
        message:
          'TASK_EXECUTION_EVIDENCE_PROVIDER_FACTS_NOT_APPLICABLE: non-agent evidence must mark prompt, usage, and cost not applicable',
      });
    },
  );
});

describe('persistence paths that begin with dots without escaping the root', () => {
  it('writes the exact bound record under a first segment that starts with two dots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-task-execution-boundaries-'));
    roots.push(root);
    const bound = routineTask('TASK-9401');
    const evidence = buildTaskExecutionEvidence(bound, facts('TXE-0000000000009401', ROUTINE));
    const relativePath = '..devai-inbox/proofs/task-execution/TXE-0000000000009401.json';

    const result = await withAuthorityHostTestScope(() =>
      succeeds(() =>
        persistTaskExecutionEvidence({
          repoRoot: root,
          relativePath,
          task: bound,
          candidate_sha: CANDIDATE,
          evidence,
        }),
      ),
    );

    expect(result.relativePath).toBe(relativePath);
    expect(result.path).toBe(join(root, relativePath));
    expect(result.evidence).toEqual(evidence);
    expect(readdirSync(root)).toEqual(['..devai-inbox']);
    expect(readFileSync(result.path, 'utf8')).toBe(`${JSON.stringify(evidence, null, 2)}\n`);
  });
});
