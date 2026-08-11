import { getValidator } from '@devai-nyx/schemas';
import { redact, type RedactionPolicy } from '@devai-nyx/utils';
import {
  computeManifestHash,
  extractManifestInputs,
  loadChain,
  saveChain,
  type EvidenceRecord,
} from './chain.js';

const validateEvidence = getValidator('evidence.schema.json');

export interface RedactRecordInputs {
  readonly chainPath: string;
  readonly targetId: string;
  readonly policy: RedactionPolicy;
}

export interface RedactRecordResult {
  readonly target: EvidenceRecord;
  readonly relinkedCount: number;
  readonly newHead: string;
}

/**
 * Apply a redaction policy to the target record's mutable string fields,
 * recompute its manifest_hash, and re-link every downstream record so the
 * chain stays internally consistent.
 *
 * Mutable fields (subject to redaction):
 *   - actor
 *   - notes[i]
 *   - artifacts[i].path
 *   - context.repo_root
 *
 * Immutable fields (never redacted, structural):
 *   - id, timestamp, action, actor_role, status
 *   - schemaVersion, previous_run_hash, manifest_hash
 *   - context.git.head_sha, context.git.dirty_files
 *
 * After this call the chain's head pointer is updated. The caller is
 * expected to append a separate `evidence.redact` event documenting the
 * redaction (who, when, what fields/patterns) — that's the audit trail.
 */
export function redactRecord(inputs: RedactRecordInputs): RedactRecordResult {
  const chain = loadChain(inputs.chainPath);
  const targetIdx = chain.records.findIndex((r) => r.id === inputs.targetId);
  if (targetIdx === -1) {
    throw new Error(`record ${inputs.targetId} not found in chain`);
  }
  const target = chain.records[targetIdx];
  if (!target) {
    throw new Error('unreachable: targetIdx valid but record missing');
  }

  const redactedTarget = applyRedactionToRecord(target, inputs.policy);
  const newTargetHash = computeManifestHash(extractManifestInputs(redactedTarget));
  redactedTarget.manifest_hash = newTargetHash;
  assertValidEvidence(redactedTarget, `redacted target ${redactedTarget.id}`);
  chain.records[targetIdx] = redactedTarget;

  let prevHash: string = newTargetHash;
  let relinkedCount = 0;
  for (let i = targetIdx + 1; i < chain.records.length; i++) {
    const downstream = chain.records[i];
    if (!downstream) continue;
    downstream.previous_run_hash = prevHash;
    const newHash = computeManifestHash(extractManifestInputs(downstream));
    downstream.manifest_hash = newHash;
    assertValidEvidence(downstream, `re-linked downstream ${downstream.id}`);
    prevHash = newHash;
    relinkedCount++;
  }

  chain.head = prevHash;
  saveChain(inputs.chainPath, chain);

  return { target: redactedTarget, relinkedCount, newHead: prevHash };
}

function assertValidEvidence(record: EvidenceRecord, label: string): void {
  const ok = validateEvidence(record);
  if (!ok) {
    throw new Error(
      `redactRecord: ${label} does not validate against evidence.schema.json: ${JSON.stringify(validateEvidence.errors)}`,
    );
  }
}

function applyRedactionToRecord(record: EvidenceRecord, policy: RedactionPolicy): EvidenceRecord {
  return {
    ...record,
    actor: redactField('actor', record.actor, policy),
    ...(record.notes !== undefined && {
      notes: record.notes.map((n) => redact(n, policy) as string),
    }),
    artifacts: record.artifacts.map((a) => ({
      ...a,
      path: redactField('path', a.path, policy),
    })),
    context: {
      ...record.context,
      repo_root: redactField('repo_root', record.context.repo_root, policy),
    },
  };
}

function redactField(key: string, value: string, policy: RedactionPolicy): string {
  if (policy.fields.includes(key)) return '[REDACTED]';
  return redact(value, policy) as string;
}
