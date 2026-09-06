import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { canonicalContainerPath, type ContainerArchiveEntry } from './container-archive.js';
import type {
  GitReleaseBlobLocator,
  ReleaseLifecycleRequest,
} from './release-lifecycle-execution.js';
import type { ImmutableReleaseContentSource } from './release-prepare-kernel.js';

const INVALID = 'release-certification-git-metadata-invalid';

/**
 * An honest, explicitly shallow candidate repository, constructed without copying host Git
 * configuration, alternates, hooks, credentials, index stat data or a linked-worktree gitdir.
 * This supplies HEAD/status/ls-files/diff against the actual candidate. It intentionally does
 * not claim history availability: a task requiring absent ancestors must fail, never receive
 * a substituted commit. The runner independently verifies the plan's base ancestry on host.
 */
export async function createProtectedCandidateGitMetadata(input: {
  readonly request: ReleaseLifecycleRequest;
  readonly source: readonly ContainerArchiveEntry[];
  readonly locators: ReadonlyMap<string, GitReleaseBlobLocator>;
  readonly content_source: Pick<ImmutableReleaseContentSource, 'readGitObject'>;
  readonly maximum_bytes: number;
}): Promise<readonly ContainerArchiveEntry[]> {
  const { request } = input;
  const format = request.candidate_locator.commit.length === 40 ? 'sha1' : 'sha256';
  const oidBytes = format === 'sha1' ? 20 : 32;
  const candidate = request.candidate_locator;
  const entries: ContainerArchiveEntry[] = [];
  const objects = new Map<string, Buffer>();
  const source = new Map(input.source.map((entry) => [entry.path, entry]));
  const observed = new Set<string>();
  let byteCount = 0;
  let rawObjectBytes = 0;
  if (
    !Number.isSafeInteger(input.maximum_bytes) ||
    input.maximum_bytes < 1024 ||
    source.size !== input.source.length ||
    source.size !== input.locators.size
  )
    throw new Error(INVALID);

  const append = (path: string, bytes: Buffer) => {
    byteCount += bytes.length;
    if (byteCount > input.maximum_bytes) throw new Error(INVALID);
    entries.push({ path, mode: '100644', bytes: Buffer.from(bytes) });
  };
  const store = (type: 'commit' | 'tree' | 'blob', id: string, bytes: Buffer): Buffer => {
    if (!Buffer.isBuffer(bytes)) throw new Error(INVALID);
    const framed = Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes]);
    if (createHash(format).update(framed).digest('hex') !== id) throw new Error(INVALID);
    const previous = objects.get(id);
    if (previous !== undefined) {
      if (!previous.equals(framed)) throw new Error(INVALID);
    } else {
      rawObjectBytes += framed.length;
      if (rawObjectBytes > input.maximum_bytes) throw new Error(INVALID);
      objects.set(id, framed);
      append(`.git/objects/${id.slice(0, 2)}/${id.slice(2)}`, deflateSync(framed));
    }
    return bytes;
  };
  const read = async (type: 'commit' | 'tree', id: string) =>
    store(
      type,
      id,
      await input.content_source.readGitObject({
        repository: request.repository_locator,
        object_format: format,
        object_id: id,
        type,
      }),
    );

  const commit = await read('commit', candidate.commit);
  if (commit.subarray(0, commit.indexOf(10)).toString('utf8') !== `tree ${candidate.tree}`)
    throw new Error(INVALID);
  const pending = [{ id: candidate.tree, prefix: '' }];
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (current === undefined || pending.length > input.maximum_bytes / 20)
      throw new Error(INVALID);
    const tree = await read('tree', current.id);
    let offset = 0;
    const names = new Set<string>();
    while (offset < tree.length) {
      const space = tree.indexOf(32, offset);
      const nul = tree.indexOf(0, space + 1);
      if (space <= offset || nul <= space + 1 || nul + 1 + oidBytes > tree.length)
        throw new Error(INVALID);
      const mode = tree.subarray(offset, space).toString('ascii');
      const nameBytes = tree.subarray(space + 1, nul);
      const name = nameBytes.toString('utf8');
      const path = `${current.prefix}${name}`;
      const id = tree.subarray(nul + 1, nul + 1 + oidBytes).toString('hex');
      offset = nul + 1 + oidBytes;
      if (
        !nameBytes.equals(Buffer.from(name)) ||
        !canonicalContainerPath(name) ||
        name.includes('/') ||
        name.toLowerCase() === '.git' ||
        !canonicalContainerPath(path) ||
        names.has(name)
      )
        throw new Error(INVALID);
      names.add(name);
      if (mode === '40000') {
        pending.push({ id, prefix: `${path}/` });
        continue;
      }
      const file = source.get(path);
      const locator = input.locators.get(path);
      if (
        file === undefined ||
        locator === undefined ||
        observed.has(path) ||
        file.mode !== mode ||
        locator.mode !== mode ||
        locator.object_id !== id ||
        locator.path !== path ||
        locator.commit !== candidate.commit ||
        locator.tree !== candidate.tree
      )
        throw new Error(INVALID);
      observed.add(path);
      store('blob', id, file.bytes);
    }
  }
  if (observed.size !== source.size) throw new Error(INVALID);

  const header = Buffer.alloc(12);
  header.write('DIRC');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(source.size, 8);
  const indexEntries = [...source.values()]
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
    .map((entry) => {
      const locator = input.locators.get(entry.path);
      if (locator === undefined) throw new Error(INVALID);
      const path = Buffer.from(entry.path);
      const fixed = Buffer.alloc(40 + oidBytes + 2);
      fixed.writeUInt32BE(Number.parseInt(entry.mode, 8), 24);
      fixed.writeUInt32BE(entry.bytes.length, 36);
      Buffer.from(locator.object_id, 'hex').copy(fixed, 40);
      fixed.writeUInt16BE(Math.min(path.length, 0xfff), 40 + oidBytes);
      const length = fixed.length + path.length + 1;
      return Buffer.concat([fixed, path, Buffer.alloc(1 + ((8 - (length % 8)) % 8))]);
    });
  const index = Buffer.concat([header, ...indexEntries]);
  append('.git/index', Buffer.concat([index, createHash(format).update(index).digest()]));
  append('.git/HEAD', Buffer.from(`${candidate.commit}\n`));
  append('.git/refs/heads/devai-protected-candidate', Buffer.from(`${candidate.commit}\n`));
  append('.git/shallow', Buffer.from(`${candidate.commit}\n`));
  append(
    '.git/config',
    Buffer.from(
      `[core]\n\trepositoryformatversion = ${format === 'sha1' ? 0 : 1}\n\tbare = false\n\tfilemode = true\n\tfsmonitor = false\n\thooksPath = /dev/null\n${format === 'sha256' ? '[extensions]\n\tobjectFormat = sha256\n' : ''}`,
    ),
  );
  return entries;
}
