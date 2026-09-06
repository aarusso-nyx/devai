import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { canonicalSha256 } from '@devai-nyx/utils';
import {
  canonicalContainerPath,
  decodeContainerDependencyArchive,
  type ContainerArchiveEntry,
  type ContainerDependencyArchiveEntry,
} from './container-archive.js';

export interface ProtectedDependencyInputs {
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
  readonly workspace_packages: readonly {
    readonly path: string;
    readonly name: string;
    readonly manifest_sha256: string;
  }[];
}

export interface ProtectedDependencyTransport {
  readonly entries: ReadonlyMap<string, ContainerDependencyArchiveEntry>;
  readonly inputs: ProtectedDependencyInputs;
  readonly identity_sha256: string;
}

const INVALID = 'release-certification-dependency-identity-invalid';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const packageRoot = /^packages\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const inputPath =
  /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|packages\/[^/]+\/package\.json)$/u;

/** Validate the entire frozen dependency namespace, including cross-volume pnpm links. */
export function validateProtectedDependencyTransport(
  archives: readonly {
    readonly mount_path: string;
    readonly archive: Buffer;
    readonly sha256: string;
    readonly inputs: ProtectedDependencyInputs;
  }[],
  maximumBytes: number,
): ProtectedDependencyTransport {
  const entries = new Map<string, ContainerDependencyArchiveEntry>();
  const directories = new Set<string>();
  const mounts: string[] = [];
  const inputs = archives[0]?.inputs ?? { files: [], workspace_packages: [] };
  let size = 0;
  for (const archive of archives) {
    size += archive.archive.length;
    if (
      size > maximumBytes ||
      !/^(?:node_modules|packages\/[^/]+\/node_modules)$/u.test(archive.mount_path) ||
      !canonicalContainerPath(archive.mount_path) ||
      mounts.some(
        (path) =>
          path === archive.mount_path ||
          path.startsWith(`${archive.mount_path}/`) ||
          archive.mount_path.startsWith(`${path}/`),
      ) ||
      hash(archive.archive) !== archive.sha256 ||
      canonicalSha256(archive.inputs) !== canonicalSha256(inputs)
    )
      throw new Error(INVALID);
    mounts.push(archive.mount_path);
    directories.add(archive.mount_path);
    for (const entry of decodeContainerDependencyArchive(archive.archive, maximumBytes)) {
      const path = `${archive.mount_path}/${entry.path}`;
      if (entries.has(path)) throw new Error(INVALID);
      entries.set(path, { ...entry, path });
      const parts = path.split('/');
      for (let index = 1; index < parts.length; index += 1)
        directories.add(parts.slice(0, index).join('/'));
    }
  }
  const roots = new Map<string, ProtectedDependencyInputs['workspace_packages'][number]>();
  const names = new Set<string>();
  const inputsByPath = new Map(inputs.files.map((file) => [file.path, file.sha256]));
  if (
    inputsByPath.size !== inputs.files.length ||
    inputs.files.some(
      (file) =>
        !canonicalContainerPath(file.path) ||
        !inputPath.test(file.path) ||
        !/^[0-9a-f]{64}$/u.test(file.sha256),
    ) ||
    (archives.length !== 0 &&
      ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].some(
        (path) => !inputsByPath.has(path),
      ))
  )
    throw new Error(INVALID);
  for (const pkg of inputs.workspace_packages) {
    if (
      !packageRoot.test(pkg.path) ||
      roots.has(pkg.path) ||
      names.has(pkg.name) ||
      pkg.name.length === 0 ||
      inputsByPath.get(`${pkg.path}/package.json`) !== pkg.manifest_sha256
    )
      throw new Error(INVALID);
    roots.set(pkg.path, pkg);
    names.add(pkg.name);
  }
  if (inputs.files.length !== (archives.length === 0 ? 0 : roots.size + 3))
    throw new Error(INVALID);
  if (
    mounts.some(
      (mount) => mount !== 'node_modules' && !roots.has(mount.slice(0, -'/node_modules'.length)),
    )
  )
    throw new Error(INVALID);
  if ([...entries.keys()].some((path) => directories.has(path))) throw new Error(INVALID);

  const resolvedLinks = new Map<string, string>();
  function resolveLink(initial: string): string {
    let path = initial;
    const visited = new Set<string>();
    for (;;) {
      if (!canonicalContainerPath(path) || visited.has(path) || visited.size > entries.size)
        throw new Error(INVALID);
      visited.add(path);
      const parts = path.split('/');
      let replaced = false;
      for (let index = 1; index <= parts.length; index += 1) {
        const prefix = parts.slice(0, index).join('/');
        const entry = entries.get(prefix);
        if (entry?.mode !== '120000') continue;
        if (
          entry.target.startsWith('/') ||
          entry.target.includes('\\') ||
          /^[A-Za-z]:/u.test(entry.target) ||
          [...entry.target].some((character) => {
            const code = character.codePointAt(0) ?? 0;
            return code <= 0x1f || code === 0x7f;
          }) ||
          Buffer.from(entry.target).toString('utf8') !== entry.target
        )
          throw new Error(INVALID);
        path = posix.normalize(
          posix.join(posix.dirname(prefix), entry.target, ...parts.slice(index)),
        );
        replaced = true;
        break;
      }
      if (replaced) continue;
      // Workspace indirection terminates at the exact package root, never an output root,
      // arbitrary repository directory or host path. Child suffixes stay within that root.
      if (roots.has(path)) return path;
      if (
        !mounts.some((mount) => path === mount || path.startsWith(`${mount}/`)) ||
        (!entries.has(path) && !directories.has(path))
      )
        throw new Error(INVALID);
      return path;
    }
  }
  for (const [path, entry] of entries) {
    if (entry.mode !== '120000') continue;
    const target = resolveLink(path);
    if (path.startsWith(`${target}/`)) throw new Error(INVALID);
    resolvedLinks.set(path, target);
  }
  const identity = [...entries.values()]
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
    .map((entry) =>
      entry.mode === '120000'
        ? { ...entry, resolved_to: resolvedLinks.get(entry.path) }
        : {
            path: entry.path,
            mode: entry.mode,
            sha256: hash(entry.bytes),
            size_bytes: entry.bytes.length,
          },
    );
  return {
    entries,
    inputs,
    identity_sha256: canonicalSha256({
      protocol: 'pnpm-frozen-links-v1',
      inputs,
      entries: identity,
    }),
  };
}

/** Revalidate immutable workspace/lock identity against the exact source sent to each task. */
export function verifyProtectedDependencyInputs(
  transport: ProtectedDependencyTransport,
  source: readonly ContainerArchiveEntry[],
): void {
  if (transport.inputs.files.length === 0) return;
  const files = new Map(source.map((entry) => [entry.path, entry]));
  for (const input of transport.inputs.files) {
    const entry = files.get(input.path);
    if (entry === undefined || hash(entry.bytes) !== input.sha256) throw new Error(INVALID);
  }
  const manifests = [...files.keys()].filter((path) =>
    /^packages\/[^/]+\/package\.json$/u.test(path),
  );
  if (manifests.length !== transport.inputs.workspace_packages.length) throw new Error(INVALID);
  for (const pkg of transport.inputs.workspace_packages) {
    const file = files.get(`${pkg.path}/package.json`);
    if (file === undefined || hash(file.bytes) !== pkg.manifest_sha256) throw new Error(INVALID);
    const manifest = JSON.parse(file.bytes.toString('utf8')) as { name?: unknown };
    if (manifest.name !== pkg.name) throw new Error(INVALID);
  }
}
