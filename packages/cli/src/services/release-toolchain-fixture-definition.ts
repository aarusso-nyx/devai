import { canonicalSha256 } from '@devai-nyx/utils';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBoundReleaseHostPackageSnapshot } from './release-host-package-binding.js';
import type { ReleasePackageSnapshot } from './release-package-snapshot.js';

export interface ReleaseToolchainFixtureDefinition {
  readonly schemaVersion: '1.0.0';
  readonly definition_sha256: string;
  readonly manifest: readonly {
    /** Destination in the fixed diagnostic candidate, not a host pathname. */
    readonly path: string;
    readonly mode: number;
    readonly size: number;
    readonly sha256: string;
  }[];
  readonly read: (path: string) => Buffer;
}

const INVALID = 'release-toolchain-fixture-definition-invalid';
const PREFIX = 'dist/runtime/fixtures/mutation-toolchain/';
const SOURCE = 'packages/cli/tests/fixtures/mutation-toolchain';
const DRIVER = 'scripts/release-host/mutation-diagnostic.mjs';
const MAXIMUM_FILE_BYTES = 64 * 1024;
// This is the source-owned population, not a caller-supplied manifest. Dynamic
// registered init bindings, the lockfile and host/devai.tgz are deliberately not
// fixture constants; the protected composition must bind them independently.
const FIXTURE = [
  ['fixture-root-gitignore', '.gitignore'],
  ['fixture-root-readme.md', 'README.md'],
  ['diagnostic-adoption.json', 'law/policy/diagnostic-adoption.json'],
  ['root-package.json', 'package.json'],
  ['packages/fixture/package.json', 'packages/fixture/package.json'],
  ['subject.ts', 'packages/fixture/src/subject.ts'],
  ['packages/fixture/src/zero.ts', 'packages/fixture/src/zero.ts'],
  ['packages/fixture/stryker.config.json', 'packages/fixture/stryker.config.json'],
  ['packages/fixture/tests/subject.test.ts.fixture', 'packages/fixture/tests/subject.test.ts'],
  ['packages/fixture/tsconfig.json', 'packages/fixture/tsconfig.json'],
  ['packages/fixture/vitest.config.cjs', 'packages/fixture/vitest.config.cjs'],
  ['root-pnpm-workspace.yaml', 'pnpm-workspace.yaml'],
  ['test-tasks.json', 'test-tasks.json'],
] as const;
const paths = [...FIXTURE.map(([, path]) => path), 'host/run-diagnostic.mjs'].sort();
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function refuse(): never {
  // Never expose a rejected filesystem path, member contents or native error.
  throw new Error(INVALID);
}

function definition(population: ReadonlyMap<string, Buffer>): ReleaseToolchainFixtureDefinition {
  if (JSON.stringify([...population.keys()].sort()) !== JSON.stringify(paths)) refuse();
  const bytes = new Map<string, Buffer>();
  const manifest = Object.freeze(
    paths.map((path) => {
      const member = population.get(path);
      if (member === undefined || member.length > MAXIMUM_FILE_BYTES) refuse();
      const captured = Buffer.from(member);
      bytes.set(path, captured);
      return Object.freeze({ path, mode: 0o644, size: captured.length, sha256: hash(captured) });
    }),
  );
  return Object.freeze({
    schemaVersion: '1.0.0',
    definition_sha256: canonicalSha256({ schemaVersion: '1.0.0', manifest }),
    manifest,
    read: (path: string): Buffer => {
      const member = bytes.get(path);
      if (member === undefined) refuse();
      return Buffer.from(member);
    },
  });
}

/** Private installed runtime read: only the exact permanently bound capture. */
export function loadReleaseToolchainFixtureDefinition(
  snapshot: ReleasePackageSnapshot,
): ReleaseToolchainFixtureDefinition {
  try {
    assertBoundReleaseHostPackageSnapshot(snapshot);
    const expectedPaths = ['manifest.json', ...paths.map((path) => `files/${path}.fixture`)].sort();
    const entries = snapshot.manifest.filter((entry) => entry.path.startsWith(PREFIX));
    if (
      JSON.stringify(entries.map((entry) => entry.path.slice(PREFIX.length)).sort()) !==
        JSON.stringify(expectedPaths) ||
      entries.some((entry) => entry.mode !== 0o644 || entry.size > MAXIMUM_FILE_BYTES)
    )
      refuse();
    const result = definition(
      new Map(paths.map((path) => [path, snapshot.read(`${PREFIX}files/${path}.fixture`)])),
    );
    // Recompute rather than accepting a manifest-selected census or digest. The
    // manifest is generated data and must equal the deterministic full projection.
    const expectedManifest = Buffer.from(JSON.stringify(result, null, 2) + '\n');
    if (!snapshot.read(`${PREFIX}manifest.json`).equals(expectedManifest)) refuse();
    return result;
  } catch {
    return refuse();
  }
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function directoryNames(path: string, maximum: number): string[] {
  const directory = opendirSync(path, { bufferSize: 16 });
  const result: string[] = [];
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      if (result.length >= maximum) refuse();
      result.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return result.sort();
}

/**
 * Source/build-only data capture. Its root comes from this module's source or
 * unassembled compiler location; installed layout cannot fall back to source.
 * Descriptor and full fixture-directory revalidation detect races, but are not
 * native openat containment against adversarial ABA swaps in host-owned parents.
 * The returned data is never a package, compatibility or execution authority brand.
 */
export function loadSourceReleaseToolchainFixtureDefinition(): ReleaseToolchainFixtureDefinition {
  const directories = new Map<string, { fd: number; metadata: BigIntStats; expected?: string[] }>();
  const files: { path: string; metadata: BigIntStats }[] = [];
  try {
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const stageDirectory = dirname(moduleDirectory);
    const cliDirectory = dirname(stageDirectory);
    if (
      basename(moduleDirectory) !== 'services' ||
      !['src', 'dist'].includes(basename(stageDirectory)) ||
      basename(cliDirectory) !== 'cli' ||
      basename(dirname(cliDirectory)) !== 'packages'
    )
      refuse();
    const root = resolve(cliDirectory, '../..');
    const entries = [
      ...FIXTURE.map(([source, path]) => [`${SOURCE}/${source}`, path]),
      [DRIVER, 'host/run-diagnostic.mjs'],
    ] as const;
    // Build the exact allowed ancestor census before touching any source bytes.
    const fixtureDirectories = new Map<string, Set<string>>();
    for (const [source] of FIXTURE) {
      const parts = source.split('/');
      for (let index = 0; index < parts.length; index += 1) {
        const parent = join(root, SOURCE, ...parts.slice(0, index));
        const names = fixtureDirectories.get(parent) ?? new Set<string>();
        const name = parts[index];
        if (name === undefined) refuse();
        names.add(name);
        fixtureDirectories.set(parent, names);
      }
    }
    for (const [source] of entries) {
      const parts = source.split('/');
      for (let index = 0; index < parts.length; index += 1) {
        const path = join(root, ...parts.slice(0, index));
        if (directories.has(path)) continue;
        const metadata = lstatSync(path, { bigint: true });
        if (!metadata.isDirectory()) refuse();
        const fd = openSync(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
        );
        const expected = fixtureDirectories.get(path);
        directories.set(path, {
          fd,
          metadata,
          ...(expected === undefined ? {} : { expected: [...expected].sort() }),
        });
        if (!sameStat(metadata, fstatSync(fd, { bigint: true }))) refuse();
      }
    }
    const verifyDirectories = (): void => {
      for (const [path, entry] of directories) {
        if (
          !sameStat(entry.metadata, lstatSync(path, { bigint: true })) ||
          !sameStat(entry.metadata, fstatSync(entry.fd, { bigint: true })) ||
          (entry.expected !== undefined &&
            JSON.stringify(directoryNames(path, entry.expected.length)) !==
              JSON.stringify(entry.expected))
        )
          refuse();
      }
    };
    verifyDirectories();
    const population = new Map<string, Buffer>();
    for (const [source, destination] of entries) {
      const path = join(root, source);
      const metadata = lstatSync(path, { bigint: true });
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1n ||
        (metadata.mode & 0o7777n) !== 0o644n ||
        metadata.size > BigInt(MAXIMUM_FILE_BYTES)
      )
        refuse();
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!sameStat(metadata, fstatSync(fd, { bigint: true }))) refuse();
        const bytes = Buffer.alloc(Number(metadata.size));
        let offset = 0;
        while (offset < bytes.length) {
          const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (count === 0) refuse();
          offset += count;
        }
        if (
          readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 ||
          !sameStat(metadata, fstatSync(fd, { bigint: true })) ||
          !sameStat(metadata, lstatSync(path, { bigint: true }))
        )
          refuse();
        population.set(destination, bytes);
        files.push({ path, metadata });
      } finally {
        closeSync(fd);
      }
    }
    verifyDirectories();
    for (const file of files)
      if (!sameStat(file.metadata, lstatSync(file.path, { bigint: true }))) refuse();
    return definition(population);
  } catch {
    return refuse();
  } finally {
    let failed = false;
    for (const entry of directories.values()) {
      try {
        closeSync(entry.fd);
      } catch {
        failed = true;
      }
    }
    if (failed) refuse();
  }
}
