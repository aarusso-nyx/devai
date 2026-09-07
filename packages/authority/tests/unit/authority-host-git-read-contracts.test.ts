import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  readCheckPolicyGitSync,
  readExactGitTreeSync,
  readGitObjectSync,
} from '../../src/boundaries/host-effects.js';

// Read-only Git seam contracts written against the retained authority mutation diagnostic
// (candidate 3dfdc316, report 414957d9); mutant ids below are the report's. Refusals are
// issued against a root that does not exist, so a guard that admits the argument is
// observed as an execution failure rather than as the argument refusal.

const NOWHERE = '/nonexistent-authority-git-fixture';
let root: string;
let commit: string;
let tree: string;
let newlineCommit: string;
let newlineTree: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'git read ç ')));
  git('init', '-q');
  git('config', 'user.name', 'Git Read Fixture');
  git('config', 'user.email', 'read@example.invalid');
  writeFileSync(join(root, 'file.txt'), 'first\n');
  git('add', '--', 'file.txt');
  git('commit', '-qm', 'first');
  commit = git('rev-parse', 'HEAD');
  tree = git('rev-parse', 'HEAD^{tree}');
  writeFileSync(join(root, 'line\nbreak.txt'), 'split');
  git('add', '--', 'line\nbreak.txt');
  git('commit', '-qm', 'newline path');
  newlineCommit = git('rev-parse', 'HEAD');
  newlineTree = git('rev-parse', 'HEAD^{tree}');
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('first-parent gate object read', () => {
  // Mutants 1522-1529: the revision is a complete lowercase object name, nothing else.
  it.each([
    'HEAD',
    'a'.repeat(39),
    'a'.repeat(65),
    'A'.repeat(40),
    'g'.repeat(40),
    'x' + 'a'.repeat(40),
    'a'.repeat(40) + 'x',
    'a',
  ])('refuses revision %s before any process runs', (revision) => {
    expect(() => readGitObjectSync(NOWHERE, revision, 'file.txt')).toThrow(
      'GIT_OBJECT_REVISION_INVALID',
    );
  });

  it.each([40, 64])('admits a %i-character object name to the read', (length) => {
    expect(() => readGitObjectSync(root, 'a'.repeat(length), 'file.txt')).toThrow(
      'GIT_OBJECT_READ_FAILED',
    );
  });

  // Mutants 1531-1563: every path shape that could name something outside the exact
  // tree is refused on its own.
  it.each(['', '/file.txt', 'a\\b', 'a\0b', 'a//b', './a', 'a/./b', 'a/..', '..', '.', 'a/'])(
    'refuses object path %j before any process runs',
    (path) => {
      expect(() => readGitObjectSync(NOWHERE, 'a'.repeat(40), path)).toThrow(
        'GIT_OBJECT_PATH_INVALID',
      );
    },
  );

  it('reads the exact committed bytes of a nested-looking plain path', () => {
    expect(readGitObjectSync(root, commit, 'file.txt')).toBe('first\n');
  });

  // Mutants 1567, 1568, 1573: a non-zero status is a read failure, never empty content.
  it('reports a missing object as a read failure rather than empty content', () => {
    expect(() => readGitObjectSync(root, commit, 'missing.txt')).toThrow('GIT_OBJECT_READ_FAILED');
    expect(() => readGitObjectSync(NOWHERE, commit, 'file.txt')).toThrow('GIT_OBJECT_READ_FAILED');
  });
});

describe('closed policy Git grammar refuses look-alike commands', () => {
  // Mutants 1658, 1662, 1663: the revision grammar is anchored on both sides and admits
  // exactly the 40- and 64-character object widths beside HEAD.
  it.each(['a'.repeat(41) + '^{commit}', 'a' + '^{commit}', 'a'.repeat(63) + '^{tree}'])(
    'refuses the revision %s',
    (revision) => {
      expect(() => readCheckPolicyGitSync(NOWHERE, ['rev-parse', '--verify', revision])).toThrow(
        'GIT_POLICY_READ_ARGUMENTS_INVALID',
      );
    },
  );

  it('admits a 64-character object revision to the verify read', () => {
    expect(() =>
      readCheckPolicyGitSync(root, ['rev-parse', '--verify', 'a'.repeat(64) + '^{commit}']),
    ).toThrow('GIT_POLICY_READ_FAILED');
  });

  // Mutants 1707, 1722, 1725, 1737, 1764, 1786-1790: each fixed verb and option of the
  // grammar is checked, not only the argument count and the object names around it.
  it.each([
    ['reset', 'a'.repeat(40), 'b'.repeat(40)],
    ['reset', '--verify', 'HEAD^{commit}'],
    ['rev-parse', '--symbolic', 'HEAD^{commit}'],
    ['reset', '-r', '-z', '--full-tree', 'a'.repeat(40)],
    ['ls-tree', '-r', '-z', '--name-only', 'a'.repeat(40)],
    ['reset', '--name-status', '-z', '-M', '--find-renames', 'a'.repeat(40), 'b'.repeat(40)],
    ['diff', '--stat', '-z', '-M', '--find-renames', 'a'.repeat(40), 'b'.repeat(40)],
    ['cat-file', 'blob', 'a'.repeat(40) + ':file.txt', 'extra'],
    ['show', 'blob', 'a'.repeat(40) + ':file.txt'],
    ['cat-file', 'blob', 'a'.repeat(41)],
  ])('refuses %j', (...args) => {
    expect(() => readCheckPolicyGitSync(NOWHERE, args)).toThrow(
      'GIT_POLICY_READ_ARGUMENTS_INVALID',
    );
  });
});

describe('exact Git tree entries', () => {
  // Mutant 1914: an entry whose path continues past a control character is refused as a
  // whole, never truncated into a shorter path.
  it('refuses a committed path containing a newline instead of truncating it', () => {
    expect(() => readExactGitTreeSync(root, newlineCommit, newlineTree, '.')).toThrow(
      'GIT_TREE_ENTRY_UNSUPPORTED',
    );
    expect(readExactGitTreeSync(root, commit, tree, '.').map((entry) => entry.path)).toEqual([
      'file.txt',
    ]);
  });
});
