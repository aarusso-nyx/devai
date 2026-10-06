// ADR-EVI-0002 (IA-001, IA-002, IA-004, and the refusal on a modified history) through the public
// `evidence verify --scope chain` and `evidence record` facades. The contract is
// docs/reference/cli/evidence-verify.md. The DETRAN fixture under
// tests/fixtures/proof-baseline/detran-r0020 is byte-exact and only ever copied into a temporary
// directory before a run that writes.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { loadChain, saveChain } from '../../../evidence/src/evidence/chain.js';
import { appendProofEpochRecord } from '../../../evidence/src/evidence/proof-epoch.js';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { evidenceRecord, evidenceVerify } from '../../src/commands/evidence/facade.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

const ROOT = resolve(import.meta.dirname, '../../../..');
const DETRAN = join(ROOT, 'tests/fixtures/proof-baseline/detran-r0020');
const BASELINE = 'record/proofs/anchor-baseline.json';
const CHAIN = 'record/proofs/chain.json';
const ACKNOWLEDGED = 'historical gap acknowledged';

interface Definition {
  register(cli: CAC): void;
}

interface InvocationResult {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The JSON receipt of `evidence verify --scope chain`, extended by ADR-EVI-0002. */
interface ChainVerification {
  readonly scope: 'chain';
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly lines: readonly {
    readonly path: string;
    readonly sequence: number;
    readonly sha256: string;
    readonly label: string;
  }[];
  readonly declarations: readonly { readonly status: string }[];
}

const roots: string[] = [];

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-evidence-anchors-'));
  roots.push(path);
  return path;
}

function detranCopy(): string {
  const root = tempRoot();
  cpSync(join(DETRAN, 'record'), join(root, 'record'), { recursive: true });
  return root;
}

async function captureInvocation(run: () => Promise<void>): Promise<InvocationResult> {
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  try {
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((exitCode?: string | number | null) => {
      process.exitCode = typeof exitCode === 'number' ? exitCode : 0;
      throw new Error(`TEST_PROCESS_EXIT:${String(process.exitCode)}`);
    }) as typeof process.exit;
    try {
      await run();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('TEST_PROCESS_EXIT:')) throw error;
    }
    await new Promise<void>((done) => setImmediate(done));
    return {
      exit: typeof process.exitCode === 'number' ? process.exitCode : 0,
      stdout,
      stderr,
    };
  } finally {
    process.argv = originalArgv;
    process.exit = originalExit;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

/**
 * Runs one facade. `--write` consent is appended after parsing, as the command router does: it
 * strips `--write` before the command parses and the facade reads it from `process.argv`.
 */
async function invoke(
  definition: Definition,
  argv: readonly string[],
  options: { readonly writeConsent?: boolean } = {},
): Promise<InvocationResult> {
  const cli = cac('devai-evidence-verify-anchors');
  definition.register(cli);
  return captureInvocation(async () => {
    process.argv = ['node', 'devai', ...argv];
    cli.parse(process.argv, { run: false });
    if (options.writeConsent === true) process.argv.push('--write');
    await withAuthorityHostTestScope(() => cli.runMatchedCommand());
  });
}

const VERIFY_CHAIN = ['evidence-verify', '--scope', 'chain', '--repo-root'] as const;

/** A read-only verification: it never writes the baseline. */
function verifyChain(repo: string, ...extra: string[]): Promise<InvocationResult> {
  return invoke(evidenceVerify, [...VERIFY_CHAIN, repo, ...extra]);
}

/** A verification with `--write` consent: the first one writes the baseline, later ones append. */
function verifyChainWriting(repo: string, ...extra: string[]): Promise<InvocationResult> {
  return invoke(evidenceVerify, [...VERIFY_CHAIN, repo, ...extra], { writeConsent: true });
}

/** Every file under the repository with its bytes, to prove that a run wrote nothing. */
function snapshot(repo: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(repo, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(repo, path)] = readFileSync(path).toString('base64');
  }
  return files;
}

function record(
  repo: string,
  kind: string,
  round: string,
  input: object,
): Promise<InvocationResult> {
  writeFileSync(join(repo, `${kind}-${round}.json`), `${JSON.stringify(input)}\n`);
  return invoke(evidenceRecord, [
    'evidence-record',
    '--kind',
    kind,
    '--round',
    round,
    '--repo-root',
    repo,
    '--input',
    `${kind}-${round}.json`,
  ]);
}

function receipt(result: InvocationResult): ChainVerification {
  return JSON.parse(result.stdout) as ChainVerification;
}

function epochPath(kind: string, round: string): string {
  return `record/proofs/work/${kind}/${round}.jsonl`;
}

function ref(path: string, sequence: number): string {
  return `${path}:${String(sequence)}`;
}

/** Whether a diagnostic names `<path>:<sequence>` exactly, so `:3` never matches `:38`. */
function names(diagnostic: string, line: string): boolean {
  const escaped = line.replace(/[.*+?^$()|[\]\\{}]/gu, '\\$&');
  return new RegExp(`${escaped}(?![0-9])`, 'u').test(diagnostic);
}

function lineDigest(root: string, path: string, sequence: number): string {
  const line = readFileSync(join(root, path), 'utf8').split('\n')[sequence - 1];
  if (line === undefined) throw new Error(`line ${ref(path, sequence)} is missing`);
  return createHash('sha256').update(line, 'utf8').digest('hex');
}

/** The 52 orphan identities that CTG-0002.md fixes, as (path, sequence, sha256). */
function contractOrphans(): { path: string; sequence: number; sha256: string }[] {
  const orphans: { path: string; sequence: number; sha256: string }[] = [];
  let round: string | null = null;
  for (const line of readFileSync(join(DETRAN, 'CTG-0002.md'), 'utf8').split('\n')) {
    const heading = /^### (R-\d{4}) — `/u.exec(line);
    if (heading !== null) round = heading[1] ?? null;
    else if (line.startsWith('### ')) round = null;
    const row = /^\| (\d+)\s+\| `([0-9a-f]{64})` \|$/u.exec(line);
    if (row !== null && round !== null) {
      orphans.push({
        path: epochPath('generic', round),
        sequence: Number(row[1]),
        sha256: row[2] ?? '',
      });
    }
  }
  return orphans;
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: repo, encoding: 'utf8' }).trim();
}

function initializeRepository(repo: string): void {
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Evidence Anchor Fixture']);
  git(repo, ['config', 'user.email', 'evidence-anchor@example.invalid']);
  // `git commit` otherwise starts `git maintenance run --auto --detach`, a background process
  // that takes `.git/objects/maintenance.lock` after the commit returns. Under load it lands
  // inside a `snapshot()` window and the "writes nothing" comparison sees a lock file the
  // verifier never wrote. The fixture owns its repository, so it turns auto-maintenance off.
  git(repo, ['config', 'maintenance.auto', 'false']);
  git(repo, ['config', 'gc.auto', '0']);
}

describe('IA-001 evidence verify --scope chain over the DETRAN baseline', () => {
  it('fails listing the 52 orphans, then passes after an anchored historical-gap declaration', async () => {
    const repo = detranCopy();
    const orphans = contractOrphans();
    expect(orphans).toHaveLength(52);

    // Without a baseline and without --write: PROOF_ANCHOR_BASELINE_MISSING, and nothing written.
    const untouched = snapshot(repo);
    const missing = await verifyChain(repo);
    expect(missing.exit).toBe(2);
    expect(missing.stderr).toContain('PROOF_ANCHOR_BASELINE_MISSING');
    expect(missing.stderr).toContain('--write');
    expect(missing.stdout).not.toMatch(/"valid":\s*true/u);
    expect(missing.stdout).not.toContain('evidence chain: valid');
    expect(existsSync(join(repo, BASELINE))).toBe(false);
    expect(snapshot(repo)).toEqual(untouched);

    // With --write consent: the baseline is written and the 52 orphans fail the verification.
    const before = await verifyChainWriting(repo);
    expect(before.exit).toBe(2);
    expect(before.stderr).not.toContain('PROOF_ANCHOR_BASELINE_MISSING');
    for (const orphan of orphans) {
      expect(names(before.stderr, ref(orphan.path, orphan.sequence))).toBe(true);
    }
    expect(existsSync(join(repo, BASELINE))).toBe(true);
    const baseline = JSON.parse(readFileSync(join(repo, BASELINE), 'utf8')) as {
      cutoff: string;
      entries: { anchor_status: string }[];
    };
    expect(baseline.entries).toHaveLength(119);
    expect(baseline.entries.filter((entry) => entry.anchor_status === 'orphaned')).toHaveLength(52);

    const declared = await record(repo, 'historical-gap', 'R-0020', {
      schemaVersion: '1.0.0',
      declaration: 'historical-gap',
      record: 'ADR-EVI-0002',
      authorization: {
        role: 'Architect',
        decision: 'CTG-0002',
        authorized_at: new Date().toISOString(),
      },
      cutoff: baseline.cutoff,
      cause: 'source_pending',
      orphans,
    });
    expect(declared, declared.stderr).toMatchObject({ exit: 0, stderr: '' });
    const declarationPath = epochPath('historical-gap', 'R-0020');
    const anchor = loadChain(join(repo, CHAIN)).records.at(-1) as unknown as Record<
      string,
      unknown
    >;
    expect(anchor).toMatchObject({
      action: 'evidence.record.historical-gap',
      proof_path: declarationPath,
      proof_sequence: 1,
      proof_sha256: lineDigest(repo, declarationPath, 1),
    });

    const after = await verifyChainWriting(repo);
    expect(after, after.stderr).toMatchObject({ exit: 0, stderr: '' });
    const result = receipt(after);
    expect(result).toMatchObject({ scope: 'chain', valid: true, errors: [] });
    expect(
      result.lines
        .filter((line) => line.label === ACKNOWLEDGED)
        .map((line) => ref(line.path, line.sequence))
        .sort(),
    ).toEqual(orphans.map((orphan) => ref(orphan.path, orphan.sequence)).sort());
    expect(result.lines.filter((line) => line.label === 'anchored')).toHaveLength(68);
    expect(result.declarations).toEqual([expect.objectContaining({ status: 'accepted' })]);

    // Later verifications are reads against the baseline and keep reporting the gap.
    const settled = snapshot(repo);
    const human = await verifyChain(repo, '--human');
    expect(human).toMatchObject({ exit: 0, stderr: '' });
    expect(human.stdout).toContain(ACKNOWLEDGED);
    expect(snapshot(repo)).toEqual(settled);
  });
});

describe('IA-002 the cryptographic chain checks are unchanged', () => {
  it('still fails a broken previous-hash link of the DETRAN chain', async () => {
    const repo = detranCopy();
    const chainPath = join(repo, CHAIN);
    const chain = loadChain(chainPath);
    const victim = chain.records[49];
    if (victim === undefined) throw new Error('fixture chain is shorter than 50 records');
    victim.previous_run_hash = '0'.repeat(64);
    await withAuthorityHostTestScope(() => saveChain(chainPath, chain));
    const result = await verifyChainWriting(repo);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain('previous_run_hash mismatch');
  });
});

describe('new anchors recorded through evidence record', () => {
  it('carry the line digest and verify in both directions', async () => {
    const repo = tempRoot();
    for (const note of ['one', 'two']) {
      expect(await record(repo, 'generic', 'R-0001', { note })).toMatchObject({ exit: 0 });
    }
    const path = epochPath('generic', 'R-0001');
    const records = loadChain(join(repo, CHAIN)).records as unknown as Record<string, unknown>[];
    expect(
      records.map((entry) => [entry['proof_path'], entry['proof_sequence'], entry['proof_sha256']]),
    ).toEqual([
      [path, 1, lineDigest(repo, path, 1)],
      [path, 2, lineDigest(repo, path, 2)],
    ]);
    const first = await verifyChainWriting(repo);
    expect(first, first.stderr).toMatchObject({ exit: 0, stderr: '' });
    expect(receipt(first)).toMatchObject({ scope: 'chain', valid: true, errors: [] });
    expect(existsSync(join(repo, BASELINE))).toBe(true);
    const written = snapshot(repo);
    expect(await verifyChain(repo)).toMatchObject({ exit: 0, stderr: '' });
    expect(snapshot(repo)).toEqual(written);
  });
});

describe('the gated baseline write', () => {
  it('fails PROOF_ANCHOR_BASELINE_MISSING without --write even for a fully anchored chain', async () => {
    const repo = tempRoot();
    expect(await record(repo, 'generic', 'R-0001', { note: 'one' })).toMatchObject({ exit: 0 });
    const before = snapshot(repo);
    for (const extra of [[], ['--human'], ['--show-head']]) {
      const result = await verifyChain(repo, ...extra);
      expect(result.exit).toBe(2);
      expect(result.stderr).toContain('PROOF_ANCHOR_BASELINE_MISSING');
      expect(result.stderr).toContain('--write');
      expect(result.stdout).not.toContain('evidence chain: valid');
      expect(result.stdout).not.toMatch(/"valid":\s*true/u);
    }
    expect(snapshot(repo)).toEqual(before);
    expect(await verifyChainWriting(repo)).toMatchObject({ exit: 0, stderr: '' });
    expect(existsSync(join(repo, BASELINE))).toBe(true);
  });
});

describe('IA-004 crash recovery through the public verifier', () => {
  it('reports UNANCHORED_NEWEST_LINE with the evidence record remediation', async () => {
    const repo = tempRoot();
    expect(await record(repo, 'generic', 'R-0004', { note: 'one' })).toMatchObject({ exit: 0 });
    // The writer is killed after the proof line and before the chain entry.
    await withAuthorityHostTestScope(() =>
      appendProofEpochRecord({
        repoRoot: repo,
        roundId: 'R-0004',
        kind: 'generic',
        payload: { note: 'two' },
      }),
    );
    const result = await verifyChainWriting(repo);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain('UNANCHORED_NEWEST_LINE');
    expect(names(result.stderr, ref(epochPath('generic', 'R-0004'), 2))).toBe(true);
    expect(result.stderr).toContain('evidence record');
  });
});

describe('the verifier refuses a working tree that modified recorded history', () => {
  async function committedRepository(): Promise<string> {
    const repo = tempRoot();
    initializeRepository(repo);
    for (const note of ['one', 'two']) {
      expect(await record(repo, 'generic', 'R-0001', { note })).toMatchObject({ exit: 0 });
    }
    expect(await verifyChainWriting(repo)).toMatchObject({ exit: 0 });
    git(repo, ['add', 'record']);
    git(repo, ['commit', '-qm', 'recorded history']);
    return repo;
  }

  it('refuses when an old proof line changed, and writes nothing', async () => {
    const repo = await committedRepository();
    const path = join(repo, epochPath('generic', 'R-0001'));
    writeFileSync(path, readFileSync(path, 'utf8').replace('"one"', '"uno"'));
    const before = snapshot(repo);
    // Even with --write consent, a refused verification writes nothing.
    const result = await verifyChainWriting(repo);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain('PROOF_HISTORY_MODIFIED');
    expect(snapshot(repo)).toEqual(before);
  });

  it('refuses when an old chain entry changed outside its manifest hash', async () => {
    const repo = await committedRepository();
    const chainPath = join(repo, CHAIN);
    const chain = loadChain(chainPath);
    const first = chain.records[0];
    if (first === undefined) throw new Error('no chain record');
    first.context = { ...first.context, repo_root: '/elsewhere' };
    await withAuthorityHostTestScope(() => saveChain(chainPath, chain));
    const result = await verifyChain(repo);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain('PROOF_HISTORY_MODIFIED');
  });

  it('does not refuse an append through evidence record', async () => {
    const repo = await committedRepository();
    expect(await record(repo, 'generic', 'R-0001', { note: 'three' })).toMatchObject({ exit: 0 });
    const result = await verifyChainWriting(repo);
    expect(result.stderr).not.toContain('PROOF_HISTORY_MODIFIED');
    expect(result).toMatchObject({ exit: 0, stderr: '' });
  });
});
