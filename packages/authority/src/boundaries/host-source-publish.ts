import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

export interface SourcePublication {
  readonly root: string;
  readonly target: string;
  readonly expected:
    Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'file'; sha256: string; mode: number }>;
  readonly content: string;
  readonly sha256: string;
}

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const conflict = (): never => {
  throw new Error('SOURCE_PUBLICATION_CONFLICT');
};

/** Private final effect. Only a broker-approved guarded host operation may invoke this. */
export function publishSourceFile(
  input: SourcePublication,
  hooks: Readonly<{ beforeFinalCheck?: () => void; afterPublish?: () => void }> = {},
): { readonly sha256: string } {
  const root = realpathSync(input.root);
  if (root !== resolve(input.root)) return conflict();
  const target = resolve(root, input.target);
  const rel = relative(root, target);
  if (rel !== input.target || rel === '' || rel.startsWith(`..${sep}`)) return conflict();
  const parents = [root];
  let current = root;
  for (const part of input.target.split('/').slice(0, -1)) {
    current = join(current, part);
    parents.push(current);
  }
  const parentIdentities = parents.map((path) => {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) return conflict();
    return { path, dev: stat.dev, ino: stat.ino };
  });
  const verifyParents = () => {
    for (const identity of parentIdentities) {
      const stat = lstatSync(identity.path, { bigint: true });
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== identity.dev ||
        stat.ino !== identity.ino
      )
        conflict();
    }
  };
  let initialIdentity: { dev: number; ino: number } | undefined;
  const checkTarget = () => {
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (input.expected.kind === 'absent') {
      if (stat !== undefined) conflict();
      return;
    }
    if (stat === undefined) return conflict();
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o7777) !== input.expected.mode
    )
      conflict();
    if (initialIdentity && (stat.dev !== initialIdentity.dev || stat.ino !== initialIdentity.ino))
      conflict();
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const observed = fstatSync(fd);
      if (
        !observed.isFile() ||
        observed.nlink !== 1 ||
        observed.dev !== stat.dev ||
        observed.ino !== stat.ino ||
        hash(readFileSync(fd)) !== input.expected.sha256
      )
        conflict();
      initialIdentity ??= { dev: observed.dev, ino: observed.ino };
    } finally {
      closeSync(fd);
    }
  };
  const bytes = Buffer.from(input.content, 'utf8');
  if (bytes.toString('utf8') !== input.content || hash(bytes) !== input.sha256) return conflict();
  verifyParents();
  checkTarget();
  const stage = join(dirname(target), `.${basename(target)}.${randomUUID()}.source-staged`);
  const fd = openSync(stage, 'wx', 0o600);
  let owned: ReturnType<typeof fstatSync>;
  try {
    owned = fstatSync(fd);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      /* Report the uncertain staging entry. */
    }
    throw Object.assign(new Error('SOURCE_PUBLICATION_STAGING_REMAINS', { cause: error }), {
      detail: JSON.stringify({
        target: input.target,
        staged: basename(stage),
        identity: 'unavailable',
      }),
    });
  }
  let published = false;
  let open = true;
  try {
    writeFileSync(fd, bytes);
    fchmodSync(fd, input.expected.kind === 'file' ? input.expected.mode : 0o644);
    fsyncSync(fd);
    closeSync(fd);
    open = false;
    hooks.beforeFinalCheck?.();
    verifyParents();
    checkTarget();
    if (input.expected.kind === 'absent') linkSync(stage, target);
    else renameSync(stage, target);
    published = true;
    hooks.afterPublish?.();
    const result = lstatSync(target);
    if (
      !result.isFile() ||
      result.dev !== owned.dev ||
      result.ino !== owned.ino ||
      hash(readFileSync(target)) !== input.sha256
    )
      throw new Error('SOURCE_PUBLICATION_INDETERMINATE');
    if (input.expected.kind === 'absent') {
      const staged = lstatSync(stage);
      if (staged.dev !== owned.dev || staged.ino !== owned.ino)
        throw new Error('SOURCE_PUBLICATION_INDETERMINATE');
      unlinkSync(stage);
    }
    const directory = openSync(dirname(target), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    verifyParents();
    const final = lstatSync(target);
    if (
      !final.isFile() ||
      final.dev !== owned.dev ||
      final.ino !== owned.ino ||
      hash(readFileSync(target)) !== input.sha256
    )
      throw new Error('SOURCE_PUBLICATION_INDETERMINATE');
    return { sha256: input.sha256 };
  } catch (error) {
    if (open)
      try {
        closeSync(fd);
      } catch {
        /* Preserve the original failure. */
      }
    if (published) {
      let observed = 'unavailable';
      try {
        const stat = lstatSync(target);
        if (stat.isFile() && !stat.isSymbolicLink()) observed = hash(readFileSync(target));
      } catch {
        /* Observation itself may fail. */
      }
      throw Object.assign(new Error('SOURCE_PUBLICATION_INDETERMINATE', { cause: error }), {
        detail: JSON.stringify({
          target: input.target,
          staged: basename(stage),
          dev: String(owned.dev),
          ino: String(owned.ino),
          observed_sha256: observed,
        }),
      });
    }
    let stageRemoved = false;
    try {
      verifyParents();
      const stat = lstatSync(stage);
      if (stat.dev === owned.dev && stat.ino === owned.ino) {
        unlinkSync(stage);
        stageRemoved = true;
      }
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code === 'ENOENT') stageRemoved = true;
    }
    if (!stageRemoved)
      throw Object.assign(new Error('SOURCE_PUBLICATION_STAGING_REMAINS', { cause: error }), {
        detail: JSON.stringify({
          target: input.target,
          staged: basename(stage),
          dev: String(owned.dev),
          ino: String(owned.ino),
        }),
      });
    throw error;
  }
}
