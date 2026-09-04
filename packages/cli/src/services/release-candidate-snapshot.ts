import { createHash } from 'node:crypto';

export interface ReleaseCandidateSnapshot {
  readonly repository: { readonly id: string; readonly commit: string; readonly tree: string };
  readonly paths: readonly string[];
  readonly read: (path: string) => Buffer;
}

export interface ReleaseGitObject {
  readonly type: 'commit' | 'tree' | 'blob';
  readonly bytes: Uint8Array;
}

const verifiedSnapshots = new WeakSet<object>();
const INVALID = 'rpl-policy-resolution-mismatch';

export function isVerifiedReleaseCandidateSnapshot(
  value: unknown,
): value is ReleaseCandidateSnapshot {
  return value !== null && typeof value === 'object' && verifiedSnapshots.has(value);
}

/**
 * Verify Git membership entirely from raw objects. Every reachable tree is required,
 * making the path census complete; only blobs actually read need to be supplied.
 * No checkout, executable, network, mutable path or Git configuration participates.
 */
export function verifyReleaseCandidateSnapshot(input: {
  readonly repository: { readonly id: string; readonly commit: string; readonly tree: string };
  readonly objects: ReadonlyMap<string, ReleaseGitObject>;
  readonly maximum_bytes: number;
  readonly maximum_entries: number;
}): ReleaseCandidateSnapshot {
  const fail = (): never => {
    throw new Error(INVALID);
  };
  try {
    const repository = { ...input.repository };
    if (
      Object.keys(repository).sort().join(',') !== 'commit,id,tree' ||
      typeof repository.id !== 'string' ||
      repository.id.length === 0 ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(repository.commit) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(repository.tree) ||
      repository.commit.length !== repository.tree.length ||
      !Number.isSafeInteger(input.maximum_bytes) ||
      input.maximum_bytes < 1 ||
      !Number.isSafeInteger(input.maximum_entries) ||
      input.maximum_entries < 1
    )
      return fail();
    const format = repository.commit.length === 40 ? 'sha1' : 'sha256';
    const idBytes = repository.commit.length / 2;
    const objects = new Map<string, { readonly type: string; readonly bytes: Buffer }>();
    let total = 0;
    for (const [id, object] of input.objects) {
      if (!['commit', 'tree', 'blob'].includes(object.type)) return fail();
      const bytes = Buffer.from(object.bytes);
      total += bytes.length;
      if (total > input.maximum_bytes || objects.size >= input.maximum_entries) return fail();
      const hash = createHash(format)
        .update(`${object.type} ${bytes.length}\0`)
        .update(bytes)
        .digest('hex');
      if (hash !== id) return fail();
      objects.set(id, { type: object.type, bytes });
    }
    const readObject = (id: string, type: string): Buffer => {
      const object = objects.get(id);
      return object?.type === type ? object.bytes : fail();
    };
    const commit = readObject(repository.commit, 'commit');
    const headerEnd = commit.indexOf(Buffer.from('\n\n'));
    if (headerEnd < 0) return fail();
    const headers = commit.subarray(0, headerEnd).toString('utf8').split('\n');
    if (
      headers[0] !== `tree ${repository.tree}` ||
      headers.filter((line) => line.startsWith('tree ')).length !== 1
    )
      return fail();
    const files = new Map<string, { readonly id: string; readonly mode: string }>();
    const pending = [{ id: repository.tree, prefix: '' }];
    let entries = 0;
    for (let cursor = 0; cursor < pending.length; cursor += 1) {
      const tree = pending[cursor];
      if (tree === undefined) return fail();
      const bytes = readObject(tree.id, 'tree');
      let offset = 0;
      let previous: Buffer | undefined;
      const names = new Set<string>();
      while (offset < bytes.length) {
        const space = bytes.indexOf(32, offset);
        const nul = bytes.indexOf(0, space + 1);
        if (space <= offset || nul <= space + 1 || nul + 1 + idBytes > bytes.length) return fail();
        const mode = bytes.subarray(offset, space).toString('utf8');
        const nameBytes = bytes.subarray(space + 1, nul);
        const name = nameBytes.toString('utf8');
        const id = bytes.subarray(nul + 1, nul + 1 + idBytes).toString('hex');
        offset = nul + 1 + idBytes;
        entries += 1;
        if (
          entries > input.maximum_entries ||
          !['40000', '100644', '100755', '120000', '160000'].includes(mode) ||
          !Buffer.from(name, 'utf8').equals(nameBytes) ||
          name.includes('/') ||
          name === '.' ||
          name === '..' ||
          name.toLowerCase() === '.git' ||
          names.has(name)
        )
          return fail();
        names.add(name);
        const sortKey = Buffer.concat([
          nameBytes,
          mode === '40000' ? Buffer.from('/') : Buffer.alloc(0),
        ]);
        if (previous !== undefined && Buffer.compare(previous, sortKey) >= 0) return fail();
        previous = sortKey;
        const path = `${tree.prefix}${name}`;
        if (mode === '40000') {
          pending.push({ id, prefix: `${path}/` });
        } else {
          if (files.has(path)) return fail();
          files.set(path, { id, mode });
        }
      }
    }
    const snapshot = Object.freeze({
      repository: Object.freeze(repository),
      paths: Object.freeze(
        [...files.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
      ),
      read: (path: string): Buffer => {
        const entry = files.get(path);
        if (entry === undefined || (entry.mode !== '100644' && entry.mode !== '100755'))
          return fail();
        return Buffer.from(readObject(entry.id, 'blob'));
      },
    });
    verifiedSnapshots.add(snapshot);
    return snapshot;
  } catch {
    return fail();
  }
}
