import type { ProtectedReleaseHostRunnerControls } from './release-protected-host-runner-types.js';
import { closed, fail } from './release-protected-host-runner-lane.js';

/**
 * Refuse a runner control object outside the exact lane, store and stage field
 * sets, and the offloaded mutation fixture; returns the lane field list the
 * fixture lane is later checked against.
 */
export function assertProtectedHostRunnerControls(
  input: ProtectedReleaseHostRunnerControls,
): string[] {
  const laneFields = [
    'candidate',
    'expected',
    'repository_root',
    'state_root',
    'maximum_input_bytes',
    'unit',
    'execution',
    'repository_identity',
  ];
  closed(
    input,
    [
      ...laneFields,
      'installed_package',
      'certification_store',
      'artifact_store',
      'publication_signature_verifier',
      'later_stages',
    ],
    [
      'producer',
      'toolchain_fixture',
      'mutation_inputs',
      'mutation_limits',
      'observe_mutation_package',
    ],
  );
  if ([input.toolchain_fixture].some((value) => value !== undefined))
    return fail('MUTATION_OFFLOADED_TO_BEDEL: use bedel');
  return laneFields;
}

/**
 * Capture the later export, offline verification and publication stages exactly
 * as declared: each present stage has its closed field set and callable members.
 */
export function captureProtectedLaterStages(input: ProtectedReleaseHostRunnerControls) {
  closed(input.later_stages, ['export', 'offline_verify'], ['evidence_publish', 'publish']);
  function publicationStage<T extends object>(
    value: T | 'unavailable' | undefined,
    keys: string[],
  ): T | undefined {
    if (value === undefined || value === 'unavailable') return undefined;
    closed(value, keys);
    if (Object.values(value).some((callback) => typeof callback !== 'function')) fail();
    return Object.freeze({ ...value });
  }
  const evidencePublication = publicationStage(input.later_stages.evidence_publish, [
    'provider',
    'authorization',
    'offline_receipt_verifier',
  ]);
  const publication = publicationStage(input.later_stages.publish, [
    'provider',
    'authorization',
    'publication_controls',
  ]);
  if (typeof input.publication_signature_verifier !== 'function') fail();
  const offlineControls = input.later_stages.offline_verify;
  if (offlineControls !== 'unavailable') {
    closed(offlineControls, ['provider', 'policy_closures']);
    if (
      typeof offlineControls.provider !== 'function' ||
      typeof offlineControls.policy_closures !== 'function'
    )
      fail();
  }
  const offlineProvider = offlineControls === 'unavailable' ? undefined : offlineControls.provider;
  const offlineClosures =
    offlineControls === 'unavailable' ? undefined : offlineControls.policy_closures;
  const exportControls = input.later_stages.export;
  if (exportControls !== 'unavailable') {
    closed(exportControls, [
      'provider',
      'destination',
      'trust',
      'signer',
      'closure_limits',
      'transport_limits',
      'transcript_limits',
    ]);
    closed(exportControls.signer, ['sign', 'verify']);
    if (
      typeof exportControls.signer.sign !== 'function' ||
      typeof exportControls.signer.verify !== 'function'
    )
      fail();
  }
  return { evidencePublication, publication, offlineProvider, offlineClosures, exportControls };
}
