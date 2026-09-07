import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, aroundEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { computeSourceHash } from '../../src/local-evidence/source-hash.js';

const roots: string[] = [];
aroundEach((runTest) => withAuthorityHostTestScope(runTest));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function git(root: string, ...args: string[]) {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}
function put(root: string, path: string, content = 'data\n') {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'source-hash-'));
  roots.push(root);
  git(root, 'init', '-q');
  return root;
}

describe('local evidence source hashing', () => {
  it('matches independent SHA256 vectors for UTF8 paths, byte lengths and deleted tracked files', () => {
    const root = fixture();
    put(root, 'sub/ação.txt', 'β\n');
    put(root, 'a.txt', 'alpha\n');
    git(root, 'add', '.');
    // Computed independently using Python hashlib and the documented framing.
    expect(computeSourceHash(root, [])).toEqual({
      algorithm: 'sha256',
      fileCount: 2,
      value: 'b840b35e11dcff36fcda1b37db2c7b05c2d2a62ee5335295db6f15747963b723',
    });
    rmSync(join(root, 'a.txt'));
    expect(computeSourceHash(root, [])).toEqual({
      algorithm: 'sha256',
      fileCount: 2,
      value: 'e99681bd73ed203e36eb4a11d6285ca3db2143108ee4cbb265c7fce4d068a230',
    });
  });

  it('ignores untracked output but binds tracked bytes and file paths', () => {
    const root = fixture();
    put(root, 'source.txt');
    git(root, 'add', '.');
    const first = computeSourceHash(root, []);
    put(root, 'diagnostic.log');
    expect(computeSourceHash(root, [])).toEqual(first);
    put(root, 'source.txt', 'changed\n');
    expect(computeSourceHash(root, []).value).not.toBe(first.value);
    put(root, 'source.txt');
    renameSync(join(root, 'source.txt'), join(root, 'renamed.txt'));
    git(root, 'add', '-A');
    expect(computeSourceHash(root, []).value).not.toBe(first.value);
  });

  it.each(['evidence', 'evidence/'])(
    'excludes a directory prefix %s without excluding similarly named sources',
    (prefix) => {
      const root = fixture();
      put(root, 'evidence/report.json');
      put(root, 'evidence-other/report.json');
      put(root, 'source.txt');
      git(root, 'add', '.');
      const first = computeSourceHash(root, [prefix]);
      expect(first.fileCount).toBe(2);
      put(root, 'evidence/report.json', 'new evidence');
      expect(computeSourceHash(root, [prefix])).toEqual(first);
      put(root, 'evidence-other/report.json', 'source change');
      expect(computeSourceHash(root, [prefix]).value).not.toBe(first.value);
    },
  );

  it('excludes an exact tracked file and hashes an empty selected population correctly', () => {
    const root = fixture();
    put(root, 'manifest.json');
    git(root, 'add', '.');
    expect(computeSourceHash(root, ['manifest.json'])).toEqual({
      algorithm: 'sha256',
      fileCount: 0,
      value: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
  });

  it('surfaces failure when the target has no Git index instead of producing an empty digest', () => {
    const root = fixture();
    rmSync(join(root, '.git'), { recursive: true });
    expect(() => computeSourceHash(root, [])).toThrow();
  });
});
