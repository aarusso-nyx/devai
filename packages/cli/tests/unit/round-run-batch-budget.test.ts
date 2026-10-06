// The `round run` authority contract bounds one invocation to `max_batches` effects: the
// broker authorizes every filesystem or process effect as its own batch (a mkdir of an
// existing directory excepted). Lock claims, fences, receipts and renewals all spend that
// budget, so a serial run of several routine tasks must fit inside it with headroom.
import { runWithAuthorityHostEffects, type AuthorityHostEffectScope } from '@devai-nyx/authority';
import { runRoundTasks, type TaskRecord } from '@devai-nyx/loop';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createIssuer,
  runtimeApi,
} from '../../../authority/tests/unit/authority-runtime-testkit.js';
import { dispatchRoundTask } from '../../src/commands/round/dispatch.js';

const ROUND = 'R-9721';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-round-run-batch-budget-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  writeFileSync(join(root, 'input.txt'), 'managed input\n');
  execFileSync('git', ['add', 'input.txt'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=DEVAI Test',
      '-c',
      'user.email=devai-test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: root },
  );
  mkdirSync(join(root, 'work/rounds', ROUND), { recursive: true });
  writeFileSync(join(root, 'work/rounds', ROUND, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  mkdirSync(join(root, '.devai/state/tasks'), { recursive: true });
  return root;
}

function task(index: number): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id: `TASK-97${String(index).padStart(2, '0')}`,
    round_id: ROUND,
    status: 'ready',
    discipline: 'engineer',
    title: `Routine ${String(index)}`,
    target_modules: [`MOD-${String(index)}`],
    target_substrates: ['F2'],
    created_at: '2026-10-05T00:00:00.000Z',
    db_isolation: 'database',
    iteration_count: 0,
    executor: {
      kind: 'routine',
      argv: [process.execPath, '-e', 'process.exit(0)'],
      cwd: '.',
      inputs: ['input.txt'],
      outputs: [],
      effects: ['read'],
      timeout_ms: 10_000,
      authority_checks: ['discipline'],
    },
  };
}

interface RegistryDocument {
  readonly entries: readonly {
    readonly action_id: string;
    readonly authority_contract: {
      readonly planner: { readonly bounds: { readonly max_batches: number } };
    };
  }[];
}

function roundRunMaxBatches(): number {
  const registry = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../../../law/policy/action-registry.json'), 'utf8'),
  ) as RegistryDocument;
  const entry = registry.entries.find((action) => action.action_id === 'round run');
  if (entry === undefined) throw new Error('round run is not registered');
  return entry.authority_contract.planner.bounds.max_batches;
}

/** Single-key routine tasks one serial `round run` invocation must fit, with headroom. */
const ROUND_RUN_TASK_CAPACITY = 32;

/** Run with a scope that counts effects the way the broker spends batches. */
async function countingBatches<T>(run: () => Promise<T>): Promise<{ result: T; batches: number }> {
  const issuer = createIssuer(await runtimeApi(), { invocation_id: 'round-run-budget' });
  let batches = 0;
  const scope: AuthorityHostEffectScope = {
    action_id: 'round run',
    invocation_id: 'round-run-budget',
    effect: 'harness-write',
    receipt_store: issuer,
    apply_effect: (request, apply) => {
      const path = request.arguments[0];
      // The broker authorizes no batch for a mkdir of a directory that already exists.
      const existingDirectory =
        request.symbol === 'mkdirSync' &&
        typeof path === 'string' &&
        existsSync(path) &&
        lstatSync(path).isDirectory();
      if (!existingDirectory) batches += 1;
      return apply();
    },
  };
  try {
    const result = await runWithAuthorityHostEffects(scope, run);
    return { result, batches };
  } finally {
    issuer.dispose();
  }
}

async function serialRun(count: number): Promise<number> {
  const root = repository();
  for (let index = 1; index <= count; index += 1) {
    const value = task(index);
    writeFileSync(
      join(root, '.devai/state/tasks', `${value.id}.json`),
      `${JSON.stringify(value, null, 2)}\n`,
    );
  }
  const { result, batches } = await countingBatches(() =>
    runRoundTasks({
      repoRoot: root,
      round: ROUND,
      dispatch: (running) => dispatchRoundTask(root, running),
    }),
  );
  expect(result).toMatchObject({ ok: true });
  expect(result.results).toHaveLength(count);
  return batches;
}

describe('round run authority batch budget', () => {
  it(`fits ${String(ROUND_RUN_TASK_CAPACITY)} routine tasks holding locks inside max_batches`, async () => {
    const one = await serialRun(1);
    const two = await serialRun(2);
    const three = await serialRun(3);
    // Every task spends the same batches (lock, fence, receipts, waiting lease, evidence).
    const perTask = two - one;
    expect(three - two).toBe(perTask);
    const fixed = one - perTask;

    expect(fixed + ROUND_RUN_TASK_CAPACITY * perTask).toBeLessThanOrEqual(roundRunMaxBatches());
  });
});
