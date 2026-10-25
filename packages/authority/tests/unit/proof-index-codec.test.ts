// Independent Inspector contract: pure v2 Git-index byte parsing/planning only.
// Real Git fixtures establish representation validity; no host CAS/action is exercised here.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Format = 'sha1' | 'sha256';
interface Entry {
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
  readonly stage: number;
  readonly assume_valid: boolean;
}
interface Snapshot {
  readonly version: number;
  readonly object_format: Format;
  readonly raw_sha256: string;
  readonly semantic_sha256: string;
  readonly other_entries_sha256: string;
  readonly entries: readonly Entry[];
  readonly has_tree_extension: boolean;
}
interface Update {
  readonly before: Snapshot;
  readonly after: Snapshot;
  readonly bytes_base64: string;
  readonly proof_path: string;
  readonly blob_oid: string;
  readonly mode: string;
}
interface Codec {
  parseProofIndex(bytes: Uint8Array, format: Format): Snapshot;
  planProofIndexUpdate(
    bytes: Uint8Array,
    format: Format,
    replacement: { path: string; mode: string; oid: string },
  ): Update;
}
const MODULE = '../../src/boundaries/proof-index-codec.js';
const codec = async (): Promise<Codec> => (await import(MODULE)) as Codec;
const PROOF = 'record/proofs/chain.json';
const roots: string[] = [];
const fixtures: Fixture[] = [];
interface RawEntry {
  start: number;
  end: number;
  nul: number;
  flags: number;
  entry: Entry;
  raw: Buffer;
}
interface Fixture {
  root: string;
  repo: string;
  format: Format;
  linked: boolean;
  index: Buffer;
  merged: Buffer;
  oid: string;
}
const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');
function git(root: string, args: string[], input?: string, index?: string): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      ...(index === undefined ? {} : { GIT_INDEX_FILE: index }),
    },
  }).trim();
}
function put(root: string, path: string, value: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
}
function commit(root: string, note: string): void {
  git(root, ['add', '--all']);
  git(root, [
    '-c',
    'user.name=Inspector byte fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '--quiet',
    '-m',
    note,
  ]);
}
function createFixture(format: Format, linked: boolean): Fixture {
  const root = mkdtempSync(join(tmpdir(), `devai-index-${format}-`));
  roots.push(root);
  const primary = join(root, 'primary');
  mkdirSync(primary);
  git(primary, [
    'init',
    '--quiet',
    '--template=',
    '--initial-branch=main',
    `--object-format=${format}`,
  ]);
  git(primary, ['config', 'index.version', '2']);
  for (const [path, contents] of [
    [PROOF, 'base chain\n'],
    ['other-conflict.txt', 'base other\n'],
    ['retained space.txt', 'unchanged\n'],
    ['nested/executable.sh', '#!/bin/sh\nexit 0\n'],
  ] as const)
    put(primary, path, contents);
  symlinkSync('retained space.txt', join(primary, 'retained-link'));
  commit(primary, 'test(fixtures): shared index base');
  git(primary, ['update-index', '--chmod=+x', 'nested/executable.sh']);
  git(primary, ['update-index', '--assume-unchanged', 'retained space.txt']);
  const base = git(primary, ['rev-parse', 'HEAD']);
  git(primary, ['update-index', '--add', '--cacheinfo', `160000,${base},retained-gitlink`]);
  git(primary, [
    '-c',
    'user.name=Inspector byte fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '--quiet',
    '-m',
    'test(fixtures): modes and flags',
  ]);
  git(primary, ['switch', '--quiet', '-c', 'feature']);
  put(primary, PROOF, 'feature chain\n');
  put(primary, 'other-conflict.txt', 'feature other\n');
  commit(primary, 'test(fixtures): feature divergence');
  git(primary, ['switch', '--quiet', 'main']);
  put(primary, PROOF, 'main chain\n');
  put(primary, 'other-conflict.txt', 'main other\n');
  commit(primary, 'test(fixtures): main divergence');
  let repo = primary;
  if (linked) {
    repo = join(root, 'linked');
    git(primary, ['worktree', 'add', '--quiet', '-b', 'linked-candidate', repo, 'main']);
  }
  const merged = readFileSync(
    git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'index']),
  );
  try {
    git(repo, [
      '-c',
      'user.name=Inspector byte fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'merge',
      '--no-commit',
      '--no-ff',
      'feature',
    ]);
  } catch {
    /* expected two-path unresolved merge */
  }
  git(repo, ['update-index', '--add', '--cacheinfo', `160000,${base},retained-gitlink`]);
  git(repo, ['update-index', '--chmod=+x', 'nested/executable.sh']);
  git(repo, ['update-index', '--assume-unchanged', 'retained space.txt']);
  git(repo, ['update-index', '--index-version=2']);
  const indexPath = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const index = readFileSync(indexPath);
  const oid = git(repo, ['hash-object', '-w', '--stdin'], 'canonical replacement chain\n');
  return { root, repo, format, linked, index, merged, oid };
}
/** Small independent byte locator, not a validator; Git independently verifies every fixture. */
function rawEntries(bytes: Buffer, format: Format): RawEntry[] {
  const length = format === 'sha1' ? 20 : 32;
  let start = 12;
  const result: RawEntry[] = [];
  for (let index = 0; index < bytes.readUInt32BE(8); index += 1) {
    const flags = bytes.readUInt16BE(start + 40 + length);
    const nul = bytes.indexOf(0, start + 42 + length);
    if (nul < 0) throw new Error('fixture missing NUL');
    const end = start + Math.ceil((nul + 1 - start) / 8) * 8;
    result.push({
      start,
      end,
      nul,
      flags,
      raw: Buffer.from(bytes.subarray(start, end)),
      entry: {
        path: bytes.subarray(start + 42 + length, nul).toString('utf8'),
        mode: bytes.readUInt32BE(start + 24).toString(8),
        oid: bytes.subarray(start + 40, start + 40 + length).toString('hex'),
        stage: (flags >>> 12) & 3,
        assume_valid: (flags & 0x8000) !== 0,
      },
    });
    start = end;
  }
  return result;
}
function extensionNames(bytes: Buffer, format: Format): string[] {
  const entries = rawEntries(bytes, format);
  const last = entries.at(-1);
  let offset = last?.end ?? 12;
  const end = bytes.length - (format === 'sha1' ? 20 : 32);
  const names: string[] = [];
  while (offset < end) {
    names.push(bytes.subarray(offset, offset + 4).toString('ascii'));
    offset += 8 + bytes.readUInt32BE(offset + 4);
  }
  return names;
}
function checksum(bytes: Buffer, format: Format): Buffer {
  const size = format === 'sha1' ? 20 : 32;
  return Buffer.concat([
    bytes.subarray(0, -size),
    createHash(format).update(bytes.subarray(0, -size)).digest(),
  ]);
}
function edit(fixture: Fixture, mutate: (bytes: Buffer, entries: RawEntry[]) => void): Buffer {
  const copy = Buffer.from(fixture.index);
  mutate(copy, rawEntries(copy, fixture.format));
  return checksum(copy, fixture.format);
}
function files(root: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [relative(root, path), sha256(readFileSync(path))];
      }),
  );
}
function fixture(format: Format, linked = false): Fixture {
  const value = fixtures.find((item) => item.format === format && item.linked === linked);
  if (value === undefined) throw new Error('missing independently validated Git fixture');
  return value;
}
function saturatedFixture(item: Fixture) {
  const path = join(item.root, 'saturated-name.index');
  writeFileSync(path, item.index);
  const longPath = Array.from({ length: 22 }, () => 'x'.repeat(190)).join('/');
  git(
    item.repo,
    ['update-index', '--add', '--cacheinfo', `100644,${item.oid},${longPath}`],
    undefined,
    path,
  );
  const index = readFileSync(path);
  const entry = rawEntries(index, item.format).find((row) => row.entry.path === longPath);
  if (entry === undefined) throw new Error('Git did not create saturated-name fixture');
  expect(entry.flags & 0x0fff).toBe(0x0fff);
  expect(git(item.repo, ['ls-files', '--stage'], undefined, path)).toContain(`\t${longPath}`);
  return { index, longPath, entry };
}
beforeAll(() => {
  for (const format of ['sha1', 'sha256'] as const)
    for (const linked of [false, true]) fixtures.push(createFixture(format, linked));
});
beforeAll(() => {
  const custody = process.env.DEVAI_INDEX_CODEC_CUSTODY_DIR;
  if (custody === undefined) return;
  mkdirSync(custody, { recursive: true });
  for (const item of fixtures) {
    const directory = join(custody, `${item.format}-${item.linked ? 'linked' : 'regular'}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'unmerged.index'), item.index);
    writeFileSync(join(directory, 'merged.index'), item.merged);
    writeFileSync(join(directory, 'replacement-blob.txt'), 'canonical replacement chain\n');
    writeFileSync(join(directory, 'saturated-name.index'), saturatedFixture(item).index);
    git(item.repo, ['bundle', 'create', join(directory, 'history.bundle'), '--all']);
    git(item.repo, ['bundle', 'verify', join(directory, 'history.bundle')]);
    writeFileSync(
      join(directory, 'fixture.json'),
      JSON.stringify(
        {
          object_format: item.format,
          linked: item.linked,
          index_sha256: sha256(item.index),
          merged_index_sha256: sha256(item.merged),
          replacement_oid: item.oid,
          unmerged_entries: rawEntries(item.index, item.format).map((row) => row.entry),
          producer:
            'Actual Git init/update-index/ordinary merge; bundle verified by Git. No codec or host mutation capability established.',
        },
        null,
        2,
      ) + '\n',
    );
  }
});
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('independent actual Git index fixtures', () => {
  it.each(['sha1', 'sha256'] as const)(
    'proves regular and linked unresolved %s v2 indices with Git before codec assertions',
    (format) => {
      for (const linked of [false, true]) {
        const item = fixture(format, linked);
        expect(item.index.subarray(0, 4).toString('ascii')).toBe('DIRC');
        expect(item.index.readUInt32BE(4)).toBe(2);
        expect(item.index).toEqual(checksum(item.index, format));
        expect(item.merged.readUInt32BE(4)).toBe(2);
        expect(item.merged).toEqual(checksum(item.merged, format));
        const mergedPath = join(item.root, 'self-merged.index');
        writeFileSync(mergedPath, item.merged);
        expect(
          git(item.repo, ['ls-files', '--stage'], undefined, mergedPath)
            .split('\n')
            .filter((row) => row.endsWith(`\t${PROOF}`)),
        ).toHaveLength(1);
        expect(
          rawEntries(item.merged, format)
            .filter((row) => row.entry.path === PROOF)
            .map((row) => row.entry.stage),
        ).toEqual([0]);

        const rows = git(item.repo, ['ls-files', '--stage']).split('\n');
        expect(rows.filter((row) => row.endsWith(`\t${PROOF}`))).toHaveLength(3);
        expect(rows.filter((row) => row.endsWith('\tother-conflict.txt'))).toHaveLength(3);
        expect(
          rawEntries(item.index, format)
            .filter((row) => row.entry.path === PROOF)
            .map((row) => row.entry.stage),
        ).toEqual([1, 2, 3]);
        if (linked) expect(readFileSync(join(item.repo, '.git'), 'utf8')).toContain('gitdir:');
      }
    },
  );
});

it('proves saturated-name index flags using real Git in both object formats before codec assertions', () => {
  for (const format of ['sha1', 'sha256'] as const) saturatedFixture(fixture(format));
});

it('proves expected zero-cache proof entry and mandatory mode using actual Git before codec assertions', () => {
  for (const format of ['sha1', 'sha256'] as const)
    for (const linked of [false, true]) {
      const item = fixture(format, linked);
      const path = join(item.root, 'git-expected-planned.index');
      writeFileSync(path, item.index);
      git(
        item.repo,
        ['update-index', '--add', '--cacheinfo', `100644,${item.oid},${PROOF}`],
        undefined,
        path,
      );
      const planned = readFileSync(path);
      const proof = rawEntries(planned, format).find((row) => row.entry.path === PROOF);
      if (proof === undefined) throw new Error('Git expected proof entry absent');
      expect(proof.entry).toEqual({
        path: PROOF,
        mode: '100644',
        oid: item.oid,
        stage: 0,
        assume_valid: false,
      });
      expect(proof.raw.subarray(0, 24)).toEqual(Buffer.alloc(24));
      expect(proof.raw.readUInt32BE(24)).toBe(0o100644);
      expect(proof.raw.subarray(28, 40)).toEqual(Buffer.alloc(12));
      expect(
        rawEntries(planned, format)
          .filter((row) => row.entry.path !== PROOF)
          .map((row) => row.raw),
      ).toEqual(
        rawEntries(item.index, format)
          .filter((row) => row.entry.path !== PROOF)
          .map((row) => row.raw),
      );
      expect(
        git(item.repo, ['ls-files', '--stage'], undefined, path)
          .split('\n')
          .filter((row) => row.endsWith(`\t${PROOF}`)),
      ).toEqual([`100644 ${item.oid} 0\t${PROOF}`]);
      const custody = process.env.DEVAI_INDEX_CODEC_CUSTODY_DIR;
      if (custody !== undefined)
        writeFileSync(
          join(custody, `${format}-${linked ? 'linked' : 'regular'}`, 'git-expected-planned.index'),
          planned,
        );
    }
});

describe('pure proof-index codec contract', () => {
  it.each(['sha1', 'sha256'] as const)(
    'accepts Git-created merged stage-zero %s indices and invalidates valid TREE cache',
    async (format) => {
      const api = await codec();
      const item = fixture(format);
      expect(
        rawEntries(item.merged, format)
          .filter((row) => row.entry.path === PROOF)
          .map((row) => row.entry.stage),
      ).toEqual([0]);
      const result = api.planProofIndexUpdate(item.merged, format, {
        path: PROOF,
        mode: '100644',
        oid: item.oid,
      });
      expect(result.before.has_tree_extension).toBe(true);
      expect(result.after.has_tree_extension).toBe(false);
      const planned = Buffer.from(result.bytes_base64, 'base64');
      expect(
        rawEntries(planned, format)
          .filter((row) => row.entry.path !== PROOF)
          .map((row) => row.raw),
      ).toEqual(
        rawEntries(item.merged, format)
          .filter((row) => row.entry.path !== PROOF)
          .map((row) => row.raw),
      );
      const path = join(item.root, 'merged-planned.index');
      writeFileSync(path, planned);
      expect(
        git(item.repo, ['ls-files', '--stage'], undefined, path)
          .split('\n')
          .filter((row) => row.endsWith(`\t${PROOF}`)),
      ).toEqual([`100644 ${item.oid} 0\t${PROOF}`]);
    },
  );
  it.each(['sha1', 'sha256'] as const)(
    'plans exactly one proof entry for both regular and linked %s indices, preserving other raw bytes',
    async (format) => {
      const api = await codec();
      for (const linked of [false, true]) {
        const item = fixture(format, linked);
        const beforeFiles = files(item.root);
        const result = api.planProofIndexUpdate(item.index, format, {
          path: PROOF,
          mode: '100644',
          oid: item.oid,
        });
        expect(files(item.root)).toEqual(beforeFiles);
        expect(result.before.entries).toEqual(
          rawEntries(item.index, format).map((row) => row.entry),
        );
        expect(result.before.raw_sha256).toBe(sha256(item.index));
        const canonical = (entries: readonly Entry[]) =>
          JSON.stringify(
            entries.map((entry) => ({
              assume_valid: entry.assume_valid,
              mode: entry.mode,
              oid: entry.oid,
              path: entry.path,
              stage: entry.stage,
            })),
          );
        expect(result.before.semantic_sha256).toBe(
          sha256(canonical(rawEntries(item.index, format).map((row) => row.entry))),
        );
        expect(result.before.other_entries_sha256).toBe(
          sha256(
            canonical(
              rawEntries(item.index, format)
                .filter((row) => row.entry.path !== PROOF)
                .map((row) => row.entry),
            ),
          ),
        );
        expect(result.after.other_entries_sha256).toBe(result.before.other_entries_sha256);
        expect(result.after.entries.filter((entry) => entry.path === PROOF)).toEqual([
          { path: PROOF, mode: '100644', oid: item.oid, stage: 0, assume_valid: false },
        ]);
        const output = Buffer.from(result.bytes_base64, 'base64');
        expect(
          rawEntries(output, format)
            .filter((row) => row.entry.path !== PROOF)
            .map((row) => row.raw),
        ).toEqual(
          rawEntries(item.index, format)
            .filter((row) => row.entry.path !== PROOF)
            .map((row) => row.raw),
        );
        const replacementEntry = rawEntries(output, format).find((row) => row.entry.path === PROOF);
        if (replacementEntry === undefined) throw new Error('planned proof entry absent');
        expect(replacementEntry.raw.subarray(0, 24)).toEqual(Buffer.alloc(24));
        expect(replacementEntry.raw.readUInt32BE(24)).toBe(0o100644);
        expect(replacementEntry.raw.subarray(28, 40)).toEqual(Buffer.alloc(12));
        expect(api.parseProofIndex(output, format)).toEqual(result.after);
        expect(result).toMatchObject({ proof_path: PROOF, blob_oid: item.oid, mode: '100644' });
        expect(result.after.has_tree_extension).toBe(false);
        const planned = join(item.root, 'planned.index');
        writeFileSync(planned, output);
        const rows = git(item.repo, ['ls-files', '--stage'], undefined, planned).split('\n');
        expect(rows.filter((row) => row.endsWith(`\t${PROOF}`))).toEqual([
          `100644 ${item.oid} 0\t${PROOF}`,
        ]);
        expect(rows.filter((row) => row.endsWith('\tother-conflict.txt'))).toHaveLength(3);
        const original = Buffer.from(item.index);
        const snapshot = api.parseProofIndex(original, format);
        original.fill(0);
        expect(snapshot.raw_sha256).toBe(sha256(item.index));
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.entries)).toBe(true);
        for (const entry of snapshot.entries) expect(Object.isFrozen(entry)).toBe(true);
        expect(Object.isFrozen(result)).toBe(true);
        for (const report of [result.before, result.after]) {
          expect(Object.isFrozen(report)).toBe(true);
          expect(Object.isFrozen(report.entries)).toBe(true);
          for (const entry of report.entries) expect(Object.isFrozen(entry)).toBe(true);
        }
      }
    },
  );

  it('accepts no-extension and saturated-name indices independently read by Git', async () => {
    const api = await codec();
    const item = fixture('sha1');
    const entries = rawEntries(item.index, 'sha1');
    const last = entries.at(-1);
    if (last === undefined) throw new Error('fixture has no entries');
    const body = item.index.subarray(0, last.end);
    const plain = Buffer.concat([body, createHash('sha1').update(body).digest()]);
    const plainPath = join(item.root, 'without-extensions.index');
    writeFileSync(plainPath, plain);
    expect(git(item.repo, ['ls-files', '--stage'], undefined, plainPath)).toBe(
      git(item.repo, ['ls-files', '--stage']),
    );
    expect(api.parseProofIndex(plain, 'sha1').has_tree_extension).toBe(false);
    const longPath = Array.from({ length: 22 }, () => 'x'.repeat(190)).join('/');
    git(
      item.repo,
      ['update-index', '--add', '--cacheinfo', `100644,${item.oid},${longPath}`],
      undefined,
      plainPath,
    );
    const saturated = readFileSync(plainPath);
    const longEntry = rawEntries(saturated, 'sha1').find((row) => row.entry.path === longPath);
    if (longEntry === undefined) throw new Error('Git did not create saturated-name fixture');
    expect(longEntry.flags & 0x0fff).toBe(0x0fff);
    expect(
      api.parseProofIndex(saturated, 'sha1').entries.some((entry) => entry.path === longPath),
    ).toBe(true);
    const planned = api.planProofIndexUpdate(saturated, 'sha1', {
      path: PROOF,
      mode: '100755',
      oid: item.oid,
    });
    expect(planned.after.entries.find((entry) => entry.path === longPath)).toEqual(longEntry.entry);
  });

  it.each([
    'header',
    'checksum',
    'count',
    'padding',
    'NUL',
    'name-length',
    'utf8',
    'path',
    'ordering',
    'duplicate',
    'mixed-stage',
    'mode',
    'extended-flags',
  ] as const)('refuses malformed %s without mutating input', async (defect) => {
    const api = await codec();
    const item = fixture('sha1');
    let input = edit(item, (bytes, entries) => {
      const first = entries[0];
      const second = entries[1];
      if (first === undefined || second === undefined) throw new Error('fixture too small');
      if (defect === 'header') bytes.write('NOPE', 0, 'ascii');
      if (defect === 'checksum') bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 255;
      if (defect === 'count') bytes.writeUInt32BE(entries.length + 1, 8);
      if (defect === 'padding') {
        if (first.nul + 1 >= first.end) throw new Error('fixture needs padding');
        bytes[first.nul + 1] = 1;
      }
      if (defect === 'NUL') bytes[first.nul] = 1;
      if (defect === 'name-length')
        bytes.writeUInt16BE(
          (first.flags & ~0x0fff) | ((first.flags + 1) & 0x0fff),
          first.start + 60,
        );
      if (defect === 'utf8') bytes[first.start + 62] = 255;
      if (defect === 'path') bytes[first.start + 62] = '/'.charCodeAt(0);
      if (defect === 'ordering') bytes[first.start + 62] = 'z'.charCodeAt(0);
      if (defect === 'duplicate') {
        const proof = entries.filter((entry) => entry.entry.path === PROOF);
        const one = proof[0];
        const two = proof[1];
        if (one === undefined || two === undefined) throw new Error('missing conflict');
        bytes.writeUInt16BE(one.flags, two.start + 60);
      }
      if (defect === 'mixed-stage') {
        const one = entries.find((entry) => entry.entry.path === PROOF);
        if (one === undefined) throw new Error('missing conflict');
        bytes.writeUInt16BE(one.flags & ~0x3000, one.start + 60);
      }
      if (defect === 'mode') bytes.writeUInt32BE(0o040000, first.start + 24);
      if (defect === 'extended-flags') bytes.writeUInt16BE(first.flags | 0x4000, first.start + 60);
    });
    if (defect === 'checksum') {
      input = Buffer.from(item.index);
      input[input.length - 1] = (input[input.length - 1] ?? 0) ^ 255;
    }
    const preserved = Buffer.from(input);
    expect(() => api.parseProofIndex(input, 'sha1')).toThrow(
      /PROOF_INDEX_(INVALID|FORMAT_UNSUPPORTED)/u,
    );
    expect(input).toEqual(preserved);
  });

  it.each(['sha1', 'sha256'] as const)(
    'refuses truncation, unsupported version/extension, and wrong object format for %s',
    async (format) => {
      const api = await codec();
      const item = fixture(format);
      const size = format === 'sha1' ? 20 : 32;
      expect(() => api.parseProofIndex(item.index.subarray(0, -1), format)).toThrow(
        /PROOF_INDEX_INVALID/u,
      );
      expect(() =>
        api.parseProofIndex(
          edit(item, (bytes) => bytes.writeUInt32BE(4, 4)),
          format,
        ),
      ).toThrow(/PROOF_INDEX_FORMAT_UNSUPPORTED/u);
      const body = item.index.subarray(0, -size);
      const extension = Buffer.alloc(8);
      extension.write('UNKN', 0, 'ascii');
      const unknown = Buffer.concat([body, extension]);
      const complete = Buffer.concat([unknown, createHash(format).update(unknown).digest()]);
      expect(() => api.parseProofIndex(complete, format)).toThrow(
        /PROOF_INDEX_FORMAT_UNSUPPORTED/u,
      );
      expect(() => api.parseProofIndex(item.index, format === 'sha1' ? 'sha256' : 'sha1')).toThrow(
        /PROOF_INDEX_INVALID/u,
      );
    },
  );

  it.each(['path', 'mode', 'oid-length', 'oid-hex', 'absent-proof'] as const)(
    'refuses replacement %s',
    async (defect) => {
      const api = await codec();
      const item = fixture('sha1');
      const replacement = { path: PROOF, mode: '100644', oid: item.oid };
      if (defect === 'path') replacement.path = 'business/source.ts';
      if (defect === 'mode') replacement.mode = '120000';
      if (defect === 'oid-length') replacement.oid = 'a'.repeat(64);
      if (defect === 'oid-hex') replacement.oid = 'z'.repeat(40);
      let input = item.index;
      if (defect === 'absent-proof') {
        const absent = join(item.root, 'absent-proof.index');
        writeFileSync(absent, item.index);
        git(item.repo, ['update-index', '--force-remove', '--', PROOF], undefined, absent);
        input = readFileSync(absent);
        expect(extensionNames(input, 'sha1')).toContain('REUC');
        expect(() => api.parseProofIndex(input, 'sha1')).toThrow(/PROOF_INDEX_FORMAT_UNSUPPORTED/u);
        const custody = process.env.DEVAI_INDEX_CODEC_CUSTODY_DIR;
        if (custody !== undefined)
          writeFileSync(join(custody, 'sha1-regular', 'absent-with-REUC.index'), input);
        git(item.repo, ['update-index', '--clear-resolve-undo'], undefined, absent);
        input = readFileSync(absent);
        expect(extensionNames(input, 'sha1').every((name) => name === 'TREE')).toBe(true);
        if (custody !== undefined)
          writeFileSync(join(custody, 'sha1-regular', 'absent-without-REUC.index'), input);
        expect(git(item.repo, ['ls-files', '--stage'], undefined, absent)).not.toContain(
          `\t${PROOF}`,
        );
      }
      expect(() => api.planProofIndexUpdate(input, 'sha1', replacement)).toThrow(
        /PROOF_INDEX_REPLACEMENT_REFUSED/u,
      );
    },
  );
});
