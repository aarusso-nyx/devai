// ADR-EVI-0006 public action. Set DEVAI_U1_TEST_BIN to the installed tarball's bin for
// installed-package qualification; default uses the registered built candidate, not mocks.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { loadChain, verifyProofAnchors } from '../../../evidence/src/evidence/chain.js';
import { deriveEvidenceId } from '../../../evidence/src/evidence/id-generator.js';
import { appendProofEpochRecord } from '../../../evidence/src/evidence/proof-epoch.js';
import { appendVerbEvidence } from '../../../evidence/src/evidence/verb-evidence.js';
const ROOT = resolve(import.meta.dirname, '../../../..');
const BIN = process.env.DEVAI_U1_TEST_BIN ?? join(ROOT, '.devai/state/pr-bootstrap/cli/bin.js');
const CHAIN = 'record/proofs/chain.json';
const PROOF = 'record/proofs/work/generic/R-0007.jsonl';
const SOURCE = 'custody/original-chain.json';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-u1-public-'));
  roots.push(root);
  return root;
}
function invoke(root: string, args: string[]) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  expect(result.signal).toBeNull();
  return { exit: result.status, stdout: result.stdout, stderr: result.stderr };
}
function flags(root: string, head?: string): string[] {
  const expected = head ?? loadChain(join(root, CHAIN)).head;
  if (expected === null) throw new Error('fixture missing canonical head');
  return [
    'evidence',
    'record',
    '--recover-divergent-anchor',
    '--proof-path',
    PROOF,
    '--proof-sequence',
    '7',
    '--source-chain',
    SOURCE,
    '--source-chain-sha256',
    createHash('sha256')
      .update(readFileSync(join(root, SOURCE)))
      .digest('hex'),
    '--expected-head',
    expected,
    '--repo-root',
    root,
    '--as-role',
    'inspector',
    '--write',
  ];
}
async function fixture(): Promise<string> {
  const root = temp();
  expect(existsSync(BIN), 'actual candidate/installed public bin must exist').toBe(true);
  for (const options of [
    ['--tier', 'tier1', '--constitution'],
    ['--operational-law'],
    ['--subprocess-effects'],
    [],
  ]) {
    const result = invoke(root, [
      'init',
      'bind',
      ...options,
      '--target',
      root,
      '--as-role',
      'architect',
      '--write',
    ]);
    expect(result, result.stderr).toMatchObject({ exit: 0, stderr: '' });
  }
  await withAuthorityHostTestScope(() => {
    for (let index = 0; index < 6; index += 1) {
      const line = appendProofEpochRecord({
        repoRoot: root,
        roundId: 'R-0007',
        kind: 'generic',
        payload: { note: `common ${index}` },
      });
      expect(
        appendVerbEvidence({
          repoRoot: root,
          action: 'evidence.record.generic',
          status: 'completed',
          proofAnchor: { path: PROOF, sequence: line.sequence },
        }).ok,
      ).toBe(true);
    }
    expect(verifyProofAnchors({ repoRoot: root, write: true }).valid).toBe(true);
    const prefix = readFileSync(join(root, CHAIN));
    const seven = appendProofEpochRecord({
      repoRoot: root,
      roundId: 'R-0007',
      kind: 'generic',
      payload: { note: 'original divergent seven' },
    });
    expect(
      appendVerbEvidence({
        repoRoot: root,
        action: 'evidence.record.generic',
        status: 'completed',
        proofAnchor: { path: PROOF, sequence: seven.sequence },
      }).ok,
    ).toBe(true);
    mkdirSync(dirname(join(root, SOURCE)), { recursive: true });
    writeFileSync(join(root, SOURCE), readFileSync(join(root, CHAIN)));
    writeFileSync(join(root, CHAIN), prefix);
    expect(
      appendVerbEvidence({
        repoRoot: root,
        action: 'verify.translation',
        status: 'completed',
        notes: ['independent branch entry'],
      }).ok,
    ).toBe(true);
    appendProofEpochRecord({
      repoRoot: root,
      roundId: 'R-0007',
      kind: 'generic',
      payload: { note: 'newest eight' },
    });
    expect(
      appendVerbEvidence({
        repoRoot: root,
        action: 'evidence.record.generic',
        status: 'completed',
        proofAnchor: { path: PROOF, sequence: 8 },
        recoverNewestLine: true,
      }).ok,
    ).toBe(true);
  });
  return root;
}
function asyncInvoke(
  root: string,
  args: string[],
): Promise<{ exit: number | null; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (value: string) => {
      stderr += value;
    });
    child.stdout.resume();
    child.once('error', reject);
    child.once('close', (exit) => resolveResult({ exit, stderr }));
  });
}
describe('ADR-EVI-0006 supported public divergent recovery', { timeout: 60_000 }, () => {
  it('advertises accepted mode and custody options on existing evidence record', () => {
    const result = invoke(temp(), ['evidence', 'record', '--help']);
    expect(result.exit).toBe(0);
    for (const option of [
      '--recover-divergent-anchor',
      '--proof-path',
      '--proof-sequence',
      '--source-chain',
      '--source-chain-sha256',
      '--expected-head',
    ])
      expect(result.stdout).toContain(option);
  });
  it('serializes two real public subprocess requests and exact retry without replay', async () => {
    const root = await fixture();
    const before = loadChain(join(root, CHAIN));
    const epoch = readFileSync(join(root, PROOF));
    const source = readFileSync(join(root, SOURCE));
    const requests = await Promise.all([
      asyncInvoke(root, flags(root)),
      asyncInvoke(root, flags(root)),
    ]);
    expect(requests.filter((result) => result.exit === 0)).toHaveLength(1);
    const refused = requests.find((result) => result.exit !== 0);
    expect(refused?.stderr).toContain('PROOF_ANCHOR_RECOVERY_STALE_HEAD');
    const after = loadChain(join(root, CHAIN));
    expect(after.records).toHaveLength(before.records.length + 1);
    expect(after.records.slice(0, -1)).toEqual(before.records);
    expect(readFileSync(join(root, PROOF))).toEqual(epoch);
    expect(readFileSync(join(root, SOURCE))).toEqual(source);
    const retry = invoke(root, flags(root));
    expect(retry, retry.stderr).toMatchObject({ exit: 0, stderr: '' });
    expect(loadChain(join(root, CHAIN))).toEqual(after);
    const checked = invoke(root, ['evidence', 'verify', '--scope', 'chain', '--repo-root', root]);
    expect(checked, checked.stderr).toMatchObject({ exit: 0, stderr: '' });
  });
  it('serializes a real ordinary proof writer against U1 without losing either canonical entry', async () => {
    const root = await fixture();
    const prior = loadChain(join(root, CHAIN));
    const beforeEpoch = readFileSync(join(root, PROOF));
    const beforeSource = readFileSync(join(root, SOURCE));
    const [recovery, ordinary] = await Promise.all([
      asyncInvoke(root, flags(root)),
      asyncInvoke(root, [
        'evidence',
        'record',
        '--kind',
        'generic',
        '--round',
        'R-0008',
        '--payload',
        '{"note":"ordinary concurrent writer"}',
        '--repo-root',
        root,
        '--as-role',
        'inspector',
        '--write',
      ]),
    ]);
    expect(ordinary, ordinary.stderr).toMatchObject({ exit: 0, stderr: '' });
    if (recovery.exit !== 0) {
      expect(recovery.stderr).toContain('PROOF_ANCHOR_RECOVERY_STALE_HEAD');
      const retry = invoke(root, flags(root));
      expect(retry, retry.stderr).toMatchObject({ exit: 0, stderr: '' });
    }
    const after = loadChain(join(root, CHAIN));
    expect(after.records).toHaveLength(prior.records.length + 2);
    for (const entry of after.records.slice(prior.records.length))
      expect(entry.id).toBe(
        deriveEvidenceId({
          timestamp: entry.timestamp,
          actor: entry.actor,
          actor_role: entry.actor_role,
          action: entry.action,
          status: entry.status,
          git_head_sha: entry.context.git.head_sha,
          artifact_sha256s: entry.artifacts.map((artifact) => artifact.sha256),
          previous_run_hash: entry.previous_run_hash,
        }),
      );

    expect(after.records.slice(0, prior.records.length)).toEqual(prior.records);
    expect(
      after.records.filter((record) => record.proof_path === PROOF && record.proof_sequence === 7),
    ).toHaveLength(1);
    expect(
      after.records.filter(
        (record) => record.proof_path === 'record/proofs/work/generic/R-0008.jsonl',
      ),
    ).toHaveLength(1);
    expect(readFileSync(join(root, PROOF))).toEqual(beforeEpoch);
    expect(readFileSync(join(root, SOURCE))).toEqual(beforeSource);
    const checked = invoke(root, ['evidence', 'verify', '--scope', 'chain', '--repo-root', root]);
    expect(checked, checked.stderr).toMatchObject({ exit: 0, stderr: '' });
  });

  it('refuses missing Inspector or write consent and mixed newest/bulk/payload modes before writes', async () => {
    const root = await fixture();
    for (const defect of ['role', 'consent', 'newest', 'payload', 'bulk']) {
      let args = flags(root);
      if (defect === 'role')
        args = args.map((value) => (value === 'inspector' ? 'engineer' : value));
      if (defect === 'consent') args = args.filter((value) => value !== '--write');
      if (defect === 'newest') args.push('--recover-newest-line');
      if (defect === 'payload') args.push('--payload', '{"note":"must never replay"}');
      if (defect === 'bulk') args.push('--proof-sequence', '*');
      const before = readFileSync(join(root, CHAIN));
      const result = invoke(root, args);
      expect(result.exit, result.stderr).not.toBe(0);
      expect(result.stderr).not.toMatch(
        /Unknown option|MODULE_NOT_FOUND|authority policy missing/u,
      );
      expect(readFileSync(join(root, CHAIN))).toEqual(before);
    }
  });
});
