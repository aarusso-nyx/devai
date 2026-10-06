import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, aroundEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fault seam over the real authority effects: by default every call passes through. A test
// may name one target whose publication links its bytes and then fails as indeterminate,
// and the descriptor and unlink calls are recorded in order.
const seam = vi.hoisted(() => ({
  indeterminateAt: undefined as string | undefined,
  events: [] as (readonly [string, string | number])[],
}));
vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  return {
    ...actual,
    publishFileNoReplaceSync: (path: string, data: string | Uint8Array) => {
      const identity = actual.publishFileNoReplaceSync(path, data);
      if (path === seam.indeterminateAt) {
        throw Object.assign(new Error(actual.PUBLISH_INDETERMINATE), {
          code: actual.PUBLISH_INDETERMINATE,
          identity,
        });
      }
      return identity;
    },
    openRegularFileReadOnlySync: (path: string) => {
      const descriptor = actual.openRegularFileReadOnlySync(path);
      seam.events.push([`open ${path}`, descriptor]);
      return descriptor;
    },
    closeReadOnlySync: (descriptor: number) => {
      seam.events.push(['close', descriptor]);
      actual.closeReadOnlySync(descriptor);
    },
    unlinkSync: (path: string) => {
      seam.events.push(['unlink', path]);
      actual.unlinkSync(path);
    },
  };
});
import {
  executeRecipeAdapterPlan,
  installRecipeAdapters,
  preflightRecipeAdapterInstall,
  type RecipeAdapterPlan,
} from '../../src/recipes/adapters.js';
import { RECIPE_INSTALL_LOCK } from '../../src/recipes/install-lock.js';
import { withAuthorityHostTestScope } from '../unit/authority-host-test-scope.js';

aroundEach((runTest) => withAuthorityHostTestScope(runTest));

// #313: the installer rechecks every target at write time without following links and
// installs the whole plan as one unit (INV-HARNESS-009).

let fixture: string;
let repo: string;
let outside: string;

const plan: RecipeAdapterPlan = {
  files: [
    { host: 'codex', path: '.agents/skills/devai-assess/SKILL.md', content: 'assess\n' },
    { host: 'codex', path: '.agents/skills/devai-assess/devai.recipe.json', content: '{}\n' },
    { host: 'claude', path: '.claude/skills/devai-assess/SKILL.md', content: 'assess\n' },
    { host: 'claude', path: '.claude/skills/devai-assess/devai.recipe.json', content: '{}\n' },
  ],
};

function target(index: number): string {
  const file = plan.files[index];
  if (file === undefined) throw new Error(`no planned file ${String(index)}`);
  return join(repo, file.path);
}

/**
 * Every entry under the repository outside the state root, so a test sees stray staged names
 * and directories; it also asserts the install lock was released.
 */
function tree(root: string): readonly string[] {
  expect(readdirSync(join(root, '.devai/state'))).toEqual([]);
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry !== '.devai' && !entry.startsWith('.devai/'))
    .sort();
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'devai-recipe-write-time-'));
  repo = join(fixture, 'repository');
  outside = join(fixture, 'outside');
  mkdirSync(join(repo, '.devai/state'), { recursive: true });
  mkdirSync(outside);
  seam.indeterminateAt = undefined;
  seam.events.length = 0;
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

describe('write-time recheck against the preflight observation', () => {
  it('refuses a target that appears between preflight and write, before any write', () => {
    const resolved = preflightRecipeAdapterInstall(repo, plan);
    mkdirSync(dirname(target(2)), { recursive: true });
    writeFileSync(target(2), 'local edit\n');

    expect(() => executeRecipeAdapterPlan(resolved)).toThrow(
      'RECIPE_ADAPTER_DRIFT: .claude/skills/devai-assess/SKILL.md',
    );
    expect(readFileSync(target(2), 'utf8')).toBe('local edit\n');
    expect(existsSync(join(repo, '.agents'))).toBe(false);
    expect(tree(repo)).toEqual([
      '.claude',
      '.claude/skills',
      '.claude/skills/devai-assess',
      '.claude/skills/devai-assess/SKILL.md',
    ]);
  });

  it('refuses an unchanged target whose bytes changed after preflight and keeps them', () => {
    mkdirSync(dirname(target(0)), { recursive: true });
    writeFileSync(target(0), 'assess\n');
    const resolved = preflightRecipeAdapterInstall(repo, plan);
    writeFileSync(target(0), 'edited after preflight\n');

    expect(() => executeRecipeAdapterPlan(resolved)).toThrow(
      'RECIPE_ADAPTER_DRIFT: .agents/skills/devai-assess/SKILL.md',
    );
    expect(readFileSync(target(0), 'utf8')).toBe('edited after preflight\n');
    expect(existsSync(target(1))).toBe(false);
    expect(existsSync(join(repo, '.claude'))).toBe(false);
  });

  it('refuses an unchanged target removed after preflight', () => {
    mkdirSync(dirname(target(0)), { recursive: true });
    writeFileSync(target(0), 'assess\n');
    const resolved = preflightRecipeAdapterInstall(repo, plan);
    rmSync(target(0));

    expect(() => executeRecipeAdapterPlan(resolved)).toThrow(
      'RECIPE_ADAPTER_DRIFT: .agents/skills/devai-assess/SKILL.md',
    );
    expect(existsSync(join(repo, '.claude'))).toBe(false);
  });

  it('refuses a link inserted at a file target after preflight and never writes through it', () => {
    const resolved = preflightRecipeAdapterInstall(repo, plan);
    const outsideFile = join(outside, 'SKILL.md');
    writeFileSync(outsideFile, 'outside\n');
    mkdirSync(dirname(target(3)), { recursive: true });
    symlinkSync(outsideFile, target(3));

    expect(() => executeRecipeAdapterPlan(resolved)).toThrow(
      'RECIPE_INSTALL_SYMLINK_REFUSED: .claude/skills/devai-assess/devai.recipe.json',
    );
    expect(readFileSync(outsideFile, 'utf8')).toBe('outside\n');
    expect(existsSync(join(repo, '.agents'))).toBe(false);
  });

  it('refuses a dangling link inserted at a file target after preflight', () => {
    const resolved = preflightRecipeAdapterInstall(repo, plan);
    mkdirSync(dirname(target(0)), { recursive: true });
    symlinkSync(join(outside, 'absent'), target(0));

    expect(() => executeRecipeAdapterPlan(resolved)).toThrow(/RECIPE_INSTALL_SYMLINK_REFUSED/u);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses a link inserted in a target ancestry after preflight', () => {
    const resolved = preflightRecipeAdapterInstall(repo, plan);
    symlinkSync(outside, join(repo, '.claude'));

    expect(() => executeRecipeAdapterPlan(resolved)).toThrow(
      'RECIPE_INSTALL_SYMLINK_REFUSED: .claude/skills/devai-assess/SKILL.md',
    );
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(repo, '.agents'))).toBe(false);
  });
});

describe('atomic installation across targets', () => {
  it('installs every absent target and leaves no staged name', () => {
    const result = executeRecipeAdapterPlan(preflightRecipeAdapterInstall(repo, plan));

    expect(result).toEqual({ written: plan.files.map((file) => file.path), unchanged: [] });
    for (const [index, file] of plan.files.entries()) {
      expect(readFileSync(target(index), 'utf8')).toBe(file.content);
    }
    expect(tree(repo).filter((entry) => entry.includes('publish-staged'))).toEqual([]);
  });

  it('leaves the prior set when a publication fails mid-install', () => {
    mkdirSync(dirname(target(0)), { recursive: true });
    writeFileSync(target(0), 'assess\n');
    const before = tree(repo);
    const resolved = preflightRecipeAdapterInstall(repo, plan);

    expect(() =>
      executeRecipeAdapterPlan(resolved, {
        beforePublish: (_file, index) => {
          if (index === 3) throw new Error('INJECTED_PUBLICATION_FAILURE');
        },
      }),
    ).toThrow('INJECTED_PUBLICATION_FAILURE');
    // Targets 1 and 2 were published and then removed; directories this call created are gone.
    expect(tree(repo)).toEqual(before);
    expect(readFileSync(target(0), 'utf8')).toBe('assess\n');
  });

  it('rolls back when a link is inserted in an ancestry during the install', () => {
    const resolved = preflightRecipeAdapterInstall(repo, plan);

    expect(() =>
      executeRecipeAdapterPlan(resolved, {
        beforePublish: (_file, index) => {
          if (index === 1) {
            mkdirSync(join(repo, '.claude'));
            symlinkSync(outside, join(repo, '.claude/skills'));
          }
        },
      }),
    ).toThrow('RECIPE_INSTALL_SYMLINK_REFUSED: .claude/skills/devai-assess/SKILL.md');
    expect(readdirSync(outside)).toEqual([]);
    // The inserted entries are not this call's to remove; everything it created is gone.
    expect(tree(repo)).toEqual(['.claude', '.claude/skills']);
  });

  it('never replaces an entry that appears after the recheck and rolls back', () => {
    const resolved = preflightRecipeAdapterInstall(repo, plan);

    expect(() =>
      executeRecipeAdapterPlan(resolved, {
        beforePublish: (file, index) => {
          if (index === 2) writeFileSync(file.absolutePath, 'raced writer\n');
        },
      }),
    ).toThrow('RECIPE_ADAPTER_DRIFT: .claude/skills/devai-assess/SKILL.md');
    expect(readFileSync(target(2), 'utf8')).toBe('raced writer\n');
    expect(existsSync(join(repo, '.agents'))).toBe(false);
    expect(tree(repo)).toEqual([
      '.claude',
      '.claude/skills',
      '.claude/skills/devai-assess',
      '.claude/skills/devai-assess/SKILL.md',
    ]);
  });

  it('detects a parent swapped for a link before the publication, unlinks the escaped file and rolls back', () => {
    const resolved = preflightRecipeAdapterInstall(repo, plan);
    const moved = join(fixture, 'moved-devai-assess');

    expect(() =>
      executeRecipeAdapterPlan(resolved, {
        beforePublish: (file, index) => {
          if (index !== 3) return;
          // After the recheck, the target's parent is replaced by a link leaving the repository.
          renameSync(dirname(file.absolutePath), moved);
          symlinkSync(outside, dirname(file.absolutePath));
        },
      }),
    ).toThrow('RECIPE_INSTALL_ESCAPE_DETECTED: .claude/skills/devai-assess/devai.recipe.json');
    // The file written through the link is removed, and no staged name is left outside.
    expect(readdirSync(outside)).toEqual([]);
    // The earlier publications are rolled back; the moved directory and the link are not ours.
    expect(readdirSync(moved)).toEqual(['SKILL.md']);
    expect(readFileSync(join(moved, 'SKILL.md'), 'utf8')).toBe('assess\n');
    expect(tree(repo)).toEqual(['.claude', '.claude/skills', '.claude/skills/devai-assess']);
    expect(lstatSync(join(repo, '.claude/skills/devai-assess')).isSymbolicLink()).toBe(true);
  });

  it('rolls back only the identity it published, never a file later placed at the path', () => {
    const resolved = preflightRecipeAdapterInstall(repo, plan);

    expect(() =>
      executeRecipeAdapterPlan(resolved, {
        beforePublish: (_file, index) => {
          if (index !== 2) return;
          // Another writer replaces a published target with its own file of the same bytes.
          rmSync(target(0));
          writeFileSync(target(0), 'assess\n');
          throw new Error('INJECTED_PUBLICATION_FAILURE');
        },
      }),
    ).toThrow('INJECTED_PUBLICATION_FAILURE');
    expect(readFileSync(target(0), 'utf8')).toBe('assess\n');
    // The non-recursive rollback keeps the directories that still hold the foreign file.
    expect(tree(repo)).toEqual([
      '.agents',
      '.agents/skills',
      '.agents/skills/devai-assess',
      '.agents/skills/devai-assess/SKILL.md',
    ]);
  });

  it('pins an indeterminate publication through the rollback that removes it', () => {
    const resolved = preflightRecipeAdapterInstall(repo, plan);
    seam.indeterminateAt = target(2);

    expect(() => executeRecipeAdapterPlan(resolved)).toThrow(
      expect.objectContaining({ code: 'AUTHORITY_PUBLISH_CLEANUP_INCOMPLETE' }),
    );
    // Every publication, the indeterminate one included, is rolled back.
    expect(tree(repo)).toEqual([]);
    const opened = seam.events.findIndex(([event]) => event === `open ${target(2)}`);
    const pin = seam.events[opened]?.[1];
    const unlinked = seam.events.findIndex(
      ([event, path]) => event === 'unlink' && path === target(2),
    );
    const closed = seam.events.findIndex(
      ([event, descriptor], index) => index > opened && event === 'close' && descriptor === pin,
    );
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(unlinked).toBeGreaterThan(opened);
    expect(closed).toBeGreaterThan(unlinked);
  });

  it('refuses a FIFO swapped in at a target after preflight without blocking on it', () => {
    mkdirSync(dirname(target(0)), { recursive: true });
    writeFileSync(target(0), 'assess\n');
    const resolved = preflightRecipeAdapterInstall(repo, plan);
    rmSync(target(0));
    execFileSync('mkfifo', [target(0)]);

    expect(() => executeRecipeAdapterPlan(resolved)).toThrow(
      'RECIPE_ADAPTER_DRIFT: .agents/skills/devai-assess/SKILL.md',
    );
    expect(lstatSync(target(0)).isFIFO()).toBe(true);
    expect(existsSync(join(repo, '.claude'))).toBe(false);
  });

  it('keeps the canonical installation idempotent', () => {
    const first = installRecipeAdapters({ repoRoot: repo });
    const second = installRecipeAdapters({ repoRoot: repo });

    expect(first.written.length).toBeGreaterThan(0);
    expect(second.written).toEqual([]);
    expect(second.unchanged).toEqual(first.written);
  });
});

describe('the repository recipe-install lock', () => {
  const lockPath = () => join(repo, RECIPE_INSTALL_LOCK);
  const holder = (pid: number, acquiredAt: string) =>
    `${JSON.stringify({ schemaVersion: '1.0.0', action_id: 'recipe adapter install', token: 'other', pid, host: hostname(), acquired_at: acquiredAt })}\n`;

  it('refuses while a live installer holds it, writing nothing and keeping the lock', () => {
    const resolved = preflightRecipeAdapterInstall(repo, plan);
    const record = holder(process.pid, new Date().toISOString());
    writeFileSync(lockPath(), record);

    expect(() => executeRecipeAdapterPlan(resolved)).toThrow(/^RECIPE_INSTALL_LOCKED: /u);
    expect(readFileSync(lockPath(), 'utf8')).toBe(record);
    expect(existsSync(join(repo, '.agents'))).toBe(false);
    expect(existsSync(join(repo, '.claude'))).toBe(false);
  });

  it('refuses a stale lock with the manual removal step and never takes it over', () => {
    const resolved = preflightRecipeAdapterInstall(repo, plan);
    const record = holder(999_999, new Date().toISOString());
    writeFileSync(lockPath(), record);

    let failure: unknown;
    try {
      executeRecipeAdapterPlan(resolved);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'RECIPE_INSTALL_LOCK_STALE',
      removal: `rm "${lockPath()}"`,
    });
    expect(readFileSync(lockPath(), 'utf8')).toBe(record);
    expect(existsSync(join(repo, '.agents'))).toBe(false);
  });

  it('holds the lock across every publication and releases it after a failure', () => {
    const resolved = preflightRecipeAdapterInstall(repo, plan);
    const seen: boolean[] = [];

    expect(() =>
      executeRecipeAdapterPlan(resolved, {
        beforePublish: (_file, index) => {
          seen.push(lstatSync(lockPath()).isFile());
          if (index === 2) throw new Error('INJECTED_PUBLICATION_FAILURE');
        },
      }),
    ).toThrow('INJECTED_PUBLICATION_FAILURE');
    expect(seen).toEqual([true, true, true]);
    expect(existsSync(lockPath())).toBe(false);
  });

  it.each([
    ['a FIFO', (path: string) => execFileSync('mkfifo', [path])],
    ['a directory', (path: string) => mkdirSync(path)],
  ])('refuses %s at the lock path without blocking, reading or removing it', (_, make) => {
    const resolved = preflightRecipeAdapterInstall(repo, plan);
    make(lockPath());

    expect(() => executeRecipeAdapterPlan(resolved)).toThrow(/^RECIPE_INSTALL_LOCK_INVALID: /u);
    expect(lstatSync(lockPath()).isFile()).toBe(false);
    expect(existsSync(join(repo, '.agents'))).toBe(false);
    expect(seam.events.filter(([event]) => event === `open ${lockPath()}`)).toEqual([]);
  });

  it('refuses without a state root rather than creating one', () => {
    rmSync(join(repo, '.devai'), { recursive: true });
    const resolved = preflightRecipeAdapterInstall(repo, plan);

    expect(() => executeRecipeAdapterPlan(resolved)).toThrow(
      'RECIPE_INSTALL_STATE_ROOT_MISSING: .devai',
    );
    expect(readdirSync(repo)).toEqual([]);
  });
});
