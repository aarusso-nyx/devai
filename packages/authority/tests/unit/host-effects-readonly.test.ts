import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  closeReadOnlySync,
  fstatSync,
  openReadOnlyNoFollowSync,
  readExactGitTreeSync,
  readCheckPolicyGitSync,
} from '../../src/index.js';

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return String(result.stdout).trim();
}

describe('read-only no-follow host seam', () => {
  it('opens the exact regular-file inode without an authority mutation scope', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devai-readonly-host-'));
    const path = join(directory, 'record.json');
    writeFileSync(path, '{}\n');
    const descriptor = openReadOnlyNoFollowSync(path);
    try {
      expect(fstatSync(descriptor).isFile()).toBe(true);
    } finally {
      closeReadOnlySync(descriptor);
    }
  });

  it('refuses a symlink at the opened leaf', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devai-readonly-host-'));
    const target = join(directory, 'record.json');
    const link = join(directory, 'record-link.json');
    writeFileSync(target, '{}\n');
    symlinkSync(target, link);
    expect(() => openReadOnlyNoFollowSync(link)).toThrow();
  });

  it('reconstructs policy Git reads without index writes or candidate programs', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-policy-read-'));
    git(root, ['init', '-q']);
    git(root, ['config', 'user.name', 'Test']);
    git(root, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(root, 'file ç.txt'), 'one\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'one']);
    const first = git(root, ['rev-parse', 'HEAD']);
    const blob = git(root, ['rev-parse', 'HEAD:file ç.txt']);
    writeFileSync(join(root, 'file ç.txt'), 'two\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'two']);
    const second = git(root, ['rev-parse', 'HEAD']);
    const index = readFileSync(join(root, '.git/index'));
    const hook = join(root, 'monitor.sh');
    writeFileSync(hook, '#!/bin/sh\ntouch "' + join(root, 'executed') + '"\n');
    chmodSync(hook, 0o755);
    git(root, ['config', 'core.fsmonitor', hook]);
    git(root, ['config', 'diff.external', hook]);
    expect(
      readCheckPolicyGitSync(root, ['rev-parse', '--verify', 'HEAD^{commit}']).toString().trim(),
    ).toBe(second);
    expect(
      readCheckPolicyGitSync(root, ['cat-file', 'blob', first + ':file ç.txt']).toString(),
    ).toBe('one\n');
    expect(readCheckPolicyGitSync(root, ['cat-file', '--batch'], blob + '\n').toString()).toContain(
      'one\n',
    );
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
    ).toContain('file ç.txt');
    readCheckPolicyGitSync(root, ['status', '--porcelain=v1', '--untracked-files=all']);
    readCheckPolicyGitSync(root, ['ls-files', '-s', '-z']);
    expect(readFileSync(join(root, '.git/index')).equals(index)).toBe(true);
    expect(existsSync(join(root, 'executed'))).toBe(false);
    for (const args of [
      ['checkout', first],
      ['config', 'user.name', 'changed'],
      ['cat-file', '--filters', first + ':file ç.txt'],
      ['diff', '--ext-diff', first, second],
      ['rev-parse', '--verify', '--output=/tmp/forbidden'],
    ])
      expect(() => readCheckPolicyGitSync(root, args)).toThrow('GIT_POLICY_READ_ARGUMENTS_INVALID');
    for (const input of ['HEAD\n', blob + '\ncheckout\n', blob, ''])
      expect(() => readCheckPolicyGitSync(root, ['cat-file', '--batch'], input)).toThrow(
        'GIT_POLICY_READ_INPUT_INVALID',
      );
  });

  it('reads exact immutable Git blobs with their executable and symlink modes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devai-readonly-git-'));
    mkdirSync(join(directory, 'package'));
    writeFileSync(join(directory, 'package/plain.txt'), 'plain\n');
    writeFileSync(join(directory, 'package/executable.sh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(directory, 'package/executable.sh'), 0o755);
    symlinkSync('plain.txt', join(directory, 'package/link.txt'));
    git(directory, ['init', '-q']);
    git(directory, ['config', 'user.name', 'Authority Test']);
    git(directory, ['config', 'user.email', 'authority@example.invalid']);
    git(directory, ['add', '.']);
    git(directory, ['commit', '-qm', 'fixture']);
    const commit = git(directory, ['rev-parse', 'HEAD']);
    const tree = git(directory, ['rev-parse', 'HEAD^{tree}']);

    expect(
      readExactGitTreeSync(directory, commit, tree, 'package').map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        text: entry.bytes.toString('utf8'),
      })),
    ).toEqual([
      { path: 'package/executable.sh', mode: '100755', text: '#!/bin/sh\nexit 0\n' },
      { path: 'package/link.txt', mode: '120000', text: 'plain.txt' },
      { path: 'package/plain.txt', mode: '100644', text: 'plain\n' },
    ]);
    expect(() => readExactGitTreeSync(directory, commit, '0'.repeat(40), 'package')).toThrow(
      'GIT_TREE_IDENTITY_MISMATCH',
    );
  });
});
