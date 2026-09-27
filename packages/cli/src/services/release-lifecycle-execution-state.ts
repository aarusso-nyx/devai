import { canonicalJson } from '@devai-nyx/utils';
import { verifyCertificationManifest } from './release-prepare-kernel.js';
import type {
  ReleaseLifecycleRequest,
  ReleaseLifecycleStateV2,
  PersistedReleaseAction,
  VerifiedReceipt,
  TrustedReleaseAuthority,
  PublicationControls,
  ReleaseStateMaterial,
} from './release-lifecycle-execution-types.js';
import {
  same,
  object,
  EFFECT_BY_ACTION,
  PRIOR_BY_STATE,
  STATE_BY_ACTION,
  packageManifest,
  packageTarball,
  packageSbom,
  primaryCandidate,
  stateReference,
  offlineReleaseUnitsProjection,
  offlineArtifactProjection,
  STATE_CANONICALIZATION,
} from './release-lifecycle-execution-support.js';
import { finalizeReleaseStateV2 } from './release-lifecycle-execution-records.js';

export function assertMaterialBijection(
  request: ReleaseLifecycleRequest,
  action: PersistedReleaseAction,
  material: ReleaseStateMaterial,
): void {
  if (
    (action === 'release prepare' || action === 'release export') &&
    material.artifact_sink == null
  ) {
    throw new Error('release-artifact-sink-protocol-invalid');
  }
  const taskPolicyDigests = new Set(
    material.inputs.filter((entry) => entry.kind === 'task-policy').map((entry) => entry.sha256),
  );
  const requested = request.candidate_locator.release_units.map((unit) => ({
    release_unit: unit.release_unit,
    version: unit.version,
    packages: unit.package_roster.map((pkg) => pkg.package_id),
  }));
  const produced = material.release_units.map((unit) => ({
    release_unit: unit.release_unit,
    version: unit.version,
    packages: unit.packages.map((pkg) => pkg.package_id),
  }));
  if (!same(requested, produced)) throw new Error('release-release-unit-bijection-invalid');
  for (const [unitIndex, unit] of material.release_units.entries()) {
    const requestUnit = request.candidate_locator.release_units[unitIndex];
    if (requestUnit === undefined) throw new Error('release-release-unit-bijection-invalid');
    for (const [packageIndex, pkg] of unit.packages.entries()) {
      const requestPackage = requestUnit.package_roster[packageIndex];
      const manifestIdentity = packageManifest(pkg);
      const tarballIdentity = packageTarball(pkg);
      const sbomIdentity = packageSbom(pkg);
      if (requestPackage === undefined || manifestIdentity === null) {
        throw new Error('release-release-unit-bijection-invalid');
      }
      const certifiedPackageManifest = pkg.certification_manifest?.entries.find(
        (entry) => entry.path === 'package.json',
      );
      if (
        action === 'release preflight' ||
        (action === 'release certify' && pkg.certification_manifest === undefined)
      ) {
        if (
          !('path' in manifestIdentity) ||
          manifestIdentity.path !== requestPackage.manifest_path ||
          manifestIdentity.sha256 !== requestPackage.manifest_digest_sha256
        ) {
          throw new Error('release-release-unit-bijection-invalid');
        }
      } else if (
        certifiedPackageManifest?.sha256 !== requestPackage.manifest_digest_sha256 ||
        ('kind' in manifestIdentity && manifestIdentity.kind !== 'package-manifest')
      ) {
        throw new Error('release-release-unit-bijection-invalid');
      }
      if (
        action !== 'release preflight' &&
        action !== 'release certify' &&
        (pkg.manifest !== undefined ||
          pkg.tarball !== undefined ||
          pkg.sbom !== undefined ||
          pkg.package_manifest?.kind !== 'package-manifest' ||
          pkg.package_tarball?.kind !== 'package-tarball' ||
          pkg.package_sbom?.kind !== 'package-sbom')
      ) {
        throw new Error('release-release-unit-bijection-invalid');
      }
      if (
        action === 'release certify' &&
        pkg.certification_manifest !== undefined &&
        pkg.certification_manifest !== null
      ) {
        verifyCertificationManifest(pkg.certification_manifest, {
          request,
          package_id: requestPackage.package_id,
          package_version: requestUnit.version,
          task_policy_digests: taskPolicyDigests,
        });
      }
      if (
        (action === 'release prepare' ||
          action === 'release export' ||
          action === 'release evidence-publish' ||
          action === 'release publish') &&
        (tarballIdentity === null || sbomIdentity === null)
      ) {
        throw new Error('release-release-unit-bijection-invalid');
      }
      if (
        (action === 'release export' ||
          action === 'release evidence-publish' ||
          action === 'release publish') &&
        (pkg.evidence_manifest == null || pkg.provider_result == null || pkg.trust === null)
      ) {
        throw new Error('release-release-unit-bijection-invalid');
      }
      if (
        (action === 'release export' ||
          action === 'release evidence-publish' ||
          action === 'release publish') &&
        (pkg.evidence_manifest == null ||
          !('kind' in pkg.evidence_manifest) ||
          pkg.evidence_manifest.kind !== 'evidence-manifest' ||
          pkg.provider_result == null ||
          !('kind' in pkg.provider_result) ||
          pkg.provider_result.kind !== 'provider-result')
      ) {
        throw new Error('release-release-unit-bijection-invalid');
      }
    }
  }
  if (action === 'release preflight' || action === 'release certify') return;
  const topByKey = new Map<string, unknown>();
  for (const artifact of material.artifacts) {
    const key =
      'opaque_handle' in artifact
        ? `${artifact.kind}\0${artifact.sink_id}\0${artifact.opaque_handle}`
        : `${artifact.kind}\0${artifact.path}`;
    if (topByKey.has(key)) throw new Error('release-release-unit-bijection-invalid');
    topByKey.set(key, artifact);
  }
  const requiredTop: unknown[] = [];
  for (const unit of material.release_units) {
    for (const pkg of unit.packages) {
      const manifestIdentity = packageManifest(pkg);
      const tarballIdentity = packageTarball(pkg);
      const sbomIdentity = packageSbom(pkg);
      if (manifestIdentity !== null)
        requiredTop.push(
          'kind' in manifestIdentity ? manifestIdentity : { kind: 'manifest', ...manifestIdentity },
        );
      if (tarballIdentity !== null)
        requiredTop.push(
          'kind' in tarballIdentity
            ? tarballIdentity
            : { kind: 'package-tarball', ...tarballIdentity },
        );
      if (sbomIdentity !== null)
        requiredTop.push('kind' in sbomIdentity ? sbomIdentity : { kind: 'sbom', ...sbomIdentity });
      if (pkg.evidence_manifest !== null)
        requiredTop.push(
          'kind' in pkg.evidence_manifest
            ? pkg.evidence_manifest
            : { kind: 'manifest', ...pkg.evidence_manifest },
        );
      if (pkg.provider_result !== null)
        requiredTop.push(
          'kind' in pkg.provider_result
            ? pkg.provider_result
            : { kind: 'provider-result', ...pkg.provider_result },
        );
    }
  }
  for (const artifact of requiredTop) {
    const artifactRecord = object(artifact);
    const key =
      typeof artifactRecord['opaque_handle'] === 'string'
        ? `${String(artifactRecord['kind'])}\0${String(artifactRecord['sink_id'])}\0${artifactRecord['opaque_handle']}`
        : `${String(artifactRecord['kind'])}\0${String(artifactRecord['path'])}`;
    if (!same(topByKey.get(key), artifact)) {
      throw new Error('release-release-unit-bijection-invalid');
    }
  }
  const projectionKey = (value: unknown): string => {
    const artifact = object(value);
    return `${String(artifact['kind'])}\0${String(artifact['sink_id'])}\0${String(artifact['opaque_handle'])}\0${String(artifact['sha256'])}\0${String(artifact['size_bytes'])}`;
  };
  const expected = [...requiredTop].sort((left, right) =>
    Buffer.compare(Buffer.from(projectionKey(left)), Buffer.from(projectionKey(right))),
  );
  if (
    material.artifacts.length !== expected.length ||
    new Set(material.artifacts.map(projectionKey)).size !== material.artifacts.length ||
    !same(material.artifacts, expected)
  ) {
    throw new Error('release-release-unit-bijection-invalid');
  }
}

export function assertStateMatchesRequest(
  request: ReleaseLifecycleRequest,
  state: ReleaseLifecycleStateV2,
): void {
  const requested = request.candidate_locator.release_units.map((unit) => ({
    release_unit: unit.release_unit,
    version: unit.version,
    packages: unit.package_roster.map((pkg) => ({
      package_id: pkg.package_id,
      manifest_path: pkg.manifest_path,
      manifest_digest_sha256: pkg.manifest_digest_sha256,
    })),
  }));
  const observed = state.release_units.map((unit) => ({
    release_unit: unit.release_unit,
    version: unit.version,
    packages: unit.packages.map((pkg) => {
      const identity = packageManifest(pkg);
      return {
        package_id: pkg.package_id,
        manifest_path:
          identity !== null && 'path' in identity
            ? identity.path
            : request.candidate_locator.release_units
                .find((candidate) => candidate.release_unit === unit.release_unit)
                ?.package_roster.find((candidate) => candidate.package_id === pkg.package_id)
                ?.manifest_path,
        manifest_digest_sha256:
          pkg.certification_manifest?.entries.find((entry) => entry.path === 'package.json')
            ?.sha256 ?? identity?.sha256,
      };
    }),
  }));
  if (
    !same(state.repository, request.repository_locator) ||
    !same(state.candidate, primaryCandidate(request)) ||
    !same(requested, observed)
  ) {
    throw new Error('release-state-identity-mismatch');
  }
}

function assertPriorMaterialContinuity(
  action: PersistedReleaseAction,
  material: ReleaseStateMaterial,
  prior: ReleaseLifecycleStateV2 | null,
): void {
  if (prior === null) return;
  if (action === 'release evidence-publish' || action === 'release publish') {
    if (
      !same(material.release_units, prior.release_units) ||
      !same(material.inputs, prior['inputs']) ||
      !same(material.evidence, prior['evidence']) ||
      !same(material.artifacts, prior['artifacts']) ||
      !same(material.artifact_sink, prior.artifact_sink)
    ) {
      throw new Error('release-evidence-binding-invalid');
    }
    return;
  }
  for (const [unitIndex, priorUnit] of prior.release_units.entries()) {
    const nextUnit = material.release_units[unitIndex];
    if (nextUnit === undefined) throw new Error('release-evidence-binding-invalid');
    if (
      (action === 'release prepare' || action === 'release export') &&
      !same(priorUnit.mutation_evidence ?? null, nextUnit.mutation_evidence ?? null)
    )
      throw new Error('release-evidence-binding-invalid');
    for (const [packageIndex, priorPackage] of priorUnit.packages.entries()) {
      const nextPackage = nextUnit.packages[packageIndex];
      if (nextPackage === undefined) throw new Error('release-evidence-binding-invalid');
      for (const key of [
        'manifest',
        'tarball',
        'sbom',
        'package_manifest',
        'package_tarball',
        'package_sbom',
        'evidence_manifest',
        'provider_result',
        'trust',
        'certification_manifest',
      ] as const) {
        if (
          action === 'release prepare' &&
          (key === 'manifest' || key === 'tarball' || key === 'sbom')
        ) {
          continue;
        }
        if (
          priorPackage[key] !== null &&
          priorPackage[key] !== undefined &&
          !same(priorPackage[key], nextPackage[key])
        ) {
          throw new Error('release-evidence-binding-invalid');
        }
      }
    }
  }
  const nextArtifacts = new Set(material.artifacts.map((artifact) => canonicalJson(artifact)));
  if (
    (prior['artifacts'] as readonly unknown[]).some(
      (artifact) => !nextArtifacts.has(canonicalJson(artifact)),
    )
  ) {
    throw new Error('release-evidence-binding-invalid');
  }
}

export function assertReceiptContinuity(
  request: ReleaseLifecycleRequest,
  receipts: readonly VerifiedReceipt[],
  prior: ReleaseLifecycleStateV2 | null,
): void {
  const offline = receipts.filter(
    (receipt) => receipt.kind === 'release-offline-verification-receipt',
  );
  if (request.action_id !== 'release evidence-publish') return;
  if (prior === null || prior.state !== 'exported' || offline.length !== 1) {
    throw new Error('release-offline-receipt-binding-invalid');
  }
  const receipt = offline[0]?.value;
  if (
    receipt === undefined ||
    receipt['schemaVersion'] !== prior.schemaVersion ||
    !same(receipt['verified_state'], stateReference(prior)) ||
    !same(receipt['release_units'], offlineReleaseUnitsProjection(prior)) ||
    !same(receipt['artifacts'], offlineArtifactProjection(prior)) ||
    !same(receipt['artifact_sink_commit'], prior.artifact_sink) ||
    !Array.isArray(receipt['release_units']) ||
    !(receipt['release_units'] as readonly unknown[]).every((unit, unitIndex) => {
      const packages = object(unit)['packages'];
      const priorPackages = prior.release_units[unitIndex]?.packages;
      return (
        Array.isArray(packages) &&
        priorPackages !== undefined &&
        packages.every((pkg, packageIndex) => {
          const expectedTrust = priorPackages[packageIndex]?.trust;
          return (
            expectedTrust !== null &&
            expectedTrust !== undefined &&
            same(object(pkg)['trust'], expectedTrust) &&
            same(object(pkg)['trust'], request.destination?.trust)
          );
        })
      );
    })
  ) {
    throw new Error('release-offline-receipt-binding-invalid');
  }
}

export function buildState(
  request: ReleaseLifecycleRequest & { readonly action_id: PersistedReleaseAction },
  material: ReleaseStateMaterial,
  prior: ReleaseLifecycleStateV2 | null,
  authorizationEventId: string | null,
  authority: TrustedReleaseAuthority,
  publicationControls: PublicationControls | undefined,
  recordedAt: string,
): ReleaseLifecycleStateV2 {
  assertMaterialBijection(request, request.action_id, material);
  assertPriorMaterialContinuity(request.action_id, material, prior);
  const primary = request.candidate_locator.release_units[0];
  if (primary === undefined) throw new Error('release-release-unit-bijection-invalid');
  const state = STATE_BY_ACTION[request.action_id];
  if (PRIOR_BY_STATE[state] !== (prior?.state ?? null))
    throw new Error('release-state-predecessor-mismatch');
  const generation = prior === null ? 0 : prior.storage.generation + 1;
  const headBefore =
    prior === null
      ? null
      : { generation: prior.storage.generation, record_digest_sha256: prior.record_digest_sha256 };
  const boundReceipts = (request.receipt_locators ?? []).map((receipt) => ({
    kind: receipt.kind,
    receipt_id: receipt.receipt_id,
    receipt_digest_sha256: receipt.receipt_digest_sha256,
    verdict: 'pass' as const,
  }));
  const artifactSink = material.artifact_sink ?? prior?.artifact_sink ?? null;
  const schemaVersion =
    request.action_id === 'release prepare' || prior?.schemaVersion === '2.1.0'
      ? ('2.1.0' as const)
      : ('2.0.0' as const);
  return finalizeReleaseStateV2({
    schemaVersion,
    canonicalization: STATE_CANONICALIZATION,
    state,
    action_id: request.action_id,
    effect: EFFECT_BY_ACTION[request.action_id],
    prior_state: prior === null ? null : stateReference(prior),
    bound_receipts: boundReceipts,
    repository: request.repository_locator,
    candidate: {
      release_unit: primary.release_unit,
      version: primary.version,
      commit: request.candidate_locator.commit,
      tree: request.candidate_locator.tree,
    },
    release_units: material.release_units,
    inputs: material.inputs,
    evidence: material.evidence,
    artifacts: material.artifacts,
    ...(schemaVersion === '2.1.0' ? { artifact_sink: artifactSink } : {}),
    actor: authority.actor,
    consent: authority.consent,
    authorization_event_id: authorizationEventId,
    publication_expectation:
      request.action_id === 'release publish' && publicationControls !== undefined
        ? { authorization_event_id: authorizationEventId, ...publicationControls }
        : null,
    storage: { generation, head_before: headBefore },
    recorded_at: recordedAt,
  } as never);
}
