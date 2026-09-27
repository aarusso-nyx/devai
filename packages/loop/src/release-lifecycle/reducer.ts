import { parsers } from '@devai-nyx/schemas';
import type {
  PersistedReleaseState,
  ReleaseLifecycleStateRecord,
  ReleaseStateReference,
  ReleaseLifecycleReduction,
  ReleaseLifecycleError,
  ReleaseIdentity,
  ReleaseCandidateIdentity,
} from './types.js';
import { computeReleaseStateRecordDigest, same } from './receipts.js';

const TRANSITIONS: Readonly<
  Record<
    PersistedReleaseState,
    Readonly<{
      action: ReleaseLifecycleStateRecord['action_id'];
      prior: PersistedReleaseState | null;
    }>
  >
> = {
  preflight_passed: { action: 'release preflight', prior: null },
  certified: { action: 'release certify', prior: 'preflight_passed' },
  prepared: { action: 'release prepare', prior: 'certified' },
  exported: { action: 'release export', prior: 'prepared' },
  evidence_published: { action: 'release evidence-publish', prior: 'exported' },
  publication_dispatched: { action: 'release publish', prior: 'evidence_published' },
};

export function reference(record: ReleaseLifecycleStateRecord): ReleaseStateReference {
  return {
    state: record.state,
    state_id: record.state_id,
    record_digest_sha256: record.record_digest_sha256,
  };
}

export function reduceReleaseLifecycle(
  recordsInput: readonly unknown[],
): ReleaseLifecycleReduction {
  const errors = new Set<ReleaseLifecycleError>();
  const records: ReleaseLifecycleStateRecord[] = [];
  const stateIds = new Set<string>();
  let head: ReleaseLifecycleStateRecord | null = null;
  let identity: { repository: ReleaseIdentity; candidate: ReleaseCandidateIdentity } | undefined;

  for (const input of recordsInput) {
    const parsed = parsers.releaseLifecycleState.safeParse<ReleaseLifecycleStateRecord>(input);
    if (!parsed.ok) {
      errors.add('release-state-schema-invalid');
      continue;
    }
    const record = parsed.value;
    records.push(record);
    if (computeReleaseStateRecordDigest(record) !== record.record_digest_sha256) {
      errors.add('release-state-record-digest-mismatch');
    }
    if (stateIds.has(record.state_id)) errors.add('release-state-id-duplicate');
    stateIds.add(record.state_id);

    const transition = TRANSITIONS[record.state];
    const observedPriorState = head === null ? null : head.state;
    if (record.action_id !== transition.action || transition.prior !== observedPriorState) {
      errors.add('release-state-transition-invalid');
    }
    const expectedPrior = head === null ? null : reference(head);
    if (!same(record.prior_state, expectedPrior)) errors.add('release-state-prior-mismatch');

    identity ??= { repository: record.repository, candidate: record.candidate };
    if (!same(record.repository, identity.repository))
      errors.add('release-state-repository-mismatch');
    if (!same(record.candidate, identity.candidate)) errors.add('release-state-candidate-mismatch');
    head = record;
  }

  return errors.size === 0 ? { ok: true, records, head } : { ok: false, errors: [...errors] };
}
