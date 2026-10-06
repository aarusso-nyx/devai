// A human task's `task finish` moves it through in_progress, pre_merge and merging before
// `completeTask` persists, and it cannot finish again from `merging`. Ownership is secured
// before the first of those writes; a completion still refused for a lost lock escalates
// the task instead of stranding it in `merging` (#285).
import { runWithAuthorityHostEffects, type AuthorityHostEffectScope } from '@devai-nyx/authority';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createIssuer,
  runtimeApi,
} from '../../../authority/tests/unit/authority-runtime-testkit.js';
import { DEFAULT_LOCK_TTL_MS, acquireLocks, listLocks } from '../../src/loop/locks.js';
import { finishRoundTask } from '../../src/loop/task-services.js';
import { loadTask, saveTask, type TaskRecord } from '../../src/loop/tasks.js';

const ROUND = 'R-0007';
const NOW = '2026-10-05T12:00:00.000Z';
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-human-finish-lock-recovery-'));
  roots.push(root);
  mkdirSync(join(root, 'work/rounds', ROUND), { recursive: true });
  writeFileSync(join(root, 'work/rounds', ROUND, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  return root;
}

const HUMAN: TaskRecord = {
  schemaVersion: '2.0.0',
  id: 'TASK-0561',
  round_id: ROUND,
  status: 'awaiting_human_review',
  discipline: 'engineer',
  title: 'Human review',
  target_modules: ['MOD-a'],
  target_substrates: ['F2'],
  created_at: NOW,
  db_isolation: 'database',
  iteration_count: 1,
  executor: {
    kind: 'human',
    role: 'engineer',
    instructions_ref: 'docs/review.md',
    timeout_ms: 3_600_000,
    timeout_behavior: 'block',
    completion_evidence: ['EV-review'],
  },
} as TaskRecord;

const locksDir = (root: string): string => join(root, '.devai/state/locks');
const keyFile = (root: string): string => join(locksDir(root), 'F2~MOD-a.json');

/** Another task's record in the key, written behind the protocol's back. */
function takeOverRaw(root: string): void {
  rmSync(keyFile(root));
  writeFileSync(
    keyFile(root),
    `${JSON.stringify({
      task_id: 'TASK-0999',
      substrate: 'F2',
      module: 'MOD-a',
      acquired_at: new Date().toISOString(),
      ttl_ms: DEFAULT_LOCK_TTL_MS,
      generation: 'takeover',
    })}\n`,
  );
}

/** Run with every effect permitted; `before` sees each effect before it applies. */
async function effects<T>(
  run: () => T,
  before?: (symbol: string, args: readonly unknown[]) => void,
): Promise<T> {
  const issuer = createIssuer(await runtimeApi(), { invocation_id: 'human-finish-recovery' });
  const scope: AuthorityHostEffectScope = {
    action_id: 'task finish',
    invocation_id: 'human-finish-recovery',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (request, apply) => {
      before?.(request.symbol, request.arguments);
      return apply();
    },
  };
  try {
    return await runWithAuthorityHostEffects(scope, async () => run());
  } finally {
    issuer.dispose();
  }
}

function finish(root: string): TaskRecord {
  return finishRoundTask({
    repoRoot: root,
    round: ROUND,
    taskId: HUMAN.id,
    evidence: ['EV-review'],
  });
}

async function waitingHumanTask(root: string, ttlMs?: number): Promise<void> {
  await effects(() => {
    saveTask(root, HUMAN);
    acquireLocks({
      locksDir: locksDir(root),
      taskId: HUMAN.id,
      targets: ['F2:MOD-a'],
      ...(ttlMs !== undefined && { ttlMs }),
    });
  });
}

describe('a human finish never strands its task in merging (#285)', () => {
  it('renews an expired own lock before the first transition, then completes', async () => {
    const root = repository();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    await waitingHumanTask(root, 60_000);
    vi.setSystemTime(new Date(Date.parse(NOW) + 2 * 60_000));
    const order: string[] = [];

    const completed = await effects(
      () => finish(root),
      (symbol, args) => {
        const path = String(args[0]);
        if (symbol === 'renameSync' && path.includes('F2~MOD-a.json')) order.push('renew');
        if (symbol === 'writeFileSync' && path.endsWith(`${HUMAN.id}.json`)) order.push('task');
      },
    );

    expect(completed.status).toBe('completed');
    expect(order[0]).toBe('renew');
    expect(listLocks({ locksDir: locksDir(root) })).toEqual([]);
  });

  it('escalates the task when the completion is refused after the transitions', async () => {
    const root = repository();
    await waitingHumanTask(root);
    let took = false;

    await effects(
      () => {
        expect(() => finish(root)).toThrow('TASK_RESOURCE_LOCK_LOST');
      },
      (symbol, args) => {
        // A takeover lands once the task reached merging, before completeTask's check.
        if (
          !took &&
          symbol === 'writeFileSync' &&
          String(args[0]).endsWith(`${HUMAN.id}.json`) &&
          String(args[1]).includes('"status": "merging"')
        ) {
          took = true;
          takeOverRaw(root);
        }
      },
    );

    expect(took).toBe(true);
    expect(loadTask(root, HUMAN.id).status).toBe('escalated');
    // The escalation released nothing it did not hold: the new holder keeps the key.
    expect(listLocks({ locksDir: locksDir(root) })).toMatchObject([{ task_id: 'TASK-0999' }]);
  });
});
