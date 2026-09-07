import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertProtectedReleaseRepositoryRoot,
  createProtectedReleaseRepositoryContext,
  readProtectedReleaseRepositoryIdentity,
  withProtectedReleaseRepositoryContext,
} from '../../src/boundaries/host-effects.js';
import { createReleaseRepositoryTestFixture } from './release-repository-test-fixture.js';

// Repository pin, authority-root and context-lifetime contracts written against the retained
// authority mutation diagnostic (candidate 3dfdc316, report 414957d9); mutant ids are the
// report's. Every case observes the exported host boundary against a real Git checkout.

const CODE = 'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID';
const GIT = '/usr/bin/git';
const REPOSITORY_ID = 'fixture/repository';
const ORIGIN = `https://github.com/${REPOSITORY_ID}.git`;

const fixtures: ReturnType<typeof createReleaseRepositoryTestFixture>[] = [];
const removals: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
  for (const path of removals.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(root: string, args: readonly string[]): string {
  return execFileSync(GIT, ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function temporaryDirectory(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  removals.push(path);
  return path;
}

function sharedFixture() {
  const fixture = createReleaseRepositoryTestFixture();
  fixtures.push(fixture);
  return fixture;
}

/**
 * A checkout whose Git directory lives outside it, so that directory can be relocated with
 * its device and inode intact while the worktree keeps its own `.git` gitfile inode.
 */
function separatedRepositoryFixture() {
  const root = temporaryDirectory('release probe worktree ç ');
  const store = temporaryDirectory('release probe store ç ');
  const directory = join(store, 'repository.git');
  execFileSync(GIT, ['init', '-q', `--separate-git-dir=${directory}`, root], { encoding: 'utf8' });
  git(root, ['config', 'user.name', 'DEVAI Release Probe']);
  git(root, ['config', 'user.email', 'release-probe@example.invalid']);
  git(root, ['remote', 'add', 'origin', ORIGIN]);
  writeFileSync(join(root, 'README.md'), 'separated git directory fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'initial']);
  const repository = Object.freeze({
    id: REPOSITORY_ID,
    commit: git(root, ['rev-parse', 'HEAD']),
    tree: git(root, ['rev-parse', 'HEAD^{tree}']),
  });
  const context = createProtectedReleaseRepositoryContext({
    repository_root: root,
    authority_repository_id: 'fixture-repository',
    read_expected_release_repository_id: () => REPOSITORY_ID,
    repository,
  });
  return { root, store, directory, repository, context };
}

describe('protected repository pin comparison', () => {
  // Mutant 332: a pin is its path together with its device and inode. The Git directory is
  // relocated with the same inode, so the root, the origin, HEAD, the tree, the pin count and
  // every pinned inode are unchanged and only the pinned paths drift.
  it('refuses a relocated Git directory whose device and inode are unchanged', async () => {
    const value = separatedRepositoryFixture();
    await withProtectedReleaseRepositoryContext(value.context, async () => {
      expect(readProtectedReleaseRepositoryIdentity().repository).toEqual(value.repository);

      const link = join(value.root, '.git');
      const linkBefore = statSync(link, { bigint: true });
      const directoryBefore = statSync(value.directory, { bigint: true });
      const configBefore = statSync(join(value.directory, 'config'), { bigint: true });
      const relocated = join(value.store, 'relocated.git');
      renameSync(value.directory, relocated);
      // In place, so the gitfile keeps the inode pinned at capture.
      writeFileSync(link, `gitdir: ${relocated}\n`);

      expect(statSync(link, { bigint: true }).ino).toBe(linkBefore.ino);
      expect(statSync(relocated, { bigint: true }).ino).toBe(directoryBefore.ino);
      expect(statSync(relocated, { bigint: true }).dev).toBe(directoryBefore.dev);
      expect(statSync(link, { bigint: true }).dev).toBe(linkBefore.dev);
      expect(statSync(join(relocated, 'config'), { bigint: true }).dev).toBe(configBefore.dev);
      expect(statSync(join(relocated, 'config'), { bigint: true }).ino).toBe(configBefore.ino);
      expect(git(value.root, ['rev-parse', '--show-toplevel'])).toBe(value.root);
      expect(git(value.root, ['rev-parse', '--absolute-git-dir'])).toBe(relocated);
      expect(git(value.root, ['config', '--local', '--get', 'remote.origin.url'])).toBe(ORIGIN);
      expect(git(value.root, ['rev-parse', 'HEAD'])).toBe(value.repository.commit);
      expect(git(value.root, ['rev-parse', 'HEAD^{tree}'])).toBe(value.repository.tree);

      expect(() => readProtectedReleaseRepositoryIdentity()).toThrow(CODE);
    });
  });
});

describe('protected authority root assertion', () => {
  // Mutants 337, 338, 339, 346, 348: the live checkout root is admitted, by its own path and
  // through a symlink that resolves to it.
  it('admits the live root directly and through a symlink', async () => {
    const fixture = sharedFixture();
    const aliases = temporaryDirectory('release probe alias ç ');
    const alias = join(aliases, 'checkout');
    symlinkSync(fixture.root, alias);
    await fixture.run(() => {
      expect(assertProtectedReleaseRepositoryRoot(fixture.root)).toBeUndefined();
      expect(assertProtectedReleaseRepositoryRoot(alias)).toBeUndefined();
    });
  });

  // Mutants 340, 346: a relative path is refused before any resolution.
  it('refuses a relative root', async () => {
    const fixture = sharedFixture();
    const relativeRoot = relative(process.cwd(), fixture.root);
    expect(isAbsolute(relativeRoot)).toBe(false);
    await fixture.run(() => {
      expect(() => assertProtectedReleaseRepositoryRoot(relativeRoot)).toThrow(CODE);
    });
  });

  // Mutants 340, 347, 348: another checkout, and a directory inside the live one, are not the
  // live root.
  it('refuses a foreign root and a directory below the live root', async () => {
    const fixture = sharedFixture();
    const foreign = temporaryDirectory('release probe foreign ç ');
    const nested = join(fixture.root, 'nested');
    mkdirSync(nested);
    await fixture.run(() => {
      expect(() => assertProtectedReleaseRepositoryRoot(foreign)).toThrow(CODE);
      expect(() => assertProtectedReleaseRepositoryRoot(nested)).toThrow(CODE);
    });
  });

  // Mutant 349: a path that cannot be resolved at all raises from `realpathSync`, and the
  // catch reports it as the same refusal rather than returning.
  it('refuses an absent absolute root through the failure path', async () => {
    const fixture = sharedFixture();
    const absent = join(fixture.root, 'absent-directory');
    await fixture.run(() => {
      expect(() => realpathSync(absent)).toThrow();
      expect(() => assertProtectedReleaseRepositoryRoot(absent)).toThrow(CODE);
    });
  });

  // Mutants 337, 338, 340: possession of the path grants nothing outside an invocation.
  it('refuses the live root outside any repository context', async () => {
    const fixture = sharedFixture();
    await fixture.run(() => {
      expect(assertProtectedReleaseRepositoryRoot(fixture.root)).toBeUndefined();
    });
    expect(() => assertProtectedReleaseRepositoryRoot(fixture.root)).toThrow(CODE);
  });
});

describe('protected repository context lifetime', () => {
  // Mutants 362, 363: the context is retired in the `finally`, so a continuation that still
  // carries the invocation's async context is refused once the invocation has returned. The
  // ungated continuation is registered at the same place and differs only in when it runs,
  // which is what makes the retirement — rather than an absent context — the observed cause.
  it('retires the context for a continuation that outlives the invocation', async () => {
    const fixture = sharedFixture();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let staleIdentity: Promise<unknown> | undefined;
    let staleRoot: Promise<unknown> | undefined;

    await fixture.run(async () => {
      staleIdentity = gate.then(() => readProtectedReleaseRepositoryIdentity());
      staleRoot = gate.then(() => assertProtectedReleaseRepositoryRoot(fixture.root));
      await expect(
        Promise.resolve().then(() => readProtectedReleaseRepositoryIdentity().repository),
      ).resolves.toEqual(fixture.repository);
    });

    if (staleIdentity === undefined || staleRoot === undefined)
      throw new Error('fixture continuations missing');
    const refusals = Promise.all([
      expect(staleIdentity).rejects.toThrow(CODE),
      expect(staleRoot).rejects.toThrow(CODE),
    ]);
    open();
    await refusals;
  });
});
