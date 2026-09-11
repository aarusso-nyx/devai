import { execFileSync, type SpawnSyncOptionsWithBufferEncoding } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type ProbeTarget = 'paths' | 'objects';
type OutputMutation =
  | 'control'
  | 'carriage-return'
  | 'empty-first'
  | 'empty-second'
  | 'malformed-first'
  | 'missing-newline'
  | 'non-utf8'
  | 'short'
  | 'extra'
  | 'extra-object-id'
  | 'trailing-sentinel'
  | 'transpose';

const probe = vi.hoisted(() => ({
  calls: [] as Array<{ readonly command: string; readonly args: readonly string[] }>,
  mutation: undefined as
    { readonly target: ProbeTarget; readonly output: OutputMutation } | undefined,
}));

function mutatedOutput(stdout: Buffer, output: OutputMutation): Buffer {
  if (output === 'non-utf8') return Buffer.from([0xff, 0xfe, 0x0a]);
  const fields = stdout.toString('utf8').slice(0, -1).split('\n');
  const value =
    output === 'trailing-sentinel'
      ? `${fields.join('\n')}!`
      : output === 'extra-object-id'
        ? `${fields.join('\n')}\n${'0'.repeat(fields[0]?.length ?? 40)}\n`
        : output === 'short'
          ? `${fields.slice(0, -1).join('\n')}\n`
          : output === 'extra'
            ? `${fields.join('\n')}\nunexpected\n`
            : output === 'empty-first'
              ? `\n${fields.slice(1).join('\n')}\n`
              : output === 'empty-second'
                ? `${fields[0] ?? ''}\n\n${fields.slice(2).join('\n')}${fields.length > 2 ? '\n' : ''}`
                : output === 'malformed-first'
                  ? `not-an-object-id\n${fields.slice(1).join('\n')}\n`
                  : output === 'missing-newline'
                    ? fields.join('\n')
                    : output === 'carriage-return'
                      ? `${fields.join('\r\n')}\r\n`
                      : output === 'transpose'
                        ? `${[...fields].reverse().join('\n')}\n`
                        : `${fields[0] ?? ''}\0${fields.slice(1).join('\n')}\n`;
  return Buffer.from(value);
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: (
      command: string,
      args: readonly string[],
      options: SpawnSyncOptionsWithBufferEncoding,
    ) => {
      probe.calls.push({ command, args: [...args] });
      const result = actual.spawnSync(command, args, options);
      const target = args.includes('--show-toplevel')
        ? 'paths'
        : args.includes('HEAD^{commit}')
          ? 'objects'
          : undefined;
      if (target !== undefined && target === probe.mutation?.target && result.stdout !== null) {
        return { ...result, stdout: mutatedOutput(result.stdout, probe.mutation.output) };
      }
      return result;
    },
  };
});

const {
  createProtectedReleaseRepositoryContext,
  readProtectedReleaseRepositoryIdentity,
  withProtectedReleaseRepositoryContext,
} = await import('../../src/boundaries/host-effects.js');

const GIT = '/usr/bin/git';
const REPOSITORY_ID = 'fixture/repository';
const ORIGIN = `https://github.com/${REPOSITORY_ID}.git`;
const removals: string[] = [];

function git(root: string, args: readonly string[]): string {
  return execFileSync(GIT, ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function temporaryDirectory(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  removals.push(root);
  return root;
}

function controls(root: string) {
  return {
    repository_root: root,
    authority_repository_id: 'fixture-repository',
    read_expected_release_repository_id: () => REPOSITORY_ID,
    repository: {
      id: REPOSITORY_ID,
      commit: git(root, ['rev-parse', 'HEAD']),
      tree: git(root, ['rev-parse', 'HEAD^{tree}']),
    },
  };
}

function fixture(objectFormat?: 'sha256') {
  const root = temporaryDirectory('repository probe batch ç ');
  git(root, [
    'init',
    '-q',
    ...(objectFormat === undefined ? [] : [`--object-format=${objectFormat}`]),
  ]);
  git(root, ['config', 'user.name', 'Repository Probe Batch']);
  git(root, ['config', 'user.email', 'repository-probe@example.invalid']);
  git(root, ['remote', 'add', 'origin', ORIGIN]);
  writeFileSync(join(root, 'README.md'), 'repository probe batching\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'initial']);
  return { root, controls: controls(root) };
}

function separateGitDirectoryFixture() {
  const parent = temporaryDirectory('repository probe separate git ç ');
  const root = join(parent, 'checkout');
  const gitDirectory = join(parent, 'git\tstore');
  execFileSync(GIT, ['init', '-q', `--separate-git-dir=${gitDirectory}`, root]);
  git(root, ['config', 'user.name', 'Repository Probe Batch']);
  git(root, ['config', 'user.email', 'repository-probe@example.invalid']);
  git(root, ['remote', 'add', 'origin', ORIGIN]);
  writeFileSync(join(root, 'README.md'), 'repository probe separate Git directory\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'initial']);
  return { root, controls: controls(root) };
}

function unbornFixture() {
  const root = temporaryDirectory('repository probe unborn ç ');
  git(root, ['init', '-q']);
  git(root, ['remote', 'add', 'origin', ORIGIN]);
  return {
    root,
    controls: {
      repository_root: root,
      authority_repository_id: 'fixture-repository',
      read_expected_release_repository_id: () => REPOSITORY_ID,
      repository: { id: REPOSITORY_ID, commit: '0'.repeat(40), tree: '0'.repeat(40) },
    },
  };
}

function innerArgs(call: (typeof probe.calls)[number]): readonly string[] {
  return call.args.slice(5);
}

function probeCall(index: number): (typeof probe.calls)[number] {
  const call = probe.calls[index];
  if (call === undefined) throw new Error(`missing repository probe call ${String(index)}`);
  return call;
}

afterEach(() => {
  probe.calls = [];
  probe.mutation = undefined;
  for (const root of removals.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe('protected repository Git probe batching', () => {
  it('rejects a sentinel appended after the common-directory path without a final newline', () => {
    const value = fixture();
    probe.mutation = { target: 'paths', output: 'trailing-sentinel' };
    expect(() => createProtectedReleaseRepositoryContext(value.controls)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );
  });

  it('rejects a sentinel appended after the real tree object without a final newline', () => {
    const value = fixture();
    probe.mutation = { target: 'objects', output: 'trailing-sentinel' };
    expect(() => createProtectedReleaseRepositoryContext(value.controls)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );
  });

  it('rejects one tab-bearing canonical path from a separate Git directory fixture', () => {
    const value = separateGitDirectoryFixture();
    expect(() => createProtectedReleaseRepositoryContext(value.controls)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );
  });

  it('rejects one isolated extra SHA-shaped object field', () => {
    const value = fixture();
    probe.mutation = { target: 'objects', output: 'extra-object-id' };
    expect(() => createProtectedReleaseRepositoryContext(value.controls)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );
  });

  it('accepts a real SHA-256 Git repository identity', async () => {
    const value = fixture('sha256');
    expect(value.controls.repository.commit).toMatch(/^[a-f0-9]{64}$/u);
    expect(value.controls.repository.tree).toMatch(/^[a-f0-9]{64}$/u);
    const context = createProtectedReleaseRepositoryContext(value.controls);
    await withProtectedReleaseRepositoryContext(context, () => {
      expect(readProtectedReleaseRepositoryIdentity().repository).toEqual(
        value.controls.repository,
      );
    });
  });

  it('uses three exact Git calls per probe and brackets the object read with pins', async () => {
    const value = fixture();
    const context = createProtectedReleaseRepositoryContext(value.controls);
    expect(probe.calls).toHaveLength(3);
    expect(probe.calls.map(({ command }) => command)).toEqual([GIT, GIT, GIT]);
    expect(innerArgs(probeCall(0))).toEqual([
      '-c',
      'extensions.worktreeConfig=false',
      'config',
      '--local',
      '--no-includes',
      '--null',
      '--list',
    ]);
    expect(innerArgs(probeCall(1))).toEqual([
      'rev-parse',
      '--show-toplevel',
      '--absolute-git-dir',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    expect(innerArgs(probeCall(2))).toEqual(['rev-parse', 'HEAD^{commit}', 'HEAD^{tree}']);

    probe.calls = [];
    await withProtectedReleaseRepositoryContext(context, () => {
      expect(readProtectedReleaseRepositoryIdentity().repository).toEqual(
        value.controls.repository,
      );
    });
    expect(probe.calls).toHaveLength(6);
  });

  it('assigns distinct linked-worktree Git and common directories correctly', async () => {
    const primary = fixture();
    const linked = temporaryDirectory('repository probe linked ç ');
    rmSync(linked, { recursive: true });
    git(primary.root, ['worktree', 'add', '-q', '--detach', linked, 'HEAD']);
    const gitDirectory = git(linked, ['rev-parse', '--absolute-git-dir']);
    const commonDirectory = git(linked, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    expect(gitDirectory).not.toBe(commonDirectory);
    const linkedControls = controls(linked);
    const context = createProtectedReleaseRepositoryContext(linkedControls);
    await withProtectedReleaseRepositoryContext(context, () => {
      expect(readProtectedReleaseRepositoryIdentity().repository).toEqual(
        linkedControls.repository,
      );
    });
  });

  it.each(['control', 'carriage-return', 'missing-newline', 'non-utf8', 'short', 'extra'] as const)(
    'fails closed on %s path output',
    (output) => {
      const value = fixture();
      probe.mutation = { target: 'paths', output };
      expect(() => createProtectedReleaseRepositoryContext(value.controls)).toThrow(
        'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
      );
    },
  );

  it.each([
    'control',
    'carriage-return',
    'empty-first',
    'empty-second',
    'malformed-first',
    'missing-newline',
    'non-utf8',
    'short',
    'extra',
    'transpose',
  ] as const)('fails closed on %s object output', (output) => {
    const value = fixture();
    probe.mutation = { target: 'objects', output };
    expect(() => createProtectedReleaseRepositoryContext(value.controls)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );
  });

  it('refuses an unborn repository instead of accepting revision path fallback', () => {
    const value = unbornFixture();
    expect(() => createProtectedReleaseRepositoryContext(value.controls)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );
  });

  it('refuses a dangling HEAD', () => {
    const value = fixture();
    writeFileSync(join(value.root, '.git', 'HEAD'), 'ref: refs/heads/missing\n');
    expect(() => createProtectedReleaseRepositoryContext(value.controls)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );
  });

  it('refuses newline-bearing canonical paths reached through a safe alias', () => {
    const parent = temporaryDirectory('repository probe newline parent ');
    const root = join(parent, 'checkout\nline');
    const gitDirectory = join(parent, 'git\nstore');
    execFileSync(GIT, ['init', '-q', `--separate-git-dir=${gitDirectory}`, root]);
    git(root, ['config', 'user.name', 'Repository Probe Batch']);
    git(root, ['config', 'user.email', 'repository-probe@example.invalid']);
    git(root, ['remote', 'add', 'origin', ORIGIN]);
    writeFileSync(join(root, 'README.md'), 'newline path fixture\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-qm', 'initial']);
    const alias = join(parent, 'safe-alias');
    symlinkSync(root, alias);
    expect(alias).not.toMatch(/[\p{Cc}\p{Cs}]/u);
    expect(realpathSync(alias)).toContain('\n');
    expect(() =>
      createProtectedReleaseRepositoryContext({ ...controls(root), repository_root: alias }),
    ).toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
  });
});
