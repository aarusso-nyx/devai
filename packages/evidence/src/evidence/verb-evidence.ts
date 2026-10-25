import { lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  appendRecord,
  initChain,
  loadChain,
  verifyLoadedChain,
  type EvidenceChain,
  type RecoveredFrom,
  type EvidenceArtifact,
} from './chain.js';
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
  readonly recoverDivergentAnchor?: {
    readonly sourceChain: string;
    readonly sourceChainSha256: string;
    readonly expectedHead: string;
  };
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
  readonly source?: { readonly path: string; readonly bytes: Buffer };
  readonly recoveredFrom?: RecoveredFrom;
}

function newestLineRecovery(inputs: VerbEvidenceInputs, divergent = false): RecoverySnapshot {
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
  if (
    !physical.ok ||
    (divergent
      ? selected.sequence >= physical.lines.length
      : physical.lines.length !== selected.sequence)
  ) {
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

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Classify stale heads only from a verified regular canonical-chain snapshot. */
function recoveryCanonicalChain(root: string): EvidenceChain {
  const bytes = recoveryBytes(root, 'record/proofs/chain.json') as Buffer;
  const canonical = JSON.parse(bytes.toString('utf8')) as EvidenceChain;
  if (
    canonical === null ||
    typeof canonical !== 'object' ||
    !Array.isArray(canonical.records) ||
    !verifyLoadedChain(canonical).valid
  )
    throw new Error('PROOF_ANCHOR_RECOVERY_REFUSED: canonical chain verification failed');
  return canonical;
}

function divergentAnchorRecovery(inputs: VerbEvidenceInputs): RecoverySnapshot {
  try {
    const request = inputs.recoverDivergentAnchor;
    if (
      request === undefined ||
      inputs.recoverNewestLine === true ||
      !/^[a-f0-9]{64}$/u.test(request.expectedHead) ||
      !/^[a-f0-9]{64}$/u.test(request.sourceChainSha256) ||
      request.sourceChain === 'record/proofs/chain.json' ||
      request.sourceChain.includes('\\') ||
      request.sourceChain.split('/').some((part) => part === '' || part === '.' || part === '..')
    )
      throw new Error('invalid or mixed divergent recovery selection');
    const root = resolve(inputs.repoRoot);
    const canonical = recoveryCanonicalChain(root);
    if (canonical.head !== request.expectedHead)
      throw new Error(
        'PROOF_ANCHOR_RECOVERY_STALE_HEAD: expected head differs from canonical head',
      );
    const snapshot = newestLineRecovery(inputs, true);
    if (snapshot.chain === undefined) throw new Error('canonical chain is missing');
    const sourceBytes = recoveryBytes(root, request.sourceChain) as Buffer;
    if (createHash('sha256').update(sourceBytes).digest('hex') !== request.sourceChainSha256)
      throw new Error('source chain digest mismatch');
    const source = JSON.parse(sourceBytes.toString('utf8')) as EvidenceChain;
    if (
      !Array.isArray(source.records) ||
      source.records.length === 0 ||
      !verifyLoadedChain(source).valid ||
      !verifyLoadedChain(canonical).valid
    )
      throw new Error('source or canonical chain verification failed');
    let fork = 0;
    while (
      fork < source.records.length &&
      fork < canonical.records.length &&
      stable(source.records[fork]) === stable(canonical.records[fork])
    )
      fork += 1;
    if (fork < 1 || fork === source.records.length || fork === canonical.records.length)
      throw new Error('chains do not have a divergent common prefix');
    const physical = splitProofEpochBytes(snapshot.proof);
    if (!physical.ok) throw new Error('proof epoch is incomplete');
    const claims = source.records.filter(
      (record) => record.proof_path === snapshot.anchor.proof_path,
    );
    const seenSequences = new Set<number>();
    for (const claim of claims) {
      if (
        !Number.isSafeInteger(claim.proof_sequence) ||
        (claim.proof_sequence ?? 0) < 1 ||
        claim.proof_sequence === undefined ||
        claim.proof_sequence > physical.lines.length ||
        claim.proof_sha256 !== proofLineDigest(physical.lines[claim.proof_sequence - 1] as Buffer)
      )
        throw new Error('source anchor epoch prefix differs from physical proof bytes');
      if (seenSequences.has(claim.proof_sequence))
        throw new Error('source has duplicate epoch anchors');
      seenSequences.add(claim.proof_sequence);
    }
    const matches = claims.filter(
      (record) => record.proof_sequence === snapshot.anchor.proof_sequence,
    );
    const entry = matches[0];
    if (
      matches.length !== 1 ||
      entry === undefined ||
      entry.recovered_from !== undefined ||
      entry.sequence === undefined ||
      entry.sequence !== source.records.indexOf(entry) + 1 ||
      entry.sequence <= fork ||
      entry.action !== inputs.action
    )
      throw new Error('source requires exactly one original direct anchor after the fork');
    const recoveredFrom: RecoveredFrom = {
      source_chain_path: request.sourceChain,
      source_chain_sha256: request.sourceChainSha256,
      source_entry_id: entry.id,
      source_entry_sequence: entry.sequence,
      source_entry_manifest_hash: entry.manifest_hash,
      fork_sequence: fork,
    };
    if (snapshot.alreadyAnchored !== undefined) {
      const existing = canonical.records.find((record) => record.id === snapshot.alreadyAnchored);
      if (
        existing?.recovered_from === undefined ||
        stable(existing.recovered_from) !== stable(recoveredFrom)
      )
        throw new Error('existing anchor has different or absent recovery provenance');
    }
    return {
      ...snapshot,
      source: { path: request.sourceChain, bytes: sourceBytes },
      recoveredFrom,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('PROOF_ANCHOR_RECOVERY_STALE_HEAD')) throw error;
    throw new Error(`PROOF_ANCHOR_RECOVERY_REFUSED ${message}`);
  }
}

function recheckRecovery(inputs: VerbEvidenceInputs, snapshot: RecoverySnapshot): void {
  const root = resolve(inputs.repoRoot);
  if (
    inputs.recoverDivergentAnchor !== undefined &&
    recoveryCanonicalChain(root).head !== inputs.recoverDivergentAnchor.expectedHead
  )
    throw new Error('PROOF_ANCHOR_RECOVERY_STALE_HEAD: canonical head changed before append');
  for (const [path, before] of [
    [snapshot.anchor.proof_path, snapshot.proof],
    ['record/proofs/chain.json', snapshot.chain],
    ['record/proofs/anchor-baseline.json', snapshot.baseline],
    ...(snapshot.source === undefined
      ? []
      : [[snapshot.source.path, snapshot.source.bytes] as const]),
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
    return inputs.recoverNewestLine === true || inputs.recoverDivergentAnchor !== undefined
      ? { ok: false, error: 'PROOF_ANCHOR_UNRESOLVED: recovery must persist its anchor' }
      : { ok: true };
  }
  try {
    const chainPath = resolve(inputs.repoRoot, inputs.chainPath ?? 'record/proofs/chain.json');
    const divergent = inputs.recoverDivergentAnchor !== undefined;
    const recovery = divergent
      ? divergentAnchorRecovery(inputs)
      : inputs.recoverNewestLine === true
        ? newestLineRecovery(inputs)
        : undefined;
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
    const artifacts =
      recovery?.source === undefined
        ? inputs.artifacts
          ? [...inputs.artifacts]
          : []
        : [
            {
              path: recovery.source.path,
              sha256: inputs.recoverDivergentAnchor?.sourceChainSha256 ?? null,
            },
            {
              path: `${recovery.anchor.proof_path}:${String(recovery.anchor.proof_sequence)}`,
              sha256: recovery.anchor.proof_sha256,
            },
          ];
    const deriveIdForHead = (head: string | null) =>
      deriveEvidenceId({
        timestamp,
        actor: VERB_EVIDENCE_ACTOR,
        actor_role: 'harness',
        action: inputs.action,
        status: inputs.status,
        git_head_sha: git.head_sha,
        artifact_sha256s: artifacts.map((artifact) => artifact.sha256),
        previous_run_hash: head,
      });
    let id = deriveIdForHead(chain.head);
    {
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
      const stored = appendRecord(
        chainPath,
        {
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
          ...(recovery?.recoveredFrom === undefined
            ? {}
            : { recovered_from: recovery.recoveredFrom }),
        },
        inputs.recoverDivergentAnchor?.expectedHead,
        inputs.recoverDivergentAnchor === undefined
          ? undefined
          : () => {
              divergentAnchorRecovery(inputs);
              if (recovery !== undefined) recheckRecovery(inputs, recovery);
            },
        deriveIdForHead,
      );
      id = stored.id;
    }
    return { ok: true, id };
  } catch (error) {
    return {
      ok: false,
      error:
        inputs.recoverDivergentAnchor !== undefined &&
        !(error instanceof Error && error.message.startsWith('PROOF_ANCHOR_RECOVERY_'))
          ? `PROOF_ANCHOR_RECOVERY_REFUSED ${error instanceof Error ? error.message : String(error)}`
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}
