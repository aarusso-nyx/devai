// #317: recipe adapter installation under the production authority broker. The cleanup of an
// escaped publication, and identity-bound rollback, must be admitted by the real broker, not
// only by the permissive unit-test scope.
import { removeEntryIfIdentitySync, runWithAuthorityHostEffects } from '@devai-nyx/authority';
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
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  executeRecipeAdapterPlan,
  preflightRecipeAdapterInstall,
  type RecipeAdapterPlan,
} from '../../../skills/src/recipes/adapters.js';
import { createAuthorityHostBroker } from '../../src/authority/broker.js';
import { getFullRegistry, type RegistryEntry } from '../../src/define-command.js';
import { resolveCliVersion } from '../../src/version.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const originalArgv = [...process.argv];
const originalStdout = process.stdout.write;
let entries: readonly RegistryEntry[];

beforeAll(async () => {
  process.argv = [process.execPath, 'devai', '--help'];
  process.stdout.write = (() => true) as typeof process.stdout.write;
  await import('../../src/bin.js');
  entries = getFullRegistry();
  process.stdout.write = originalStdout;
  process.argv = [...originalArgv];
});

afterAll(() => {
  process.stdout.write = originalStdout;
  process.argv = [...originalArgv];
});

const plan: RecipeAdapterPlan = {
  files: [
    { host: 'codex', path: '.agents/skills/devai-assess/SKILL.md', content: 'assess\n' },
    { host: 'codex', path: '.agents/skills/devai-assess/devai.recipe.json', content: '{}\n' },
    { host: 'claude', path: '.claude/skills/devai-assess/SKILL.md', content: 'assess\n' },
    { host: 'claude', path: '.claude/skills/devai-assess/devai.recipe.json', content: '{}\n' },
  ],
};

let fixture: string;
let repo: string;
let outside: string;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'devai-recipe-broker-'));
  repo = join(fixture, 'repository');
  outside = join(fixture, 'outside');
  mkdirSync(join(repo, '.devai/state'), { recursive: true });
  mkdirSync(join(repo, '.devai/pin'), { recursive: true });
  writeFileSync(
    join(repo, '.devai/pin/constitution.md'),
    readFileSync(join(ROOT, 'law/constitution.md')),
  );
  mkdirSync(outside);
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

/**
 * Runs `callback` with every host effect brokered for `init apply harness --include skills`.
 * `beforeApply` runs after the broker has authorized an effect and before the effect runs,
 * the window in which a path-based authorization cannot see a swapped parent.
 */
function underProductionBroker<T>(
  callback: () => T,
  beforeApply?: (request: {
    readonly symbol: string;
    readonly arguments: readonly unknown[];
  }) => void,
): T {
  const entry = entries.find((candidate) => candidate.name === 'init apply harness');
  if (entry === undefined) throw new Error('missing action init apply harness');
  const host = createAuthorityHostBroker({
    entry,
    entries,
    argv: [
      process.execPath,
      'devai',
      'init',
      'apply',
      'harness',
      '--include',
      'skills',
      '--as-role',
      'architect',
      '--write',
    ],
    role: 'architect',
    declaration: { as_role: 'architect' },
    repository_root: repo,
    package_version: resolveCliVersion(),
    bootstrap_policy: true,
  });
  const scope =
    beforeApply === undefined
      ? host.scope
      : {
          ...host.scope,
          apply_effect: (
            request: Parameters<typeof host.scope.apply_effect>[0],
            apply: () => unknown,
          ) =>
            host.scope.apply_effect(request, () => {
              beforeApply(request);
              return apply();
            }),
        };
  try {
    return runWithAuthorityHostEffects(scope, callback);
  } finally {
    host.dispose();
  }
}

/** The error `callback` throws, or undefined. */
function caught(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Entries under the repository outside the state root. */
function tree(): readonly string[] {
  return readdirSync(repo, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry !== '.devai' && !entry.startsWith('.devai/'))
    .sort();
}

describe('recipe adapter installation under the production broker (#317)', () => {
  it('installs the plan and releases the lock', () => {
    const resolved = preflightRecipeAdapterInstall(repo, plan);
    const result = underProductionBroker(() => executeRecipeAdapterPlan(resolved));

    expect(result.written).toEqual(plan.files.map((file) => file.path));
    expect(readdirSync(join(repo, '.devai/state'))).toEqual([]);
  });

  it('refuses a publication whose parent was swapped before the broker authorized it', () => {
    const resolved = preflightRecipeAdapterInstall(repo, plan);
    const moved = join(fixture, 'moved-devai-assess');

    const failure = caught(() =>
      underProductionBroker(() =>
        executeRecipeAdapterPlan(resolved, {
          beforePublish: (file, index) => {
            if (index !== 3) return;
            renameSync(dirname(file.absolutePath), moved);
            symlinkSync(outside, dirname(file.absolutePath));
          },
        }),
      ),
    );
    // The publication is refused, and so is the rollback of the earlier file now behind the
    // link: the broker never authorizes a removal outside the repository, so it is residue.
    expect(failure).toMatchObject({ code: 'RECIPE_INSTALL_ROLLBACK_INCOMPLETE' });
    const errors = (failure as AggregateError).errors as Error[];
    expect(errors[0]?.message).toContain('AUTHORITY_FS_SYMLINK_ESCAPE');
    expect(errors.slice(1).map((error) => error.message)).toEqual([
      expect.stringContaining('AUTHORITY_FS_SYMLINK_ESCAPE'),
    ]);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(repo, '.agents'))).toBe(false);
    expect(readdirSync(join(repo, '.devai/state'))).toEqual([]);
  });

  it('detects an escaped publication and reports it without deleting anything outside the repository', () => {
    const resolved = preflightRecipeAdapterInstall(repo, plan);
    const moved = join(fixture, 'moved-devai-assess');
    const last = plan.files[3]?.path ?? '';
    let swapped = false;

    const failure = caught(() =>
      underProductionBroker(
        () => executeRecipeAdapterPlan(resolved),
        (request) => {
          // After the broker authorized the publication and before its link(2), the parent is
          // replaced by a link leaving the repository: the write lands outside.
          if (
            swapped ||
            request.symbol !== 'publishFileNoReplaceSync' ||
            request.arguments[0] !== join(repo, last)
          )
            return;
          swapped = true;
          renameSync(dirname(join(repo, last)), moved);
          symlinkSync(outside, dirname(join(repo, last)));
        },
      ),
    );
    expect(swapped).toBe(true);
    // The escape is the first error; the earlier file behind the link is rollback residue.
    expect(failure).toMatchObject({ code: 'RECIPE_INSTALL_ROLLBACK_INCOMPLETE' });
    const errors = (failure as AggregateError).errors as Error[];
    expect(errors[0]).toMatchObject({
      code: 'RECIPE_INSTALL_ESCAPE_DETECTED',
      residue: [join(repo, last)],
    });
    expect(errors[0]?.message).toContain(`RECIPE_INSTALL_ESCAPE_DETECTED: ${last}`);
    // The escaped file stays where it landed: nothing outside the repository is deleted.
    expect(readdirSync(outside)).toEqual(['devai.recipe.json']);
    // Every earlier publication inside the repository is rolled back; the moved directory and
    // the link are left.
    expect(existsSync(join(repo, '.agents'))).toBe(false);
    expect(readdirSync(moved)).toEqual(['SKILL.md']);
    expect(lstatSync(join(repo, '.claude/skills/devai-assess')).isSymbolicLink()).toBe(true);
    expect(readdirSync(join(repo, '.devai/state'))).toEqual([]);
  });

  it('rolls back by identity and keeps a replacement directory', () => {
    const resolved = preflightRecipeAdapterInstall(repo, plan);
    const created = join(repo, '.claude/skills/devai-assess');

    expect(() =>
      underProductionBroker(() =>
        executeRecipeAdapterPlan(resolved, {
          beforePublish: (_file, index) => {
            if (index !== 2) return;
            rmSync(created, { recursive: true });
            mkdirSync(created);
            throw new Error('INJECTED_PUBLICATION_FAILURE');
          },
        }),
      ),
    ).toThrow('INJECTED_PUBLICATION_FAILURE');
    expect(tree()).toEqual(['.claude', '.claude/skills', '.claude/skills/devai-assess']);
  });

  it('refuses an unpublished removal whose parent was swapped after authorization, and puts the outside entry back', () => {
    const skills = join(repo, '.claude/skills');
    mkdirSync(skills, { recursive: true });
    const inside = join(skills, 'entry.txt');
    writeFileSync(inside, 'inside\n');
    const stat = lstatSync(inside, { bigint: true });
    const foreign = join(outside, 'entry.txt');
    writeFileSync(foreign, 'outside\n');
    const moved = join(fixture, 'moved-skills');

    expect(() =>
      underProductionBroker(
        () =>
          removeEntryIfIdentitySync(inside, {
            dev: stat.dev,
            ino: stat.ino,
            birthtimeNs: stat.birthtimeNs,
          }),
        (request) => {
          if (request.symbol !== 'removeEntryIfIdentitySync') return;
          // After authorization, the parent is replaced by a link leaving the repository.
          renameSync(skills, moved);
          symlinkSync(outside, skills);
        },
      ),
    ).toThrow('AUTHORITY_REMOVE_PARENT_ESCAPED');
    // The outside entry is another identity: it was quarantined, checked and put back.
    expect(readFileSync(foreign, 'utf8')).toBe('outside\n');
    expect(readdirSync(outside)).toEqual(['entry.txt']);
    expect(readFileSync(join(moved, 'entry.txt'), 'utf8')).toBe('inside\n');
  });

  it('refuses a removal whose authorized parent is missing at effect time', () => {
    const missing = join(repo, '.claude/skills/absent-directory/entry.txt');

    expect(() =>
      underProductionBroker(() =>
        removeEntryIfIdentitySync(missing, { dev: 1n, ino: 2n, birthtimeNs: 3n }),
      ),
    ).toThrow('AUTHORITY_REMOVE_PARENT_ESCAPED');
  });

  it('checks the parent after a removal that failed, keeping the failure as the cause', () => {
    const skills = join(repo, '.claude/skills');
    mkdirSync(skills, { recursive: true });
    const inside = join(skills, 'entry.txt');
    writeFileSync(inside, 'inside\n');
    const stat = lstatSync(inside, { bigint: true });

    const failure = caught(() =>
      underProductionBroker(
        () =>
          removeEntryIfIdentitySync(inside, {
            dev: stat.dev,
            ino: stat.ino,
            birthtimeNs: stat.birthtimeNs,
          }),
        (request) => {
          if (request.symbol !== 'removeEntryIfIdentitySync') return;
          renameSync(skills, join(fixture, 'moved-skills'));
          symlinkSync(outside, skills);
          throw new Error('INJECTED_EFFECT_FAILURE');
        },
      ),
    );
    expect(failure).toMatchObject({
      message: expect.stringContaining('AUTHORITY_REMOVE_PARENT_ESCAPED'),
      cause: expect.objectContaining({ message: 'INJECTED_EFFECT_FAILURE' }),
    });
  });

  it('refuses an identity-bound removal through a link out of the repository for a file it did not publish', () => {
    const foreign = join(outside, 'foreign.txt');
    writeFileSync(foreign, 'outside\n');
    mkdirSync(join(repo, '.claude'));
    symlinkSync(outside, join(repo, '.claude/skills'));
    const stat = lstatSync(foreign, { bigint: true });
    let applied = false;

    expect(() =>
      underProductionBroker(() =>
        removeEntryIfIdentitySync(join(repo, '.claude/skills/foreign.txt'), {
          dev: stat.dev,
          ino: stat.ino,
          birthtimeNs: stat.birthtimeNs,
        }),
      ),
    ).toThrow(/AUTHORITY_FS_SYMLINK_ESCAPE/u);
    applied = readFileSync(foreign, 'utf8') !== 'outside\n';
    expect(applied).toBe(false);
    expect(readdirSync(outside)).toEqual(['foreign.txt']);
  });

  it('classifies a removal of a final link by the link itself, inside the repository', () => {
    mkdirSync(join(repo, '.claude/skills'), { recursive: true });
    const link = join(repo, '.claude/skills/devai-assess');
    symlinkSync(outside, link);
    const stat = lstatSync(link, { bigint: true });

    expect(
      underProductionBroker(() =>
        removeEntryIfIdentitySync(link, {
          dev: stat.dev,
          ino: stat.ino,
          birthtimeNs: stat.birthtimeNs,
        }),
      ),
    ).toBe('removed');
    expect(existsSync(link)).toBe(false);
    expect(lstatSync(outside).isDirectory()).toBe(true);
  });
});
