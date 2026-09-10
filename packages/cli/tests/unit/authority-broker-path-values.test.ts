// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalRelativePath,
  existingRealpath,
  gitMetadataLayout,
  gitMetadataLogicalPath,
  physicalCanonicalPath,
  within,
} from '../../src/authority/broker.js';

const roots: string[] = [];
function temporary(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('authority broker canonical path values', () => {
  it('resolves an existing symlink ancestor while preserving a missing suffix', () => {
    const root = temporary('devai-path-values-');
    const physical = join(root, 'physical');
    mkdirSync(physical);
    symlinkSync(physical, join(root, 'link'));
    expect(existingRealpath(join(root, 'link', 'missing', 'file'))).toBe(
      join(realpathSync(physical), 'missing', 'file'),
    );
  });

  it('recognizes repository containment including the root boundary', () => {
    expect(within('/repo', '/repo')).toBe(true);
    expect(within('/repo', '/repo/child')).toBe(true);
    expect(within('/repo', '/repository')).toBe(false);
    expect(within('/repo', '/other/repo')).toBe(false);
  });

  it('reads a directory-form Git metadata layout', () => {
    const root = temporary('devai-git-dir-');
    mkdirSync(join(root, '.git'));
    expect(gitMetadataLayout(root)).toEqual({
      admin_root: realpathSync(join(root, '.git')),
      common_root: realpathSync(join(root, '.git')),
    });
  });

  it('reads an exact file-form worktree layout and its common directory', () => {
    const base = temporary('devai-git-file-');
    const root = join(base, 'worktree');
    const admin = join(base, 'admin');
    const common = join(base, 'common');
    mkdirSync(root);
    mkdirSync(admin);
    mkdirSync(common);
    writeFileSync(join(root, '.git'), `gitdir: ${admin}\n`);
    writeFileSync(join(admin, 'commondir'), `${common}\n`);
    expect(gitMetadataLayout(root)).toEqual({
      admin_root: realpathSync(admin),
      common_root: realpathSync(common),
    });
  });

  it.each(['gitdir:', 'prefix gitdir: /tmp', 'gitdir /tmp'])(
    'rejects malformed Git metadata marker %s',
    (marker) => {
      const root = temporary('devai-git-invalid-');
      writeFileSync(join(root, '.git'), marker);
      expect(gitMetadataLayout(root)).toBeUndefined();
    },
  );

  it('maps only protected Git metadata namespaces to logical paths', () => {
    const base = temporary('devai-git-map-');
    const root = join(base, 'worktree');
    const admin = join(base, 'admin');
    const common = join(base, 'common');
    mkdirSync(root);
    mkdirSync(join(admin, 'devai'), { recursive: true });
    mkdirSync(join(common, 'hooks'), { recursive: true });
    writeFileSync(join(root, '.git'), `gitdir: ${admin}\n`);
    writeFileSync(join(admin, 'commondir'), `${common}\n`);

    expect(gitMetadataLogicalPath(root, realpathSync(join(admin, 'devai')))).toBe('.git/devai');
    expect(gitMetadataLogicalPath(root, join(realpathSync(admin), 'devai', 'state.json'))).toBe(
      '.git/devai/state.json',
    );
    expect(gitMetadataLogicalPath(root, realpathSync(join(common, 'hooks')))).toBe('.git/hooks');
    expect(gitMetadataLogicalPath(root, join(realpathSync(common), 'hooks', 'pre-commit'))).toBe(
      '.git/hooks/pre-commit',
    );
    expect(gitMetadataLogicalPath(root, realpathSync(common))).toBeUndefined();

    expect(physicalCanonicalPath(root, '.git/devai/state.json')).toBe(
      join(realpathSync(admin), 'devai', 'state.json'),
    );
    expect(physicalCanonicalPath(root, '.git/hooks/pre-commit')).toBe(
      join(realpathSync(common), 'hooks', 'pre-commit'),
    );
    expect(physicalCanonicalPath(root, 'ordinary/file')).toBe(resolve(root, 'ordinary/file'));
  });

  it('canonicalizes repository files and refuses empty, root, outside, and symlink escapes', () => {
    const root = temporary('devai-canonical-');
    const outside = temporary('devai-outside-');
    mkdirSync(join(root, 'inside'));
    writeFileSync(join(root, 'inside', 'file'), 'ok');
    symlinkSync(outside, join(root, 'escape'));

    expect(canonicalRelativePath(root, join(root, 'inside', 'file'))).toBe('inside/file');
    expect(() => canonicalRelativePath(root, '')).toThrow('AUTHORITY_FS_TARGET_INVALID');
    expect(() => canonicalRelativePath(root, undefined)).toThrow('AUTHORITY_FS_TARGET_INVALID');
    expect(() => canonicalRelativePath(root, root)).toThrow('AUTHORITY_FS_TARGET_INVALID');
    expect(() => canonicalRelativePath(root, outside)).toThrow('AUTHORITY_FS_SYMLINK_ESCAPE');
    expect(() => canonicalRelativePath(root, join(root, 'escape', 'file'))).toThrow(
      'AUTHORITY_FS_SYMLINK_ESCAPE',
    );
  });
});
