import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeGovernedRound,
  declareGovernedRound,
  governedRoundStatus,
  scaffoldGovernedRound,
} from '../../src/round-lifecycle/index.js';
import { runRoundTasks } from '../../src/loop/round-runner.js';
import { roundTaskStatus, startRoundTask } from '../../src/loop/task-services.js';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';

// ADR-EVI-0003 inspector acceptance IA-001 to IA-004, proven at the lifecycle layer.
// The lifecycle read reports the governed state; the active-task precondition stays
// with task dispatch. The cases that assert the sealed status read fail on a head that
// still gates the read on an active task round.

const ROUND = 'R-0005';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-sealed-status-'));
  roots.push(path);
  return path;
}

function write(repo: string, rel: string, value: unknown): string {
  const path = join(repo, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

function closedRecord(): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    id: ROUND,
    title: `${ROUND} fixture`,
    type: 'round-record',
    status: 'closed',
    date: '2026-07-24',
    authority: 'Architect',
    kind: 'round',
    goal: 'Exercise the sealed lifecycle read',
    declared_by: 'DII-1',
    closed_by: 'DII-2',
    phase_closure: 'PC-0001',
    merged_as: 'b'.repeat(40),
    isolation: { kind: 'worktree', branch: 'fixture', base_sha: 'a'.repeat(40) },
    waves: [
      {
        id: 'W1',
        title: 'Verify',
        roles: ['Inspector'],
        type: 'serial',
        lock_scopes: ['tests/**'],
        gates: ['unit'],
      },
    ],
    gates: ['unit'],
    orchestrator_prompt: 'prompts/00-orchestrator.md',
    plan_path: 'plan.md',
  };
}

/** Declare a closed round with its seal preconditions and an active task authorization. */
function declared(repo: string): void {
  scaffoldGovernedRound({ repoRoot: repo, round: 5 });
  declareGovernedRound({
    repoRoot: repo,
    round: 5,
    recordPath: write(repo, 'record.json', closedRecord()),
  });
  write(
    repo,
    'law/register/DECISIONS.md',
    '### DII-1 — Declare fixture\n\n### DII-2 — Close fixture\n',
  );
  write(repo, 'record/proofs/compliance/closures/PC-0001.json', {
    schemaVersion: '1.0.0',
    id: 'PC-0001',
    round_id: ROUND,
    declaring_decision: 'DII-1',
    closing_decision: 'DII-2',
    batches: [{ id: 'B1', roles: ['Architect'], headline: 'fixture' }],
    gates: { unit: { status: 'pass' } },
    source_repo_deleted: false,
    validation_criteria: [{ criterion: 'fixture', verdict: 'pass', evidence: 'unit' }],
    closed_at: '2026-07-26T00:00:00.000Z',
    merged_as: 'b'.repeat(40),
    release_disposition: 'none-needed',
  });
  write(repo, 'record/derived/indexes/rounds.md', 'PC-0001\n');
  write(repo, `work/rounds/${ROUND}/AUTHORIZATION.md`, 'status: active\nGRANTED\n');
}

function treeDigest(repo: string, rel: string): string {
  const hash = createHash('sha256');
  const walk = (directory: string): void => {
    for (const name of readdirSync(join(repo, directory)).sort()) {
      const child = join(directory, name);
      if (statSync(join(repo, child)).isDirectory()) walk(child);
      else
        hash
          .update(child)
          .update('\0')
          .update(readFileSync(join(repo, child)))
          .update('\0');
    }
  };
  walk(rel);
  return hash.digest('hex');
}

function digest(repo: string, rel: string): string {
  return createHash('sha256')
    .update(readFileSync(join(repo, rel)))
    .digest('hex');
}

function failureOf(action: () => unknown): { code: string; exitCode: number | undefined } {
  try {
    action();
  } catch (error) {
    const typed = error as { code?: string; exitCode?: number; message?: string };
    return { code: typed.code ?? String(typed.message), exitCode: typed.exitCode };
  }
  throw new Error('expected the action to fail');
}

const CLOSE_STATE = `work/rounds/${ROUND}/close-state.jsonl`;

describe('sealed round lifecycle read (ADR-EVI-0003)', () => {
  it('IA-001 reports closed after the seal and leaves seal and proof bytes unchanged', async () => {
    const repo = repository();
    await withAuthorityHostTestScope(() => {
      declared(repo);
      expect(closeGovernedRound({ repoRoot: repo, round: 5 })).toMatchObject({
        ok: true,
        close_state: CLOSE_STATE,
      });
      const closeState = digest(repo, CLOSE_STATE);
      const chain = treeDigest(repo, 'record/proofs');
      const rounds = treeDigest(repo, 'work/rounds');

      const status = governedRoundStatus({ repoRoot: repo, round: ROUND });
      expect(status).toMatchObject({ ok: true, id: ROUND, location: 'closed' });
      expect(status.path).toBe(`work/rounds/${ROUND}/record.md`);

      expect(digest(repo, CLOSE_STATE)).toBe(closeState);
      expect(treeDigest(repo, 'record/proofs')).toBe(chain);
      expect(treeDigest(repo, 'work/rounds')).toBe(rounds);
      expect(JSON.parse(readFileSync(join(repo, CLOSE_STATE), 'utf8'))).toMatchObject({
        round_id: ROUND,
        status: 'closed',
      });
    });
  });

  it('IA-001 keeps the lifecycle read independent of the task summary on a sealed round', async () => {
    const repo = repository();
    await withAuthorityHostTestScope(() => {
      declared(repo);
      // Before the seal the authorization is active, so the task summary exists.
      expect(roundTaskStatus({ repoRoot: repo, round: ROUND })).toMatchObject({
        round_id: ROUND,
        count: 0,
      });
      closeGovernedRound({ repoRoot: repo, round: 5 });
      const closeState = digest(repo, CLOSE_STATE);
      // The lifecycle read still succeeds where the task summary refuses.
      expect(governedRoundStatus({ repoRoot: repo, round: ROUND }).location).toBe('closed');
      expect(failureOf(() => roundTaskStatus({ repoRoot: repo, round: ROUND }))).toEqual({
        code: 'TASK_ROUND_INACTIVE',
        exitCode: 5,
      });
      expect(digest(repo, CLOSE_STATE)).toBe(closeState);
    });
  });

  it('IA-003 refuses task summary, dispatch, and round run on a sealed round with TASK_ROUND_INACTIVE', async () => {
    const repo = repository();
    await withAuthorityHostTestScope(async () => {
      declared(repo);
      closeGovernedRound({ repoRoot: repo, round: 5 });
      const closeState = digest(repo, CLOSE_STATE);

      expect(failureOf(() => roundTaskStatus({ repoRoot: repo, round: ROUND }))).toEqual({
        code: 'TASK_ROUND_INACTIVE',
        exitCode: 5,
      });
      expect(
        failureOf(() => startRoundTask({ repoRoot: repo, round: ROUND, taskId: 'TASK-0001' })),
      ).toEqual({ code: 'TASK_ROUND_INACTIVE', exitCode: 5 });
      await expect(
        runRoundTasks({
          repoRoot: repo,
          round: ROUND,
          dispatch: () => {
            throw new Error('dispatch must not run on a sealed round');
          },
        }),
      ).rejects.toMatchObject({ code: 'TASK_ROUND_INACTIVE', exitCode: 5 });
      expect(digest(repo, CLOSE_STATE)).toBe(closeState);
    });
  });

  it('IA-002 keeps the task summary on an active round', async () => {
    const repo = repository();
    await withAuthorityHostTestScope(() => {
      declared(repo);
      expect(roundTaskStatus({ repoRoot: repo, round: ROUND })).toEqual({
        round_id: ROUND,
        count: 0,
        tasks: [],
      });
    });
  });

  it('IA-004 keeps ROUND_RECORD_NOT_FOUND for an unknown round', async () => {
    const repo = repository();
    await withAuthorityHostTestScope(() => {
      declared(repo);
      closeGovernedRound({ repoRoot: repo, round: 5 });
      expect(failureOf(() => governedRoundStatus({ repoRoot: repo, round: 'R-0099' })).code).toBe(
        'ROUND_RECORD_NOT_FOUND',
      );
      expect(failureOf(() => roundTaskStatus({ repoRoot: repo, round: 'R-0099' }))).toEqual({
        code: 'TASK_ROUND_INACTIVE',
        exitCode: 5,
      });
    });
  });

  it('IA-004 keeps the existing named code when the seal is repeated over a malformed close state', async () => {
    const repo = repository();
    await withAuthorityHostTestScope(() => {
      declared(repo);
      closeGovernedRound({ repoRoot: repo, round: 5 });
      truncateSync(join(repo, CLOSE_STATE), 20);
      const truncated = digest(repo, CLOSE_STATE);
      expect(failureOf(() => closeGovernedRound({ repoRoot: repo, round: 5 })).code).toBe(
        'ROUND_CLOSE_STATE_CONFLICT',
      );
      expect(digest(repo, CLOSE_STATE)).toBe(truncated);
    });
  });

  it('IA-004 fails a status read over a malformed close state with ROUND_CLOSE_STATE_CONFLICT', async () => {
    const repo = repository();
    await withAuthorityHostTestScope(() => {
      declared(repo);
      closeGovernedRound({ repoRoot: repo, round: 5 });
      truncateSync(join(repo, CLOSE_STATE), 20);
      const truncated = digest(repo, CLOSE_STATE);
      let reported: string | undefined;
      let code: string | undefined;
      try {
        reported = governedRoundStatus({ repoRoot: repo, round: ROUND }).location;
      } catch (error) {
        code = (error as { code?: string; message?: string }).code ?? (error as Error).message;
      }
      expect(reported).not.toBe('closed');
      expect(code).toBe('ROUND_CLOSE_STATE_CONFLICT');
      expect(digest(repo, CLOSE_STATE)).toBe(truncated);
    });
  });
});
