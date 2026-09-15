import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTask } from '../../src/loop/tasks.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-task-executor-input-'));
  roots.push(root);
  return root;
}

function task(executor: unknown): Parameters<typeof spawnTask>[0]['task'] {
  return {
    id: 'TASK-8503',
    round_id: 'R-0007',
    discipline: 'engineer',
    title: 'Malformed executor boundary',
    target_modules: [],
    target_substrates: ['F2'],
    db_isolation: 'database',
    executor,
  };
}

describe('spawnTask executor input boundaries', () => {
  it.each([
    ['null', null],
    ['array', []],
    ['primitive', 'routine'],
  ])('refuses a %s executor before creating task state', (_label, executor) => {
    const root = repository();

    expect(() => spawnTask({ repoRoot: root, task: task(executor) })).toThrow(
      'TASK_EXECUTOR_REQUIRED',
    );
    expect(existsSync(join(root, '.devai'))).toBe(false);
  });
});
