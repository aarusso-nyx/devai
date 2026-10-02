import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { appendRecord, initChain, loadChain, type EvidenceArtifact } from './chain.js';
import { verifyProofAnchors } from './anchors.js';
import { gatherGitContext } from './git-context.js';
import { deriveEvidenceId } from './id-generator.js';
import {
  CANONICAL_PROOF_PATH,
  proofLineDigest,
  resolveProofAnchor,
  splitProofEpochBytes,
  verifyProofEpoch,
} from './proof-epoch.js';

export {
  verifyProofAnchors,
  type ProofAnchorVerification,
  type ProofAnchorVerificationInputs,
} from './anchors.js';

/**
 * Append one current CLI operation to the adopter's evidence chain.
 *
 * Never throws. Callers decide whether an append failure is fatal or a warning.
 */
export interface VerbEvidenceInputs {
  readonly repoRoot: string;
  /** Override the chain path; default <repoRoot>/record/proofs/chain.json. */
  readonly chainPath?: string;
  /** Stable operation identifier, for example `verify.translation`. */
  readonly action: string;
  readonly status: 'completed' | 'failed';
  readonly artifacts?: readonly EvidenceArtifact[];
  readonly notes?: readonly string[];
  /** Skip persistence for explicitly non-recording operations. */
  readonly automatic?: boolean;
  /**
   * ADR-EVI-0002: the proof line this entry anchors. The digest is computed from the bytes on
   * disk and recorded as `proof_path`, `proof_sequence`, and `proof_sha256`; the line itself is
   * never rewritten, so the same call recovers a line whose chain entry a crash left unwritten.
   */
  readonly proofAnchor?: { readonly path: string; readonly sequence: number };
  /** ADR-EVI-0005: recover only an immutable newest line, with an exact retry as a no-op. */
  readonly recoverNewestLine?: boolean;
}

export interface VerbEvidenceResult {
  readonly ok: boolean;
  readonly id?: string;
  readonly alreadyAnchored?: boolean;
  readonly error?: string;
}

export const VERB_EVIDENCE_ACTOR = 'devai-cli';

/** Read only regular files beneath the root, refusing every symlink component. */
function recoveryBytes(root: string, path: string, optional = false): Buffer | undefined {
  const components = path.split('/');
  for (let index = 0; index < components.length; index += 1) {
    const absolute = resolve(root, ...components.slice(0, index + 1));
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (
      stat.isSymbolicLink() ||
      (index === components.length - 1 ? !stat.isFile() : !stat.isDirectory())
    ) {
      throw new Error(`PROOF_ANCHOR_UNRESOLVED ${path}: not a regular path beneath the repository`);
    }
  }
  return readFileSync(resolve(root, path));
}

interface RecoverySnapshot {
  readonly proof: Buffer;
  readonly chain: Buffer | undefined;
  readonly baseline: Buffer | undefined;
  readonly anchor: { proof_path: string; proof_sequence: number; proof_sha256: string };
  readonly alreadyAnchored?: string;
}

function newestLineRecovery(inputs: VerbEvidenceInputs): RecoverySnapshot {
  const root = resolve(inputs.repoRoot);
  const selected = inputs.proofAnchor;
  if (
    selected === undefined ||
    !CANONICAL_PROOF_PATH.test(selected.path) ||
    !Number.isSafeInteger(selected.sequence) ||
    selected.sequence < 1 ||
    (inputs.chainPath !== undefined && inputs.chainPath !== 'record/proofs/chain.json')
  ) {
    throw new Error(
      'PROOF_ANCHOR_UNRESOLVED: recovery requires a canonical path and positive sequence',
    );
  }
  const kind = selected.path.split('/')[3] as string;
  const roundId = selected.path.slice(selected.path.lastIndexOf('/') + 1, -6);
  if (inputs.action !== `evidence.record.${kind}`) {
    throw new Error('PROOF_ANCHOR_UNRESOLVED: recovery action must match the proof kind');
  }
  const proof = recoveryBytes(root, selected.path) as Buffer;
  const physical = splitProofEpochBytes(proof);
  if (!physical.ok || physical.lines.length !== selected.sequence) {
    throw new Error(
      `PROOF_ANCHOR_UNRESOLVED ${selected.path}:${String(selected.sequence)}: recovery requires the newest complete physical line`,
    );
  }
  const epoch = verifyProofEpoch({ repoRoot: root, roundId, kind, requireClosed: false });
  if (!epoch.valid) {
    throw new Error(`PROOF_ANCHOR_UNRESOLVED ${selected.path}: ${epoch.errors.join('; ')}`);
  }
  const bytes = physical.lines[selected.sequence - 1] as Buffer;
  const anchor = {
    proof_path: selected.path,
    proof_sequence: selected.sequence,
    proof_sha256: proofLineDigest(bytes),
  };
  const chain = recoveryBytes(root, 'record/proofs/chain.json', true);
  const baseline = recoveryBytes(root, 'record/proofs/anchor-baseline.json', true);
  const chainPath = resolve(root, 'record/proofs/chain.json');
  const verification = verifyProofAnchors({
    repoRoot: root,
    chainPath,
    inspectRecovery: true,
    write: false,
  });
  // Gaps remain verification failures; only their missing entry may be appended here.
  // Absence diagnostics are ignored only when the safe snapshots prove actual absence.
  const defects = verification.errors.filter(
    (error) =>
      !error.startsWith('UNANCHORED_NEWEST_LINE ') &&
      !error.startsWith('PROOF_LINE_ORPHAN ') &&
      !(
        baseline === undefined &&
        error ===
          'PROOF_ANCHOR_BASELINE_MISSING record/proofs/anchor-baseline.json: no anchor baseline is recorded; rerun evidence verify --scope chain with --write to record the first baseline'
      ) &&
      !(
        chain === undefined &&
        error ===
          'PROOF_ANCHOR_UNRESOLVED record/proofs/chain.json: no evidence chain is recorded for read-only recovery inspection'
      ),
  );
  if (defects.length > 0) throw new Error(defects.join('; '));
  const finding = verification.lines.find(
    (line) => line.path === selected.path && line.sequence === selected.sequence,
  );
  if (finding?.label === 'historical gap acknowledged') {
    throw new Error(
      `PROOF_ANCHOR_UNRESOLVED ${selected.path}: recovery cannot replace a historical declaration`,
    );
  }
  let alreadyAnchored: string | undefined;
  if (chain !== undefined) {
    const claims = loadChain(chainPath).records.filter((record) => {
      if (
        record.proof_path !== undefined ||
        record.proof_sequence !== undefined ||
        record.proof_sha256 !== undefined
      ) {
        return record.proof_path === selected.path && record.proof_sequence === selected.sequence;
      }
      return (
        record.action === inputs.action &&
        record.notes?.includes(`round_id=${roundId}`) === true &&
        record.notes.includes(`proof_sequence=${String(selected.sequence)}`)
      );
    });
    if (claims.length > 1)
      throw new Error(`PROOF_ANCHOR_UNRESOLVED ${selected.path}: ambiguous anchors`);
    const claim = claims[0];
    if (claim !== undefined) {
      if (claim.proof_sha256 !== anchor.proof_sha256) {
        throw new Error(
          `PROOF_ANCHOR_UNRESOLVED ${selected.path}: existing anchor is not an exact digest retry`,
        );
      }
      alreadyAnchored = claim.id;
    }
  } else if (baseline !== undefined) {
    // A recorded baseline without its chain is missing immutable evidence, not a first-write crash.
    throw new Error(
      'PROOF_ANCHOR_UNRESOLVED: the baseline exists but its evidence chain is missing',
    );
  }
  if (
    chain !== undefined &&
    alreadyAnchored === undefined &&
    chain.toString('utf8') !==
      `${JSON.stringify(loadChain(resolve(root, 'record/proofs/chain.json')), null, 2)}\n`
  ) {
    throw new Error('PROOF_ANCHOR_UNRESOLVED: appending would change existing chain record bytes');
  }
  return {
    proof,
    chain,
    baseline,
    anchor,
    ...(alreadyAnchored === undefined ? {} : { alreadyAnchored }),
  };
}

function recheckRecovery(inputs: VerbEvidenceInputs, snapshot: RecoverySnapshot): void {
  const root = resolve(inputs.repoRoot);
  for (const [path, before] of [
    [snapshot.anchor.proof_path, snapshot.proof],
    ['record/proofs/chain.json', snapshot.chain],
    ['record/proofs/anchor-baseline.json', snapshot.baseline],
  ] as const) {
    const now = recoveryBytes(root, path, before === undefined);
    if (before === undefined ? now !== undefined : now === undefined || !before.equals(now)) {
      throw new Error(
        `PROOF_ANCHOR_UNRESOLVED ${path}: immutable recovery inputs changed before append`,
      );
    }
  }
}

export function appendVerbEvidence(inputs: VerbEvidenceInputs): VerbEvidenceResult {
  if (inputs.automatic === true) {
    return inputs.recoverNewestLine === true
      ? { ok: false, error: 'PROOF_ANCHOR_UNRESOLVED: recovery must persist its anchor' }
      : { ok: true };
  }
  try {
    const chainPath = resolve(inputs.repoRoot, inputs.chainPath ?? 'record/proofs/chain.json');
    const recovery = inputs.recoverNewestLine === true ? newestLineRecovery(inputs) : undefined;
    if (recovery?.alreadyAnchored !== undefined) {
      recheckRecovery(inputs, recovery);
      return { ok: true, id: recovery.alreadyAnchored, alreadyAnchored: true };
    }
    let anchor: { proof_path: string; proof_sequence: number; proof_sha256: string } | undefined;
    if (recovery !== undefined) {
      anchor = recovery.anchor;
    } else if (inputs.proofAnchor !== undefined) {
      const resolution = resolveProofAnchor(resolve(inputs.repoRoot), inputs.proofAnchor);
      if (!resolution.resolved) {
        return {
          ok: false,
          error: `PROOF_ANCHOR_UNRESOLVED ${inputs.proofAnchor.path}:${String(inputs.proofAnchor.sequence)}: ${resolution.reason}`,
        };
      }
      anchor = {
        proof_path: resolution.path,
        proof_sequence: resolution.sequence,
        proof_sha256: resolution.sha256,
      };
    }
    const chain =
      recovery?.chain === undefined && recovery !== undefined
        ? { head: null, records: [] }
        : recovery !== undefined
          ? loadChain(chainPath)
          : initChain(chainPath);
    const timestamp = new Date().toISOString();
    const git = gatherGitContext(inputs.repoRoot);
    const artifacts = inputs.artifacts ? [...inputs.artifacts] : [];
    const id = deriveEvidenceId({
      timestamp,
      actor: VERB_EVIDENCE_ACTOR,
      actor_role: 'harness',
      action: inputs.action,
      status: inputs.status,
      git_head_sha: git.head_sha,
      artifact_sha256s: artifacts.map((artifact) => artifact.sha256),
      previous_run_hash: chain.head,
    });
    // Keep the final immutable byte check adjacent to the only permitted persistence.
    if (recovery !== undefined) {
      recheckRecovery(inputs, recovery);
      if (recovery.chain === undefined) initChain(chainPath);
    }
    const notes =
      recovery === undefined
        ? inputs.notes
        : [
            `round_id=${recovery.anchor.proof_path.slice(recovery.anchor.proof_path.lastIndexOf('/') + 1, -6)}`,
            `proof_sequence=${String(recovery.anchor.proof_sequence)}`,
          ];
    appendRecord(chainPath, {
      id,
      timestamp,
      actor: VERB_EVIDENCE_ACTOR,
      actor_role: 'harness',
      action: inputs.action,
      status: inputs.status,
      context: { repo_root: inputs.repoRoot, git },
      artifacts,
      ...(notes === undefined ? {} : { notes }),
      ...anchor,
    });
    return { ok: true, id };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
