import { resolve } from 'node:path';
import { appendRecord, initChain, loadChain, type EvidenceArtifact } from './chain.js';
import { gatherGitContext } from './git-context.js';
import { deriveEvidenceId } from './id-generator.js';

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
    });
    return { ok: true, id };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
