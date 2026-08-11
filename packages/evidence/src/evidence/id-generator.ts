import { createHash } from 'node:crypto';
import type { ManifestHashInputs } from './chain.js';

/**
 * Derive an `EV-<16hex>` id from the canonical manifest inputs minus the id
 * itself. Content-hash style per D-32, with the first 16 hex of SHA-256.
 *
 * Same field order and same artifact-sort as computeManifestHash to keep the
 * id derivation linked to the same canon. Two records with identical
 * canonical-minus-id will collide — in practice timestamps differ.
 */
export type IdDerivationInputs = Omit<ManifestHashInputs, 'id'>;

export function deriveEvidenceId(inputs: IdDerivationInputs): string {
  const sortedArtifacts = [...inputs.artifact_sha256s].sort((a, b) => {
    const aa = a ?? '';
    const bb = b ?? '';
    if (aa < bb) return -1;
    if (aa > bb) return 1;
    return 0;
  });
  const canonical = JSON.stringify([
    inputs.timestamp,
    inputs.actor,
    inputs.actor_role,
    inputs.action,
    inputs.status,
    inputs.git_head_sha,
    sortedArtifacts,
    inputs.previous_run_hash,
  ]);
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `EV-${hash.slice(0, 16)}`;
}
