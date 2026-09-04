import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProtectedReleaseRepositoryContext,
  readProtectedReleaseRepositoryIdentity,
  withProtectedReleaseRepositoryContext,
  type ProtectedReleaseRepositoryControls,
} from '../../src/boundaries/host-effects.js';

const roots: string[] = [];
const GIT = '/usr/bin/git';
const REPOSITORY_ID = 'aarusso-nyx/devai';
const ORIGIN = `https://github.com/${REPOSITORY_ID}.git`;

function git(root: string, args: readonly string[]): string {
  return execFileSync(GIT, ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'release context ç space-')));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Release Context Fixture']);
  git(root, ['config', 'user.email', 'release-context@example.invalid']);
  git(root, ['remote', 'add', 'origin', ORIGIN]);
  writeFileSync(join(root, 'README.md'), 'protected context fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'initial']);
  let expected = REPOSITORY_ID;
  const repository = {
    id: REPOSITORY_ID,
    commit: git(root, ['rev-parse', 'HEAD']),
    tree: git(root, ['rev-parse', 'HEAD^{tree}']),
  };
  const controls: ProtectedReleaseRepositoryControls = {
    repository_root: root,
    authority_repository_id: 'aarusso-nyx-devai',
    read_expected_release_repository_id: () => expected,
    repository,
  };
  return {
    root,
    controls,
    setExpected(value: string) {
      expected = value;
    },
  };
}

function refusal(callback: () => unknown | Promise<unknown>): Promise<void> {
  return expect(Promise.resolve().then(callback)).rejects.toThrow(
    'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('protected release repository context', () => {
  it('captures and freshly rechecks an exact Git worktree in a space and Unicode path', async () => {
    const value = fixture();
    expect(value.root).toContain('ç space-');
    const context = createProtectedReleaseRepositoryContext(value.controls);
    await withProtectedReleaseRepositoryContext(context, async () => {
      expect(readProtectedReleaseRepositoryIdentity()).toEqual({
        authority_repository_id: 'aarusso-nyx-devai',
        expected_release_repository_id: REPOSITORY_ID,
        origin_url: ORIGIN,
        repository: value.controls.repository,
      });
    });
    await refusal(() => readProtectedReleaseRepositoryIdentity());
  });

  it('refuses cloned, nested, and escaped context possession', async () => {
    const value = fixture();
    const context = createProtectedReleaseRepositoryContext(value.controls);
    await refusal(() =>
      withProtectedReleaseRepositoryContext({ ...context }, async () => undefined),
    );

    let escaped: (() => unknown) | undefined;
    await withProtectedReleaseRepositoryContext(context, async () => {
      await refusal(() => withProtectedReleaseRepositoryContext(context, async () => undefined));
      escaped = () => readProtectedReleaseRepositoryIdentity();
    });
    if (escaped === undefined) throw new Error('fixture escaped callback missing');
    expect(escaped).toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
  });

  it('refuses expected identity, raw origin, and HEAD/tree drift at the live recheck', async () => {
    const expected = fixture();
    const expectedContext = createProtectedReleaseRepositoryContext(expected.controls);
    await withProtectedReleaseRepositoryContext(expectedContext, async () => {
      expected.setExpected('stynx-nyx/stynx');
      expect(() => readProtectedReleaseRepositoryIdentity()).toThrow(
        'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
      );
    });

    const origin = fixture();
    const originContext = createProtectedReleaseRepositoryContext(origin.controls);
    await withProtectedReleaseRepositoryContext(originContext, async () => {
      git(origin.root, [
        'remote',
        'set-url',
        'origin',
        'ssh://git@github.com/aarusso-nyx/devai.git',
      ]);
      expect(() => readProtectedReleaseRepositoryIdentity()).toThrow(
        'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
      );
    });

    const head = fixture();
    const headContext = createProtectedReleaseRepositoryContext(head.controls);
    await withProtectedReleaseRepositoryContext(headContext, async () => {
      writeFileSync(join(head.root, 'README.md'), 'drifted HEAD\n');
      git(head.root, ['add', 'README.md']);
      git(head.root, ['commit', '-qm', 'drift']);
      expect(() => readProtectedReleaseRepositoryIdentity()).toThrow(
        'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
      );
    });
  });

  it('rejects local config rewrites and non-top-level roots, while pinning a symlinked control root', async () => {
    const config = fixture();
    git(config.root, ['config', 'include.path', 'candidate-controlled.inc']);
    expect(() => createProtectedReleaseRepositoryContext(config.controls)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );

    const nested = fixture();
    mkdirSync(join(nested.root, 'nested'));
    expect(() =>
      createProtectedReleaseRepositoryContext({
        ...nested.controls,
        repository_root: join(nested.root, 'nested'),
      }),
    ).toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');

    const linked = fixture();
    const alias = join(realpathSync(tmpdir()), 'release-context-alias');
    roots.push(alias);
    symlinkSync(linked.root, alias);
    const context = createProtectedReleaseRepositoryContext({
      ...linked.controls,
      repository_root: alias,
    });
    await withProtectedReleaseRepositoryContext(context, async () => {
      expect(readProtectedReleaseRepositoryIdentity().repository).toEqual(
        linked.controls.repository,
      );
    });
  });

  it('requires the exact named lowercase origin while ignoring unrelated remote subsections', async () => {
    const unrelated = fixture();
    git(unrelated.root, ['config', 'remote.Origin.url', 'https://github.com/stynx-nyx/stynx.git']);
    const accepted = createProtectedReleaseRepositoryContext(unrelated.controls);
    await withProtectedReleaseRepositoryContext(accepted, async () => {
      expect(readProtectedReleaseRepositoryIdentity().origin_url).toBe(ORIGIN);
    });

    const missing = fixture();
    git(missing.root, ['config', '--unset-all', 'remote.origin.url']);
    git(missing.root, ['config', 'remote.Origin.url', ORIGIN]);
    expect(() => createProtectedReleaseRepositoryContext(missing.controls)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );
  });
});
