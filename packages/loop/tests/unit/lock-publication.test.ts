// ADR-AUT-0005 for resource locks: a fresh lock is published without replacement, so no
// reader ever sees an empty or partial lock, a competitor that wins the key first is never
// replaced, and a publication whose cleanup failed leaves no lock behind.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({
  publishes: [] as string[],
  before: undefined as undefined | ((path: string) => void),
  indeterminate: undefined as undefined | string,
}));
vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  return {
    ...actual,
    publishFileNoReplaceSync: (path: string, data: string) => {
      seam.publishes.push(path);
      const before = seam.before;
      seam.before = undefined;
      before?.(path);
      actual.publishFileNoReplaceSync(path, data);
      if (seam.indeterminate === path) {
        seam.indeterminate = undefined;
        throw Object.assign(new Error(actual.PUBLISH_INDETERMINATE), {
          code: actual.PUBLISH_INDETERMINATE,
        });
      }
    },
  };
});

import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { acquireLocks, listLocks } from '../../src/loop/locks.js';

const roots: string[] = [];
afterEach(() => {
  seam.publishes = [];
  seam.before = undefined;
  seam.indeterminate = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function locksDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-lock-publication-'));
  roots.push(root);
  return join(root, '.devai/state/locks');
}

describe('fresh lock publication', () => {
  it('publishes each fresh lock complete, leaving no staged name', async () => {
    const dir = locksDir();
    const result = await withAuthorityHostTestScope(() =>
      acquireLocks({ locksDir: dir, taskId: 'TASK-0001', targets: ['F2:MOD-a', 'F3:MOD-a'] }),
    );
    expect(result.denied).toEqual([]);
    expect(seam.publishes).toEqual([join(dir, 'F2~MOD-a.json'), join(dir, 'F3~MOD-a.json')]);
    for (const path of seam.publishes) {
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ task_id: 'TASK-0001' });
    }
    expect(readdirSync(dir).filter((name) => name.endsWith('.publish-staged'))).toEqual([]);
  });

  it('never replaces a competitor that published the key first', async () => {
    const dir = locksDir();
    const result = await withAuthorityHostTestScope(() => {
      seam.before = () => {
        const competitor = acquireLocks({
          locksDir: dir,
          taskId: 'TASK-0002',
          targets: ['F2:MOD-a'],
        });
        expect(competitor.denied).toEqual([]);
      };
      return acquireLocks({ locksDir: dir, taskId: 'TASK-0001', targets: ['F2:MOD-a'] });
    });
    expect(result.acquired).toEqual([]);
    expect(result.denied).toEqual([{ target: 'F2:MOD-a', held_by: 'TASK-0002' }]);
    expect(listLocks({ locksDir: dir }).map((lock) => lock.task_id)).toEqual(['TASK-0002']);
  });

  it('withdraws its own lock and rolls back the others when a publication is indeterminate', async () => {
    const dir = locksDir();
    seam.indeterminate = join(dir, 'F3~MOD-a.json');
    await expect(
      withAuthorityHostTestScope(() =>
        acquireLocks({ locksDir: dir, taskId: 'TASK-0001', targets: ['F2:MOD-a', 'F3:MOD-a'] }),
      ),
    ).rejects.toMatchObject({ code: 'DURABLE_PUBLICATION_INDETERMINATE' });
    expect(existsSync(join(dir, 'F2~MOD-a.json'))).toBe(false);
    expect(existsSync(join(dir, 'F3~MOD-a.json'))).toBe(false);
    const retry = await withAuthorityHostTestScope(() =>
      acquireLocks({ locksDir: dir, taskId: 'TASK-0003', targets: ['F2:MOD-a', 'F3:MOD-a'] }),
    );
    expect(retry.denied).toEqual([]);
  });
});
