import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  verifyReleaseCandidateSnapshot,
  type ReleaseGitObject,
} from '../../src/services/release-candidate-snapshot.js';

type Fixture = ReturnType<typeof fixture>;

function objectId(type: ReleaseGitObject['type'], bytes: Uint8Array): string {
  return createHash('sha1').update(`${type} ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function entry(mode: string, name: Uint8Array | string, id = 'd'.repeat(40)): Buffer {
  const nameBytes = typeof name === 'string' ? Buffer.from(name) : Buffer.from(name);
  return Buffer.concat([
    Buffer.from(`${mode} `),
    nameBytes,
    Buffer.from([0]),
    Buffer.from(id, 'hex'),
  ]);
}

function fixture(treeBytes = entry('160000', 'submodule')) {
  const tree = objectId('tree', treeBytes);
  const commitBytes = Buffer.from(
    `tree ${tree}\nauthor Fixture <fixture@example.invalid> 0 +0000\n\nfixture\n`,
  );
  const commit = objectId('commit', commitBytes);
  return {
    repository: { id: 'fixture/repository', commit, tree },
    objects: new Map<string, ReleaseGitObject>([
      [commit, { type: 'commit', bytes: commitBytes }],
      [tree, { type: 'tree', bytes: treeBytes }],
    ]),
  };
}

function replaceCommit(value: Fixture, bytes: Buffer): void {
  value.objects.delete(value.repository.commit);
  const commit = objectId('commit', bytes);
  value.objects.set(commit, { type: 'commit', bytes });
  value.repository.commit = commit;
}

function verify(
  value: Fixture,
  overrides: Partial<Parameters<typeof verifyReleaseCandidateSnapshot>[0]> = {},
) {
  return verifyReleaseCandidateSnapshot({
    repository: value.repository,
    objects: value.objects,
    maximum_bytes: 1_000_000,
    maximum_entries: 100,
    ...overrides,
  });
}

function refuse(run: () => unknown): void {
  expect(run).toThrow(/^rpl-policy-resolution-mismatch$/u);
}

describe('release candidate snapshot malformed-object boundaries', () => {
  it.each([
    ['extra repository key', (value: Fixture) => ({ ...value.repository, extra: true })],
    ['non-string repository id', (value: Fixture) => ({ ...value.repository, id: 1 })],
    ['empty repository id', (value: Fixture) => ({ ...value.repository, id: '' })],
    [
      'commit prefix',
      (value: Fixture) => ({
        ...value.repository,
        commit: `x${value.repository.commit.slice(1)}`,
      }),
    ],
    [
      'commit suffix',
      (value: Fixture) => ({
        ...value.repository,
        commit: `${value.repository.commit.slice(0, -1)}x`,
      }),
    ],
    [
      'tree prefix',
      (value: Fixture) => ({ ...value.repository, tree: `x${value.repository.tree.slice(1)}` }),
    ],
    [
      'tree suffix',
      (value: Fixture) => ({
        ...value.repository,
        tree: `${value.repository.tree.slice(0, -1)}x`,
      }),
    ],
  ])('refuses %s independently', (_label, mutate) => {
    const value = fixture();
    refuse(() => verify(value, { repository: mutate(value) as Fixture['repository'] }));
  });

  it.each([
    ['unsafe byte quota', { maximum_bytes: Number.POSITIVE_INFINITY }],
    ['unsafe entry quota', { maximum_entries: Number.POSITIVE_INFINITY }],
    ['zero byte quota', { maximum_bytes: 0 }],
    ['zero entry quota', { maximum_entries: 0 }],
  ])('refuses an %s', (_label, overrides) => {
    refuse(() => verify(fixture(), overrides));
  });

  it('refuses an unreferenced object with an unknown Git type', () => {
    const value = fixture();
    const bytes = Buffer.from('unused');
    const tag = createHash('sha1').update(`tag ${bytes.length}\0`).update(bytes).digest('hex');
    value.objects.set(tag, { type: 'tag' as 'blob', bytes });
    refuse(() => verify(value));
  });

  it('accepts a byte census exactly at its quota', () => {
    const value = fixture();
    const total = [...value.objects.values()].reduce((sum, object) => sum + object.bytes.length, 0);
    expect(verify(value, { maximum_bytes: total }).paths).toEqual(['submodule']);
  });

  it.each([
    ['missing separator', (value: Fixture) => Buffer.from(`tree ${value.repository.tree}\n`)],
    [
      'second tree header',
      (value: Fixture) =>
        Buffer.from(`tree ${value.repository.tree}\ntree ${value.repository.tree}\n\n`),
    ],
    [
      'missing tree header',
      () => Buffer.from('author Fixture <fixture@example.invalid> 0 +0000\n\n'),
    ],
    ['wrong tree header', () => Buffer.from(`tree ${'a'.repeat(40)}\n\n`)],
  ])('refuses a commit with %s', (_label, bytes) => {
    const value = fixture();
    replaceCommit(value, bytes(value));
    refuse(() => verify(value));
  });

  it('refuses a truncated tree entry before exposing its path', () => {
    const complete = entry('160000', 'truncated');
    const value = fixture(complete.subarray(0, complete.length - 1));
    refuse(() => verify(value));
  });

  it.each([
    ['empty name', Buffer.alloc(0), '160000'],
    ['dot name', Buffer.from('.'), '160000'],
    ['dot-dot name', Buffer.from('..'), '160000'],
    ['slash in name', Buffer.from('nested/name'), '160000'],
    ['reserved Git name', Buffer.from('.GiT'), '160000'],
    ['invalid UTF-8', Buffer.from([0xff]), '160000'],
    ['unknown mode', Buffer.from('name'), '100600'],
  ])('refuses a tree entry with %s', (_label, name, mode) => {
    refuse(() => verify(fixture(entry(mode, name))));
  });

  it('counts tree entries independently of the supplied object count', () => {
    const value = fixture(
      Buffer.concat([entry('160000', 'one'), entry('160000', 'three'), entry('160000', 'two')]),
    );
    refuse(() => verify(value, { maximum_entries: 2 }));
  });

  it('accepts an entry census exactly at its quota', () => {
    const value = fixture(Buffer.concat([entry('160000', 'one'), entry('160000', 'two')]));
    expect(verify(value, { maximum_entries: 2 }).paths).toEqual(['one', 'two']);
  });

  it('uses the Git directory slash when validating tree order', () => {
    const childBytes = entry('160000', 'child');
    const child = objectId('tree', childBytes);
    const value = fixture(
      Buffer.concat([entry('160000', 'folder.ext'), entry('40000', 'folder', child)]),
    );
    value.objects.set(child, { type: 'tree', bytes: childBytes });
    expect(verify(value).paths).toEqual(['folder.ext', 'folder/child']);
  });

  it('does not append the Git directory slash to regular files', () => {
    const value = fixture(Buffer.concat([entry('160000', 'file'), entry('160000', 'file.ext')]));
    expect(verify(value).paths).toEqual(['file', 'file.ext']);
  });
});
