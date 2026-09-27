import { parsers } from '@devai-nyx/schemas';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import type {
  PackageEvidence,
  ArtifactIdentity,
  ReleaseLifecycleRequest,
  ReleaseLifecycleStateV2,
  PersistedReleaseAction,
  PersistedReleaseState,
  ReleaseAction,
  VerifiedReceipt,
  StateReference,
} from './release-lifecycle-execution-types.js';

export function packageManifest(pkg: PackageEvidence): ArtifactIdentity | null {
  return pkg.package_manifest ?? pkg.manifest ?? null;
}

export function packageTarball(pkg: PackageEvidence): ArtifactIdentity | null {
  return pkg.package_tarball ?? pkg.tarball ?? null;
}

export function packageSbom(pkg: PackageEvidence): ArtifactIdentity | null {
  return pkg.package_sbom ?? pkg.sbom ?? null;
}

const FORBIDDEN_REQUEST_KEYS = new Set([
  'state_id',
  'generation',
  'head',
  'digest',
  'record_digest_sha256',
  'actor',
  'role',
  'authority',
  'authorization',
  'consent',
  'effective_authorities',
  'provider_result',
  'provider_handle',
]);

export const STATE_BY_ACTION: Readonly<Record<PersistedReleaseAction, PersistedReleaseState>> = {
  'release preflight': 'preflight_passed',
  'release certify': 'certified',
  'release prepare': 'prepared',
  'release export': 'exported',
  'release evidence-publish': 'evidence_published',
  'release publish': 'publication_dispatched',
};

export const PRIOR_BY_STATE: Readonly<Record<PersistedReleaseState, PersistedReleaseState | null>> =
  {
    preflight_passed: null,
    certified: 'preflight_passed',
    prepared: 'certified',
    exported: 'prepared',
    evidence_published: 'exported',
    publication_dispatched: 'evidence_published',
  };

export const EFFECT_BY_ACTION = {
  'release preflight': 'harness-write',
  'release certify': 'harness-write',
  'release prepare': 'local-write',
  'release export': 'local-write',
  'release evidence-publish': 'remote-write',
  'release publish': 'remote-write',
} as const;

export const ROLES_BY_ACTION: Readonly<Record<PersistedReleaseAction, readonly string[]>> = {
  'release preflight': ['inspector'],
  'release certify': ['inspector'],
  'release prepare': ['architect'],
  'release export': ['architect'],
  'release evidence-publish': ['owner'],
  'release publish': ['owner'],
};

export const STATE_CANONICALIZATION = {
  kernel_id: 'devai.kernel.release-lifecycle-state.v2',
  encoding: 'utf-8',
  json_form: 'rfc8785-jcs',
  digest_algorithm: 'sha256',
  projection_excludes: ['state_id', 'record_digest_sha256'],
  id_derivation: 'RLS-hyphen-plus-first-16-lowercase-hex-of-record_digest_sha256',
} as const;

export const STORE_CANONICALIZATION = {
  json_form: 'rfc8785-jcs',
  encoding: 'utf-8',
  digest_algorithm: 'sha256',
  projection_excludes: ['record_id', 'record_digest_sha256'],
  id_derivation: 'RLE-hyphen-plus-first-16-lowercase-hex-of-record_digest_sha256',
} as const;

export const HEAD_CANONICALIZATION = {
  kernel_id: 'devai.kernel.release-lifecycle-store-head.v2',
  encoding: 'utf-8',
  json_form: 'rfc8785-jcs',
  digest_algorithm: 'sha256',
  projection_excludes: ['head_digest_sha256'],
} as const;

export function object(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('release-request-projection-invalid');
  }
  return value as Readonly<Record<string, unknown>>;
}

function rejectForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectForbiddenKeys(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Readonly<Record<string, unknown>>)) {
    if (FORBIDDEN_REQUEST_KEYS.has(key))
      throw new Error(`release-request-projection-invalid:${key}`);
    rejectForbiddenKeys(child);
  }
}

function assertSortedUnique(values: readonly string[], code: string): void {
  const sorted = [...values].sort();
  if (
    new Set(values).size !== values.length ||
    values.some((value, index) => value !== sorted[index])
  ) {
    throw new Error(code);
  }
}

export function validateReleaseLifecycleRequest(
  value: unknown,
  expectedAction?: ReleaseAction,
): ReleaseLifecycleRequest {
  rejectForbiddenKeys(value);
  const parsed = parsers.releaseLifecycleRequest.safeParse<ReleaseLifecycleRequest>(value);
  if (!parsed.ok) throw new Error('release-request-projection-invalid');
  const request = parsed.value;
  if (expectedAction !== undefined && request.action_id !== expectedAction) {
    throw new Error('release-request-action-mismatch');
  }
  if (
    request.repository_locator.commit !== request.candidate_locator.commit ||
    request.repository_locator.tree !== request.candidate_locator.tree
  ) {
    throw new Error('release-request-identity-mismatch');
  }
  assertSortedUnique(
    request.candidate_locator.release_units.map((unit) => `${unit.release_unit}\0${unit.version}`),
    'release-release-unit-bijection-invalid',
  );

  for (const unit of request.candidate_locator.release_units) {
    assertSortedUnique(
      unit.package_roster.map((pkg) => pkg.package_id),
      'release-release-unit-bijection-invalid',
    );
  }
  if (request.receipt_locators !== undefined) {
    assertSortedUnique(
      request.receipt_locators.map((receipt) => `${receipt.kind}\0${receipt.receipt_id}`),
      'release-request-receipt-order-invalid',
    );
  }
  const receiptKinds = request.receipt_locators?.map((receipt) => receipt.kind) ?? [];
  if (
    request.action_id !== 'release plan' &&
    request.action_id !== 'release evidence-publish' &&
    request.action_id !== 'release resume' &&
    (receiptKinds.length !== request.candidate_locator.release_units.length ||
      receiptKinds.some((kind) => kind !== 'release-plan-receipt'))
  ) {
    throw new Error('release-receipt-identity-mismatch');
  }
  if (
    request.action_id === 'release evidence-publish' &&
    (receiptKinds.length !== 1 || receiptKinds[0] !== 'release-offline-verification-receipt')
  ) {
    throw new Error('release-receipt-identity-mismatch');
  }
  return request;
}

export function computeReleaseRequestDigest(request: ReleaseLifecycleRequest): string {
  return canonicalSha256(request);
}

export function without(value: Readonly<Record<string, unknown>>, keys: readonly string[]) {
  const excluded = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key)));
}

export function same(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalSha256(left) === canonicalSha256(right);
}

export function primaryCandidate(
  request: ReleaseLifecycleRequest,
): ReleaseLifecycleStateV2['candidate'] {
  const unit = request.candidate_locator.release_units[0];
  if (unit === undefined) throw new Error('release-release-unit-bijection-invalid');
  return {
    release_unit: unit.release_unit,
    version: unit.version,
    commit: request.candidate_locator.commit,
    tree: request.candidate_locator.tree,
  };
}

export function stateReference(state: ReleaseLifecycleStateV2): StateReference {
  return {
    state: state.state,
    state_id: state.state_id,
    record_digest_sha256: state.record_digest_sha256,
  };
}

function sortedArtifacts(values: readonly unknown[]): readonly unknown[] {
  return [...values].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right), 'en'),
  );
}

export function recordedPlanBindings(state: ReleaseLifecycleStateV2): readonly unknown[] {
  const receipts = state['bound_receipts'];
  return sortedArtifacts(
    Array.isArray(receipts)
      ? receipts.filter((entry: unknown) => object(entry)['kind'] === 'release-plan-receipt')
      : [],
  );
}

export function verifiedPlanBindings(receipts: readonly VerifiedReceipt[]): readonly unknown[] {
  return sortedArtifacts(
    receipts
      .filter((receipt) => receipt.kind === 'release-plan-receipt')
      .map(({ value }) => ({
        kind: 'release-plan-receipt',
        receipt_id: value['receipt_id'],
        receipt_digest_sha256: value['receipt_digest_sha256'],
        verdict: value['verdict'],
      })),
  );
}

export function offlineArtifactProjection(state: ReleaseLifecycleStateV2): readonly unknown[] {
  if (state.schemaVersion === '2.1.0') {
    return state['artifacts'] as readonly unknown[];
  }
  const allowed = new Set(['package-tarball', 'evidence-bundle', 'manifest', 'attestation']);
  const artifacts: unknown[] = (state['artifacts'] as readonly Readonly<Record<string, unknown>>[])
    .filter((artifact) => allowed.has(String(artifact['kind'])))
    .map((artifact) => artifact);
  for (const unit of state.release_units) {
    for (const pkg of unit.packages) {
      const manifestIdentity = packageManifest(pkg);
      const tarballIdentity = packageTarball(pkg);
      if (manifestIdentity !== null)
        artifacts.push(
          'kind' in manifestIdentity ? manifestIdentity : { kind: 'manifest', ...manifestIdentity },
        );
      if (tarballIdentity !== null)
        artifacts.push(
          'kind' in tarballIdentity
            ? tarballIdentity
            : { kind: 'package-tarball', ...tarballIdentity },
        );
      if (pkg.evidence_manifest !== null)
        artifacts.push(
          'kind' in pkg.evidence_manifest
            ? pkg.evidence_manifest
            : { kind: 'manifest', ...pkg.evidence_manifest },
        );
    }
  }
  const unique = new Map(artifacts.map((artifact) => [canonicalJson(artifact), artifact]));
  return sortedArtifacts([...unique.values()]);
}

export function offlineReleaseUnitsProjection(state: ReleaseLifecycleStateV2): readonly unknown[] {
  if (state.schemaVersion !== '2.1.0') return state.release_units;
  return state.release_units.map((unit) => ({
    release_unit: unit.release_unit,
    version: unit.version,
    ...(unit.mutation_evidence === undefined ? {} : { mutation_evidence: unit.mutation_evidence }),
    packages: unit.packages.map((pkg) => ({
      package_id: pkg.package_id,
      package_manifest: pkg.package_manifest,
      package_tarball: pkg.package_tarball,
      package_sbom: pkg.package_sbom,
      evidence_manifest: pkg.evidence_manifest,
      provider_result: pkg.provider_result,
      trust: pkg.trust,
    })),
  }));
}
