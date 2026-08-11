import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { dirname } from 'node:path';
import { getValidator } from '@devai-nyx/schemas';

const validateEvidence = getValidator('evidence.schema.json');

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
}

export interface EvidenceChain {
  head: string | null;
  records: EvidenceRecord[];
}

export interface ManifestHashInputs {
  readonly id: string;
  readonly timestamp: string;
  readonly actor: string;
  readonly actor_role: string;
  readonly action: string;
  readonly status: string;
  readonly git_head_sha: string | null;
  readonly artifact_sha256s: readonly (string | null)[];
  readonly previous_run_hash: string | null;
}

const DOMAIN_SEPARATOR = 'GENESIS';

export function computeManifestHash(inputs: ManifestHashInputs): string {
  const sortedArtifacts = [...inputs.artifact_sha256s].sort((a, b) => {
    const aa = a ?? '';
    const bb = b ?? '';
    if (aa < bb) return -1;
    if (aa > bb) return 1;
    return 0;
  });
  const canonical = JSON.stringify([
    inputs.id,
    inputs.timestamp,
    inputs.actor,
    inputs.actor_role,
    inputs.action,
    inputs.status,
    inputs.git_head_sha,
    sortedArtifacts,
    inputs.previous_run_hash,
    DOMAIN_SEPARATOR,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export function extractManifestInputs(record: EvidenceRecord): ManifestHashInputs {
  return {
    id: record.id,
    timestamp: record.timestamp,
    actor: record.actor,
    actor_role: record.actor_role,
    action: record.action,
    status: record.status,
    git_head_sha: record.context.git.head_sha,
    artifact_sha256s: record.artifacts.map((a) => a.sha256),
    previous_run_hash: record.previous_run_hash,
  };
}

function atomicWriteFileSync(path: string, contents: string): void {
  const tmp = `${path}.tmp.${process.pid.toString()}.${Date.now().toString()}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

export function initChain(chainPath: string): EvidenceChain {
  if (existsSync(chainPath)) return loadChain(chainPath);
  const empty: EvidenceChain = { head: null, records: [] };
  mkdirSync(dirname(chainPath), { recursive: true });
  atomicWriteFileSync(chainPath, JSON.stringify(empty, null, 2) + '\n');
  return empty;
}

export function loadChain(chainPath: string): EvidenceChain {
  const text = readFileSync(chainPath, 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`evidence chain at ${chainPath} is not a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.records)) {
    throw new Error(`evidence chain at ${chainPath} has an invalid 'records' field`);
  }
  if (obj.head !== null && typeof obj.head !== 'string') {
    throw new Error(`evidence chain at ${chainPath} has an invalid 'head' field`);
  }
  return parsed as EvidenceChain;
}

export function saveChain(chainPath: string, chain: EvidenceChain): void {
  atomicWriteFileSync(chainPath, JSON.stringify(chain, null, 2) + '\n');
}

export function appendRecord(chainPath: string, draft: DraftEvidence): EvidenceRecord {
  const chain = loadChain(chainPath);
  const previous_run_hash = chain.head;
  const artifacts = draft.artifacts ? [...draft.artifacts] : [];
  const inputs: ManifestHashInputs = {
    id: draft.id,
    timestamp: draft.timestamp,
    actor: draft.actor,
    actor_role: draft.actor_role,
    action: draft.action,
    status: draft.status,
    git_head_sha: draft.context.git.head_sha,
    artifact_sha256s: artifacts.map((a) => a.sha256),
    previous_run_hash,
  };
  const manifest_hash = computeManifestHash(inputs);
  const record: EvidenceRecord = {
    schemaVersion: '1.0.0',
    id: draft.id,
    timestamp: draft.timestamp,
    actor: draft.actor,
    actor_role: draft.actor_role,
    action: draft.action,
    status: draft.status,
    context: draft.context,
    artifacts,
    ...(draft.findings_summary !== undefined && { findings_summary: draft.findings_summary }),
    ...(draft.notes !== undefined && { notes: [...draft.notes] }),
    previous_run_hash,
    manifest_hash,
  };
  const ok = validateEvidence(record);
  if (!ok) {
    throw new Error(
      `evidence record does not validate against schema: ${JSON.stringify(validateEvidence.errors)}`,
    );
  }
  chain.records.push(record);
  chain.head = manifest_hash;
  saveChain(chainPath, chain);
  return record;
}

export interface VerifyResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function verifyChain(chainPath: string): VerifyResult {
  const chain = loadChain(chainPath);
  const errors: string[] = [];
  let prev: string | null = null;
  for (const record of chain.records) {
    if (record.previous_run_hash !== prev) {
      errors.push(
        `record ${record.id}: previous_run_hash mismatch (expected ${prev ?? 'null'}, got ${record.previous_run_hash ?? 'null'})`,
      );
    }
    const expected = computeManifestHash(extractManifestInputs(record));
    if (expected !== record.manifest_hash) {
      errors.push(
        `record ${record.id}: manifest_hash mismatch (expected ${expected}, got ${record.manifest_hash})`,
      );
    }
    prev = record.manifest_hash;
  }
  if (chain.head !== prev) {
    errors.push(`chain head mismatch (expected ${prev ?? 'null'}, got ${chain.head ?? 'null'})`);
  }
  return { valid: errors.length === 0, errors };
}
