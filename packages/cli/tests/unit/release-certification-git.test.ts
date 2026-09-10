import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { ContainerArchiveEntry } from '../../src/services/container-archive.js';
import { createProtectedCandidateGitMetadata } from '../../src/services/release-certification-git.js';
import type {
  GitReleaseBlobLocator,
  ReleaseLifecycleRequest,
} from '../../src/services/release-lifecycle-execution.js';

const INVALID = 'release-certification-git-metadata-invalid';
const FILE_BYTES = Buffer.from('protected candidate\n', 'utf8');

type GitObjectType = 'commit' | 'tree' | 'blob';

function gitObject(type: GitObjectType, bytes: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${String(bytes.length)}\0`, 'utf8'), bytes]);
}

function gitObjectId(
  type: GitObjectType,
  bytes: Buffer,
  format: 'sha1' | 'sha256' = 'sha1',
): string {
  return createHash(format).update(gitObject(type, bytes)).digest('hex');
}

function treeEntry(
  name: string,
  bytes = FILE_BYTES,
  mode = '100644',
  format: 'sha1' | 'sha256' = 'sha1',
): Buffer {
  return Buffer.concat([
    Buffer.from(`${mode} ${name}\0`, 'utf8'),
    Buffer.from(gitObjectId('blob', bytes, format), 'hex'),
  ]);
}

function rawTreeEntry(name: Buffer, bytes = FILE_BYTES): Buffer {
  return Buffer.concat([
    Buffer.from('100644 ', 'ascii'),
    name,
    Buffer.from([0]),
    Buffer.from(gitObjectId('blob', bytes), 'hex'),
  ]);
}

interface Fixture {
  readonly request: ReleaseLifecycleRequest;
  readonly source: readonly ContainerArchiveEntry[];
  readonly locators: ReadonlyMap<string, GitReleaseBlobLocator>;
  readonly objects: ReadonlyMap<string, Readonly<{ type: 'commit' | 'tree'; bytes: Buffer }>>;
}

function fixture(
  input: {
    readonly name?: string;
    readonly candidate_tree_bytes?: Buffer;
    readonly delivered_tree_bytes?: Buffer;
    readonly commit_tree?: string;
    readonly locator?: Readonly<Partial<GitReleaseBlobLocator>>;
    readonly format?: 'sha1' | 'sha256';
  } = {},
): Fixture {
  const name = input.name ?? 'file.txt';
  const format = input.format ?? 'sha1';
  const candidateTreeBytes =
    input.candidate_tree_bytes ?? treeEntry(name, FILE_BYTES, '100644', format);
  const candidateTree = gitObjectId('tree', candidateTreeBytes, format);
  const deliveredTreeBytes = input.delivered_tree_bytes ?? candidateTreeBytes;
  const commitBytes = Buffer.from(
    [
      `tree ${input.commit_tree ?? candidateTree}`,
      'author Fixture <fixture@example.invalid> 0 +0000',
      'committer Fixture <fixture@example.invalid> 0 +0000',
      '',
      'fixture',
      '',
    ].join('\n'),
    'utf8',
  );
  const commit = gitObjectId('commit', commitBytes, format);
  const source = [{ path: name, mode: '100644' as const, bytes: FILE_BYTES }];
  const exactLocator: GitReleaseBlobLocator = {
    kind: 'git-object',
    repository: 'fixture/repository',
    commit,
    tree: candidateTree,
    object_format: format,
    path: name,
    mode: '100644',
    object_id: gitObjectId('blob', FILE_BYTES, format),
    size_bytes: FILE_BYTES.length,
    content_digest_sha256: createHash('sha256').update(FILE_BYTES).digest('hex'),
    ...input.locator,
  };
  return {
    request: {
      schemaVersion: '1.0.0',
      request_kind: 'release-lifecycle-request',
      action_id: 'release certify',
      repository_locator: { id: 'fixture/repository', commit, tree: candidateTree },
      candidate_locator: { commit, tree: candidateTree, release_units: [] },
    },
    source,
    locators: new Map([[name, exactLocator]]),
    objects: new Map([
      [commit, { type: 'commit', bytes: commitBytes }],
      [candidateTree, { type: 'tree', bytes: deliveredTreeBytes }],
    ]),
  };
}

function createMetadata(value: Fixture, maximumBytes = 64 * 1024) {
  return createProtectedCandidateGitMetadata({
    request: value.request,
    source: value.source,
    locators: value.locators,
    content_source: {
      readGitObject: ({ type, object_id }) => {
        const object = value.objects.get(object_id);
        if (object === undefined || object.type !== type)
          throw new Error('fixture Git object missing');
        return Buffer.from(object.bytes);
      },
    },
    maximum_bytes: maximumBytes,
  });
}

function expectedIndex(value: Fixture): Buffer {
  const source = value.source[0];
  if (source === undefined) throw new Error('fixture source missing');
  const locator = value.locators.get(source.path);
  if (locator === undefined) throw new Error('fixture locator missing');
  const header = Buffer.alloc(12);
  header.write('DIRC');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(1, 8);
  const path = Buffer.from(source.path, 'utf8');
  const format = locator.object_format;
  const oidBytes = format === 'sha1' ? 20 : 32;
  const fixed = Buffer.alloc(40 + oidBytes + 2);
  fixed.writeUInt32BE(Number.parseInt(source.mode, 8), 24);
  fixed.writeUInt32BE(source.bytes.length, 36);
  Buffer.from(locator.object_id, 'hex').copy(fixed, 40);
  fixed.writeUInt16BE(path.length, 40 + oidBytes);
  const unpaddedLength = fixed.length + path.length + 1;
  const entry = Buffer.concat([fixed, path, Buffer.alloc(1 + ((8 - (unpaddedLength % 8)) % 8))]);
  const index = Buffer.concat([header, entry]);
  return Buffer.concat([index, createHash(format).update(index).digest()]);
}

describe('protected candidate Git metadata', () => {
  it('emits exact object paths, Git index v2 bytes, and shallow HEAD identity', async () => {
    const value = fixture();
    const entries = await createMetadata(value);
    const byPath = new Map(entries.map((entry) => [entry.path, entry.bytes]));
    const commit = value.request.candidate_locator.commit;
    const tree = value.request.candidate_locator.tree;
    const blob = gitObjectId('blob', FILE_BYTES);
    expect([...byPath.keys()]).toEqual([
      `.git/objects/${commit.slice(0, 2)}/${commit.slice(2)}`,
      `.git/objects/${tree.slice(0, 2)}/${tree.slice(2)}`,
      `.git/objects/${blob.slice(0, 2)}/${blob.slice(2)}`,
      '.git/index',
      '.git/HEAD',
      '.git/refs/heads/devai-protected-candidate',
      '.git/shallow',
      '.git/config',
    ]);
    expect(byPath.get('.git/index')).toEqual(expectedIndex(value));
    expect(byPath.get('.git/HEAD')).toEqual(Buffer.from(`${commit}\n`, 'utf8'));
    expect(byPath.get('.git/refs/heads/devai-protected-candidate')).toEqual(
      Buffer.from(`${commit}\n`, 'utf8'),
    );
    expect(byPath.get('.git/shallow')).toEqual(Buffer.from(`${commit}\n`, 'utf8'));
    expect(
      inflateSync(byPath.get(`.git/objects/${blob.slice(0, 2)}/${blob.slice(2)}`) ?? []),
    ).toEqual(gitObject('blob', FILE_BYTES));
  });

  it('refuses a tree whose delivered bytes do not match its requested object id', async () => {
    const candidateTreeBytes = treeEntry('file.txt');
    const value = fixture({
      name: 'other.txt',
      candidate_tree_bytes: candidateTreeBytes,
      delivered_tree_bytes: treeEntry('other.txt'),
    });
    await expect(createMetadata(value)).rejects.toThrow(INVALID);
  });

  it('declares the exact SHA-256 repository extension and index identity', async () => {
    const value = fixture({ format: 'sha256' });
    const entries = await createMetadata(value);
    const byPath = new Map(entries.map((entry) => [entry.path, entry.bytes]));
    expect(byPath.get('.git/index')).toEqual(expectedIndex(value));
    expect(byPath.get('.git/config')?.toString('utf8')).toBe(
      '[core]\n\trepositoryformatversion = 1\n\tbare = false\n\tfilemode = true\n\tfsmonitor = false\n\thooksPath = /dev/null\n[extensions]\n\tobjectFormat = sha256\n',
    );
  });

  it('refuses a commit that does not bind the requested candidate tree', async () => {
    const value = fixture({ commit_tree: 'f'.repeat(40) });
    await expect(createMetadata(value)).rejects.toThrow(INVALID);
  });

  it.each([1023, Number.NaN])(
    'refuses the invalid metadata byte ceiling %s',
    async (maximumBytes) => {
      await expect(createMetadata(fixture(), maximumBytes)).rejects.toThrow(INVALID);
    },
  );

  it.each([
    ['a path separator', 'dir/file', treeEntry('dir/file')],
    ['invalid UTF-8', '\ufffd', rawTreeEntry(Buffer.from([0xff]))],
  ] as const)('refuses a tree entry name containing %s', async (_label, name, tree) => {
    await expect(createMetadata(fixture({ name, candidate_tree_bytes: tree }))).rejects.toThrow(
      INVALID,
    );
  });

  it('refuses the reserved Git metadata name without case sensitivity', async () => {
    const value = fixture({ name: '.GiT' });
    await expect(createMetadata(value)).rejects.toThrow(INVALID);
  });

  it.each([
    ['path', { path: 'other.txt' }],
    ['commit', { commit: 'f'.repeat(40) }],
  ] as const)('refuses a blob locator with a mismatched %s', async (_label, locator) => {
    const value = fixture({ locator });
    await expect(createMetadata(value)).rejects.toThrow(INVALID);
  });
});
