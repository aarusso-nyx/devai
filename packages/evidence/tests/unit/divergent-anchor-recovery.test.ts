// ADR-EVI-0006 IA001–008. All Git/proof/chain writes below are disposable fixture custody.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, aroundEach, describe, expect, it, vi } from 'vitest';
import * as authority from '@devai-nyx/authority';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import * as chainModule from '../../src/evidence/chain.js';
import * as anchorsModule from '../../src/evidence/anchors.js';
import { loadChain, saveChain, verifyChain, verifyProofAnchors } from '../../src/evidence/chain.js';
import { appendProofEpochRecord } from '../../src/evidence/proof-epoch.js';
import { deriveEvidenceId } from '../../src/evidence/id-generator.js';
import * as gitContext from '../../src/evidence/git-context.js';
import { appendVerbEvidence, type VerbEvidenceInputs } from '../../src/evidence/verb-evidence.js';

const CHAIN = 'record/proofs/chain.json';
const PROOF = 'record/proofs/work/generic/R-0007.jsonl';
const SOURCE = 'custody/original-divergent-chain.json';
const BASELINE = 'record/proofs/anchor-baseline.json';
const roots: string[] = [];
const hash = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');
const bytes = (root: string, path: string): Buffer => fs.readFileSync(join(root, path));
aroundEach((test) => withAuthorityHostTestScope(test));
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
}
function commit(root: string, message: string): void {
  git(root, ['add', '--', 'record']);
  git(root, [
    '-c',
    'user.name=Inspector fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '--quiet',
    '-m',
    message,
  ]);
}
function record(root: string, round = 'R-0007'): void {
  const proof = appendProofEpochRecord({
    repoRoot: root,
    roundId: round,
    kind: 'generic',
    payload: { note: `line in ${round}` },
  });
  expect(
    appendVerbEvidence({
      repoRoot: root,
      action: 'evidence.record.generic',
      status: 'completed',
      proofAnchor: { path: `record/proofs/work/generic/${round}.jsonl`, sequence: proof.sequence },
    }),
  ).toMatchObject({ ok: true });
}
/** Actual branch commits and an ordinary conflicting merge; source chain is original Git bytes. */
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'devai-u1-inspector-'));
  roots.push(root);
  git(root, ['init', '--quiet', '--template=', '--initial-branch=main']);
  for (let index = 0; index < 6; index += 1) record(root);
  expect(verifyProofAnchors({ repoRoot: root, write: true }).valid).toBe(true);
  commit(root, 'test(fixtures): shared six-line prefix');
  git(root, ['switch', '--quiet', '-c', 'divergent']);
  record(root);
  commit(root, 'test(fixtures): original direct anchor seven');
  const sourceHead = git(root, ['rev-parse', 'HEAD']);
  const source = bytes(root, CHAIN);
  git(root, ['switch', '--quiet', 'main']);
  record(root, 'R-0008');
  commit(root, 'test(fixtures): independent canonical proof');
  const canonical = bytes(root, CHAIN);
  // A real merge conflicts on the two chains. Preserve canonical chain, merge proof files.
  try {
    git(root, [
      '-c',
      'user.name=Inspector fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'merge',
      '--no-commit',
      '--no-ff',
      'divergent',
    ]);
  } catch {
    /* expected chain conflict */
  }
  fs.writeFileSync(join(root, CHAIN), canonical);
  commit(root, 'test(fixtures): resolve merge retaining canonical chain');
  expect(git(root, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ')).toHaveLength(3);
  fs.mkdirSync(dirname(join(root, SOURCE)), { recursive: true });
  fs.writeFileSync(join(root, SOURCE), source);
  expect(execFileSync('git', ['show', `${sourceHead}:${CHAIN}`], { cwd: root })).toEqual(source);
  const newest = appendProofEpochRecord({
    repoRoot: root,
    roundId: 'R-0007',
    kind: 'generic',
    payload: { note: 'newest crash residue eight' },
  });
  expect(newest.sequence).toBe(8);
  expect(
    appendVerbEvidence({
      repoRoot: root,
      action: 'evidence.record.generic',
      status: 'completed',
      proofAnchor: { path: PROOF, sequence: 8 },
      recoverNewestLine: true,
    }),
  ).toMatchObject({ ok: true });
  const observed = verifyProofAnchors({ repoRoot: root, write: false });
  expect(observed.errors.some((error) => error.startsWith(`PROOF_LINE_ORPHAN ${PROOF}:7`))).toBe(
    true,
  );
  expect(observed.lines.find((line) => line.path === PROOF && line.sequence === 8)?.label).toBe(
    'anchored',
  );
  const custodyDirectory = process.env.DEVAI_U1_TEST_CUSTODY_DIR;
  if (custodyDirectory !== undefined) {
    fs.mkdirSync(custodyDirectory, { recursive: true });
    fs.cpSync(root, join(custodyDirectory, basename(root)), { recursive: true });
  }
  return { root, source, sourceHead, prior: loadChain(join(root, CHAIN)) };
}
interface Recovery {
  sourceChain: string;
  sourceChainSha256: string;
  expectedHead: string;
}
type Request = VerbEvidenceInputs & { recoverDivergentAnchor: Recovery };
function request(root: string, overrides: Partial<Recovery> = {}, sequence = 7): Request {
  const head = loadChain(join(root, CHAIN)).head;
  if (head === null) throw new Error('fixture missing canonical head');
  return {
    repoRoot: root,
    action: 'evidence.record.generic',
    status: 'completed',
    proofAnchor: { path: PROOF, sequence },
    recoverDivergentAnchor: {
      sourceChain: SOURCE,
      sourceChainSha256: hash(bytes(root, SOURCE)),
      expectedHead: head,
      ...overrides,
    },
  };
}
function protectedBytes(root: string) {
  return Object.fromEntries(
    [CHAIN, PROOF, BASELINE, SOURCE].map((path) => [path, bytes(root, path).toString('base64')]),
  );
}
function refused(
  root: string,
  run: () => ReturnType<typeof appendVerbEvidence>,
  code = 'PROOF_ANCHOR_RECOVERY_REFUSED',
): void {
  const before = protectedBytes(root);
  const result = run();
  expect(result).toMatchObject({ ok: false });
  expect(result.error).toContain(code);
  expect(protectedBytes(root)).toEqual(before);
}

describe('ADR-EVI-0006 custody-proven divergent anchors', () => {
  it('IA005: classifies a winner published during snapshot collection as stale head', () => {
    const { root, prior } = fixture();
    const input = request(root);
    const proof = bytes(root, PROOF);
    const source = bytes(root, SOURCE);
    const baseline = bytes(root, BASELINE);
    const original = anchorsModule.verifyProofAnchors;
    let winner: ReturnType<typeof appendVerbEvidence> | undefined;
    vi.spyOn(anchorsModule, 'verifyProofAnchors').mockImplementationOnce((options) => {
      winner = appendVerbEvidence(input);
      return original(options);
    });
    const loser = appendVerbEvidence(input);
    expect(winner).toMatchObject({ ok: true });
    expect(loser).toMatchObject({ ok: false });
    expect(loser.error).toContain('PROOF_ANCHOR_RECOVERY_STALE_HEAD');
    const after = loadChain(join(root, CHAIN));
    expect(after.records).toHaveLength(prior.records.length + 1);
    expect(after.records.slice(0, -1)).toEqual(prior.records);
    expect(bytes(root, PROOF)).toEqual(proof);
    expect(bytes(root, SOURCE)).toEqual(source);
    expect(bytes(root, BASELINE)).toEqual(baseline);
    const retry = appendVerbEvidence(request(root));
    expect(retry).toMatchObject({ ok: true, alreadyAnchored: true, id: winner?.id });
    expect(loadChain(join(root, CHAIN))).toEqual(after);
  });

  it.each(['corrupt', 'missing'] as const)('IA005: refuses %s chain during snapshot', (defect) => {
    const { root } = fixture();
    const input = request(root);
    const proof = bytes(root, PROOF);
    const source = bytes(root, SOURCE);
    const baseline = bytes(root, BASELINE);
    const original = anchorsModule.verifyProofAnchors;
    vi.spyOn(anchorsModule, 'verifyProofAnchors').mockImplementationOnce((options) => {
      if (defect === 'corrupt') fs.writeFileSync(join(root, CHAIN), '{invalid');
      else fs.unlinkSync(join(root, CHAIN));
      return original(options);
    });
    const result = appendVerbEvidence(input);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('PROOF_ANCHOR_RECOVERY_REFUSED');
    expect(result.error).not.toContain('PROOF_ANCHOR_RECOVERY_STALE_HEAD');
    if (defect === 'corrupt') expect(fs.readFileSync(join(root, CHAIN), 'utf8')).toBe('{invalid');
    else expect(fs.existsSync(join(root, CHAIN))).toBe(false);
    expect(bytes(root, PROOF)).toEqual(proof);
    expect(bytes(root, SOURCE)).toEqual(source);
    expect(bytes(root, BASELINE)).toEqual(baseline);
  });

  it('IA005: classifies a winner after claims inspection as stale head', () => {
    const { root, prior } = fixture();
    const input = request(root);
    const originalAnchors = anchorsModule.verifyProofAnchors;
    const originalLoad = chainModule.loadChain;
    let winner: ReturnType<typeof appendVerbEvidence> | undefined;
    let loads = 0;
    let insideWinner = false;
    vi.spyOn(anchorsModule, 'verifyProofAnchors').mockImplementationOnce((options) => {
      const result = originalAnchors(options);
      vi.spyOn(chainModule, 'loadChain').mockImplementation((path) => {
        if (!insideWinner && ++loads === 2) {
          insideWinner = true;
          winner = appendVerbEvidence(input);
          insideWinner = false;
        }
        return originalLoad(path);
      });
      return result;
    });
    const loser = appendVerbEvidence(input);
    expect(winner).toMatchObject({ ok: true });
    expect(loser).toMatchObject({ ok: false });
    expect(loser.error).toContain('PROOF_ANCHOR_RECOVERY_STALE_HEAD');
    const after = originalLoad(join(root, CHAIN));
    expect(after.records).toHaveLength(prior.records.length + 1);
    expect(after.records.slice(0, -1)).toEqual(prior.records);
  });

  it('IA001/008: restores orphan seven exactly once through a new canonical append without replaying payloads', () => {
    const { root, source, prior } = fixture();
    const before = protectedBytes(root);
    const sourceEntry = loadChain(join(root, SOURCE)).records.at(-1);
    const result = appendVerbEvidence(request(root));
    expect(result).toMatchObject({ ok: true });
    const after = loadChain(join(root, CHAIN));
    expect(after.records).toHaveLength(prior.records.length + 1);
    expect(after.records.slice(0, -1)).toEqual(prior.records);
    const entry = after.records.at(-1);
    const physical = bytes(root, PROOF).toString('utf8').trimEnd().split('\n')[6];
    if (physical === undefined || sourceEntry === undefined)
      throw new Error('fixture missing anchor');
    expect(entry).toMatchObject({
      proof_path: PROOF,
      proof_sequence: 7,
      proof_sha256: hash(physical),
      previous_run_hash: prior.head,
      recovered_from: {
        source_chain_path: SOURCE,
        source_chain_sha256: hash(source),
        source_entry_id: sourceEntry.id,
        source_entry_sequence: sourceEntry.sequence,
        source_entry_manifest_hash: sourceEntry.manifest_hash,
        fork_sequence: 6,
      },
    });
    expect(entry?.sequence).toBe(prior.records.length + 1);
    expect(entry?.sequence).not.toBe(sourceEntry.sequence);
    expect(entry?.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: SOURCE, sha256: hash(source) }),
        expect.objectContaining({ sha256: hash(physical) }),
      ]),
    );
    expect(bytes(root, PROOF).toString('base64')).toBe(before[PROOF]);
    expect(bytes(root, SOURCE).toString('base64')).toBe(before[SOURCE]);
    expect(bytes(root, BASELINE).toString('base64')).toBe(before[BASELINE]);
    expect(verifyProofAnchors({ repoRoot: root, write: false })).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it('IA006: exact retry returns original identity and no writes; changing source path is refused', () => {
    const { root } = fixture();
    const first = appendVerbEvidence(request(root));
    expect(first.ok).toBe(true);
    const before = protectedBytes(root);
    expect(appendVerbEvidence(request(root))).toMatchObject({
      ok: true,
      id: first.id,
      alreadyAnchored: true,
    });
    expect(protectedBytes(root)).toEqual(before);
    fs.writeFileSync(join(root, 'custody/other.json'), bytes(root, SOURCE));
    refused(root, () => appendVerbEvidence(request(root, { sourceChain: 'custody/other.json' })));
  });

  it('IA006: same-path retry with a different valid source entry is refused', () => {
    const { root } = fixture();
    const originalSource = loadChain(join(root, SOURCE));
    const sourceEntry = originalSource.records.at(-1);
    if (sourceEntry === undefined) throw new Error('missing source anchor');
    expect(appendVerbEvidence(request(root)).ok).toBe(true);
    const prefix = originalSource.records.slice(0, -1);
    const previous = prefix.at(-1);
    if (previous === undefined) throw new Error('missing source prefix');
    saveChain(join(root, SOURCE), { head: previous.manifest_hash, records: prefix });
    expect(
      appendVerbEvidence({
        repoRoot: root,
        chainPath: SOURCE,
        action: 'evidence.record.generic',
        status: 'completed',
        proofAnchor: { path: PROOF, sequence: 7 },
      }).ok,
    ).toBe(true);
    expect(loadChain(join(root, SOURCE)).records.at(-1)?.id).not.toBe(sourceEntry.id);
    expect(verifyChain(join(root, SOURCE)).valid).toBe(true);
    refused(root, () => appendVerbEvidence(request(root)));
  });

  it('IA005: stale expected head writes nothing, including a second request with the old head', () => {
    const { root } = fixture();
    refused(
      root,
      () => appendVerbEvidence(request(root, { expectedHead: '0'.repeat(64) })),
      'PROOF_ANCHOR_RECOVERY_STALE_HEAD',
    );
    const sameHead = request(root);
    expect(appendVerbEvidence(sameHead).ok).toBe(true);
    refused(root, () => appendVerbEvidence(sameHead), 'PROOF_ANCHOR_RECOVERY_STALE_HEAD');
    expect(appendVerbEvidence(request(root))).toMatchObject({ ok: true, alreadyAnchored: true });
  });

  it.each([
    'digest',
    'sequence',
    'link',
    'manifest',
    'common-prefix',
    'missing-anchor',
    'duplicate-anchor',
    'mismatched-anchor',
    'other-line-digest',
  ] as const)('IA002/003: refuses %s before mutation', (defect) => {
    const { root } = fixture();
    if (defect === 'digest') {
      refused(root, () => appendVerbEvidence(request(root, { sourceChainSha256: '0'.repeat(64) })));
      return;
    }
    if (defect === 'duplicate-anchor' || defect === 'other-line-digest') {
      expect(
        appendVerbEvidence({
          repoRoot: root,
          chainPath: SOURCE,
          action: 'evidence.record.generic',
          status: 'completed',
          proofAnchor: { path: PROOF, sequence: defect === 'duplicate-anchor' ? 7 : 6 },
        }).ok,
      ).toBe(true);
      const expanded = loadChain(join(root, SOURCE));
      const extra = expanded.records.at(-1);
      if (extra === undefined) throw new Error('missing extra source anchor');
      if (defect === 'other-line-digest') extra.proof_sha256 = '0'.repeat(64);
      saveChain(join(root, SOURCE), expanded);
      expect(verifyChain(join(root, SOURCE)).valid).toBe(true);
      refused(root, () => appendVerbEvidence(request(root)));
      return;
    }
    const source = loadChain(join(root, SOURCE));
    const first = source.records[0];
    const last = source.records.at(-1);
    if (first === undefined || last === undefined) throw new Error('missing source records');
    if (defect === 'sequence') last.sequence = 400;
    if (defect === 'link') last.previous_run_hash = '0'.repeat(64);
    if (defect === 'manifest') last.manifest_hash = '0'.repeat(64);
    if (defect === 'common-prefix') first.proof_sha256 = '0'.repeat(64);
    if (defect === 'missing-anchor') {
      last.proof_sequence = 6;
    }
    if (defect === 'mismatched-anchor') last.proof_sha256 = '0'.repeat(64);
    saveChain(join(root, SOURCE), source);
    refused(root, () => appendVerbEvidence(request(root)));
  });

  it.each([8, 6, 9])(
    'IA004: refuses newest, already anchored, or nonexistent line %s',
    (sequence) => {
      const { root } = fixture();
      refused(root, () => appendVerbEvidence(request(root, {}, sequence)));
    },
  );

  it.each([
    'source-symlink',
    'source-parent-symlink',
    'proof-symlink',
    'nonregular-source',
    'canonical-source',
    'outside-source',
    'tail',
  ] as const)('IA007: refuses %s with all fixture inputs preserved', (defect) => {
    const { root } = fixture();
    let sourcePath = SOURCE;
    if (defect === 'source-symlink') {
      fs.writeFileSync(join(root, 'custody/raw.json'), bytes(root, SOURCE));
      fs.rmSync(join(root, SOURCE));
      fs.symlinkSync('raw.json', join(root, SOURCE));
    }
    if (defect === 'source-parent-symlink') {
      fs.renameSync(join(root, 'custody'), join(root, 'held'));
      fs.symlinkSync('held', join(root, 'custody'));
    }
    if (defect === 'proof-symlink') {
      fs.renameSync(join(root, PROOF), join(root, 'epoch.jsonl'));
      fs.symlinkSync(join(root, 'epoch.jsonl'), join(root, PROOF));
    }
    if (defect === 'canonical-source') sourcePath = CHAIN;
    if (defect === 'outside-source')
      sourcePath = `../${root.split('/').at(-1)}/custody/original-divergent-chain.json`;
    if (defect === 'tail') fs.writeFileSync(join(root, PROOF), bytes(root, PROOF).subarray(0, -1));
    if (defect === 'nonregular-source') {
      sourcePath = 'custody/directory';
      fs.mkdirSync(join(root, sourcePath));
    }
    const digest = defect === 'nonregular-source' ? '0'.repeat(64) : hash(bytes(root, sourcePath));
    refused(root, () =>
      appendVerbEvidence(request(root, { sourceChain: sourcePath, sourceChainSha256: digest })),
    );
  });

  it.each(['source', 'head', 'proof'] as const)(
    'IA005: rechecks %s immediately before append',
    (changed) => {
      const { root } = fixture();
      const input = request(root);
      const canonical = bytes(root, CHAIN);
      const canonicalCount = loadChain(join(root, CHAIN)).records.length;
      const original = gitContext.gatherGitContext;
      vi.spyOn(gitContext, 'gatherGitContext').mockImplementationOnce((repoRoot) => {
        const result = original(repoRoot);
        if (changed === 'source') fs.appendFileSync(join(root, SOURCE), ' ');
        if (changed === 'proof') fs.appendFileSync(join(root, PROOF), ' ');
        if (changed === 'head')
          appendVerbEvidence({ repoRoot: root, action: 'verify.translation', status: 'completed' });
        return result;
      });
      const result = appendVerbEvidence(input);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        changed === 'head' ? 'PROOF_ANCHOR_RECOVERY_STALE_HEAD' : 'PROOF_ANCHOR_RECOVERY_REFUSED',
      );
      if (changed === 'head')
        expect(loadChain(join(root, CHAIN)).records).toHaveLength(canonicalCount + 1);
      else expect(bytes(root, CHAIN)).toEqual(canonical);
    },
  );

  it('IA008: tampering either bound artifact digest breaks manifest verification', () => {
    const { root } = fixture();
    expect(appendVerbEvidence(request(root)).ok).toBe(true);
    const recovered = loadChain(join(root, CHAIN));
    const last = recovered.records.at(-1);
    if (last === undefined) throw new Error('missing recovery record');
    expect(last.artifacts).toHaveLength(2);
    for (const artifact of last.artifacts) {
      const saved = artifact.sha256;
      artifact.sha256 = '0'.repeat(64);
      saveChain(join(root, CHAIN), recovered);
      expect(verifyChain(join(root, CHAIN)).valid).toBe(false);
      artifact.sha256 = saved;
    }
  });

  it('crash at the normal append boundary leaves old chain and custody intact for retry', () => {
    const { root } = fixture();
    const before = protectedBytes(root);
    vi.spyOn(chainModule, 'appendRecord').mockImplementationOnce(() => {
      throw new Error('injected stop before normal chain publication');
    });
    expect(appendVerbEvidence(request(root))).toMatchObject({ ok: false });
    expect(protectedBytes(root)).toEqual(before);
    vi.restoreAllMocks();
    expect(appendVerbEvidence(request(root))).toMatchObject({ ok: true });
    expect(verifyProofAnchors({ repoRoot: root, write: false }).valid).toBe(true);
  });
  it.each(['foreign-file', 'symlink', 'directory'] as const)(
    'refuses a %s append lock without replacing or deleting it',
    (kind) => {
      const { root } = fixture();
      const lock = join(root, `${CHAIN}.append.lock`);
      if (kind === 'foreign-file') fs.writeFileSync(lock, '{"operation":"foreign-owner"}\n');
      if (kind === 'directory') fs.mkdirSync(lock);
      if (kind === 'symlink') {
        fs.writeFileSync(join(root, 'held-lock'), 'external fixture custody');
        fs.symlinkSync(join(root, 'held-lock'), lock);
      }
      const identity = fs.lstatSync(lock);
      refused(root, () => appendVerbEvidence(request(root)));
      expect(fs.lstatSync(lock).ino).toBe(identity.ino);
      if (kind === 'symlink')
        expect(fs.readFileSync(join(root, 'held-lock'), 'utf8')).toBe('external fixture custody');
    },
  );

  it('never steals a recognized held append lock and refuses after the bounded wait', () => {
    const { root } = fixture();
    const lock = join(root, `${CHAIN}.append.lock`);
    const owner = JSON.stringify({
      operation: 'evidence-chain-append',
      chain_path: join(root, CHAIN),
      pid: -1,
      nonce: 'held-custody',
    });
    fs.writeFileSync(lock, owner);
    const identity = fs.lstatSync(lock);
    refused(root, () => appendVerbEvidence(request(root)));
    expect(fs.readFileSync(lock, 'utf8')).toBe(owner);
    expect(fs.lstatSync(lock).ino).toBe(identity.ino);
  }, 15_000);

  it('reports a foreign replacement during cleanup without removing it or hiding completed append', () => {
    const { root } = fixture();
    const prior = loadChain(join(root, CHAIN));
    const lock = join(root, `${CHAIN}.append.lock`);
    expect(() =>
      chainModule.appendRecord(
        join(root, CHAIN),
        {
          id: 'EV-0000000000000999',
          timestamp: '2026-10-24T16:00:00.000Z',
          actor: 'inspector-fixture',
          actor_role: 'harness',
          action: 'verify.translation',
          status: 'completed',
          context: { repo_root: root, git: { head_sha: null, dirty_files: [] } },
        },
        undefined,
        () => {
          fs.renameSync(lock, `${lock}.held-owned`);
          fs.writeFileSync(lock, 'foreign replacement owner');
        },
      ),
    ).toThrow(/cleanup incomplete.*append completed/u);
    expect(fs.readFileSync(lock, 'utf8')).toBe('foreign replacement owner');
    expect(loadChain(join(root, CHAIN)).records).toHaveLength(prior.records.length + 1);
    expect(verifyChain(join(root, CHAIN)).valid).toBe(true);
  });

  it('failure after writing complete temporary chain leaves canonical old and retry safe', () => {
    const { root } = fixture();
    const before = protectedBytes(root);
    const original = authority.renameSync;
    vi.spyOn(authority, 'renameSync').mockImplementation((from, to) => {
      if (String(from).startsWith(join(root, `${CHAIN}.tmp.`)))
        throw new Error('injected crash before canonical rename');
      return original(from, to);
    });
    expect(appendVerbEvidence(request(root))).toMatchObject({ ok: false });
    expect(protectedBytes(root)).toEqual(before);
    expect(fs.existsSync(join(root, `${CHAIN}.append.lock`))).toBe(false);
    const temporaries = fs
      .readdirSync(dirname(join(root, CHAIN)))
      .filter((name) => name.startsWith('chain.json.tmp.'));
    expect(temporaries).toHaveLength(1);
    const temporary = temporaries[0];
    if (temporary === undefined) throw new Error('missing complete crash residue');
    expect(
      JSON.parse(fs.readFileSync(join(root, 'record/proofs', temporary), 'utf8')),
    ).toHaveProperty('head');
    vi.restoreAllMocks();
    expect(appendVerbEvidence(request(root))).toMatchObject({ ok: true });
    expect(verifyProofAnchors({ repoRoot: root, write: false }).valid).toBe(true);
  });
  it('ordinary append identity binds the actual serialized predecessor after another writer advances head', () => {
    const { root } = fixture();
    const original = gitContext.gatherGitContext;
    vi.spyOn(gitContext, 'gatherGitContext').mockImplementationOnce((repoRoot) => {
      const context = original(repoRoot);
      expect(
        appendVerbEvidence({ repoRoot: root, action: 'verify.translation', status: 'completed' })
          .ok,
      ).toBe(true);
      return context;
    });
    expect(
      appendVerbEvidence({ repoRoot: root, action: 'verify.translation', status: 'completed' }).ok,
    ).toBe(true);
    const last = loadChain(join(root, CHAIN)).records.at(-1);
    if (last === undefined) throw new Error('missing ordinary append');
    expect(last.id).toBe(
      deriveEvidenceId({
        timestamp: last.timestamp,
        actor: last.actor,
        actor_role: last.actor_role,
        action: last.action,
        status: last.status,
        git_head_sha: last.context.git.head_sha,
        artifact_sha256s: last.artifacts.map((artifact) => artifact.sha256),
        previous_run_hash: last.previous_run_hash,
      }),
    );
  });
  it('fresh guarded lock retry classifies actual advanced canonical head as stale', () => {
    const { root } = fixture();
    const input = request(root);
    const before = loadChain(join(root, CHAIN));
    vi.spyOn(authority, 'publishFileNoReplaceSync').mockImplementationOnce(() => {
      expect(
        appendVerbEvidence({ repoRoot: root, action: 'verify.translation', status: 'completed' })
          .ok,
      ).toBe(true);
      throw new Error('AUTHORITY_RESOURCE_CHANGED_AFTER_PREPARE');
    });
    const result = appendVerbEvidence(input);
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('PROOF_ANCHOR_RECOVERY_STALE_HEAD');
    const after = loadChain(join(root, CHAIN));
    expect(after.records).toHaveLength(before.records.length + 1);
    expect(after.records.some((entry) => entry.recovered_from !== undefined)).toBe(false);
    expect(verifyChain(join(root, CHAIN)).valid).toBe(true);
  });

  it('retries exact publication resource-change through a fresh guarded decision without inventing stale head', () => {
    const { root } = fixture();
    const before = loadChain(join(root, CHAIN));
    const publish = vi.spyOn(authority, 'publishFileNoReplaceSync').mockImplementationOnce(() => {
      throw new Error('AUTHORITY_RESOURCE_CHANGED_AFTER_PREPARE');
    });
    expect(appendVerbEvidence(request(root))).toMatchObject({ ok: true });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(loadChain(join(root, CHAIN)).records).toHaveLength(before.records.length + 1);
    expect(verifyProofAnchors({ repoRoot: root, write: false }).valid).toBe(true);
  });

  it('preserves unrelated publication authority refusal and never disguises it as stale head', () => {
    const { root } = fixture();
    vi.spyOn(authority, 'publishFileNoReplaceSync').mockImplementationOnce(() => {
      throw new Error('AUTHORITY_SCOPE_UNDECLARED');
    });
    const before = protectedBytes(root);
    const result = appendVerbEvidence(request(root));
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('AUTHORITY_SCOPE_UNDECLARED');
    expect(result.error).not.toContain('PROOF_ANCHOR_RECOVERY_STALE_HEAD');
    expect(protectedBytes(root)).toEqual(before);
  });

  it('never retries or rewrites resource-change at canonical publication as a lock race', () => {
    const { root } = fixture();
    const before = protectedBytes(root);
    const original = authority.renameSync;
    const rename = vi.spyOn(authority, 'renameSync').mockImplementation((from, to) => {
      if (String(from).startsWith(join(root, `${CHAIN}.tmp.`)))
        throw new Error('AUTHORITY_RESOURCE_CHANGED_AFTER_PREPARE');
      return original(from, to);
    });
    const result = appendVerbEvidence(request(root));
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('AUTHORITY_RESOURCE_CHANGED_AFTER_PREPARE');
    expect(result.error).not.toContain('PROOF_ANCHOR_RECOVERY_STALE_HEAD');
    expect(rename).toHaveBeenCalledTimes(1);
    expect(protectedBytes(root)).toEqual(before);
  });
});
