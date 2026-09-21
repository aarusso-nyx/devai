import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readCheckPolicyGitSync } from '../../src/boundaries/host-effects.js';

let root: string;
let first: string;
let second: string;
let tree: string;
let blob: string;
const git = (args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'policy git ç ')));
  git(['init', '-q']);
  git(['config', 'user.name', 'Policy Read Fixture']);
  git(['config', 'user.email', 'policy@example.invalid']);
  writeFileSync(join(root, 'file ç.txt'), 'first\n');
  git(['add', 'file ç.txt']);
  git(['commit', '-qm', 'first']);
  first = git(['rev-parse', 'HEAD']);
  blob = git(['rev-parse', 'HEAD:file ç.txt']);
  writeFileSync(join(root, 'file ç.txt'), 'second\n');
  git(['add', 'file ç.txt']);
  git(['commit', '-qm', 'second']);
  second = git(['rev-parse', 'HEAD']);
  tree = git(['rev-parse', 'HEAD^{tree}']);
  writeFileSync(join(root, 'untracked.txt'), 'keep\n');
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('closed policy reconstruction Git grammar', () => {
  it('reads ancestry, exact objects, tracked and untracked populations without index changes', () => {
    const index = readFileSync(join(root, '.git/index'));
    expect(readCheckPolicyGitSync(root, ['merge-base', first, second]).toString().trim()).toBe(
      first,
    );
    for (const revision of ['HEAD', second]) {
      expect(
        readCheckPolicyGitSync(root, ['rev-parse', '--verify', revision + '^{commit}'])
          .toString()
          .trim(),
      ).toBe(second);
      expect(
        readCheckPolicyGitSync(root, ['rev-parse', '--verify', revision + '^{tree}'])
          .toString()
          .trim(),
      ).toBe(tree);
    }
    expect(
      readCheckPolicyGitSync(root, ['ls-tree', '-r', '-z', '--full-tree', first]).toString(),
    ).toBe(`100644 blob ${blob}\tfile ç.txt\0`);
    expect(readCheckPolicyGitSync(root, ['ls-files', '-s', '-z']).toString()).toContain(
      ' 0\tfile ç.txt\0',
    );
    expect(
      readCheckPolicyGitSync(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
        .toString()
        .split('\0')
        .filter(Boolean)
        .sort(),
    ).toEqual(['file ç.txt', 'untracked.txt']);
    expect(
      readCheckPolicyGitSync(root, ['ls-files', '-z', '--others', '--exclude-standard']).toString(),
    ).toBe('untracked.txt\0');
    expect(
      readCheckPolicyGitSync(root, [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ]).toString(),
    ).toBe('?? untracked.txt\n');
    expect(
      readCheckPolicyGitSync(root, [
        'diff',
        '--name-status',
        '-z',
        '-M',
        '--find-renames',
        first,
        second,
      ]).toString(),
    ).toBe('M\0file ç.txt\0');
    expect(
      readCheckPolicyGitSync(root, [
        'diff',
        '--name-status',
        '-z',
        '-M',
        '--find-renames',
        first,
        '--',
      ]).toString(),
    ).toBe('M\0file ç.txt\0');
    expect(
      readCheckPolicyGitSync(root, ['cat-file', 'blob', first + ':file ç.txt']).toString(),
    ).toBe('first\n');
    expect(
      readCheckPolicyGitSync(root, ['cat-file', '--batch'], Buffer.from(blob + '\n')).toString(),
    ).toBe(`${blob} blob 6\nfirst\n\n`);
    expect(
      readCheckPolicyGitSync(
        root,
        ['cat-file', '--batch-check'],
        Buffer.from(blob + '\n'),
      ).toString(),
    ).toBe(`${blob} blob 6\n`);
    expect(readFileSync(join(root, '.git/index'))).toEqual(index);
  });

  it.each([
    'a'.repeat(39),
    'a'.repeat(41),
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(40),
    'g'.repeat(40),
    'HEAD',
    '--help',
  ])('refuses a nonexact object name %s', (value) => {
    for (const args of [
      ['merge-base', value, first],
      ['merge-base', first, value],
      ['ls-tree', '-r', '-z', '--full-tree', value],
      ['diff', '--name-status', '-z', '-M', '--find-renames', value, first],
      ['diff', '--name-status', '-z', '-M', '--find-renames', first, value],
      ['cat-file', 'blob', value + ':file ç.txt'],
    ])
      expect(() => readCheckPolicyGitSync('/nonexistent-policy-fixture', args)).toThrow(
        'GIT_POLICY_READ_ARGUMENTS_INVALID',
      );
  });

  it.each([
    '',
    '/absolute',
    '../outside',
    './file',
    'a//b',
    'a/../b',
    'a/./b',
    'a\\b',
    'a\0b',
    'a\nb',
    'a\tb',
    'a\x1fb',
    'a\x7fb',
  ])('refuses unsafe object paths %j', (path) => {
    expect(() =>
      readCheckPolicyGitSync('/nonexistent-policy-fixture', [
        'cat-file',
        'blob',
        first + ':' + path,
      ]),
    ).toThrow('GIT_POLICY_READ_ARGUMENTS_INVALID');
  });

  it.each([
    'HEAD',
    'HEAD^{blob}',
    'HEAD^{commit}extra',
    'main^{commit}',
    'HEAD~1^{tree}',
    '--help',
  ])('refuses revision grammar %s', (revision) => {
    expect(() =>
      readCheckPolicyGitSync('/nonexistent-policy-fixture', ['rev-parse', '--verify', revision]),
    ).toThrow('GIT_POLICY_READ_ARGUMENTS_INVALID');
  });

  it('refuses missing, surplus, reordered, and effectful arguments', () => {
    for (const args of [
      [],
      ['status'],
      ['status', '--porcelain=v1'],
      ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'],
      ['ls-files', '-z', '-s'],
      ['ls-files', '-z', '--others'],
      ['ls-tree', '-r', '-z', first],
      ['ls-tree', '-r', '-z', '--full-tree', first, 'file ç.txt'],
      ['cat-file', '--filters', first + ':file ç.txt'],
      ['cat-file', '--batch', '--buffer'],
      ['cat-file', '--batch-check', '--buffer'],
      ['cat-file', '--batch-check', '--batch-all-objects'],
      ['rev-parse', '--verify', 'HEAD^{commit}', '--'],
      ['merge-base', first, second, '--all'],
      ['diff', '--name-status', '-z', '-M', '--find-renames', first, second, '--ext-diff'],
      ['checkout', first],
      ['reset', '--hard', first],
      ['update-ref', 'refs/heads/changed', first],
    ])
      expect(() => readCheckPolicyGitSync(root, args)).toThrow('GIT_POLICY_READ_ARGUMENTS_INVALID');
    expect(git(['rev-parse', 'HEAD'])).toBe(second);
    expect(readFileSync(join(root, 'file ç.txt'), 'utf8')).toBe('second\n');
  });

  it('accepts only complete newline-delimited exact batch identities', () => {
    for (const command of ['--batch', '--batch-check']) {
      for (const input of [
        undefined,
        '',
        Buffer.alloc(0),
        blob,
        blob + '\n\n',
        'HEAD\n',
        blob + '\r\n',
        Buffer.from([0xff, 0x0a]),
      ])
        expect(() => readCheckPolicyGitSync(root, ['cat-file', command], input)).toThrow(
          'GIT_POLICY_READ_INPUT_INVALID',
        );
    }
    expect(
      readCheckPolicyGitSync(root, ['cat-file', '--batch'], blob + '\n' + blob + '\n').toString(),
    ).toBe(`${blob} blob 6\nfirst\n\n`.repeat(2));
    expect(
      readCheckPolicyGitSync(
        root,
        ['cat-file', '--batch-check'],
        blob + '\n' + blob + '\n',
      ).toString(),
    ).toBe(`${blob} blob 6\n`.repeat(2));
    expect(() =>
      readCheckPolicyGitSync(root, ['status', '--porcelain=v1', '--untracked-files=all'], ''),
    ).toThrow('GIT_POLICY_READ_INPUT_INVALID');
  });

  it('discards inherited Git directory and injected configuration controls', () => {
    vi.stubEnv('GIT_DIR', join(root, 'nonexistent-git-directory'));
    vi.stubEnv('GIT_WORK_TREE', join(root, 'nonexistent-worktree'));
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.bare');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'true');
    expect(
      readCheckPolicyGitSync(root, ['rev-parse', '--verify', 'HEAD^{commit}']).toString().trim(),
    ).toBe(second);
    expect(
      readCheckPolicyGitSync(root, [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ]).toString(),
    ).toBe('?? untracked.txt\n');
  });

  it('reports execution failure separately from invalid grammar', () => {
    expect(() =>
      readCheckPolicyGitSync('/nonexistent-policy-fixture', [
        'rev-parse',
        '--verify',
        'HEAD^{commit}',
      ]),
    ).toThrow('GIT_POLICY_READ_FAILED');
    expect(() =>
      readCheckPolicyGitSync(root, ['cat-file', 'blob', 'a'.repeat(64) + ':file']),
    ).toThrow('GIT_POLICY_READ_FAILED');
  });
});
