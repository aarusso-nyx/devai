import { createHash } from 'node:crypto';

/** Historical evidence formats. Keep these byte algorithms separate from JCS. */
export interface EvidenceManifestHashInputs {
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

export function computeEvidenceManifestHash(inputs: EvidenceManifestHashInputs): string {
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

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, member]) => [key, stable(member)]),
    );
  }
  return value;
}

export function computeEvidenceEpochLineHash(line: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stable(line)))
    .digest('hex');
}
