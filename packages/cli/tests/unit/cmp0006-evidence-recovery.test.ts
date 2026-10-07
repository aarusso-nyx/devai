// ADR-EVI-0005 IA-006/IA-007; INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020.
// These disposable adopter fixtures use the actual bindings, public CLI, physical proof writer
// and verifier. No mocked authority, recovery result or verification verdict establishes PASS.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import {
  appendRecord,
  loadChain,
  resolveProofAnchor,
  saveChain,
  verifyChain,
} from '../../../evidence/src/evidence/chain.js';
import { appendProofEpochRecord } from '../../../evidence/src/evidence/proof-epoch.js';
import { appendVerbEvidence } from '../../../evidence/src/evidence/verb-evidence.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const BIN = join(ROOT, '.devai/state/pr-bootstrap/cli/bin.js');
const CHAIN = 'record/proofs/chain.json';
const BASELINE = 'record/proofs/anchor-baseline.json';
const PATH = 'record/proofs/work/generic/R-0007.jsonl';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai newest-line ç-'));
  roots.push(root);
  return root;
}

function invoke(root: string, argv: readonly string[]) {
  const result = spawnSync(process.execPath, [BIN, ...argv], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  expect(result.signal, result.stderr).toBeNull();
  return { exit: result.status, stdout: result.stdout, stderr: result.stderr };
}

function verify(root: string, write = false) {
  return invoke(root, [
    'evidence',
    'verify',
    '--scope',
    'chain',
    '--repo-root',
    root,
    ...(write ? ['--write'] : []),
  ]);
}

function recover(
  root: string,
  path = PATH,
  sequence = '3',
  extra: readonly string[] = [],
  write = true,
) {
  return invoke(root, [
    'evidence',
    'record',
    '--recover-newest-line',
    '--proof-path',
    path,
    // Equals keeps a negative value inside the option rather than making it a separate flag.
    ...(sequence.startsWith('-')
      ? [`--proof-sequence=${sequence}`]
      : ['--proof-sequence', sequence]),
    '--repo-root',
    root,
    '--as-role',
    'inspector',
    ...(write ? ['--write'] : []),
    ...extra,
  ]);
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const name = relative(root, path);
    if (entry.isSymbolicLink()) files[name] = `symlink:${readlinkSync(path)}`;
    else if (entry.isFile()) files[name] = readFileSync(path).toString('base64');
  }
  return files;
}

function withoutChain(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).filter(([path]) => path !== CHAIN));
}

/** Snapshot stored record bytes, excluding the mutable head and array closing delimiter. */
function recordPopulation(root: string): string {
  const population = /"records": \[([\s\S]*)\n {2}\]/u.exec(
    readFileSync(join(root, CHAIN), 'utf8'),
  )?.[1];
  if (population === undefined || population.trim().length === 0) {
    throw new Error('fixture has no stored chain record population');
  }
  return population;
}

/** Bind only through the real verbs. Architect here is a test-fixture actor, not the author role. */
function boundRoot(): string {
  const root = tempRoot();
  for (const args of [
    ['--tier', 'tier1', '--constitution'],
    ['--operational-law'],
    ['--subprocess-effects'],
    [],
  ]) {
    const result = invoke(root, [
      'init',
      'bind',
      ...args,
      '--target',
      root,
      '--as-role',
      'architect',
      '--write',
    ]);
    expect(result, `binding ${args.join(' ')}`).toMatchObject({ exit: 0, stderr: '' });
  }
  return root;
}

function normalRecord(root: string, note: string, round = 'R-0007') {
  return invoke(root, [
    'evidence',
    'record',
    '--kind',
    'generic',
    '--round',
    round,
    '--payload',
    JSON.stringify({ note }),
    '--repo-root',
    root,
    '--as-role',
    'inspector',
    '--write',
  ]);
}

async function crashFixture() {
  const root = boundRoot();
  for (const note of ['first historical bytes', 'second historical bytes']) {
    expect(normalRecord(root, note)).toMatchObject({ exit: 0, stderr: '' });
  }
  expect(verify(root, true)).toMatchObject({ exit: 0, stderr: '' });
  const prior = loadChain(join(root, CHAIN));
  // Execute the real first write, then stop before the second write (appendVerbEvidence).
  // This is the exact durable state of the writer dying between its two operations.
  const crashed = await withAuthorityHostTestScope(() =>
    appendProofEpochRecord({
      repoRoot: root,
      roundId: 'R-0007',
      kind: 'generic',
      payload: { note: 'crashed newest ç' },
    }),
  );
  expect(crashed.sequence).toBe(3);
  expect(loadChain(join(root, CHAIN))).toEqual(prior);
  const observed = verify(root, true);
  expect(observed.exit).toBe(2);
  expect(observed.stderr).toContain('UNANCHORED_NEWEST_LINE');
  expect(observed.stderr).toContain(`${PATH}:3`);
  return { root, prior, bytes: readFileSync(join(root, PATH)), files: snapshot(root) };
}

function expectRefused(root: string, run: () => ReturnType<typeof invoke>) {
  const before = snapshot(root);
  const result = run();
  expect(snapshot(root)).toEqual(before);
  expect(result.exit, result.stderr).not.toBe(0);
  // Refusal probes cannot pass merely because the new public spelling is absent or setup broke.
  expect(result.stderr).not.toMatch(/Unknown option|authority policy missing|MODULE_NOT_FOUND/u);
  expect(result.stderr.trim().length).toBeGreaterThan(0);
}

function newestBytes(root: string): Buffer {
  const lines = readFileSync(join(root, PATH)).subarray(0, -1).toString('utf8').split('\n');
  const newest = lines.at(-1);
  if (newest === undefined) throw new Error('missing crash line');
  return Buffer.from(newest);
}

async function duplicateAnchor(root: string, digest?: string) {
  await withAuthorityHostTestScope(() => {
    if (digest === undefined) {
      const result = appendVerbEvidence({
        repoRoot: root,
        action: 'evidence.record.generic',
        status: 'completed',
        proofAnchor: { path: PATH, sequence: 3 },
      });
      expect(result).toMatchObject({ ok: true });
    } else {
      // Keep the cryptographic chain valid while crafting the contradictory anchor.
      const draft = {
        id: 'EV-0645000000000001',
        timestamp: '2026-10-02T00:00:00.000Z',
        actor: 'devai-cli',
        actor_role: 'harness',
        action: 'evidence.record.generic',
        status: 'completed',
        context: { repo_root: root, git: { head_sha: null, dirty_files: [] } },
        proof_path: PATH,
        proof_sequence: 3,
        proof_sha256: digest,
      };
      appendRecord(join(root, CHAIN), draft);
    }
  });
}

// Every case runs the built CLI as a subprocess, most several times (record, verify, recover):
// 4.5-6.7 s each alone without coverage at load 5, and three of them exceeded 30 s at load 55-65
// (#342's affected check). The RC coverage lane's 15 s default leaves no margin under its own
// instrumentation, so each case gets a 60 s hang guard sized for that measured cost (#246).
describe('ADR-EVI-0005 public newest-line recovery', { timeout: 60_000 }, () => {
  it('keeps the existing record and real chain verification positive paths', () => {
    const root = boundRoot();
    expect(normalRecord(root, 'existing behavior')).toMatchObject({ exit: 0, stderr: '' });
    expect(verify(root, true)).toMatchObject({ exit: 0, stderr: '' });
    const before = snapshot(root);
    expect(verify(root)).toMatchObject({ exit: 0, stderr: '' });
    expect(snapshot(root)).toEqual(before);
  });

  it('advertises the accepted recovery spelling on the existing public action', () => {
    const result = invoke(tempRoot(), ['evidence', 'record', '--help']);
    expect(result.exit).toBe(0);
    for (const flag of ['--recover-newest-line', '--proof-path', '--proof-sequence'])
      expect(result.stdout).toContain(flag);
  });

  it('appends exactly one missing anchor without changing any historical bytes, then verifies and safely retries', async () => {
    const { root, prior, bytes, files } = await crashFixture();
    const oldRecordBytes = recordPopulation(root);
    const result = recover(root);
    expect(result, result.stderr).toMatchObject({ exit: 0, stderr: '' });
    expect(readFileSync(join(root, PATH))).toEqual(bytes);
    expect(withoutChain(snapshot(root))).toEqual(withoutChain(files));
    const recovered = loadChain(join(root, CHAIN));
    expect(recovered.records).toHaveLength(prior.records.length + 1);
    expect(recovered.records.slice(0, -1)).toEqual(prior.records);
    expect(recordPopulation(root).startsWith(oldRecordBytes)).toBe(true);
    const last = recovered.records.at(-1);
    expect(last).toMatchObject({
      proof_path: PATH,
      proof_sequence: 3,
      proof_sha256: createHash('sha256').update(newestBytes(root)).digest('hex'),
    });
    expect(last?.proof_sha256).not.toBe(
      (JSON.parse(newestBytes(root).toString('utf8')) as { line_hash: string }).line_hash,
    );
    expect(recovered.head).toBe(last?.manifest_hash);
    const verified = verify(root);
    expect(verified, verified.stderr).toMatchObject({ exit: 0, stderr: '' });
    expect(JSON.parse(verified.stdout)).toMatchObject({ valid: true, declarations: [] });
    const after = snapshot(root);
    expect(recover(root)).toMatchObject({ exit: 0, stderr: '' });
    expect(snapshot(root)).toEqual(after);
  });

  it('recovers a one-line epoch with no chain file without writing a baseline', async () => {
    const root = boundRoot();
    await withAuthorityHostTestScope(() =>
      appendProofEpochRecord({
        repoRoot: root,
        roundId: 'R-0007',
        kind: 'generic',
        payload: { note: 'first-write crash' },
      }),
    );
    const before = snapshot(root);
    expect(recover(root, PATH, '1')).toMatchObject({ exit: 0, stderr: '' });
    expect(withoutChain(snapshot(root))).toEqual(before);
    expect(loadChain(join(root, CHAIN)).records).toHaveLength(1);
    expect(verify(root, true)).toMatchObject({ exit: 0, stderr: '' });
  });

  it('does not hide an unrelated older orphan after recovering the eligible newest line', async () => {
    const { root, prior } = await crashFixture();
    const other = 'record/proofs/work/generic/R-0008.jsonl';
    await withAuthorityHostTestScope(() => {
      appendProofEpochRecord({
        repoRoot: root,
        roundId: 'R-0008',
        kind: 'generic',
        payload: { note: 'older orphan' },
      });
      appendProofEpochRecord({
        repoRoot: root,
        roundId: 'R-0008',
        kind: 'generic',
        payload: { note: 'anchored newest' },
      });
      expect(
        appendVerbEvidence({
          repoRoot: root,
          action: 'evidence.record.generic',
          status: 'completed',
          proofAnchor: { path: other, sequence: 2 },
        }),
      ).toMatchObject({ ok: true });
    });
    expect(verify(root, true).exit).toBe(2);
    const before = snapshot(root);
    expect(recover(root)).toMatchObject({ exit: 0, stderr: '' });
    expect(withoutChain(snapshot(root))).toEqual(withoutChain(before));
    expect(loadChain(join(root, CHAIN)).records).toHaveLength(prior.records.length + 2);
    const observed = verify(root);
    expect(observed.exit).toBe(2);
    expect(observed.stderr).toContain(`${other}:1`);
    expect(observed.stderr).not.toContain(`${PATH}:3`);
  });

  it.each([
    ['backslash', 'record\\proofs\\work\\generic\\R-0007.jsonl', '3'],
    ['mixed separator', 'record/proofs/work/generic\\R-0007.jsonl', '3'],
    ['dot segment', 'record/proofs/work/generic/./R-0007.jsonl', '3'],
    ['escape', '../record/proofs/work/generic/R-0007.jsonl', '3'],
    ['internal traversal', 'record/proofs/work/other/../generic/R-0007.jsonl', '3'],
    ['absolute path', '/record/proofs/work/generic/R-0007.jsonl', '3'],
    ['invalid round', 'record/proofs/work/generic/R-7.jsonl', '3'],
    ['invalid kind', 'record/proofs/work/Generic/R-0007.jsonl', '3'],
    ['zero', PATH, '0'],
    ['negative', PATH, '-1'],
    ['fraction', PATH, '2.5'],
    ['non-number', PATH, 'three'],
    ['unsafe integer', PATH, '9007199254740993'],
    ['outside epoch', PATH, '4'],
    ['older anchored', PATH, '1'],
  ])('refuses %s before changing any file', async (_, path, sequence) => {
    const { root } = await crashFixture();
    expectRefused(root, () => recover(root, path, sequence));
  });

  it('refuses an older orphan rather than manufacturing historical provenance', async () => {
    const { root } = await crashFixture();
    await withAuthorityHostTestScope(() =>
      appendProofEpochRecord({
        repoRoot: root,
        roundId: 'R-0007',
        kind: 'generic',
        payload: { note: 'newer physical line' },
      }),
    );
    expectRefused(root, () => recover(root));
  });

  it('refuses missing explicit write consent', async () => {
    const { root } = await crashFixture();
    expectRefused(root, () => recover(root, PATH, '3', [], false));
  });

  it('refuses changed physical bytes after their baseline observation', async () => {
    const { root } = await crashFixture();
    const bytes = readFileSync(join(root, PATH), 'utf8').replace(
      'crashed newest ç',
      'changed newest ç',
    );
    writeFileSync(join(root, PATH), bytes);
    expectRefused(root, () => recover(root));
  });

  // ADR-EVI-0005 IA-002/IA-007: absence of a baseline cannot hide defective older anchors.
  it.each(['digest mismatch', 'duplicate population'] as const)(
    'refuses an older anchor %s with no baseline even when the cryptographic chain is valid',
    async (defect) => {
      const { root } = await crashFixture();
      rmSync(join(root, BASELINE));
      const chain = loadChain(join(root, CHAIN));
      const [first, second] = chain.records;
      if (first === undefined || second === undefined) throw new Error('missing older anchors');
      const physical = resolveProofAnchor(root, { path: PATH, sequence: 1 });
      expect(physical.resolved).toBe(true);
      if (!physical.resolved) throw new Error('older physical line does not resolve');
      expect(first.proof_sha256).toBe(physical.sha256);
      if (defect === 'digest mismatch') {
        first.proof_sha256 = '0'.repeat(64);
        expect(first.proof_sha256).not.toBe(physical.sha256);
      } else {
        second.proof_path = PATH;
        second.proof_sequence = 1;
        second.proof_sha256 = physical.sha256;
        expect(
          chain.records.filter(
            (record) => record.proof_path === PATH && record.proof_sequence === 1,
          ),
        ).toHaveLength(2);
      }
      // Structured anchor fields are outside the manifest hash; the observed defect must not
      // collapse into a generic broken cryptographic chain fixture.
      await withAuthorityHostTestScope(() => saveChain(join(root, CHAIN), chain));
      expect(verifyChain(join(root, CHAIN))).toMatchObject({ valid: true, errors: [] });
      expect(
        chain.records.filter((record) => record.proof_path === PATH && record.proof_sequence === 3),
      ).toEqual([]);
      expect(existsSync(join(root, BASELINE))).toBe(false);
      expectRefused(root, () => recover(root));
    },
  );

  it('refuses changed committed older proof bytes when both the chain and baseline are absent', async () => {
    const { root, bytes } = await crashFixture();
    rmSync(join(root, CHAIN));
    rmSync(join(root, BASELINE));
    const git = (args: readonly string[]): string => {
      const result = spawnSync('git', [...args], {
        cwd: root,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        },
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      if (result.error !== undefined) throw result.error;
      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    // This is a disposable fixture commit, never a commit in the author worktree.
    git(['init', '--quiet', '--template=', '--initial-branch=fixture']);
    git(['add', '--', PATH]);
    git([
      '-c',
      'user.name=Inspector recovery fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--quiet',
      '-m',
      'test(fixtures): preserve proof history',
    ]);
    expect(git(['show', `HEAD:${PATH}`])).toBe(bytes.toString('utf8'));
    const newest = newestBytes(root);
    // Leading JSON whitespace preserves parsed content and every internal line hash, while
    // changing the committed physical bytes of line 1. The newest crash residue stays exact.
    writeFileSync(join(root, PATH), Buffer.concat([Buffer.from(' '), bytes]));
    expect(newestBytes(root)).toEqual(newest);
    expect(git(['diff', '--name-only', 'HEAD', '--', PATH])).toBe(`${PATH}\n`);
    expect(existsSync(join(root, CHAIN))).toBe(false);
    expect(existsSync(join(root, BASELINE))).toBe(false);
    // snapshot includes Git/config metadata as well as proofs and checks absent-file population.
    expectRefused(root, () => recover(root));
  });

  it('refuses a non-newline tail', async () => {
    const { root, bytes } = await crashFixture();
    writeFileSync(join(root, PATH), bytes.subarray(0, -1));
    expectRefused(root, () => recover(root));
  });

  it.each(['file', 'parent'] as const)(
    'refuses a %s symlink and preserves its external target',
    async (type) => {
      const { root } = await crashFixture();
      const external = tempRoot();
      if (type === 'file') {
        cpSync(join(root, PATH), join(external, 'epoch.jsonl'));
        rmSync(join(root, PATH));
        symlinkSync(join(external, 'epoch.jsonl'), join(root, PATH));
      } else {
        renameSync(dirname(join(root, PATH)), join(external, 'generic'));
        symlinkSync(join(external, 'generic'), dirname(join(root, PATH)), 'dir');
      }
      const target = snapshot(external);
      expectRefused(root, () => recover(root));
      expect(snapshot(external)).toEqual(target);
      expect(
        lstatSync(type === 'file' ? join(root, PATH) : dirname(join(root, PATH))).isSymbolicLink(),
      ).toBe(true);
    },
  );

  it('refuses two exact anchors instead of treating ambiguity as a safe retry', async () => {
    const { root } = await crashFixture();
    await duplicateAnchor(root);
    await duplicateAnchor(root);
    expect(verify(root).exit).toBe(2);
    expectRefused(root, () => recover(root));
  });

  it('refuses a contradictory anchor digest instead of adding another anchor', async () => {
    const { root } = await crashFixture();
    await duplicateAnchor(root, 'f'.repeat(64));
    const result = verify(root);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain('DIGEST_MISMATCH');
    expectRefused(root, () => recover(root));
  });

  it.each(['round', 'kind'] as const)(
    'refuses a canonical path with a different physical %s identity',
    async (identity) => {
      const { root } = await crashFixture();
      const target =
        identity === 'round'
          ? 'record/proofs/work/generic/R-0009.jsonl'
          : 'record/proofs/work/test/R-0007.jsonl';
      mkdirSync(dirname(join(root, target)), { recursive: true });
      renameSync(join(root, PATH), join(root, target));
      expectRefused(root, () => recover(root, target));
    },
  );

  it('does not mutate the chain when proof options are supplied without recovery mode', async () => {
    const { root } = await crashFixture();
    expectRefused(root, () =>
      invoke(root, [
        'evidence',
        'record',
        '--proof-path',
        PATH,
        '--proof-sequence',
        '3',
        '--repo-root',
        root,
        '--as-role',
        'inspector',
        '--write',
      ]),
    );
  });
});
