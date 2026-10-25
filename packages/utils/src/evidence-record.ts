import {
  computeEvidenceManifestHash,
  type EvidenceManifestHashInputs,
} from './evidence-integrity.js';

export interface EvidenceContext {
  repo_root: string;
  task_id?: string | null;
  worktree_id?: string | null;
  branch?: string | null;
  git: {
    head_sha: string | null;
    dirty_files: string[];
  };
}

export interface EvidenceArtifact {
  path: string;
  sha256: string | null;
  kind?: string;
}

export interface FindingsSummary {
  info?: number;
  warning?: number;
  error?: number;
  critical?: number;
}

export interface RecoveredFrom {
  readonly source_chain_path: string;
  readonly source_chain_sha256: string;
  readonly source_entry_id: string;
  readonly source_entry_sequence: number;
  readonly source_entry_manifest_hash: string;
  readonly fork_sequence: number;
}

export interface EvidenceRecord {
  schemaVersion: '1.0.0';
  id: string;
  timestamp: string;
  actor: string;
  actor_role: string;
  action: string;
  status: string;
  context: EvidenceContext;
  artifacts: EvidenceArtifact[];
  findings_summary?: FindingsSummary;
  notes?: string[];
  previous_run_hash: string | null;
  manifest_hash: string;
  /** Canonical append ordinal for fresh adopter chains. */
  sequence?: number;
  /** Human-readable predecessor alias: GENESIS or the prior manifest hash. */
  previous_hash?: string;
  /** ADR-EVI-0002 anchor: the canonical path of the proof epoch file holding the line. */
  proof_path?: string;
  /** ADR-EVI-0002 anchor: the one-based position of the line within that file. */
  proof_sequence?: number;
  /** ADR-EVI-0002 anchor: the SHA-256 of the line bytes, exclusive of the newline. */
  proof_sha256?: string;
  recovered_from?: RecoveredFrom;
}

export interface DraftEvidence {
  readonly id: string;
  readonly timestamp: string;
  readonly actor: string;
  readonly actor_role: string;
  readonly action: string;
  readonly status: string;
  readonly context: EvidenceContext;
  readonly artifacts?: readonly EvidenceArtifact[];
  readonly findings_summary?: FindingsSummary;
  readonly notes?: readonly string[];
  readonly proof_path?: string;
  readonly proof_sequence?: number;
  readonly proof_sha256?: string;
  readonly recovered_from?: RecoveredFrom;
}

/** Shared normal-record construction only; callers retain schema validation and all effects. */
export function buildEvidenceRecord(
  draft: DraftEvidence,
  previous_run_hash: string | null,
  sequence: number,
  id = draft.id,
): EvidenceRecord {
  const artifacts = draft.artifacts ? [...draft.artifacts] : [];
  const inputs: EvidenceManifestHashInputs = {
    id,
    timestamp: draft.timestamp,
    actor: draft.actor,
    actor_role: draft.actor_role,
    action: draft.action,
    status: draft.status,
    git_head_sha: draft.context.git.head_sha,
    artifact_sha256s: artifacts.map((a) => a.sha256),
    previous_run_hash,
  };
  const manifest_hash = computeEvidenceManifestHash(inputs);
  const record: EvidenceRecord = {
    schemaVersion: '1.0.0',
    id,
    timestamp: draft.timestamp,
    actor: draft.actor,
    actor_role: draft.actor_role,
    action: draft.action,
    status: draft.status,
    context: draft.context,
    artifacts,
    ...(draft.findings_summary !== undefined && { findings_summary: draft.findings_summary }),
    ...(draft.notes !== undefined && { notes: [...draft.notes] }),
    ...(draft.proof_path !== undefined && { proof_path: draft.proof_path }),
    ...(draft.proof_sequence !== undefined && { proof_sequence: draft.proof_sequence }),
    ...(draft.proof_sha256 !== undefined && { proof_sha256: draft.proof_sha256 }),
    ...(draft.recovered_from !== undefined && { recovered_from: { ...draft.recovered_from } }),
    previous_run_hash,
    manifest_hash,
    sequence,
    previous_hash: previous_run_hash ?? 'GENESIS',
  };
  return record;
}
