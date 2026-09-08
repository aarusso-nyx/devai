import { describe, expect, it } from 'vitest';
import {
  completeHumanTask,
  type HumanCompletionOptions,
  type HumanExecutorRole,
} from '../../src/loop/human-executor.js';

function request(): HumanCompletionOptions {
  return {
    task_id: 'TASK-9701',
    round_id: 'R-0007',
    executor: { kind: 'human', role: 'inspector', completion_evidence: ['EV-review', 'EV-result'] },
    evidence: ['EV-review', 'EV-result'],
  };
}

describe('human completion retains requested governance identity and exact evidence', () => {
  it.each(['owner', 'architect', 'inspector', 'engineer', 'auditor'] as HumanExecutorRole[])(
    'retains an explicitly matching %s completion',
    (role) => {
      const base = request();
      const options = {
        ...base,
        executor: { ...base.executor, role },
        completion: { task_id: base.task_id, round_id: base.round_id, role },
        task: { id: base.task_id, round_id: base.round_id },
        completed_by_role: role,
      };
      const before = JSON.stringify(options);
      const result = completeHumanTask(options);
      expect(result).toEqual({
        ok: true,
        task_id: base.task_id,
        round_id: base.round_id,
        role,
        evidence: base.evidence,
      });
      expect(JSON.stringify(options)).toBe(before);
      if (result.ok) expect(result.evidence).not.toBe(options.evidence);
    },
  );

  const identityChanges: ReadonlyArray<readonly [string, Partial<HumanCompletionOptions>, string]> =
    [
      [
        'persisted task',
        { task: { id: 'TASK-9702', round_id: 'R-0007' } },
        'TASK_HUMAN_TASK_MISMATCH',
      ],
      [
        'persisted round',
        { task: { id: 'TASK-9701', round_id: 'R-0008' } },
        'TASK_HUMAN_ROUND_MISMATCH',
      ],
      [
        'completion task',
        { completion: { task_id: 'TASK-9702', round_id: 'R-0007', role: 'inspector' } },
        'TASK_HUMAN_TASK_MISMATCH',
      ],
      [
        'completion round',
        { completion: { task_id: 'TASK-9701', round_id: 'R-0008', role: 'inspector' } },
        'TASK_HUMAN_ROUND_MISMATCH',
      ],
      [
        'completion role',
        { completion: { task_id: 'TASK-9701', round_id: 'R-0007', role: 'owner' } },
        'TASK_HUMAN_ROLE_MISMATCH',
      ],
      ['authenticated role', { completed_by_role: 'owner' }, 'TASK_HUMAN_ROLE_MISMATCH'],
    ];
  it.each(identityChanges)('refuses substitution of the %s', (_label, change, code) => {
    expect(completeHumanTask({ ...request(), ...change })).toEqual({ ok: false, code });
  });

  it('uses the requested identity when optional bindings are absent', () => {
    expect(completeHumanTask(request())).toEqual({
      ok: true,
      task_id: 'TASK-9701',
      round_id: 'R-0007',
      role: 'inspector',
      evidence: ['EV-review', 'EV-result'],
    });
  });

  it.each([
    { label: 'empty', evidence: [] },
    { label: 'empty member', evidence: ['EV-review', ''] },
    { label: 'blank member', evidence: ['EV-review', ' \t\n'] },
    { label: 'duplicate', evidence: ['EV-review', 'EV-result', 'EV-review'] },
    { label: 'missing requirement', evidence: ['EV-review'] },
    { label: 'different case', evidence: ['EV-review', 'ev-result'] },
    { label: 'padded identity', evidence: ['EV-review', 'EV-result '] },
  ])('refuses $label evidence', ({ evidence }) => {
    expect(completeHumanTask({ ...request(), evidence })).toEqual({
      ok: false,
      code: 'TASK_HUMAN_EVIDENCE_REQUIRED',
    });
  });

  it('accepts additional distinct evidence and preserves its order', () => {
    const evidence = Object.freeze(['EV-extra', 'EV-result', 'EV-review']);
    expect(completeHumanTask({ ...request(), evidence })).toEqual({
      ok: true,
      task_id: 'TASK-9701',
      round_id: 'R-0007',
      role: 'inspector',
      evidence,
    });
  });

  it.each([undefined, []].map((requirements) => ({ requirements })))(
    'requires some evidence even without declared requirements: $requirements',
    ({ requirements }) => {
      const base = request();
      const executor = { ...base.executor, completion_evidence: requirements };
      expect(completeHumanTask({ ...base, executor, evidence: [] })).toEqual({
        ok: false,
        code: 'TASK_HUMAN_EVIDENCE_REQUIRED',
      });
      expect(completeHumanTask({ ...base, executor, evidence: ['EV-review'] })).toEqual({
        ok: true,
        task_id: base.task_id,
        round_id: base.round_id,
        role: base.executor.role,
        evidence: ['EV-review'],
      });
    },
  );
});
