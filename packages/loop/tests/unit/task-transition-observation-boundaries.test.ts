import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalSha256 } from '@devai-nyx/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { finishRoundTask, startRoundTask } from '../../src/loop/task-services.js';
import { listGovernanceSegments, readGovernanceEvents } from '../../src/tracking/index.js';
import { saveTask, type TaskRecord } from '../../src/loop/tasks.js';
import type { RoundTrackingActivation } from '../../src/tracking/index.js';

const roots: string[] = [];
const ROUND = 'R-0007';
const SESSION = 'AUTH-SESSION-0f1e2d3c4b5a69788796';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-task-transition-observation-'));
  roots.push(root);
  mkdirSync(join(root, 'work/rounds', ROUND), { recursive: true });
  writeFileSync(join(root, 'work/rounds', ROUND, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  return root;
}

function activate(root: string): void {
  const activation: RoundTrackingActivation = {
    schemaVersion: '1.0.0',
    round_id: ROUND,
    repository_id: 'adopter',
    state: 'active',
    adapter: {
      id: 'github-issues',
      adapter_version: '1.0.0',
      package_version: '1.3.0',
      config_digest_sha256: 'a'.repeat(64),
      workflow_digest_sha256: 'b'.repeat(64),
    },
    target: { repository: 'example/adopter', issue_number: null },
    authorization: {
      authority_session_id: SESSION,
      role: 'owner',
      publish_flag: true,
      authorized_at: '2026-08-27T12:00:00.000Z',
    },
    disclosure_profile: 'public-safe-v1',
    pending_policy: 'freeze',
    disabled: null,
  };
  const directory = join(root, '.devai/state/tracking', ROUND);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'activation.json'), `${JSON.stringify(activation, null, 2)}\n`);
}

function task(): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id: 'TASK-8701',
    round_id: ROUND,
    status: 'merging',
    discipline: 'engineer',
    title: 'Observation boundary',
    target_modules: [],
    target_substrates: ['F2'],
    created_at: '2026-09-08T12:00:00.000Z',
    db_isolation: 'database',
    iteration_count: 0,
    executor: {
      kind: 'routine',
      argv: ['node', 'fixture.mjs'],
      cwd: '.',
      inputs: [],
      outputs: [],
      effects: ['read'],
      timeout_ms: 1_000,
      authority_checks: ['discipline'],
    },
  };
}

describe('task transition tracking observations', () => {
  it('records an intended start without sealing a checkpoint', () => {
    const root = repository();
    activate(root);
    const declared = { ...task(), id: 'TASK-8702', status: 'ready' as const };

    withAuthorityHostTestScope(() => {
      saveTask(root, declared);
      expect(
        startRoundTask({ repoRoot: root, round: ROUND, taskId: declared.id }).task,
      ).toMatchObject({
        id: declared.id,
        status: 'ready',
      });
    });

    const event = readGovernanceEvents({ repoRoot: root, round: ROUND }).at(-1);
    expect(event).toBeDefined();
    if (event === undefined) throw new Error('task start observation was not recorded');
    expect(event).toMatchObject({
      kind: 'action_intended',
      task_id: declared.id,
      public_safe_summary: `Task ${declared.id} started.`,
      payload_digest_sha256: canonicalSha256({
        task_id: declared.id,
        status: 'ready',
        executor: 'routine',
      }),
    });
    expect(event.status).toBeUndefined();
    expect(listGovernanceSegments({ repoRoot: root, round: ROUND })).toEqual([]);
  });

  it('persists the completed transition status, checkpoint, payload, and summary', () => {
    const root = repository();
    activate(root);

    withAuthorityHostTestScope(() => {
      saveTask(root, task());
      expect(finishRoundTask({ repoRoot: root, round: ROUND, taskId: 'TASK-8701' })).toMatchObject({
        id: 'TASK-8701',
        status: 'completed',
      });
    });

    const event = readGovernanceEvents({ repoRoot: root, round: ROUND }).at(-1);
    expect(event).toBeDefined();
    if (event === undefined) throw new Error('task transition observation was not recorded');
    expect(event).toMatchObject({
      kind: 'action_completed',
      task_id: 'TASK-8701',
      status: 'pass',
      public_safe_summary: 'Task TASK-8701 completed.',
      payload_digest_sha256: canonicalSha256({
        task_id: 'TASK-8701',
        status: 'completed',
        executor: 'routine',
      }),
    });
    const segments = listGovernanceSegments({ repoRoot: root, round: ROUND });
    expect(segments).toHaveLength(1);
    expect(segments[0]?.seal_reason).toBe('checkpoint');
    expect(segments[0]?.event_ids).toContain(event.event_id);
    expect(
      JSON.parse(readFileSync(join(root, '.devai/state/tasks/TASK-8701.json'), 'utf8')).status,
    ).toBe('completed');
  });
});
