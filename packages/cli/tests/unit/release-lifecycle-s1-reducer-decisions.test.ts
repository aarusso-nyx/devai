import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  finalizeReleaseStateV2,
  reduceReleaseStates,
  type ReleaseLifecycleStateV2,
} from '../../src/services/release-lifecycle-execution.js';

function preflightState(): ReleaseLifecycleStateV2 {
  const schema = JSON.parse(
    readFileSync(join(process.cwd(), 'law/schemas/release-lifecycle-state.schema.json'), 'utf8'),
  ) as { examples: readonly ReleaseLifecycleStateV2[] };
  const example = schema.examples[0];
  if (example === undefined) throw new Error('missing lifecycle state schema example');
  const { state_id: _stateId, record_digest_sha256: _digest, ...draft } = structuredClone(example);
  return finalizeReleaseStateV2(draft);
}

function certifiedAfter(
  preflight: ReleaseLifecycleStateV2,
  receiptDigest?: string,
): ReleaseLifecycleStateV2 {
  const receipts = preflight['bound_receipts'] as readonly {
    readonly kind: 'release-plan-receipt';
    readonly receipt_id: string;
    readonly receipt_digest_sha256: string;
    readonly verdict: 'pass';
  }[];
  const selectedDigest = receiptDigest ?? receipts[0]?.receipt_digest_sha256;
  if (selectedDigest === undefined) throw new Error('missing preflight plan binding');
  const { state_id: _stateId, record_digest_sha256: _digest, ...draft } = preflight;
  return finalizeReleaseStateV2({
    ...draft,
    state: 'certified',
    action_id: 'release certify',
    bound_receipts: receipts.map((receipt) => ({
      ...receipt,
      receipt_digest_sha256: selectedDigest,
    })),
    prior_state: {
      state: preflight.state,
      state_id: preflight.state_id,
      record_digest_sha256: preflight.record_digest_sha256,
    },
    storage: {
      generation: preflight.storage.generation + 1,
      head_before: {
        generation: preflight.storage.generation,
        record_digest_sha256: preflight.record_digest_sha256,
      },
    },
  });
}

describe('release lifecycle S1 reducer decisions', () => {
  it('retains the first plan population and reports an exact later plan drift', () => {
    const preflight = preflightState();
    const changedPlan = certifiedAfter(preflight, 'f'.repeat(64));

    expect(reduceReleaseStates([preflight, changedPlan])).toEqual({
      ok: false,
      head: changedPlan,
      errors: ['release-receipt-identity-mismatch'],
    });
  });

  it('reports the transition predicate independently of predecessor and head drift', () => {
    const preflight = preflightState();
    const certified = certifiedAfter(preflight);
    const repeatedCertified = certifiedAfter(preflight);

    expect(reduceReleaseStates([preflight, certified, repeatedCertified])).toEqual({
      ok: false,
      head: repeatedCertified,
      errors: [
        'release-state-predecessor-mismatch',
        'release-state-head-mismatch',
        'release-state-transition-invalid',
      ],
    });
  });
});
