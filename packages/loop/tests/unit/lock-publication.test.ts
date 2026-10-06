// ADR-AUT-0005 for resource locks: a fresh lock is published without replacement, so no
// reader ever sees an empty or partial lock, a competitor that wins the key first is never
// replaced, a new locks directory is durable before its first lock, and a publication
// whose cleanup failed leaves no lock behind or names the one it could not withdraw.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  publishNoReplaceSteps,
  type PublishNoReplaceHooks,
} from '../../../authority/src/boundaries/host-publish.js';

const seam = vi.hoisted(() => ({
  events: [] as string[],
  before: undefined as undefined | ((path: string) => void),
  /** Faults injected into the real post-link steps of one publication. */
  faults: new Map<string, PublishNoReplaceHooks>(),
  swap: undefined as undefined | (() => 'claimed'),
}));
vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      seam.events.push(`open ${String(args[0])}`);
      return actual.openSync(...args);
    },
    publishFileNoReplaceSync: (path: string, data: string) => {
      seam.events.push(`publish ${path}`);
      const before = seam.before;
      seam.before = undefined;
      before?.(path);
      const hooks = seam.faults.get(path);
      if (hooks === undefined) {
        actual.publishFileNoReplaceSync(path, data);
        return;
      }
      seam.faults.delete(path);
      // The authority effect's own steps, with one post-link step failing.
      publishNoReplaceSteps(path, data, hooks);
    },
  };
});
vi.mock('../../src/loop/record-claims.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/loop/record-claims.js')>();
  return {
    ...actual,
    swapObservedRecord: (options: Parameters<typeof actual.swapObservedRecord>[0]) => {
      const injected = seam.swap;
      seam.swap = undefined;
      return injected?.() ?? actual.swapObservedRecord(options);
    },
  };
});

import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { acquireLocks, listLocks } from '../../src/loop/locks.js';

const eio = () => {
  throw Object.assign(new Error('EIO'), { code: 'EIO' });
};
const roots: string[] = [];
afterEach(() => {
  seam.events = [];
  seam.before = undefined;
  seam.faults.clear();
  seam.swap = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function locksDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-lock-publication-'));
  roots.push(root);
  mkdirSync(join(root, '.devai/state'), { recursive: true });
  return join(root, '.devai/state/locks');
}

const stagedNames = (dir: string) =>
  readdirSync(dir).filter((name) => name.endsWith('.publish-staged'));

describe('fresh lock publication', () => {
  it('makes a new locks directory durable before publishing each lock complete', async () => {
    const dir = locksDir();
    const result = await withAuthorityHostTestScope(() =>
      acquireLocks({ locksDir: dir, taskId: 'TASK-0001', targets: ['F2:MOD-a', 'F3:MOD-a'] }),
    );
    expect(result.denied).toEqual([]);
    const state = join(dir, '..');
    const fsyncedParent = seam.events.indexOf(`open ${state}`);
    const firstPublish = seam.events.indexOf(`publish ${join(dir, 'F2~MOD-a.json')}`);
    expect(fsyncedParent).toBeGreaterThanOrEqual(0);
    expect(fsyncedParent).toBeLessThan(firstPublish);
    for (const key of ['F2~MOD-a.json', 'F3~MOD-a.json']) {
      expect(JSON.parse(readFileSync(join(dir, key), 'utf8'))).toMatchObject({
        task_id: 'TASK-0001',
      });
    }
    expect(stagedNames(dir)).toEqual([]);
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

  it.each([
    ['the staged unlink', { unlinkStaged: eio }],
    ['the directory fsync', { fsyncDirectory: eio }],
  ])(
    'withdraws its own lock and rolls back the others when %s fails after the link',
    async (_, hooks) => {
      const dir = locksDir();
      seam.faults.set(join(dir, 'F3~MOD-a.json'), hooks);
      await expect(
        withAuthorityHostTestScope(() =>
          acquireLocks({ locksDir: dir, taskId: 'TASK-0001', targets: ['F2:MOD-a', 'F3:MOD-a'] }),
        ),
      ).rejects.toMatchObject({ code: 'DURABLE_PUBLICATION_INDETERMINATE' });
      expect(existsSync(join(dir, 'F2~MOD-a.json'))).toBe(false);
      expect(existsSync(join(dir, 'F3~MOD-a.json'))).toBe(false);
      expect(stagedNames(dir)).toEqual([]);
      const retry = await withAuthorityHostTestScope(() =>
        acquireLocks({ locksDir: dir, taskId: 'TASK-0003', targets: ['F2:MOD-a', 'F3:MOD-a'] }),
      );
      expect(retry.denied).toEqual([]);
    },
  );

  it('names the lock it could not withdraw when another writer holds its claim', async () => {
    const dir = locksDir();
    const lock = join(dir, 'F2~MOD-a.json');
    seam.faults.set(lock, { unlinkStaged: eio });
    seam.swap = () => 'claimed';
    await expect(
      withAuthorityHostTestScope(() =>
        acquireLocks({ locksDir: dir, taskId: 'TASK-0001', targets: ['F2:MOD-a'] }),
      ),
    ).rejects.toMatchObject({ code: 'TASK_LOCK_WITHDRAWAL_UNCONFIRMED', lock });
    // The unconfirmed record stays where it is, complete, for a person to inspect.
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ task_id: 'TASK-0001' });
  });
});
