import { lstatSync, readlinkSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readCandidateFile } from '@devai-nyx/sensors';
import { canonicalize, sha256Hex } from '../../services/check-runner/canonical.js';
import {
  committedSnapshot,
  currentRepositoryState,
  gitText,
  isHarnessMutatedPath,
  worktreeSnapshot,
} from '../../services/check-runner/policy-git.js';

interface LinkMember {
  readonly path: string;
  readonly mode: '100644' | '100755';
  readonly contentDigest: string;
}

interface LinkEntry {
  readonly path: string;
  readonly mode: '120000';
  readonly literalSha256: string;
  readonly target: string;
  readonly targetMode: 'directory';
  readonly targetPopulationSha256: string;
  readonly members: readonly LinkMember[];
}

export interface NativeCandidateLinkMetadata {
  readonly version: 'tracked-unconsumed-directory-links-v1';
  readonly entries: readonly LinkEntry[];
}

type Entry = ReturnType<typeof committedSnapshot>[number];
function fail(code: string): never {
  throw new Error(`NATIVE_CANDIDATE_LINK_${code}`);
}
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const denied = new Set([
  '.git',
  'node_modules',
  '.devai',
  'record',
  'scratch',
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.secrets',
  'secrets',
  'credentials',
  '.npmrc',
  '.yarnrc',
  '.netrc',
]);

function namespaceAllowed(path: string): void {
  if (
    path.split('/').some((part) => {
      const lower = part.toLowerCase();
      return denied.has(lower) || lower === '.env' || lower.startsWith('.env.');
    })
  )
    fail('TARGET_NAMESPACE_REFUSED');
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

function canonicalPath(path: string): void {
  if (
    path === '' ||
    path !== path.normalize('NFC') ||
    isAbsolute(path) ||
    path.includes('\\') ||
    hasControl(path) ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    fail('PATH_INVALID');
}

function fingerprint(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  return canonicalize({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

/** Check components lexically; an internal directory alias grants no follow permission. */
function regularDirectories(root: string, path: string): void {
  let current = root;
  for (const part of path.split('/').filter(Boolean)) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      fail('TARGET_INVALID');
    }
    if (stat.isSymbolicLink()) fail('TARGET_NONREGULAR');
    if (!stat.isDirectory()) fail('TARGET_INVALID');
  }
}

function observeLink(
  root: string,
  path: string,
  committed: ReadonlyMap<string, Entry>,
  inputs: ReadonlySet<string>,
): { entry: LinkEntry; observations: readonly unknown[] } {
  namespaceAllowed(path);
  const parent = dirname(path);
  regularDirectories(root, parent === '.' ? '' : parent);
  const absolute = resolve(root, path);
  const initial = fingerprint(absolute);
  if (!lstatSync(absolute).isSymbolicLink()) fail('GIT_MISMATCH');
  const raw = readlinkSync(absolute, { encoding: 'buffer' });
  const literal = raw.toString('utf8');
  if (
    !Buffer.from(literal, 'utf8').equals(raw) ||
    literal !== literal.normalize('NFC') ||
    literal === '' ||
    isAbsolute(literal) ||
    /^[A-Za-z]:/u.test(literal) ||
    literal.includes('\\') ||
    hasControl(literal)
  )
    fail('TARGET_INVALID');
  const source = committed.get(path);
  if (
    source?.mode !== '120000' ||
    source.type !== 'blob' ||
    source.contentDigest !== sha256Hex(raw)
  )
    fail('GIT_MISMATCH');
  const absoluteTarget = resolve(dirname(absolute), literal);
  const target = relative(root, absoluteTarget);
  if (
    target === '' ||
    target === '..' ||
    target.startsWith(`..${sep}`) ||
    isAbsolute(target) ||
    path === target ||
    path.startsWith(`${target}/`)
  )
    fail('TARGET_INVALID');
  canonicalPath(target);
  namespaceAllowed(target);
  regularDirectories(root, target);
  if (realpathSync(absoluteTarget) !== absoluteTarget) fail('TARGET_INVALID');
  const expected = [...committed.values()].filter((entry) => entry.path.startsWith(`${target}/`));
  if (expected.length === 0) fail('TARGET_UNTRACKED');
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  for (const member of expected) {
    namespaceAllowed(member.path);
    if (member.type !== 'blob' || !['100644', '100755'].includes(member.mode))
      fail('TARGET_NONREGULAR');
    if (!inputs.has(member.path)) throw new Error('SENSE_NATIVE_CONFIG_CLOSURE_INCOMPLETE');
  }
  const members: LinkMember[] = [];
  const observations: unknown[] = [{ path, stat: initial, literalSha256: sha256Hex(raw) }];
  const walk = (directory: string): void => {
    const directoryPath = resolve(root, directory);
    const before = fingerprint(directoryPath);
    if (!lstatSync(directoryPath).isDirectory()) fail('TARGET_NONREGULAR');
    const names = readdirSync(directoryPath).sort(order);
    observations.push({ path: directory, stat: before, names });
    for (const name of names) {
      const memberPath = `${directory}/${name}`;
      canonicalPath(memberPath);
      namespaceAllowed(memberPath);
      const absoluteMember = resolve(root, memberPath);
      const stat = lstatSync(absoluteMember);
      if (stat.isSymbolicLink()) fail('TARGET_NONREGULAR');
      if (stat.isDirectory()) {
        if (!expected.some((entry) => entry.path.startsWith(`${memberPath}/`)))
          fail('TARGET_UNTRACKED');
        walk(memberPath);
      } else if (stat.isFile() && stat.nlink === 1) {
        const wanted = expectedByPath.get(memberPath);
        if (wanted === undefined) fail('TARGET_UNTRACKED');
        const mode = stat.mode & 0o111 ? '100755' : '100644';
        if (wanted.mode !== mode) fail('GIT_MISMATCH');
        const fileBefore = fingerprint(absoluteMember);
        const contentDigest = sha256Hex(readCandidateFile(root, memberPath));
        if (contentDigest !== wanted.contentDigest) fail('GIT_MISMATCH');
        if (fingerprint(absoluteMember) !== fileBefore) fail('OBSERVATION_CHANGED');
        members.push(Object.freeze({ path: memberPath, mode, contentDigest }));
        observations.push({ path: memberPath, stat: fileBefore, contentDigest });
      } else fail('TARGET_NONREGULAR');
    }
    if (fingerprint(directoryPath) !== before) fail('OBSERVATION_CHANGED');
  };
  walk(target);
  members.sort((a, b) => order(a.path, b.path));
  if (
    canonicalize(members.map((entry) => entry.path)) !==
    canonicalize(expected.map((entry) => entry.path).sort(order))
  )
    fail('TARGET_UNTRACKED');
  if (
    fingerprint(absolute) !== initial ||
    !readlinkSync(absolute, { encoding: 'buffer' }).equals(raw)
  )
    fail('OBSERVATION_CHANGED');
  return {
    entry: Object.freeze({
      path,
      mode: '120000',
      literalSha256: sha256Hex(raw),
      target,
      targetMode: 'directory',
      targetPopulationSha256: sha256Hex(members),
      members: Object.freeze(members),
    }),
    observations,
  };
}

/** Private selection metadata only: actual alias reads remain prohibited by native provenance. */
export function nativeCandidateLinkMetadata(
  repoRoot: string,
  inputPaths: readonly string[],
): NativeCandidateLinkMetadata {
  const root = realpathSync(repoRoot);
  const inputs = new Set(inputPaths);
  const index = gitText(root, ['ls-files', '-s', '-z']);
  const tracked = new Map<string, string>();
  for (const row of index.split('\0').filter(Boolean)) {
    const parsed = /^(\d+) [0-9a-f]+ 0\t(.+)$/u.exec(row);
    if (parsed?.[1] === undefined || parsed[2] === undefined) fail('GIT_MISMATCH');
    const path = parsed[2];
    canonicalPath(path);
    if (tracked.has(path)) fail('GIT_MISMATCH');
    tracked.set(path, parsed[1]);
  }
  const links: string[] = [];
  for (const [path, mode] of [...tracked].sort(([a], [b]) => order(a, b))) {
    if (isHarnessMutatedPath(path)) continue;
    if (!inputs.has(path)) throw new Error('SENSE_NATIVE_CONFIG_CLOSURE_INCOMPLETE');
    if (mode === '120000') links.push(path);
    else readCandidateFile(root, path);
  }
  const version = 'tracked-unconsumed-directory-links-v1' as const;
  if (links.length === 0) return Object.freeze({ version, entries: Object.freeze([]) });
  const state = currentRepositoryState(root);
  if (!state.clean) fail('CANDIDATE_DIRTY');
  const snapshot = committedSnapshot(root, state.commit).filter(
    (entry) => !isHarnessMutatedPath(entry.path),
  );
  const working = () => worktreeSnapshot(root).filter((entry) => !isHarnessMutatedPath(entry.path));
  if (canonicalize(snapshot) !== canonicalize(working())) fail('GIT_MISMATCH');
  const committed = new Map(snapshot.map((entry) => [entry.path, entry]));
  const observe = (path: string) => {
    try {
      return observeLink(root, path, committed, inputs);
    } catch (error) {
      // Disappearing/retyped paths between observations are a refusal, never partial metadata.
      if (error !== null && typeof error === 'object' && 'code' in error)
        fail('OBSERVATION_CHANGED');
      throw error;
    }
  };
  const first = links.map(observe);
  const second = links.map(observe);
  if (canonicalize(first) !== canonicalize(second)) fail('OBSERVATION_CHANGED');
  const final = currentRepositoryState(root);
  if (
    !final.clean ||
    final.commit !== state.commit ||
    final.tree !== state.tree ||
    gitText(root, ['ls-files', '-s', '-z']) !== index
  )
    fail('CANDIDATE_CHANGED');
  if (canonicalize(snapshot) !== canonicalize(working())) fail('OBSERVATION_CHANGED');
  return Object.freeze({ version, entries: Object.freeze(first.map(({ entry }) => entry)) });
}
