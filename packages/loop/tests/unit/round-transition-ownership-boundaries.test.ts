import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { loadTask, saveTask, type TaskRecord } from '../../src/loop/tasks.js';
import {
  escalateRoundTask,
  finishRoundTask,
  pauseRoundTask,
  resumeRoundTask,
  startRoundTask,
} from '../../src/loop/task-services.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-queue-boundaries-'));
  roots.push(root);
  for (const round of ['R-0007', 'R-0008']) {
    const dir = join(root, 'work/rounds', round);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'AUTHORIZATION.md'), '# Authorization\nstatus: active\nGRANTED\n');
  }
  return root;
}
function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id: 'TASK-9701',
    round_id: 'R-0007',
    status: 'queued',
    discipline: 'engineer',
    title: 'Retain task identity',
    priority: 70,
    description: 'Approved scope',
    target_modules: ['MOD-QUEUE'],
    target_substrates: ['F2'],
    created_at: '2026-09-08T00:00:00.000Z',
    db_isolation: 'database',
    iteration_count: 0,
    executor: {
      kind: 'routine',
      argv: ['node', 'fixture.mjs'],
      cwd: '.',
      inputs: [],
      outputs: [],
      effects: ['read'],
      timeout_ms: 1000,
      authority_checks: ['discipline'],
    },
    ...overrides,
  };
}

function bytes(root: string, id = 'TASK-9701') {
  return readFileSync(join(root, '.devai/state/tasks', id + '.json'));
}
function request(repoRoot: string, taskId = 'TASK-9701') {
  return { repoRoot, round: 'R-0007', taskId };
}

describe('round transitions preserve exact persisted task ownership', () => {
  it('resumes the requested task when an earlier task shares its reference gap', async () => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      saveTask(
        root,
        task({ id: 'TASK-9700', status: 'rgr_pending', tags: ['rgr_pause:RGR-1', 'keep-other'] }),
      );
      const declared = task({ status: 'rgr_pending', tags: ['keep-requested', 'rgr_pause:RGR-1'] });
      saveTask(root, declared);
      const other = bytes(root, 'TASK-9700');
      expect(resumeRoundTask({ ...request(root), gapId: 'RGR-1' })).toEqual({
        ...declared,
        status: 'queued',
        tags: ['keep-requested'],
      });
      expect(bytes(root, 'TASK-9700')).toEqual(other);
    });
  });
  it('cannot resume another round task sharing the requested reference gap', async () => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      saveTask(
        root,
        task({
          id: 'TASK-9700',
          round_id: 'R-0008',
          status: 'rgr_pending',
          tags: ['rgr_pause:RGR-1'],
        }),
      );
      saveTask(root, task({ status: 'rgr_pending', tags: ['rgr_pause:RGR-1'] }));
      const other = bytes(root, 'TASK-9700');
      expect(resumeRoundTask({ ...request(root), gapId: 'RGR-1' }).id).toBe('TASK-9701');
      expect(bytes(root, 'TASK-9700')).toEqual(other);
    });
  });
  it.each(['in_progress', 'checkpoint'] as const)(
    'pauses %s with the exact gap while preserving unrelated tags and task bytes',
    async (status) => {
      const root = repository();
      await withAuthorityHostTestScope(() => {
        const declared = task({
          status,
          branch: 'review/branch',
          tags: ['keep', 'rgr_pause:RGR-OLD', 'rgr_pauseish:keep'],
        });
        saveTask(root, declared);
        saveTask(root, task({ id: 'TASK-9700' }));
        const other = bytes(root, 'TASK-9700');
        expect(pauseRoundTask({ ...request(root), gapId: 'RGR-NEW' })).toEqual({
          ...declared,
          status: 'rgr_pending',
          branch: 'rgr/review/branch',
          tags: ['keep', 'rgr_pauseish:keep', 'rgr_pause:RGR-NEW'],
        });
        expect(bytes(root, 'TASK-9700')).toEqual(other);
      });
    },
  );
  it.each([
    'queued',
    'ready',
    'lock_denied',
    'awaiting_human_review',
    'pre_merge',
    'merging',
    'completed',
    'escalated',
    'cancelled',
    'rgr_pending',
  ] as const)('refuses pause from %s without writing', async (status) => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      saveTask(root, task({ status }));
      const before = bytes(root);
      expect(() => pauseRoundTask({ ...request(root), gapId: 'RGR-NEW' })).toThrow(
        'TASK_LIFECYCLE_TRANSITION_FORBIDDEN',
      );
      expect(bytes(root)).toEqual(before);
    });
  });
  it.each([
    'lock_denied',
    'in_progress',
    'checkpoint',
    'awaiting_human_review',
    'pre_merge',
    'merging',
    'experimental_blocked',
    'rgr_pending',
  ] as const)('escalates eligible %s without dropping declaration fields', async (status) => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      const declared = task({ status, branch: 'review/branch', tags: ['keep'] });
      saveTask(root, declared);
      expect(escalateRoundTask(request(root))).toEqual({
        ...declared,
        status: 'escalated',
        branch: 'escalated/review/branch',
      });
      expect(loadTask(root, declared.id).status).toBe('escalated');
    });
  });
  it.each(['queued', 'ready', 'completed', 'cancelled', 'escalated'] as const)(
    'refuses escalation from %s without writing',
    async (status) => {
      const root = repository();
      await withAuthorityHostTestScope(() => {
        saveTask(root, task({ status }));
        const before = bytes(root);
        expect(() => escalateRoundTask(request(root))).toThrow(
          'TASK_LIFECYCLE_TRANSITION_FORBIDDEN',
        );
        expect(bytes(root)).toEqual(before);
      });
    },
  );
  it.each([
    'in_progress',
    'checkpoint',
    'awaiting_human_review',
    'pre_merge',
    'merging',
    'completed',
    'escalated',
    'cancelled',
    'rgr_pending',
  ] as const)('refuses starting %s without changing its task record', async (status) => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      saveTask(root, task({ status }));
      const before = bytes(root);
      expect(() => startRoundTask(request(root))).toThrow('TASK_START_STATUS_INVALID');
      expect(bytes(root)).toEqual(before);
    });
  });
  it('refuses a different gap before any task write', async () => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      saveTask(root, task({ status: 'rgr_pending', tags: ['rgr_pause:RGR-1'] }));
      const before = bytes(root);
      expect(() => resumeRoundTask({ ...request(root), gapId: 'RGR-2' })).toThrow(
        'TASK_GAP_MISMATCH',
      );
      expect(bytes(root)).toEqual(before);
    });
  });
  it.each(['start', 'pause', 'resume', 'escalate', 'finish'] as const)(
    'reports a missing record before %s writes',
    async (operation) => {
      const root = repository();
      await withAuthorityHostTestScope(() => {
        const invoke = {
          start: () => startRoundTask(request(root)),
          pause: () => pauseRoundTask({ ...request(root), gapId: 'RGR-1' }),
          resume: () => resumeRoundTask({ ...request(root), gapId: 'RGR-1' }),
          escalate: () => escalateRoundTask(request(root)),
          finish: () => finishRoundTask(request(root)),
        };
        expect(invoke[operation]).toThrow('TASK_NOT_FOUND');
      });
    },
  );
});
