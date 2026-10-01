import { resolve } from 'node:path';
import { appendRecord, initChain, loadChain, type EvidenceArtifact } from './chain.js';
import { gatherGitContext } from './git-context.js';
import { deriveEvidenceId } from './id-generator.js';
import { resolveProofAnchor } from './proof-epoch.js';

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
}

export interface VerbEvidenceResult {
  readonly ok: boolean;
  readonly id?: string;
  readonly error?: string;
}

export const VERB_EVIDENCE_ACTOR = 'devai-cli';

export function appendVerbEvidence(inputs: VerbEvidenceInputs): VerbEvidenceResult {
  if (inputs.automatic === true) return { ok: true };
  try {
    const chainPath = resolve(inputs.repoRoot, inputs.chainPath ?? 'record/proofs/chain.json');
    let anchor: { proof_path: string; proof_sequence: number; proof_sha256: string } | undefined;
    if (inputs.proofAnchor !== undefined) {
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
    initChain(chainPath);
    const chain = loadChain(chainPath);
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
    appendRecord(chainPath, {
      id,
      timestamp,
      actor: VERB_EVIDENCE_ACTOR,
      actor_role: 'harness',
      action: inputs.action,
      status: inputs.status,
      context: { repo_root: inputs.repoRoot, git },
      artifacts,
      ...(inputs.notes === undefined ? {} : { notes: inputs.notes }),
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
