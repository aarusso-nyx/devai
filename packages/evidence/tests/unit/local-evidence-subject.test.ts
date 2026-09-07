import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, aroundEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  deriveExactSubject,
  deriveTrailerParentSubject,
} from '../../src/local-evidence/subject.js';

const roots: string[] = [];
aroundEach((runTest) => withAuthorityHostTestScope(runTest));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
function put(root: string, name: string, content = '{}\n') {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function fixture(origin = 'https://github.com/owner/repository.git', algorithm = 'sha1') {
  const root = mkdtempSync(join(tmpdir(), 'evidence-subject-ç '));
  roots.push(root);
  git(root, 'init', '-q', `--object-format=${algorithm}`);
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'remote', 'add', 'origin', origin);
  put(root, 'source.txt', 'candidate\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'candidate');
  return root;
}

describe('exact local evidence subjects', () => {
  it.each(['sha1', 'sha256'])('records the exact %s commit and tree', (algorithm) => {
    const root = fixture(undefined, algorithm);
    expect(deriveExactSubject(root)).toEqual({
      repository: 'owner/repository',
      commitSha: git(root, 'rev-parse', 'HEAD'),
      tree: { algorithm, value: git(root, 'rev-parse', 'HEAD^{tree}') },
    });
  });
  it.each([
    'git@github.com:owner/repository.git',
    'ssh://git@github.com/owner/repository.git',
    'owner/repository.git',
    '/owner/repository/',
  ])('derives the repository path from the supported remote form %s', (origin) => {
    expect(deriveExactSubject(fixture(origin)).repository).toBe('owner/repository');
  });
  it.each([false, true])('refuses tracked edits with staged=%s', (staged) => {
    const root = fixture();
    put(root, 'source.txt', 'changed\n');
    if (staged) git(root, 'add', '.');
    expect(() => deriveExactSubject(root)).toThrow('clean tracked index and worktree');
  });
  it('ignores untracked diagnostics and resolves an explicitly selected existing ref', () => {
    const root = fixture();
    const first = deriveExactSubject(root);
    git(root, 'commit', '--allow-empty', '-qm', 'later');
    put(root, 'diagnostic.log');
    expect(deriveExactSubject(root, 'HEAD^')).toEqual(first);
  });

  it.each([
    'evidence/manifest.json',
    'evidence/ação com espaço.json',
    'evidence/tab\tname.json',
    ' leading manifest.json',
  ])('binds a manifest-only trailer to its parent using the exact filename %s', (name) => {
    const root = fixture();
    const expected = deriveExactSubject(root);
    put(root, name);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'trailer');
    expect(deriveTrailerParentSubject(root, name)).toEqual(expected);
  });
  it('rejects an initial commit, an empty trailer, and a trailer with additional source changes', () => {
    const root = fixture();
    expect(() => deriveTrailerParentSubject(root, 'manifest.json')).toThrow('exactly one parent');
    git(root, 'commit', '--allow-empty', '-qm', 'empty');
    expect(() => deriveTrailerParentSubject(root, 'manifest.json')).toThrow(
      'only the declared manifest',
    );
    put(root, 'manifest.json');
    put(root, 'source.txt', 'changed');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'mixed');
    expect(() => deriveTrailerParentSubject(root, 'manifest.json')).toThrow(
      'only the declared manifest',
    );
  });
});

it.each([
  ['https://github.com///owner/repository///', 'owner/repository'],
  ['///owner/repository///', 'owner/repository'],
  ['owner.git/repository.git', 'owner.git/repository'],
])('preserves the exact repository identity for %s', (origin, expected) => {
  expect(deriveExactSubject(fixture(origin)).repository).toBe(expected);
});

it.each(['', '/', '///'])('refuses an empty repository identity from origin %j', (origin) => {
  expect(() => deriveExactSubject(fixture(origin))).toThrow(
    'cannot derive repository identity from origin',
  );
});

it('reports a missing origin as a failed Git lookup rather than inventing an identity', () => {
  const root = fixture();
  git(root, 'remote', 'remove', 'origin');
  expect(() => deriveExactSubject(root)).toThrow('git config --get remote.origin.url failed');
});
