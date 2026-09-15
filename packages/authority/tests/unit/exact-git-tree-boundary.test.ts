import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readExactGitTreeSync } from '../../src/boundaries/host-effects.js';

let root: string;
let commit: string;
let tree: string;
let tagObject: string;
let gitlinkCommit: string;
let gitlinkTree: string;
let controlCommit: string;
let controlTree: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'exact tree ç ')));
  git('init', '-q');
  git('config', 'user.name', 'Exact Tree Fixture');
  git('config', 'user.email', 'tree@example.invalid');
  writeFileSync(join(root, 'a.txt'), Buffer.from([0, 255, 13, 10]));
  writeFileSync(join(root, 'B.txt'), 'second');
  git('add', '--', 'a.txt', 'B.txt');
  git('commit', '-qm', 'base');
  commit = git('rev-parse', 'HEAD');
  tree = git('rev-parse', 'HEAD^{tree}');
  git('tag', '-a', 'fixture', '-m', 'annotated');
  tagObject = git('rev-parse', 'refs/tags/fixture');
  git('update-index', '--add', '--cacheinfo', '160000,' + commit + ',submodule');
  git('commit', '-qm', 'gitlink');
  gitlinkCommit = git('rev-parse', 'HEAD');
  gitlinkTree = git('rev-parse', 'HEAD^{tree}');
  git('update-index', '--force-remove', 'submodule');
  writeFileSync(join(root, 'tab\tfile'), 'control');
  git('add', '--', 'tab\tfile');
  git('commit', '-qm', 'control filename');
  controlCommit = git('rev-parse', 'HEAD');
  controlTree = git('rev-parse', 'HEAD^{tree}');
  writeFileSync(join(root, 'a.txt'), 'dirty bytes must remain');
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('exact immutable Git tree boundary', () => {
  it('reads root projection in declared order with exact binary blobs while preserving index and dirty bytes', () => {
    const index = readFileSync(join(root, '.git/index'));
    const entries = readExactGitTreeSync(root, commit, tree, '.');
    expect(entries.map(({ path }) => path)).toEqual(['a.txt', 'B.txt']);
    expect(entries.map(({ mode }) => mode)).toEqual(['100644', '100644']);
    const first = entries[0];
    if (!first) throw new Error('missing first fixture entry');
    expect(first.object_id).toBe(git('rev-parse', commit + ':a.txt'));
    expect(first.bytes).toEqual(Buffer.from([0, 255, 13, 10]));
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('dirty bytes must remain');
    expect(readFileSync(join(root, '.git/index'))).toEqual(index);
  });

  it.each(['HEAD', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), '--help'])(
    'rejects malformed commit and tree identity %s independently',
    (identity) => {
      expect(() => readExactGitTreeSync(root, identity, tree, '.')).toThrow(
        'GIT_TREE_IDENTITY_INVALID',
      );
      expect(() => readExactGitTreeSync(root, commit, identity, '.')).toThrow(
        'GIT_TREE_IDENTITY_INVALID',
      );
    },
  );

  it.each(['', '/a.txt', '../a.txt', 'a//b', 'a/./b', 'a\\b', 'tab\tfile', 'a\u007fb'])(
    'refuses unsafe prefix %j',
    (prefix) => {
      expect(() => readExactGitTreeSync(root, commit, tree, prefix)).toThrow(
        'GIT_OBJECT_PATH_INVALID',
      );
    },
  );

  it('refuses a valid annotated-tag object ID even when it peels to the expected candidate', () => {
    expect(tagObject).not.toBe(commit);
    expect(git('rev-parse', tagObject + '^{commit}')).toBe(commit);
    expect(() => readExactGitTreeSync(root, tagObject, tree, '.')).toThrow(
      'GIT_COMMIT_IDENTITY_MISMATCH',
    );
  });

  it('rejects unsupported gitlinks instead of omitting them from the projection', () => {
    expect(() => readExactGitTreeSync(root, gitlinkCommit, gitlinkTree, '.')).toThrow(
      'GIT_TREE_ENTRY_UNSUPPORTED',
    );
  });

  it('rejects a control character in a committed path', () => {
    expect(() => readExactGitTreeSync(root, controlCommit, controlTree, '.')).toThrow(
      'GIT_OBJECT_PATH_INVALID',
    );
  });

  it('rejects a missing projection and unavailable objects distinctly', () => {
    expect(() => readExactGitTreeSync(root, commit, tree, 'missing')).toThrow(
      'GIT_TREE_PROJECTION_EMPTY',
    );
    expect(() => readExactGitTreeSync(root, '0'.repeat(40), tree, '.')).toThrow(
      'GIT_TREE_READ_FAILED',
    );
  });
});
