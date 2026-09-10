import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as authority from '@devai-nyx/authority';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
  type ProtectedReleaseExportCapacityBinding,
} from '@devai-nyx/authority';
import { parsers as schemaParsers } from '@devai-nyx/schemas';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import {
  createLifecyclePolicyFixture,
  createLifecyclePolicyResolutionSetFixture,
} from '../helpers/release-policy-resolution-fixture.js';
import { fixture as unitMutationEvidenceFixture } from '../helpers/release-unit-mutation-evidence-fixture.js';
import { withReleasePrepareAuthorityFixture } from '../helpers/release-prepare-authority-fixture.js';
import { createReleasePolicyClosure } from '../../src/services/release-policy-closure.js';
import { buildResolvedReleasePlanReceipt } from '../../src/services/release-lifecycle.js';
import {
  createReleaseExportMutationEvidence,
  readReleaseExportMutationEvidence,
} from '../../src/services/release-export-mutation-evidence.js';
import {
  RELEASE_EXPORT_SPEC_DIGEST,
  RELEASE_EXPORT_SPEC_ID,
} from '../../src/services/release-export-artifact-store.js';
import {
  encodeReleaseExportProviderResult,
  encodeReleaseExportTranscript,
} from '../../src/services/release-export-transcript.js';
import {
  RELEASE_EXPORT_SPEC_V3_DIGEST,
  RELEASE_EXPORT_SPEC_V3_ID,
  RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT,
  encodeReleaseExportProviderResultV2,
  encodeReleaseExportTranscriptV2,
} from '../../src/services/release-export-transcript-v2.js';
import {
  RELEASE_PACK_SPEC_DIGEST,
  RELEASE_PACK_SPEC_ID,
  finalizeCertificationManifest,
  type CertificationOutputClosureBinding,
} from '../../src/services/release-prepare-kernel.js';
import { createReleaseCertificationProvider } from '../../src/services/release-lifecycle-certification.js';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import {
  ReleaseLifecycleFileStore,
  assertReleaseProviderInvocationContext,
  computeReleaseRequestDigest,
  executeReleaseLifecycleAction,
  executeOfflineVerification,
  readVerifiedReleaseOfflineContext,
  createVerifiedReleaseMutationCheck,
  type VerifiedReleaseOfflineContext,
  finalizeReleaseStateV2,
  finalizeStoreHead,
  finalizeStoreRecord,
  offlineArtifactProjection,
  reduceReleaseStates,
  reduceStoreRecords,
  resumeReleaseLifecycleExecution,
  resolveReleaseMutationRequirements,
  validateReleaseLifecycleRequest,
  verifyStoreRecordIdentity,
  verifyReleaseStateIdentity,
  type ReleaseLifecycleRequest,
  type ReleaseProvider,
  type ReleaseStateMaterial,
  type OpaqueArtifactIdentity,
  type StoreRecord,
  type AuthorizationAttemptBinding,
  type AuthorizationBridge,
  type PublicationControls,
  type ReleaseLifecycleStateV2,
  type TrustedOfflineReceiptVerifier,
  type TrustedReleaseAuthority,
} from '../../src/services/release-lifecycle-execution.js';

const POLICY_FIXTURE = createLifecyclePolicyFixture();
const DEVAI_ADOPTION = JSON.parse(
  readFileSync(join(process.cwd(), 'law/policy/devai-adoption.json'), 'utf8'),
) as {
  readonly release_verification: Readonly<Record<string, unknown>> & {
    readonly mutation_roster: readonly {
      readonly package: string;
      readonly manifest_path: string;
    }[];
  };
};
const REQUIRED_POLICY_FIXTURE = createLifecyclePolicyFixture(
  DEVAI_ADOPTION.release_verification.mutation_roster,
  DEVAI_ADOPTION.release_verification,
);
const ARTIFACT_BYTES = POLICY_FIXTURE.package_json;
const COMMIT = POLICY_FIXTURE.candidate.repository.commit;
const TREE = POLICY_FIXTURE.candidate.repository.tree;
const COMMIT_BYTES = Buffer.from(POLICY_FIXTURE.objects.get(COMMIT)?.bytes ?? []);
const TREE_BYTES = Buffer.from(POLICY_FIXTURE.objects.get(TREE)?.bytes ?? []);
const BLOB =
  [...POLICY_FIXTURE.objects].find(
    ([, object]) => object.type === 'blob' && Buffer.from(object.bytes).equals(ARTIFACT_BYTES),
  )?.[0] ??
  (() => {
    throw new Error('fixture package blob missing');
  })();
const MANIFEST_DIGEST = createHash('sha256').update(ARTIFACT_BYTES).digest('hex');
const EVIDENCE_DIGEST = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const CERTIFICATION_TASK_POLICY = { nodes: ['certify'] };
const TASK_POLICY_DIGEST = canonicalSha256(CERTIFICATION_TASK_POLICY);
const SINK_ID = 'release-test-sink';
const TRANSACTION_HANDLE = 'release-test-transaction';
const COMMIT_MANIFEST_HANDLE = 'release-test-commit-manifest';

function planReceipt(): Readonly<Record<string, unknown>> {
  return POLICY_FIXTURE.receipt;
}

const resolvePlanInput = POLICY_FIXTURE.resolve_plan_input;
const policyClosures = [
  {
    closure: createReleasePolicyClosure({
      plan: POLICY_FIXTURE.receipt,
      resolution: POLICY_FIXTURE.resolution,
    }),
    expected: POLICY_FIXTURE.expected,
    implementation: POLICY_FIXTURE.package_snapshot,
    limits: {
      maximum_archive_bytes: 4 * 1024 * 1024,
      maximum_unpacked_bytes: 4 * 1024 * 1024,
      maximum_git_bytes: 4 * 1024 * 1024,
      maximum_git_entries: 2000,
    },
  },
];

function offlineReceipt(): Readonly<Record<string, unknown>> {
  const schema = JSON.parse(
    readFileSync(
      join(process.cwd(), 'law/schemas/release-offline-verification-receipt.schema.json'),
      'utf8',
    ),
  ) as { examples: readonly Readonly<Record<string, unknown>>[] };
  const example = schema.examples[0];
  if (example === undefined) throw new Error('missing offline verification fixture');
  return example;
}

function request(
  action: ReleaseLifecycleRequest['action_id'] = 'release preflight',
  receiptOverride?: Readonly<Record<string, unknown>>,
): ReleaseLifecycleRequest {
  const receipt = planReceipt();
  const base = {
    schemaVersion: '1.0.0',
    request_kind: 'release-lifecycle-request',
    action_id: action,
    repository_locator: { id: 'aarusso-nyx/devai', commit: COMMIT, tree: TREE },
    candidate_locator: {
      commit: COMMIT,
      tree: TREE,
      release_units: [
        {
          release_unit: '@aarusso-nyx/devai',
          version: '1.5.0',
          package_roster: [
            {
              package_id: '@aarusso-nyx/devai',
              manifest_path: 'package.json',
              manifest_digest_sha256: MANIFEST_DIGEST,
            },
          ],
        },
      ],
    },
  } as const;
  if (action === 'release plan' || action === 'release resume') return base;
  if (action === 'release prepare') {
    return {
      ...base,
      receipt_locators: [receiptLocator(receipt)],
    } as ReleaseLifecycleRequest;
  }
  if (action === 'release export') {
    return {
      ...base,
      receipt_locators: [receiptLocator(receipt)],
      provider: { kind: 'evidence-export', provider_id: 'canonical-verifier' },
      destination: { kind: 'evidence-destination', exact_identifier: 'external/devai-1.5.0' },
    } as ReleaseLifecycleRequest;
  }
  if (action === 'release offline-verify') {
    return {
      ...base,
      receipt_locators: [receiptLocator(receipt)],
      provider: { kind: 'offline-verifier', provider_id: 'canonical-verifier' },
      destination: {
        kind: 'external-trust-input',
        exact_identifier: 'trust/devai-1.5.0',
        trust: {
          trust_root_id: 'release-root',
          trust_store_digest_sha256: 'b'.repeat(64),
          key_id: 'release-key',
          signature_algorithm: 'ed25519',
        },
      },
    } as ReleaseLifecycleRequest;
  }
  if (action === 'release evidence-publish' || action === 'release publish') {
    const requiredReceipt =
      receiptOverride ?? (action === 'release evidence-publish' ? offlineReceipt() : receipt);
    return {
      ...base,
      receipt_locators: [
        {
          ...receiptLocator(requiredReceipt),
          kind:
            action === 'release evidence-publish'
              ? ('release-offline-verification-receipt' as const)
              : ('release-plan-receipt' as const),
        },
      ],
      provider: { kind: 'protected-dispatch', provider_id: 'github-actions' },
      destination: {
        kind: 'publication-destination',
        exact_identifier:
          action === 'release publish'
            ? 'npm:@aarusso-nyx/devai@1.5.0'
            : 'git:refs/tags/evidence/v1.5.0',
        trust: {
          trust_root_id: 'release-root',
          trust_store_digest_sha256: 'b'.repeat(64),
          key_id: 'release-key',
          signature_algorithm: 'ed25519' as const,
        },
      },
    } as ReleaseLifecycleRequest;
  }
  return { ...base, receipt_locators: [receiptLocator(receipt)] } as ReleaseLifecycleRequest;
}

function receiptLocator(receipt: Readonly<Record<string, unknown>>) {
  return {
    kind: 'release-plan-receipt' as const,
    receipt_id: String(receipt['receipt_id']),
    receipt_digest_sha256: String(receipt['receipt_digest_sha256']),
    path: 'receipts/plan.json',
  };
}

function material(): ReleaseStateMaterial {
  return {
    release_units: [
      {
        release_unit: '@aarusso-nyx/devai',
        version: '1.5.0',
        packages: [
          {
            package_id: '@aarusso-nyx/devai',
            manifest: {
              path: 'package.json',
              sha256: MANIFEST_DIGEST,
              size_bytes: ARTIFACT_BYTES.byteLength,
            },
            tarball: null,
            sbom: null,
            evidence_manifest: null,
            provider_result: null,
            trust: null,
          },
        ],
      },
    ],
    inputs: [
      {
        kind: 'release-lifecycle-policy',
        path: 'law/policy/release-lifecycle.json',
        sha256: MANIFEST_DIGEST,
      },
      {
        kind: 'task-policy',
        path: 'task-policy/certify/selection',
        sha256: TASK_POLICY_DIGEST,
      },
    ],
    evidence: {
      manifest_digest_sha256: EVIDENCE_DIGEST,
      receipt_digests: [String(planReceipt()['receipt_digest_sha256'])],
      independently_checkable: true,
    },
    artifacts: [],
  };
}

function certificationManifest() {
  return finalizeCertificationManifest({
    candidate: { commit: COMMIT, tree: TREE },
    task_policy_digest_sha256: TASK_POLICY_DIGEST,
    package_id: '@aarusso-nyx/devai',
    package_version: '1.5.0',
    entry_order: 'ascending-utf-8-byte-collation-by-path;duplicates-refuse',
    manifest_digest_contract: {
      domain: 'DEVAI-CERTIFIED-PACKAGE-ENTRY-MANIFEST-V1\0',
      payload:
        'utf-8-rfc8785-jcs-of-the-entire-manifest-with-manifest_digest_sha256-omitted;framed-as-domain-utf8-bytes-plus-payload-utf8-bytes',
      canonicalization: 'rfc8785-jcs',
      algorithm: 'sha256',
    },
    entries: [
      {
        path: 'package.json',
        mode: '100644',
        size_bytes: ARTIFACT_BYTES.byteLength,
        sha256: MANIFEST_DIGEST,
        immutable_blob_locator: {
          kind: 'git-object',
          repository: 'aarusso-nyx/devai',
          commit: COMMIT,
          tree: TREE,
          object_format: 'sha1',
          path: 'package.json',
          mode: '100644',
          object_id: BLOB,
          size_bytes: ARTIFACT_BYTES.byteLength,
          content_digest_sha256: MANIFEST_DIGEST,
        },
      },
    ],
  });
}

function opaqueArtifact(
  kind:
    | 'package-manifest'
    | 'package-tarball'
    | 'package-sbom'
    | 'evidence-manifest'
    | 'provider-result',
  handle: string,
): OpaqueArtifactIdentity {
  return {
    kind,
    sink_id: SINK_ID,
    opaque_handle: handle,
    sha256: MANIFEST_DIGEST,
    size_bytes: ARTIFACT_BYTES.byteLength,
  } as const;
}

function committedSink(artifacts: ReleaseStateMaterial['artifacts']) {
  const manifest = Buffer.from(
    canonicalJson({
      schemaVersion: '1.0.0',
      kind: 'release-artifact-sink-commit-manifest',
      sink_id: SINK_ID,
      transaction_handle: TRANSACTION_HANDLE,
      repository: { id: 'aarusso-nyx/devai', commit: COMMIT, tree: TREE },
      candidate: { commit: COMMIT, tree: TREE },
      pack_spec_id: 'devai.pure-npm-compatible-pack.v4',
      pack_spec_digest_sha256: '46ba1063f36f48fb6d5082548024b17b274cf475e24a5c1df89faa5f07a46316',
      artifacts,
    }),
  );
  return {
    manifest,
    identity: {
      sink_id: SINK_ID,
      transaction_handle: TRANSACTION_HANDLE,
      committed_manifest_handle: COMMIT_MANIFEST_HANDLE,
      committed_manifest_sha256: createHash('sha256').update(manifest).digest('hex'),
      committed_manifest_size_bytes: manifest.byteLength,
      commit_protocol: 'devai.artifact-sink.two-phase.v1' as const,
    },
  };
}

function opaqueBytes(
  kind: OpaqueArtifactIdentity['kind'],
  handle: string,
  bytes: Buffer,
): OpaqueArtifactIdentity {
  return {
    kind,
    sink_id: SINK_ID,
    opaque_handle: handle,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size_bytes: bytes.byteLength,
  } as const;
}

function requireOpaqueArtifact(
  artifact: ReleaseStateMaterial['artifacts'][number],
): OpaqueArtifactIdentity {
  if (!('sink_id' in artifact)) throw new Error('opaque fixture expected');
  return artifact;
}

function opaqueArtifacts(
  artifacts: readonly ReleaseStateMaterial['artifacts'][number][],
): OpaqueArtifactIdentity[] {
  return artifacts.map(requireOpaqueArtifact);
}

function sortOpaque(artifacts: readonly OpaqueArtifactIdentity[]): OpaqueArtifactIdentity[] {
  return [...artifacts].sort((left, right) => {
    return Buffer.compare(
      Buffer.from(
        `${left.kind}\0${left.sink_id}\0${left.opaque_handle}\0${left.sha256}\0${left.size_bytes}`,
      ),
      Buffer.from(
        `${right.kind}\0${right.sink_id}\0${right.opaque_handle}\0${right.sha256}\0${right.size_bytes}`,
      ),
    );
  });
}

function preparedPackageManifestBytes(
  certification: NonNullable<
    NonNullable<
      ReleaseStateMaterial['release_units'][number]['packages'][number]['certification_manifest']
    >
  >,
  tarball: ReturnType<typeof opaqueArtifact>,
  sbom: ReturnType<typeof opaqueArtifact>,
): Buffer {
  return Buffer.from(
    canonicalJson({
      schemaVersion: '2.0.0',
      kind: 'release-prepared-package-manifest',
      candidate: { commit: COMMIT, tree: TREE },
      package_id: '@aarusso-nyx/devai',
      package_version: '1.5.0',
      pack_spec_id: RELEASE_PACK_SPEC_ID,
      pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
      certification_manifest_digest_sha256: certification.manifest_digest_sha256,
      artifacts: {
        tarball: { sha256: tarball.sha256, size_bytes: tarball.size_bytes },
        sbom: { sha256: sbom.sha256, size_bytes: sbom.size_bytes },
      },
    }),
  );
}

function materialFor(action: ReleaseLifecycleRequest['action_id']): ReleaseStateMaterial {
  const base = material();
  const baseUnit = required(base.release_units[0], 'missing base unit');
  const packageEvidence = required(baseUnit.packages[0], 'missing base package');
  if (action === 'release preflight') return base;
  const certified = {
    ...packageEvidence,
    certification_manifest: certificationManifest(),
  };
  if (action === 'release certify') {
    return {
      ...base,
      release_units: [{ ...baseUnit, packages: [certified] }],
    };
  }
  const packageTarball = opaqueArtifact('package-tarball', 'package-tarball');
  const packageSbom = opaqueArtifact('package-sbom', 'package-sbom');
  const prepared = {
    package_id: certified.package_id,
    package_manifest: opaqueBytes(
      'package-manifest',
      'package-manifest',
      preparedPackageManifestBytes(certified.certification_manifest, packageTarball, packageSbom),
    ),
    package_tarball: packageTarball,
    package_sbom: packageSbom,
    evidence_manifest: null,
    provider_result: null,
    trust: null,
    certification_manifest: certified.certification_manifest,
  };
  if (action === 'release prepare') {
    const artifacts = [prepared.package_manifest, prepared.package_sbom, prepared.package_tarball];
    return {
      ...base,
      release_units: [{ ...baseUnit, packages: [prepared] }],
      artifacts,
      artifact_sink: committedSink(artifacts).identity,
    };
  }
  return exportFixture().material;
}

function exportFixture(): {
  readonly material: ReleaseStateMaterial;
  readonly bytes: ReadonlyMap<string, Buffer>;
} {
  const prepared = materialFor('release prepare');
  const preparedUnit = required(prepared.release_units[0], 'missing prepared release unit');
  const preparedPackage = required(preparedUnit.packages[0], 'missing prepared package');
  const preparedArtifacts = opaqueArtifacts(prepared.artifacts);
  const parent = committedSink(preparedArtifacts);
  const trust = {
    trust_root_id: 'release-root',
    trust_store_digest_sha256: 'b'.repeat(64),
    key_id: 'release-key',
    signature_algorithm: 'ed25519' as const,
  };
  const closureBytes = Buffer.from(
    canonicalJson({ format: 'opaque-policy-closure-fixture', package_id: '@aarusso-nyx/devai' }),
  );
  const evidenceManifest = opaqueBytes('evidence-manifest', 'evidence-manifest', closureBytes);
  const closureInput = {
    package_id: '@aarusso-nyx/devai',
    sha256: evidenceManifest.sha256,
    size_bytes: evidenceManifest.size_bytes,
    expected_installed_package: {
      name: '@aarusso-nyx/devai' as const,
      version: '1.5.0',
      archive_sha256: 'a'.repeat(64),
      content_manifest_sha256: 'c'.repeat(64),
    },
    policy_resolution_digest_sha256: 'd'.repeat(64),
  };
  const binding = {
    action_id: 'release export' as const,
    repository: { id: 'aarusso-nyx/devai', commit: COMMIT, tree: TREE },
    candidate: { commit: COMMIT, tree: TREE },
    plan_receipt_digest_sha256: String(planReceipt()['receipt_digest_sha256']),
    parent_artifact_sink: parent.identity,
    sink_id: SINK_ID,
    destination: { kind: 'evidence-destination', exact_identifier: 'external/devai-1.5.0' },
    trust,
    attempt_id: 'RLA-0123456789abcdef',
    export_spec_digest_sha256: RELEASE_EXPORT_SPEC_DIGEST,
    closure_inputs: [closureInput],
  };
  const transcript = encodeReleaseExportTranscript(
    {
      version: 'devai.release-export-transcript-json.v1',
      binding: {
        action_id: binding.action_id,
        repository: binding.repository,
        candidate: binding.candidate,
        plan_receipt_digest_sha256: binding.plan_receipt_digest_sha256,
        parent_artifact_sink: binding.parent_artifact_sink,
        sink_id: binding.sink_id,
        destination: binding.destination,
        trust: binding.trust,
        attempt_id: binding.attempt_id,
      },
      parent: preparedArtifacts,
      closures: [
        {
          package_id: closureInput.package_id,
          evidence_manifest: evidenceManifest,
          expected_installed_package: closureInput.expected_installed_package,
          policy_resolution_digest_sha256: closureInput.policy_resolution_digest_sha256,
        },
      ],
      destination: binding.destination,
      trust: binding.trust,
    },
    {
      maximum_transcript_bytes: 64 * 1024,
      maximum_provider_result_bytes: 64 * 1024,
      maximum_packages: 1,
    },
  );
  const providerBytes = encodeReleaseExportProviderResult(
    { package_id: closureInput.package_id, transcript, signature: 'AQ==' },
    {
      maximum_transcript_bytes: 64 * 1024,
      maximum_provider_result_bytes: 64 * 1024,
      maximum_packages: 1,
    },
  );
  const providerResult = opaqueBytes('provider-result', 'provider-result', providerBytes);
  const exported = {
    ...preparedPackage,
    evidence_manifest: evidenceManifest,
    provider_result: providerResult,
    trust,
  };
  const artifacts = sortOpaque([...preparedArtifacts, evidenceManifest, providerResult]);
  const manifest = Buffer.from(
    canonicalJson({
      schemaVersion: '1.0.0',
      kind: 'release-artifact-sink-commit-manifest',
      sink_id: SINK_ID,
      transaction_handle: 'export-transaction',
      repository: binding.repository,
      candidate: binding.candidate,
      export_spec_id: RELEASE_EXPORT_SPEC_ID,
      export_spec_digest_sha256: RELEASE_EXPORT_SPEC_DIGEST,
      parent_artifact_sink: parent.identity,
      binding,
      artifacts,
    }),
  );
  const exportSink = {
    sink_id: SINK_ID,
    transaction_handle: 'export-transaction',
    committed_manifest_handle: 'export-commit-manifest',
    committed_manifest_sha256: createHash('sha256').update(manifest).digest('hex'),
    committed_manifest_size_bytes: manifest.byteLength,
    commit_protocol: 'devai.artifact-sink.two-phase.v1' as const,
  };
  const objectBytes = new Map<string, Buffer>([
    [parent.identity.committed_manifest_handle, parent.manifest],
    [exportSink.committed_manifest_handle, manifest],
    [evidenceManifest.opaque_handle, closureBytes],
    [providerResult.opaque_handle, providerBytes],
    ...preparedArtifacts.map((entry) => {
      return [
        entry.opaque_handle,
        entry.kind === 'package-manifest'
          ? preparedPackageManifestBytes(
              required(preparedPackage.certification_manifest, 'missing prepared certification'),
              required(preparedPackage.package_tarball, 'missing prepared tarball'),
              required(preparedPackage.package_sbom, 'missing prepared sbom'),
            )
          : Buffer.from(ARTIFACT_BYTES),
      ] as const;
    }),
  ]);
  return {
    material: {
      ...prepared,
      release_units: [{ ...preparedUnit, packages: [exported] }],
      artifacts,
      artifact_sink: exportSink,
    },
    bytes: objectBytes,
  };
}

async function requiredExportFixture(template: ReleaseLifecycleStateV2) {
  const requiredInput = await requiredMutationCertificationFixture();
  const selected: ReleaseLifecycleRequest = {
    ...requiredInput.request,
    action_id: 'release offline-verify',
    provider: { kind: 'offline-verifier', provider_id: 'canonical-verifier' },
    destination: required(
      request('release offline-verify').destination,
      'missing offline destination',
    ),
  };
  const mutationRequest: ReleaseLifecycleRequest = {
    ...requiredInput.request,
    action_id: 'release prepare',
  };
  const mutationToken = await createReleaseExportMutationEvidence({
    request: mutationRequest,
    material: requiredInput.material,
    source: requiredMutationEvidenceSink(requiredInput.evidence),
    plan: {
      resolve_receipt: () => requiredInput.fixture.receipt,
      resolve_plan_input: requiredInput.fixture.resolve_plan_input,
    },
    maximum_provider_result_bytes: 1_000_000,
  });
  const mutation = readReleaseExportMutationEvidence(mutationToken, {
    repository: mutationRequest.repository_locator,
    plan_receipt_digest_sha256: String(requiredInput.fixture.receipt['receipt_digest_sha256']),
    release_units: requiredInput.material.release_units,
    inputs: requiredInput.material.inputs,
  });
  const mutationUnit = required(mutation.mutation_units[0], 'missing required mutation unit');
  const portable = required(mutation.portable_units[0], 'missing portable mutation unit');
  if (mutationUnit.mutation_evidence === null || portable.mutation_evidence === null)
    throw new Error('required mutation evidence unexpectedly absent');

  const releaseUnit = required(
    mutationRequest.candidate_locator.release_units[0],
    'missing required release unit',
  );
  const certifiedPackage = required(
    requiredInput.material.release_units[0]?.packages[0],
    'missing certified package',
  );
  const certificationManifest = required(
    certifiedPackage.certification_manifest,
    'missing certification manifest',
  );
  const packageTarball = opaqueArtifact('package-tarball', 'package-tarball');
  const packageSbom = opaqueArtifact('package-sbom', 'package-sbom');
  const packageManifestBytes = Buffer.from(
    canonicalJson({
      schemaVersion: '2.0.0',
      kind: 'release-prepared-package-manifest',
      candidate: {
        commit: mutationRequest.candidate_locator.commit,
        tree: mutationRequest.candidate_locator.tree,
      },
      package_id: certifiedPackage.package_id,
      package_version: releaseUnit.version,
      pack_spec_id: RELEASE_PACK_SPEC_ID,
      pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
      certification_manifest_digest_sha256: certificationManifest.manifest_digest_sha256,
      artifacts: {
        tarball: { sha256: packageTarball.sha256, size_bytes: packageTarball.size_bytes },
        sbom: { sha256: packageSbom.sha256, size_bytes: packageSbom.size_bytes },
      },
    }),
  );
  const packageManifest = opaqueBytes('package-manifest', 'package-manifest', packageManifestBytes);
  const preparedArtifacts = sortOpaque([packageManifest, packageTarball, packageSbom]);
  const parentManifest = Buffer.from(
    canonicalJson({
      schemaVersion: '1.0.0',
      kind: 'release-artifact-sink-commit-manifest',
      sink_id: SINK_ID,
      transaction_handle: TRANSACTION_HANDLE,
      repository: mutationRequest.repository_locator,
      candidate: {
        commit: mutationRequest.candidate_locator.commit,
        tree: mutationRequest.candidate_locator.tree,
      },
      pack_spec_id: RELEASE_PACK_SPEC_ID,
      pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
      artifacts: preparedArtifacts,
    }),
  );
  const parent = {
    manifest: parentManifest,
    identity: {
      sink_id: SINK_ID,
      transaction_handle: TRANSACTION_HANDLE,
      committed_manifest_handle: COMMIT_MANIFEST_HANDLE,
      committed_manifest_sha256: createHash('sha256').update(parentManifest).digest('hex'),
      committed_manifest_size_bytes: parentManifest.byteLength,
      commit_protocol: 'devai.artifact-sink.two-phase.v1' as const,
    },
  };
  const trust = {
    trust_root_id: 'release-root',
    trust_store_digest_sha256: 'b'.repeat(64),
    key_id: 'release-key',
    signature_algorithm: 'ed25519' as const,
  };
  const closureBytes = Buffer.from(
    canonicalJson({
      format: 'opaque-policy-closure-fixture',
      package_id: certifiedPackage.package_id,
    }),
  );
  const evidenceManifest = opaqueBytes('evidence-manifest', 'evidence-manifest', closureBytes);
  const destination = {
    kind: 'evidence-destination' as const,
    exact_identifier: 'external/devai-1.5.0',
  };
  const limits = {
    maximum_transcript_bytes: 1_000_000,
    maximum_provider_result_bytes: 1_000_000,
    maximum_packages: 1,
  };
  const binding = {
    action_id: 'release export' as const,
    repository: mutationRequest.repository_locator,
    candidate: {
      commit: mutationRequest.candidate_locator.commit,
      tree: mutationRequest.candidate_locator.tree,
    },
    plan_receipt_digest_sha256: String(requiredInput.fixture.receipt['receipt_digest_sha256']),
    parent_artifact_sink: parent.identity,
    sink_id: SINK_ID,
    destination,
    trust,
    attempt_id: 'RLA-0123456789abcdef',
    export_spec_digest_sha256: RELEASE_EXPORT_SPEC_V3_DIGEST,
    mutation_units: [mutationUnit],
    closure_inputs: [
      {
        package_id: certifiedPackage.package_id,
        release_unit: releaseUnit.release_unit,
        sha256: evidenceManifest.sha256,
        size_bytes: evidenceManifest.size_bytes,
        expected_installed_package: {
          name: '@aarusso-nyx/devai' as const,
          version: '1.5.0',
          archive_sha256: 'a'.repeat(64),
          content_manifest_sha256: 'c'.repeat(64),
        },
        policy_resolution_digest_sha256: 'd'.repeat(64),
      },
    ],
  };
  const transcript = encodeReleaseExportTranscriptV2(
    {
      version: RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT,
      binding: {
        action_id: binding.action_id,
        repository: binding.repository,
        candidate: binding.candidate,
        plan_receipt_digest_sha256: binding.plan_receipt_digest_sha256,
        parent_artifact_sink: binding.parent_artifact_sink,
        sink_id: binding.sink_id,
        destination: binding.destination,
        trust: binding.trust,
        attempt_id: binding.attempt_id,
      },
      parent: preparedArtifacts,
      closures: [
        {
          package_id: certifiedPackage.package_id,
          release_unit: releaseUnit.release_unit,
          evidence_manifest: evidenceManifest,
          expected_installed_package:
            binding.closure_inputs[0]?.expected_installed_package ??
            (() => {
              throw new Error('missing closure input');
            })(),
          policy_resolution_digest_sha256: 'd'.repeat(64),
        },
      ],
      mutation_units: [mutationUnit],
      destination,
      trust,
    },
    limits,
  );
  const providerBytes = encodeReleaseExportProviderResultV2(
    {
      package_id: certifiedPackage.package_id,
      transcript,
      signature: 'AQ==',
      mutation_evidence: portable.mutation_evidence,
    },
    limits,
  );
  const providerResult = opaqueBytes('provider-result', 'provider-result', providerBytes);
  const exportedPackage = {
    package_id: certifiedPackage.package_id,
    package_manifest: packageManifest,
    package_tarball: packageTarball,
    package_sbom: packageSbom,
    evidence_manifest: evidenceManifest,
    provider_result: providerResult,
    trust,
    certification_manifest: certificationManifest,
  };
  const artifacts = sortOpaque([...preparedArtifacts, evidenceManifest, providerResult]);
  const manifest = Buffer.from(
    canonicalJson({
      schemaVersion: '1.0.0',
      kind: 'release-artifact-sink-commit-manifest',
      sink_id: SINK_ID,
      transaction_handle: 'export-transaction',
      repository: binding.repository,
      candidate: binding.candidate,
      export_spec_id: RELEASE_EXPORT_SPEC_V3_ID,
      export_spec_digest_sha256: RELEASE_EXPORT_SPEC_V3_DIGEST,
      parent_artifact_sink: parent.identity,
      binding,
      artifacts,
    }),
  );
  const artifactSink = {
    sink_id: SINK_ID,
    transaction_handle: 'export-transaction',
    committed_manifest_handle: 'export-commit-manifest',
    committed_manifest_sha256: createHash('sha256').update(manifest).digest('hex'),
    committed_manifest_size_bytes: manifest.byteLength,
    commit_protocol: 'devai.artifact-sink.two-phase.v1' as const,
  };
  const bytes = new Map<string, Buffer>([
    [packageManifest.opaque_handle, packageManifestBytes],
    [packageTarball.opaque_handle, Buffer.from(ARTIFACT_BYTES)],
    [packageSbom.opaque_handle, Buffer.from(ARTIFACT_BYTES)],
    [evidenceManifest.opaque_handle, closureBytes],
  ]);
  bytes.set(parent.identity.committed_manifest_handle, parent.manifest);
  bytes.set(providerResult.opaque_handle, providerBytes);
  bytes.set(artifactSink.committed_manifest_handle, manifest);
  const artifactReader = {
    readArtifact: ({ opaque_handle }: { readonly opaque_handle: string }) => {
      const value = bytes.get(opaque_handle);
      if (value === undefined) throw new Error('required export artifact missing');
      return Buffer.from(value);
    },
  };
  const { state_id: _stateId, record_digest_sha256: _recordDigest, ...templateDraft } = template;
  const stateDraft = {
    ...templateDraft,
    repository: mutationRequest.repository_locator,
    candidate: {
      release_unit: releaseUnit.release_unit,
      version: releaseUnit.version,
      commit: mutationRequest.candidate_locator.commit,
      tree: mutationRequest.candidate_locator.tree,
    },
    bound_receipts: [
      {
        kind: 'release-plan-receipt',
        receipt_id: String(requiredInput.fixture.receipt['receipt_id']),
        receipt_digest_sha256: String(requiredInput.fixture.receipt['receipt_digest_sha256']),
        verdict: 'pass',
      },
    ],
    release_units: [
      {
        release_unit: releaseUnit.release_unit,
        version: releaseUnit.version,
        packages: [exportedPackage],
        mutation_evidence: requiredInput.evidence.closure,
      },
    ],
    inputs: requiredInput.material.inputs,
    evidence: {
      ...template.evidence,
      receipt_digests: [String(requiredInput.fixture.receipt['receipt_digest_sha256'])],
    },
    artifacts,
    artifact_sink: artifactSink,
  } as Parameters<typeof finalizeReleaseStateV2>[0];
  const state = finalizeReleaseStateV2(stateDraft);
  return {
    state,
    request: selected,
    artifactReader,
    limits,
    policyClosures: [
      {
        closure: createReleasePolicyClosure({
          plan: requiredInput.fixture.receipt,
          resolution: requiredInput.fixture.resolution,
        }),
        expected: requiredInput.fixture.expected,
        implementation: requiredInput.fixture.package_snapshot,
        limits: {
          maximum_archive_bytes: 4 * 1024 * 1024,
          maximum_unpacked_bytes: 4 * 1024 * 1024,
          maximum_git_bytes: 4 * 1024 * 1024,
          maximum_git_entries: 2000,
        },
      },
    ],
  };
}

function providerFor(action: ReleaseLifecycleRequest['action_id']) {
  if (action !== 'release certify')
    return () => ({ outcome: 'success' as const, material: materialFor(action) });
  return createReleaseCertificationProvider({
    resolve_receipt: () => planReceipt(),
    resolve_plan_input: resolvePlanInput,
    provider: {
      kind: 'protected-certification-provider-v3',
      certify: () => ({ outcome: 'success' as const, material: materialFor('release certify') }),
    },
    evidence_sink: {
      kind: 'certification-evidence-sink-v3',
      protocol: 'two-phase-content-addressed',
      begin: () => undefined as never,
      readCertificationEvidenceReceipt: () => {
        throw new Error('no generated output');
      },
      readCertificationOutputClosure: (binding) => ({ ...binding, outputs: [] }),
      readGeneratedBlob: () => {
        throw new Error('no generated output');
      },
    },
    content_source: {
      readGitObject: ({ type, object_id }) => {
        if (type === 'commit' && object_id === COMMIT) return COMMIT_BYTES;
        if (type === 'tree' && object_id === TREE) return TREE_BYTES;
        throw new Error('unknown Git object');
      },
      readGitBlob: ({ object_id }) => {
        if (object_id !== BLOB) throw new Error('unknown Git blob');
        return ARTIFACT_BYTES;
      },
    },
    task_policies: [
      {
        release_unit: '@aarusso-nyx/devai',
        task_policy_digest_sha256: TASK_POLICY_DIGEST,
        document: CERTIFICATION_TASK_POLICY,
      },
    ],
  });
}

function certificationProviderBoundaryInput(
  certify = vi.fn(() => ({
    outcome: 'success' as const,
    material: materialFor('release certify'),
  })),
) {
  const input = {
    resolve_receipt: () => planReceipt(),
    resolve_plan_input: resolvePlanInput,
    provider: {
      kind: 'protected-certification-provider-v3' as const,
      certify,
    },
    evidence_sink: {
      kind: 'certification-evidence-sink-v3' as const,
      protocol: 'two-phase-content-addressed' as const,
      begin: () => undefined as never,
      readCertificationEvidenceReceipt: () => {
        throw new Error('no generated output');
      },
      readCertificationOutputClosure: (binding: CertificationOutputClosureBinding) => ({
        ...binding,
        outputs: [],
      }),
      readGeneratedBlob: () => {
        throw new Error('no generated output');
      },
    },
    content_source: {
      readGitObject: ({
        type,
        object_id,
      }: {
        readonly type: string;
        readonly object_id: string;
      }) => {
        if (type === 'commit' && object_id === COMMIT) return COMMIT_BYTES;
        if (type === 'tree' && object_id === TREE) return TREE_BYTES;
        throw new Error('unknown Git object');
      },
      readGitBlob: ({ object_id }: { readonly object_id: string }) => {
        if (object_id !== BLOB) throw new Error('unknown Git blob');
        return ARTIFACT_BYTES;
      },
    },
    task_policies: [
      {
        release_unit: '@aarusso-nyx/devai',
        task_policy_digest_sha256: TASK_POLICY_DIGEST,
        document: CERTIFICATION_TASK_POLICY,
      },
    ],
  } satisfies Parameters<typeof createReleaseCertificationProvider>[0];
  return { certify, input };
}

function requiredMutationRequest(): ReleaseLifecycleRequest {
  const fixture = REQUIRED_POLICY_FIXTURE;
  const manifestDigest = createHash('sha256').update(fixture.package_json).digest('hex');
  return {
    schemaVersion: '1.0.0',
    request_kind: 'release-lifecycle-request',
    action_id: 'release certify',
    repository_locator: fixture.candidate.repository,
    candidate_locator: {
      commit: fixture.candidate.repository.commit,
      tree: fixture.candidate.repository.tree,
      release_units: [
        {
          release_unit: '@aarusso-nyx/devai',
          version: '1.5.0',
          package_roster: [
            {
              package_id: '@aarusso-nyx/devai',
              manifest_path: 'package.json',
              manifest_digest_sha256: manifestDigest,
            },
          ],
        },
      ],
    },
    receipt_locators: [receiptLocator(fixture.receipt)],
  };
}

async function requiredMutationCertificationFixture() {
  const request = requiredMutationRequest();
  const fixture = REQUIRED_POLICY_FIXTURE;
  const requirement = required(
    resolveReleaseMutationRequirements(request, {
      resolve_receipt: () => fixture.receipt,
      resolve_plan_input: fixture.resolve_plan_input,
    })[0],
    'missing required mutation requirement',
  );
  if (requirement.binding === null) throw new Error('fixture mutation must be required');
  const packageJson = fixture.package_json;
  const packageDigest = createHash('sha256').update(packageJson).digest('hex');
  const blob = required(
    [...fixture.objects].find(
      ([, object]) => object.type === 'blob' && Buffer.from(object.bytes).equals(packageJson),
    )?.[0],
    'missing required mutation package blob',
  );
  const evidence = await unitMutationEvidenceFixture({
    binding: {
      ...requirement.binding,
      task_policy_digests_sha256: [TASK_POLICY_DIGEST],
    },
    packages: DEVAI_ADOPTION.release_verification.mutation_roster.map((entry) => ({
      packageName: entry.package,
      workspace: entry.manifest_path.replace(/\/package\.json$/u, ''),
    })),
  });
  const certification = finalizeCertificationManifest({
    candidate: {
      commit: fixture.candidate.repository.commit,
      tree: fixture.candidate.repository.tree,
    },
    task_policy_digest_sha256: TASK_POLICY_DIGEST,
    package_id: '@aarusso-nyx/devai',
    package_version: '1.5.0',
    entry_order: 'ascending-utf-8-byte-collation-by-path;duplicates-refuse',
    manifest_digest_contract: {
      domain: 'DEVAI-CERTIFIED-PACKAGE-ENTRY-MANIFEST-V1\0',
      payload:
        'utf-8-rfc8785-jcs-of-the-entire-manifest-with-manifest_digest_sha256-omitted;framed-as-domain-utf8-bytes-plus-payload-utf8-bytes',
      canonicalization: 'rfc8785-jcs',
      algorithm: 'sha256',
    },
    entries: [
      {
        path: 'package.json',
        mode: '100644',
        size_bytes: packageJson.byteLength,
        sha256: packageDigest,
        immutable_blob_locator: {
          kind: 'git-object',
          repository: fixture.candidate.repository.id,
          commit: fixture.candidate.repository.commit,
          tree: fixture.candidate.repository.tree,
          object_format: 'sha1',
          path: 'package.json',
          mode: '100644',
          object_id: blob,
          size_bytes: packageJson.byteLength,
          content_digest_sha256: packageDigest,
        },
      },
    ],
  });
  const material: ReleaseStateMaterial = {
    release_units: [
      {
        release_unit: '@aarusso-nyx/devai',
        version: '1.5.0',
        packages: [
          {
            package_id: '@aarusso-nyx/devai',
            manifest: {
              path: 'package.json',
              sha256: packageDigest,
              size_bytes: packageJson.byteLength,
            },
            tarball: null,
            sbom: null,
            evidence_manifest: null,
            provider_result: null,
            trust: null,
            certification_manifest: certification,
          },
        ],
        mutation_evidence: evidence.closure,
      },
    ],
    inputs: [
      {
        kind: 'release-lifecycle-policy',
        path: 'law/policy/release-lifecycle.json',
        sha256: packageDigest,
      },
      {
        kind: 'task-policy',
        path: 'task-policy/certify/selection',
        sha256: TASK_POLICY_DIGEST,
      },
    ],
    evidence: {
      manifest_digest_sha256: EVIDENCE_DIGEST,
      receipt_digests: [String(fixture.receipt['receipt_digest_sha256'])],
      independently_checkable: true,
    },
    artifacts: [],
  };
  const content_source = {
    readGitObject: ({ type, object_id }: { readonly type: string; readonly object_id: string }) => {
      const object = fixture.objects.get(object_id);
      if (object?.type !== type || (type !== 'commit' && type !== 'tree'))
        throw new Error('unknown required mutation Git object');
      return Buffer.from(object.bytes);
    },
    readGitBlob: ({ object_id }: { readonly object_id: string }) => {
      if (object_id !== blob) throw new Error('unknown required mutation Git blob');
      return Buffer.from(packageJson);
    },
  };
  return { request, fixture, evidence, material, content_source };
}

async function mixedMutationCertificationFixture() {
  const fixture = createLifecyclePolicyResolutionSetFixture({
    mutation_roster: DEVAI_ADOPTION.release_verification.mutation_roster,
    profile_overrides: DEVAI_ADOPTION.release_verification,
    changed_packages: [['@aarusso-nyx/devai'], []],
    change_kinds: ['behavioral', 'documentation'],
  });
  const packageJson = fixture.candidate.read('package.json');
  const packageDigest = createHash('sha256').update(packageJson).digest('hex');
  const releaseUnits = fixture.receipts.map((receipt) => {
    const candidate = receipt['candidate'] as Readonly<Record<string, unknown>>;
    return {
      release_unit: String(candidate['release_unit']),
      version: String(candidate['version']),
      package_roster: [
        {
          package_id: String(candidate['release_unit']),
          manifest_path: 'package.json',
          manifest_digest_sha256: packageDigest,
        },
      ],
    };
  });
  const request: ReleaseLifecycleRequest = {
    schemaVersion: '1.0.0',
    request_kind: 'release-lifecycle-request',
    action_id: 'release certify',
    repository_locator: fixture.candidate.repository,
    candidate_locator: {
      commit: fixture.candidate.repository.commit,
      tree: fixture.candidate.repository.tree,
      release_units: releaseUnits,
    },
    receipt_locators: fixture.receipts
      .map(receiptLocator)
      .sort((left, right) => left.receipt_id.localeCompare(right.receipt_id, 'en')),
  };
  const resolveReceipt = (locator: { readonly receipt_digest_sha256: string }) =>
    required(
      fixture.receipts.find(
        (receipt) => receipt['receipt_digest_sha256'] === locator.receipt_digest_sha256,
      ),
      'missing mixed export receipt',
    );
  const requirements = resolveReleaseMutationRequirements(request, {
    resolve_receipt: resolveReceipt,
    resolve_plan_input: fixture.resolve_plan_input,
  });
  const binding = required(requirements[0]?.binding, 'first mixed unit must require mutation');
  if (requirements[1]?.binding !== null) throw new Error('second mixed unit must omit mutation');
  const evidence = await unitMutationEvidenceFixture({
    binding: { ...binding, task_policy_digests_sha256: [TASK_POLICY_DIGEST] },
    packages: DEVAI_ADOPTION.release_verification.mutation_roster.map((entry) => ({
      packageName: entry.package,
      workspace: entry.manifest_path.replace(/\/package\.json$/u, ''),
    })),
  });
  const certification = (releaseUnit: (typeof releaseUnits)[number]) =>
    finalizeCertificationManifest({
      candidate: {
        commit: fixture.candidate.repository.commit,
        tree: fixture.candidate.repository.tree,
      },
      task_policy_digest_sha256: TASK_POLICY_DIGEST,
      package_id: releaseUnit.package_roster[0]?.package_id ?? '',
      package_version: releaseUnit.version,
      entry_order: 'ascending-utf-8-byte-collation-by-path;duplicates-refuse',
      manifest_digest_contract: {
        domain: 'DEVAI-CERTIFIED-PACKAGE-ENTRY-MANIFEST-V1\0',
        payload:
          'utf-8-rfc8785-jcs-of-the-entire-manifest-with-manifest_digest_sha256-omitted;framed-as-domain-utf8-bytes-plus-payload-utf8-bytes',
        canonicalization: 'rfc8785-jcs',
        algorithm: 'sha256',
      },
      entries: [
        {
          path: 'package.json',
          mode: '100644',
          size_bytes: packageJson.byteLength,
          sha256: packageDigest,
          immutable_blob_locator: {
            kind: 'git-object',
            repository: fixture.candidate.repository.id,
            commit: fixture.candidate.repository.commit,
            tree: fixture.candidate.repository.tree,
            object_format: 'sha1',
            path: 'package.json',
            mode: '100644',
            object_id: 'a'.repeat(40),
            size_bytes: packageJson.byteLength,
            content_digest_sha256: packageDigest,
          },
        },
      ],
    });
  const material: ReleaseStateMaterial = {
    release_units: releaseUnits.map((unit, index) => ({
      release_unit: unit.release_unit,
      version: unit.version,
      packages: [
        {
          package_id: unit.package_roster[0]?.package_id ?? '',
          manifest: {
            path: 'package.json',
            sha256: packageDigest,
            size_bytes: packageJson.byteLength,
          },
          tarball: null,
          sbom: null,
          evidence_manifest: null,
          provider_result: null,
          trust: null,
          certification_manifest: certification(unit),
        },
      ],
      ...(index === 0 ? { mutation_evidence: evidence.closure } : {}),
    })),
    inputs: [
      {
        kind: 'release-lifecycle-policy',
        path: 'law/policy/release-lifecycle.json',
        sha256: packageDigest,
      },
      {
        kind: 'task-policy',
        path: 'task-policy/certify/selection',
        sha256: TASK_POLICY_DIGEST,
      },
    ],
    evidence: {
      manifest_digest_sha256: EVIDENCE_DIGEST,
      receipt_digests: fixture.receipts.map((receipt) => String(receipt['receipt_digest_sha256'])),
      independently_checkable: true,
    },
    artifacts: [],
  };
  return {
    request,
    receipts: fixture.receipts,
    resolve_plan_input: fixture.resolve_plan_input,
    resolutions: fixture.resolutions,
    package_snapshot: fixture.package_snapshot,
    candidate: fixture.candidate,
    evidence,
    material,
  };
}

function requiredMutationEvidenceSink(
  evidence: Awaited<ReturnType<typeof unitMutationEvidenceFixture>>,
  options: {
    readonly closure?: typeof evidence.closure;
    readonly read_blob?: (identity: Parameters<typeof evidence.read>[0]) => Buffer;
    readonly omit_unit_readers?: boolean;
    readonly omit_unit_reader?: 'closure' | 'receipt' | 'blob';
    readonly omit_unit_maximum?: boolean;
    readonly unit_maximum_bytes?: number;
  } = {},
) {
  const omitAllUnitReaders = options.omit_unit_readers === true;
  return {
    kind: 'certification-evidence-sink-v3' as const,
    protocol: 'two-phase-content-addressed' as const,
    begin: () => undefined as never,
    readCertificationEvidenceReceipt: () => {
      throw new Error('no generated output');
    },
    readCertificationOutputClosure: (binding: CertificationOutputClosureBinding) => ({
      ...binding,
      outputs: [],
    }),
    readGeneratedBlob: () => {
      throw new Error('no generated output');
    },
    ...(omitAllUnitReaders || options.omit_unit_maximum
      ? {}
      : { unit_mutation_maximum_bytes: options.unit_maximum_bytes ?? 1_000_000 }),
    ...(omitAllUnitReaders || options.omit_unit_reader === 'closure'
      ? {}
      : { readUnitMutationEvidenceClosure: () => options.closure ?? evidence.closure }),
    ...(omitAllUnitReaders || options.omit_unit_reader === 'receipt'
      ? {}
      : {
          readUnitMutationEvidenceReceipt: () => (options.closure ?? evidence.closure).receipt,
        }),
    ...(omitAllUnitReaders || options.omit_unit_reader === 'blob'
      ? {}
      : {
          readUnitMutationEvidenceBlob: ({
            identity,
          }: {
            readonly identity: Parameters<typeof evidence.read>[0];
          }) => options.read_blob?.(identity) ?? evidence.read(identity),
        }),
  };
}

function requiredMutationProvider(
  input: Awaited<ReturnType<typeof requiredMutationCertificationFixture>>,
  certify = vi.fn(() => ({ outcome: 'success' as const, material: input.material })),
  options: Parameters<typeof requiredMutationEvidenceSink>[1] = {},
  resolvers: {
    readonly resolve_receipt?: (
      locator: NonNullable<ReleaseLifecycleRequest['receipt_locators']>[number],
    ) => unknown;
    readonly resolve_plan_input?: typeof input.fixture.resolve_plan_input;
  } = {
    resolve_receipt: () => input.fixture.receipt,
    resolve_plan_input: input.fixture.resolve_plan_input,
  },
) {
  return {
    certify,
    provider: createReleaseCertificationProvider({
      provider: { kind: 'protected-certification-provider-v3', certify },
      evidence_sink: requiredMutationEvidenceSink(input.evidence, options),
      content_source: input.content_source,
      task_policies: [
        {
          release_unit: '@aarusso-nyx/devai',
          task_policy_digest_sha256: TASK_POLICY_DIGEST,
          document: CERTIFICATION_TASK_POLICY,
        },
      ],
      ...resolvers,
    }),
  };
}

function artifactReaderFor(action: ReleaseLifecycleRequest['action_id']) {
  if (['release export', 'release evidence-publish', 'release publish'].includes(action)) {
    const exported = exportFixture();
    return {
      readArtifact: ({ opaque_handle }: { readonly opaque_handle: string }) => {
        const bytes = exported.bytes.get(opaque_handle);
        if (bytes === undefined) throw new Error('fixture export artifact missing');
        return Buffer.from(bytes);
      },
    };
  }
  const material = materialFor(action);
  const sink = committedSink(material.artifacts);
  const preparedPackage = material.release_units
    .flatMap((unit) => unit.packages)
    .find((entry) => entry.package_manifest !== null && entry.package_manifest !== undefined);
  const packageManifest =
    preparedPackage?.package_manifest === null || preparedPackage?.package_manifest === undefined
      ? undefined
      : preparedPackage.package_manifest;
  const packageManifestBytes =
    packageManifest === undefined ||
    preparedPackage?.certification_manifest === null ||
    preparedPackage?.certification_manifest === undefined ||
    preparedPackage.package_tarball === null ||
    preparedPackage.package_tarball === undefined ||
    preparedPackage.package_sbom === null ||
    preparedPackage.package_sbom === undefined
      ? undefined
      : preparedPackageManifestBytes(
          preparedPackage.certification_manifest,
          preparedPackage.package_tarball,
          preparedPackage.package_sbom,
        );
  return {
    readArtifact: ({ opaque_handle }: { readonly opaque_handle: string }) => {
      if (opaque_handle === COMMIT_MANIFEST_HANDLE) return sink.manifest;
      if (opaque_handle === packageManifest?.opaque_handle && packageManifestBytes !== undefined)
        return packageManifestBytes;
      return ARTIFACT_BYTES;
    },
  };
}

function authorityFor(action: ReleaseLifecycleRequest['action_id']): TrustedReleaseAuthority {
  const role =
    action === 'release preflight' || action === 'release certify'
      ? 'inspector'
      : action === 'release prepare' || action === 'release export'
        ? 'architect'
        : 'owner';
  return {
    actor: { kind: 'human', role, declaration_source: 'cli-flag' },
    consent: {
      write: true,
      allow_publish: action === 'release evidence-publish' || action === 'release publish',
      experimental: false,
    },
  };
}

function publicationControls(): PublicationControls {
  return {
    destination: {
      system_id: 'publication-destination',
      exact_identifier: 'npm:@aarusso-nyx/devai@1.5.0',
      operation: 'publish',
    },
    workflow: {
      repository: 'aarusso-nyx/devai',
      workflow_path: '.github/workflows/release.yml',
      workflow_sha: COMMIT,
      protected_environment: 'release',
      protected: true,
    },
    trust: {
      trust_root_id: 'release-root',
      trust_store_digest_sha256: 'b'.repeat(64),
      key_id: 'release-key',
      signature_algorithm: 'ed25519',
    },
  };
}

function finalizeAuthorizationEvent(draft: Readonly<Record<string, unknown>>) {
  const payload = canonicalSha256(draft);
  return {
    ...draft,
    event_id: `EA-${payload.slice(0, 16)}`,
    payload_digest_sha256: payload,
  };
}

function authorizationLedger(events: readonly Readonly<Record<string, unknown>>[]) {
  const schema = JSON.parse(
    readFileSync(
      join(process.cwd(), 'law/schemas/effect-authorization-ledger.schema.json'),
      'utf8',
    ),
  ) as { examples: readonly Readonly<Record<string, unknown>>[] };
  const template = required(schema.examples[0], 'missing ledger example');
  const entries = events.map((event) => ({
    sequence: event['sequence'],
    event_id: event['event_id'],
    event_digest_sha256: canonicalSha256(event),
    previous_event_digest_sha256: event['previous_event_digest_sha256'],
    kind: event['kind'],
    references_event_id: event['grant_event_id'],
  }));
  const final = required(entries.at(-1), 'missing ledger head');
  return {
    ...template,
    ledger_id: 'EAL-release-test',
    repository: { id: 'aarusso-nyx/devai' },
    head: {
      sequence: final.sequence,
      event_id: final.event_id,
      event_digest_sha256: final.event_digest_sha256,
    },
    entries,
  };
}

function authorizationBridge(
  onConsume?: (binding: AuthorizationAttemptBinding) => void,
  grantRecordedAt = '2026-09-03T00:00:00.000Z',
): AuthorizationBridge {
  let grant:
    | {
        readonly event: Readonly<Record<string, unknown>>;
        readonly digest: string;
        readonly head: {
          readonly ledger_id: string;
          readonly sequence: number;
          readonly event_id: string;
          readonly event_digest_sha256: string;
        };
      }
    | undefined;
  const makeGrant = (binding: AuthorizationAttemptBinding) => {
    const draft = {
      schemaVersion: '1.0.0',
      canonicalization: {
        kernel_id: 'devai.kernel.effect-authorization-event-canonicalization.v1',
        encoding: 'utf-8',
        json_form: 'rfc8785-jcs',
        digest_algorithm: 'sha256',
        payload_projection_excludes: ['event_id', 'payload_digest_sha256'],
        event_id_derivation:
          'EA-hyphen-plus-the-first-16-lowercase-hex-characters-of-payload_digest_sha256',
        event_digest_projection: 'complete-event-record-with-no-field-excluded',
        calculation_order: [
          'compute-payload_digest_sha256-over-the-canonical-payload-projection',
          'derive-event_id-from-payload_digest_sha256',
          'compute-ledger-event-digest-over-the-complete-event-record',
        ],
      },
      ledger_id: 'EAL-release-test',
      sequence: 1,
      previous_event_digest_sha256: null,
      kind: 'granted',
      action_id: binding.action_id,
      effect: 'remote-write',
      resource: {
        kind: 'remote',
        system_id: binding.destination.system_id,
        exact_identifier: binding.destination.exact_identifier,
        operations: [binding.destination.operation],
      },
      repository: binding.repository,
      candidate: binding.candidate,
      grantor: authorityFor(binding.action_id).actor,
      subject_role: 'owner',
      consent: authorityFor(binding.action_id).consent,
      one_time: true,
      uses_permitted: 1,
      bearer_transferable: false,
      delegable: false,
      not_before: '2026-09-03T00:00:00.000Z',
      expires_at: '2026-09-03T01:00:00.000Z',
      recorded_at: grantRecordedAt,
      grant_event_id: null,
    };
    const event = finalizeAuthorizationEvent(draft);
    const digest = canonicalSha256(event);
    return {
      event,
      digest,
      head: {
        ledger_id: 'EAL-release-test',
        sequence: 1,
        event_id: event.event_id,
        event_digest_sha256: digest,
      },
    };
  };
  return {
    resolve: (binding) => {
      grant ??= makeGrant(binding);
      return {
        ok: true,
        ledger: authorizationLedger([grant.event]),
        events: [grant.event],
      };
    },
    consume: (binding) => {
      onConsume?.(binding);
      grant ??= makeGrant(binding);
      const {
        event_id: _eventId,
        payload_digest_sha256: _payloadDigest,
        not_before: _notBefore,
        expires_at: _expiresAt,
        ...grantBase
      } = grant.event;
      const event = finalizeAuthorizationEvent({
        ...grantBase,
        schemaVersion: '2.0.0',
        canonicalization: {
          ...((grant.event['canonicalization'] ?? {}) as Readonly<Record<string, unknown>>),
          kernel_id: 'devai.kernel.effect-authorization-event-canonicalization.v2',
        },
        sequence: 2,
        previous_event_digest_sha256: grant.digest,
        kind: 'consumed',
        recorded_at: '2026-09-03T00:00:00.000Z',
        grant_event_id: grant.event.event_id,
        consumed_by_state_id: null,
        consumption_binding: {
          ...binding,
          ledger_predecessor_digest_sha256: grant.digest,
        },
      });
      return {
        durable: true,
        ledger: authorizationLedger([grant.event, event]),
        events: [grant.event, event],
      };
    },
  };
}

function offlineArtifacts(exported: Readonly<Record<string, unknown>>): readonly unknown[] {
  if (exported['schemaVersion'] === '2.1.0') {
    return exported['artifacts'] as readonly unknown[];
  }
  const units = exported['release_units'] as readonly {
    readonly packages: readonly Record<string, unknown>[];
  }[];
  const values: unknown[] = (
    exported['artifacts'] as readonly Readonly<Record<string, unknown>>[]
  ).filter((artifact) =>
    ['package-tarball', 'evidence-bundle', 'manifest', 'attestation'].includes(
      String(artifact['kind']),
    ),
  );
  for (const unit of units) {
    for (const pkg of unit.packages) {
      if (pkg['manifest'] !== null)
        values.push({ kind: 'manifest', ...objectValue(pkg['manifest']) });
      if (pkg['tarball'] !== null)
        values.push({ kind: 'package-tarball', ...objectValue(pkg['tarball']) });
      if (pkg['evidence_manifest'] !== null)
        values.push({ kind: 'manifest', ...objectValue(pkg['evidence_manifest']) });
    }
  }
  return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'),
  );
}

function offlineReleaseUnits(exported: Readonly<Record<string, unknown>>): readonly unknown[] {
  const units = exported['release_units'] as readonly {
    readonly release_unit: string;
    readonly version: string;
    readonly packages: readonly Readonly<Record<string, unknown>>[];
  }[];
  if (exported['schemaVersion'] !== '2.1.0') return units;
  return units.map((unit) => ({
    release_unit: unit.release_unit,
    version: unit.version,
    packages: unit.packages.map((pkg) => ({
      package_id: pkg['package_id'],
      package_manifest: pkg['package_manifest'],
      package_tarball: pkg['package_tarball'],
      package_sbom: pkg['package_sbom'],
      evidence_manifest: pkg['evidence_manifest'],
      provider_result: pkg['provider_result'],
      trust: pkg['trust'],
    })),
    ...('mutation_evidence' in unit ? { mutation_evidence: unit['mutation_evidence'] } : {}),
  }));
}

function exportedWithMutationEvidence(
  exported: Parameters<typeof finalizeReleaseStateV2>[0] & Readonly<Record<string, unknown>>,
  mutationEvidence: unknown,
) {
  const { state_id: _stateId, record_digest_sha256: _recordDigest, ...draft } = exported;
  const releaseUnits = draft['release_units'];
  if (!Array.isArray(releaseUnits)) throw new Error('exported fixture lacks release units');
  return finalizeReleaseStateV2({
    ...draft,
    release_units: releaseUnits.map((unit) => ({
      ...objectValue(unit),
      mutation_evidence: mutationEvidence,
    })),
  } as Parameters<typeof finalizeReleaseStateV2>[0]);
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected object');
  }
  return value as Readonly<Record<string, unknown>>;
}

function boundOfflineReceipt(
  exported: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const legacy = offlineReceipt();
  const draft: Readonly<Record<string, unknown>> = {
    ...legacy,
    schemaVersion: '2.1.0',
    canonicalization: {
      ...(legacy['canonicalization'] as Readonly<Record<string, unknown>>),
      kernel_id: 'devai.kernel.release-offline-verification-receipt-canonicalization.v3',
    },
    verification_kernel: {
      ...(legacy['verification_kernel'] as Readonly<Record<string, unknown>>),
      kernel_id: 'devai.kernel.offline-verification-receipt.v3',
      supported_canonicalization_kernels: [
        'devai.kernel.release-offline-verification-receipt-canonicalization.v1',
        'devai.kernel.release-offline-verification-receipt-canonicalization.v2',
        'devai.kernel.release-offline-verification-receipt-canonicalization.v3',
      ],
      v3_sink_handle_closure:
        'for-a-v2.1-receipt-resolve-every-aggregate-and-per-package-opaque-handle-through-the-external-sink-rehash-byte-digest-and-size-require-sorted-duplicate-free-one-to-one-equality-by-kind-sink_id-opaque_handle-sha256-size_bytes-with-the-exported-state-and-evidence-publish-input-and-verify-artifact-sink-commit-and-external-trust-inputs',
      v3_sink_handle_errors: [
        'rov-v3-opaque-artifact-closure-invalid',
        'rov-v3-artifact-sink-commit-mismatch',
        'rov-v3-external-sink-reverification-failed',
        'rov-v3-evidence-publish-continuity-invalid',
      ],
    },
    repository: exported['repository'],
    candidate: exported['candidate'],
    verified_state: {
      state: exported['state'],
      state_id: exported['state_id'],
      record_digest_sha256: exported['record_digest_sha256'],
    },
    release_units: offlineReleaseUnits(exported),
    artifacts: offlineArtifacts(exported),
    artifact_sink_commit: exported['artifact_sink'],
  };
  const { receipt_id: _receiptId, receipt_digest_sha256: _receiptDigest, ...projection } = draft;
  const digest = canonicalSha256(projection);
  return {
    ...projection,
    receipt_id: `ROV-${digest.slice(0, 16)}`,
    receipt_digest_sha256: digest,
  };
}

function rehashReceipt(
  receipt: Readonly<Record<string, unknown>>,
  changes: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const { receipt_id: _receiptId, receipt_digest_sha256: _receiptDigest, ...original } = receipt;
  const projection = { ...original, ...changes };
  const digest = canonicalSha256(projection);
  const prefix = receipt['receipt_kind'] === 'release-plan-receipt' ? 'RPL' : 'ROV';
  return {
    ...projection,
    receipt_id: `${prefix}-${digest.slice(0, 16)}`,
    receipt_digest_sha256: digest,
  };
}

function finalizePublicationReceipt(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const {
    receipt_id: _receiptId,
    receipt_digest_sha256: _receiptDigest,
    trust: trustInput,
    ...projection
  } = input;
  const {
    signature: _signature,
    signed_payload_digest_sha256: _signedPayloadDigest,
    ...trust
  } = objectValue(trustInput);
  const signedDigest = canonicalSha256({ ...projection, trust });
  const signed = {
    ...projection,
    receipt_id: `RPU-${signedDigest.slice(0, 16)}`,
    trust: {
      ...trust,
      signature: 'AQ==',
      signed_payload_digest_sha256: signedDigest,
    },
  };
  return {
    ...signed,
    receipt_digest_sha256: canonicalSha256(signed),
  };
}

function boundPublicationReceipt(
  state: Readonly<Record<string, unknown>>,
  changes: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const schema = JSON.parse(
    readFileSync(
      join(process.cwd(), 'law/schemas/release-publication-receipt.schema.json'),
      'utf8',
    ),
  ) as { examples: readonly Readonly<Record<string, unknown>>[] };
  const example = required(schema.examples[0], 'missing publication receipt fixture');
  const expectation = objectValue(state['publication_expectation']);
  const workflow = objectValue(expectation['workflow']);
  return finalizePublicationReceipt({
    ...example,
    schemaVersion: '1.1.0',
    repository: state['repository'],
    candidate: state['candidate'],
    dispatched_state: {
      state: state['state'],
      state_id: state['state_id'],
      record_digest_sha256: state['record_digest_sha256'],
    },
    artifacts: state['artifacts'],
    publication: expectation['destination'],
    workflow: {
      ...workflow,
      run_id: '9876543210',
      run_attempt: 2,
      candidate_product_execution: false,
    },
    trust: {
      ...objectValue(expectation['trust']),
      signature: 'AQ==',
      signed_payload_digest_sha256: '0'.repeat(64),
    },
    ...changes,
  });
}

async function advanceToExported(store: ReleaseLifecycleFileStore): Promise<void> {
  await seedPreflight(store);
  for (const action of ['release certify', 'release prepare', 'release export'] as const) {
    const value = request(action);
    const execute = () =>
      executeReleaseLifecycleAction({
        request: value,
        action,
        authority: authorityFor(action),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider: providerFor(action),
        artifactReader:
          action === 'release export' ? artifactReaderFor('release prepare') : undefined,
        recorded_at: '2026-09-03T00:00:00.000Z',
      });
    const result =
      action === 'release prepare'
        ? await withReleasePrepareAuthorityFixture(value, execute)
        : action === 'release export'
          ? await withReleaseExportAuthorityFixture(value, execute)
          : await withAuthorityHostTestScope(execute);
    if (!result.ok) throw new Error(`advance failed: ${result.code}`);
  }
}

async function withReleaseExportAuthorityFixture<T>(
  request: ReleaseLifecycleRequest,
  callback: () => Promise<T>,
): Promise<T> {
  const plan = request.receipt_locators?.find((entry) => entry.kind === 'release-plan-receipt');
  if (plan === undefined) throw new Error('fixture export request lacks a plan receipt');
  const binding: ProtectedReleaseExportCapacityBinding = {
    action_id: 'release export',
    repository: request.repository_locator,
    candidate: {
      commit: request.candidate_locator.commit,
      tree: request.candidate_locator.tree,
    },
    plan_receipt_digest_sha256: plan.receipt_digest_sha256,
  };
  let ordinal = 0;
  let appliedBatches = 0;
  let appliedTargets = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'release-export-test-authority',
    issuer_version: '1.0.0',
    invocation_id: 'release-export-test-invocation',
    canonicalSha256,
    randomId: () => `release-export-test-authority-${String(++ordinal)}`,
    now: () => '2026-09-03T00:00:00.000Z',
    receipt_ttl_ms: 30_000,
  });
  const scope: AuthorityHostEffectScope = {
    action_id: 'release export',
    invocation_id: 'release-export-test-invocation',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => {
      if (appliedBatches >= 128 || appliedTargets >= 8192)
        throw new Error('release-export-capacity-unavailable');
      appliedBatches += 1;
      appliedTargets += 1;
      return apply();
    },
    read_export_capacity: (selected) => {
      if (canonicalSha256(selected) !== canonicalSha256(binding))
        throw new Error('release-export-capacity-unavailable');
      return {
        remaining_batches: 128 - appliedBatches,
        remaining_targets: 8192 - appliedTargets,
      };
    },
  };
  try {
    return await runWithAuthorityHostEffects(scope, callback);
  } finally {
    issuer.dispose();
  }
}

/** Valid persisted preflight state for downstream reducer tests. Executing the
 * protected preflight provider itself is covered by its container acceptance suite. */
async function seedPreflight(store: ReleaseLifecycleFileStore) {
  const value = request('release preflight');
  const requestDigest = computeReleaseRequestDigest(value);
  const candidate = {
    commit: value.candidate_locator.commit,
    tree: value.candidate_locator.tree,
    release_units: value.candidate_locator.release_units.map((unit) => ({
      release_unit: unit.release_unit,
      version: unit.version,
      packages: unit.package_roster.map((pkg) => ({ package_id: pkg.package_id })),
    })),
  };
  const attemptId = `RLA-${canonicalSha256({
    request_digest_sha256: requestDigest,
    action_id: 'release preflight',
    sequence: 0,
    predecessor_record: null,
  }).slice(0, 16)}`;
  const canonicalization = {
    json_form: 'rfc8785-jcs' as const,
    encoding: 'utf-8' as const,
    digest_algorithm: 'sha256' as const,
    projection_excludes: ['record_id', 'record_digest_sha256'] as const,
    id_derivation: 'RLE-hyphen-plus-first-16-lowercase-hex-of-record_digest_sha256' as const,
  };
  const attempt = finalizeStoreRecord({
    schemaVersion: '1.0.0',
    record_kind: 'attempt',
    canonicalization,
    sequence: 0,
    repository: value.repository_locator,
    candidate,
    predecessor_record: null,
    observed_head_before: null,
    attempt_id: attemptId,
    action_id: 'release preflight',
    request_digest_sha256: requestDigest,
    authorization_event_id: null,
    provider_handle: null,
    provider_dispatch: { status: 'not-dispatched', handle_observed: false },
    completion: null,
    failure: null,
    unknown: null,
  });
  const material = materialFor('release preflight');
  const primary = required(value.candidate_locator.release_units[0], 'missing preflight unit');
  const state = finalizeReleaseStateV2({
    schemaVersion: '2.0.0',
    canonicalization: {
      kernel_id: 'devai.kernel.release-lifecycle-state.v2',
      encoding: 'utf-8',
      json_form: 'rfc8785-jcs',
      digest_algorithm: 'sha256',
      projection_excludes: ['state_id', 'record_digest_sha256'],
      id_derivation: 'RLS-hyphen-plus-first-16-lowercase-hex-of-record_digest_sha256',
    },
    state: 'preflight_passed',
    action_id: 'release preflight',
    effect: 'harness-write',
    prior_state: null,
    bound_receipts:
      value.receipt_locators?.map((locator) => ({
        kind: locator.kind,
        receipt_id: locator.receipt_id,
        receipt_digest_sha256: locator.receipt_digest_sha256,
        verdict: 'pass',
      })) ?? [],
    repository: value.repository_locator,
    candidate: {
      release_unit: primary.release_unit,
      version: primary.version,
      commit: COMMIT,
      tree: TREE,
    },
    release_units: material.release_units,
    inputs: material.inputs,
    evidence: material.evidence,
    artifacts: material.artifacts,
    actor: authorityFor('release preflight').actor,
    consent: authorityFor('release preflight').consent,
    authorization_event_id: null,
    publication_expectation: null,
    storage: { generation: 0, head_before: null },
    recorded_at: '2026-09-03T00:00:00.000Z',
  });
  const completion = finalizeStoreRecord({
    schemaVersion: '1.0.0',
    record_kind: 'completion',
    canonicalization,
    sequence: 1,
    repository: value.repository_locator,
    candidate,
    predecessor_record: {
      sequence: attempt.sequence,
      record_id: attempt.record_id,
      record_digest_sha256: attempt.record_digest_sha256,
    },
    observed_head_before: null,
    attempt_id: attemptId,
    action_id: 'release preflight',
    request_digest_sha256: requestDigest,
    authorization_event_id: null,
    provider_handle: null,
    provider_dispatch: { status: 'not-dispatched', handle_observed: false },
    completion: {
      state_id: state.state_id,
      state_digest_sha256: state.record_digest_sha256,
      state: state.state,
    },
    failure: null,
    unknown: null,
  });
  await withAuthorityHostTestScope(() =>
    store.withExecutionLock(() => {
      store.appendStoreRecord(attempt);
      store.appendStoreRecord(completion);
      store.appendStateAndAdvanceHead(state, completion, null);
    }),
  );
  expect(reduceStoreRecords(store.readStoreRecords())).toMatchObject({ ok: true, failed: false });
  return { attempt, completion, state };
}

async function seedCertified(store: ReleaseLifecycleFileStore) {
  await seedPreflight(store);
  const result = await withAuthorityHostTestScope(() =>
    executeReleaseLifecycleAction({
      request: request('release certify'),
      action: 'release certify',
      authority: authorityFor('release certify'),
      store,
      resolveReceipt: () => planReceipt(),
      resolvePlanInput,
      provider: providerFor('release certify'),
      recorded_at: '2026-09-03T00:00:00.000Z',
    }),
  );
  if (!result.ok) throw new Error(`certified fixture failed: ${result.code}`);
  return result;
}

async function advanceToPrepared(store: ReleaseLifecycleFileStore): Promise<void> {
  await seedCertified(store);
  const value = request('release prepare');
  const result = await withReleasePrepareAuthorityFixture(value, () =>
    executeReleaseLifecycleAction({
      request: value,
      action: 'release prepare',
      authority: authorityFor('release prepare'),
      store,
      resolveReceipt: () => planReceipt(),
      resolvePlanInput,
      provider: providerFor('release prepare'),
      recorded_at: '2026-09-03T00:00:00.000Z',
    }),
  );
  if (!result.ok) throw new Error(`prepared fixture failed: ${result.code}`);
}

async function advanceToEvidencePublished(store: ReleaseLifecycleFileStore): Promise<void> {
  await advanceToExported(store);
  const exported = required(store.readStateRecords().at(-1), 'missing exported state');
  const receipt = boundOfflineReceipt(exported);
  const value = request('release evidence-publish', receipt);
  const result = await withAuthorityHostTestScope(() =>
    executeReleaseLifecycleAction({
      request: value,
      action: 'release evidence-publish',
      authority: authorityFor('release evidence-publish'),
      store,
      resolveReceipt: () => receipt,
      resolvePlanInput,
      offlineReceiptVerifier: { verify: ({ receipt: value }) => value },
      artifactReader: artifactReaderFor('release export'),
      authorization: authorizationBridge(),
      provider: () => ({
        outcome: 'success',
        provider_handle: 'evidence-run-1',
        material: materialFor('release evidence-publish'),
      }),
      recorded_at: '2026-09-03T00:00:00.000Z',
    }),
  );
  if (!result.ok) throw new Error(`evidence publish failed: ${result.code}`);
}

async function advanceToPublicationDispatched(
  store: ReleaseLifecycleFileStore,
): Promise<Readonly<Record<string, unknown>>> {
  await advanceToEvidencePublished(store);
  const value = request('release publish');
  const prior = required(store.readStateRecords().at(-1), 'missing evidence state');
  const result = await withAuthorityHostTestScope(() =>
    executeReleaseLifecycleAction({
      request: value,
      action: 'release publish',
      authority: authorityFor('release publish'),
      publication_controls: publicationControls(),
      store,
      resolveReceipt: () => planReceipt(),
      resolvePlanInput,
      artifactReader: artifactReaderFor('release evidence-publish'),
      authorization: authorizationBridge(),
      provider: () => ({
        outcome: 'success',
        provider_handle: 'publish-run-1',
        material: {
          release_units: prior.release_units,
          inputs: prior['inputs'],
          evidence: prior['evidence'],
          artifacts: prior['artifacts'],
          artifact_sink: prior.artifact_sink,
        } as ReleaseStateMaterial,
      }),
      recorded_at: '2026-09-03T00:00:00.000Z',
    }),
  );
  if (!result.ok) throw new Error(`publication dispatch failed: ${result.code}`);
  return result.state;
}

function root(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'devai-release-lifecycle-')));
}

function required<T>(value: T | null | undefined, message: string): NonNullable<T> {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

describe('release lifecycle execution kernel', () => {
  it('refuses unprotected preflight and v3 certify before task execution or state append', async () => {
    const preflight = request('release preflight');
    const preflightStore = new ReleaseLifecycleFileStore(root(), preflight);
    const genericPreflight = vi.fn(() => ({
      outcome: 'success' as const,
      material: materialFor('release preflight'),
    }));
    const preflightResult = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: preflight,
        action: 'release preflight',
        authority: authorityFor('release preflight'),
        store: preflightStore,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider: genericPreflight,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(preflightResult).toMatchObject({
      ok: false,
      phase: 'provider',
      code: 'release-certification-provider-unavailable',
    });
    expect(genericPreflight).not.toHaveBeenCalled();
    expect(preflightStore.readStoreRecords()).toEqual([]);

    const value = request('release certify');
    const store = new ReleaseLifecycleFileStore(root(), value);
    const genericProvider = vi.fn(() => ({
      outcome: 'success' as const,
      material: materialFor('release certify'),
    }));
    const result = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release certify',
        authority: authorityFor('release certify'),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider: genericProvider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      phase: 'provider',
      code: 'release-certification-provider-unavailable',
    });
    expect(genericProvider).not.toHaveBeenCalled();
    expect(store.readStoreRecords()).toEqual([]);

    const protectedProvider = {
      kind: 'protected-certification-provider-v3' as const,
      certify: vi.fn(),
    };
    expect(() =>
      createReleaseCertificationProvider({
        provider: protectedProvider,
        evidence_sink: undefined as never,
        content_source: undefined as never,
        task_policies: [],
      }),
    ).toThrow('release-certification-evidence-sink-unavailable');
    expect(protectedProvider.certify).not.toHaveBeenCalled();
  });

  it('checks each protected certification construction capability independently', () => {
    const { input, certify } = certificationProviderBoundaryInput();
    const construct = (overrides: Readonly<Record<string, unknown>>) =>
      createReleaseCertificationProvider({
        ...input,
        ...overrides,
      } as Parameters<typeof createReleaseCertificationProvider>[0]);

    for (const provider of [
      undefined,
      {},
      { kind: 'other-provider', certify },
      { kind: 'protected-certification-provider-v3' },
    ]) {
      expect(() => construct({ provider })).toThrow('release-certification-provider-unavailable');
    }

    for (const [property, value] of [
      ['kind', 'other-sink'],
      ['protocol', 'other-protocol'],
      ['begin', undefined],
      ['readCertificationEvidenceReceipt', undefined],
      ['readCertificationOutputClosure', undefined],
      ['readGeneratedBlob', undefined],
    ] as const) {
      expect(() =>
        construct({ evidence_sink: { ...input.evidence_sink, [property]: value } }),
      ).toThrow('release-certification-evidence-sink-unavailable');
    }

    for (const property of ['readGitObject', 'readGitBlob'] as const) {
      expect(() =>
        construct({ content_source: { ...input.content_source, [property]: undefined } }),
      ).toThrow('release-prepare-git-tree-membership-invalid');
    }
    expect(() => construct({ content_source: undefined })).toThrow(
      'release-prepare-git-tree-membership-invalid',
    );
    expect(certify).not.toHaveBeenCalled();
  });

  it('refuses each task-policy identity defect before protected certification dispatch', async () => {
    const wrongAction = certificationProviderBoundaryInput();
    await expect(
      createReleaseCertificationProvider(wrongAction.input)(request('release preflight')),
    ).resolves.toMatchObject({ outcome: 'failure', code: 'release-task-policy-identity-mismatch' });
    expect(wrongAction.certify).not.toHaveBeenCalled();

    const wrongUnit = certificationProviderBoundaryInput();
    const wrongUnitRequest = request('release certify');
    const originalUnit = required(
      wrongUnitRequest.candidate_locator.release_units[0],
      'missing release unit',
    );
    await expect(
      createReleaseCertificationProvider(wrongUnit.input)({
        ...wrongUnitRequest,
        candidate_locator: {
          ...wrongUnitRequest.candidate_locator,
          release_units: [{ ...originalUnit, release_unit: '@foreign/unit' }],
        },
      }),
    ).resolves.toMatchObject({ outcome: 'failure', code: 'release-task-policy-identity-mismatch' });
    expect(wrongUnit.certify).not.toHaveBeenCalled();

    const wrongDigest = certificationProviderBoundaryInput();
    const secondUnit = { ...originalUnit, release_unit: '@foreign/unit' };
    const policyInput = {
      ...wrongDigest.input,
      task_policies: [
        wrongDigest.input.task_policies[0],
        {
          release_unit: '@foreign/unit',
          task_policy_digest_sha256: '0'.repeat(64),
          document: { nodes: ['foreign'] },
        },
      ],
    } as Parameters<typeof createReleaseCertificationProvider>[0];
    await expect(
      createReleaseCertificationProvider(policyInput)({
        ...wrongUnitRequest,
        candidate_locator: {
          ...wrongUnitRequest.candidate_locator,
          release_units: [originalUnit, secondUnit],
        },
      }),
    ).resolves.toMatchObject({ outcome: 'failure', code: 'release-task-policy-identity-mismatch' });
    expect(wrongDigest.certify).not.toHaveBeenCalled();
  });

  it('preserves protected provider refusals and rejects incomplete success dispositions', async () => {
    for (const result of [
      { outcome: 'failure' as const, code: 'release-provider-refused' },
      { outcome: 'unknown' as const, provider_handle: 'provider-run-1' },
    ]) {
      const boundary = certificationProviderBoundaryInput(vi.fn(() => result));
      await expect(
        createReleaseCertificationProvider(boundary.input)(request('release certify')),
      ).resolves.toEqual(result);
    }

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      for (const result of [
        { outcome: 'success' as const },
        {
          outcome: 'success' as const,
          material: materialFor('release certify'),
          transaction: {
            commit: vi.fn(),
            rollback: vi.fn(),
            dispose: vi.fn(),
          },
        },
      ]) {
        stderr.mockClear();
        const boundary = certificationProviderBoundaryInput(vi.fn(() => result));
        await expect(
          createReleaseCertificationProvider(boundary.input)(request('release certify')),
        ).resolves.toMatchObject({
          outcome: 'failure',
          code: 'release-certification-generated-output-untrusted',
        });
        expect(boundary.certify).toHaveBeenCalledOnce();
        expect(stderr.mock.calls[0]?.[0]).toContain(
          'Error: release-certification-generated-output-untrusted',
        );
      }
    } finally {
      stderr.mockRestore();
    }
  });

  it('keeps diagnostic details off-ledger while preserving only exact closed refusal codes', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      for (const [message, expectedCode] of [
        ['release-valid-code', 'release-valid-code'],
        ['rpl-valid-code', 'rpl-valid-code'],
        ['prefix-release-valid-code', 'release-certification-generated-output-untrusted'],
        ['release-valid-code-suffix!', 'release-certification-generated-output-untrusted'],
      ] as const) {
        stderr.mockClear();
        const error = new Error(message);
        error.stack = undefined;
        const boundary = certificationProviderBoundaryInput(
          vi.fn(() => {
            throw error;
          }),
        );

        await expect(
          createReleaseCertificationProvider(boundary.input)(request('release certify')),
        ).resolves.toEqual({ outcome: 'failure', code: expectedCode });
        expect(stderr).toHaveBeenCalledOnce();
        expect(stderr.mock.calls[0]?.[0]).toBe(`release certify: cause: ${message}\n`);
      }
    } finally {
      stderr.mockRestore();
    }
  });

  it('rejects one mismatched package policy among otherwise matching release units', async () => {
    const good = materialFor('release certify');
    const unit = required(good.release_units[0], 'missing certified release unit');
    const pkg = required(unit.packages[0], 'missing certified package');
    const certification = required(pkg.certification_manifest, 'missing certification manifest');
    const materialWithWrongPolicy: ReleaseStateMaterial = {
      ...good,
      release_units: [
        {
          ...unit,
          packages: [
            pkg,
            {
              ...pkg,
              package_id: '@foreign/package',
              certification_manifest: {
                ...certification,
                package_id: '@foreign/package',
                task_policy_digest_sha256: '0'.repeat(64),
              },
            },
          ],
        },
      ],
    };
    const boundary = certificationProviderBoundaryInput(
      vi.fn(() => ({ outcome: 'success' as const, material: materialWithWrongPolicy })),
    );

    await expect(
      createReleaseCertificationProvider(boundary.input)(request('release certify')),
    ).resolves.toMatchObject({ outcome: 'failure', code: 'release-task-policy-identity-mismatch' });
    expect(boundary.certify).toHaveBeenCalledOnce();
  });

  it('requires both a live provider context value and its exact object identity', () => {
    const value = request('release prepare');
    expect(() => assertReleaseProviderInvocationContext(value, null)).toThrow(
      'release-provider-invocation-unbound',
    );
    expect(() => assertReleaseProviderInvocationContext(value, 'context')).toThrow(
      'release-provider-invocation-unbound',
    );
    expect(() => assertReleaseProviderInvocationContext(value, {})).toThrow(
      'release-provider-invocation-unbound',
    );
  });

  it('keeps a genuinely mutation-free certification compatible with its resolved plan', async () => {
    const result = await providerFor('release certify')(request('release certify'));

    expect(result).toMatchObject({ outcome: 'success' });
    expect(result.material?.release_units[0]?.mutation_evidence).toBeUndefined();
  });

  it('retains and semantically verifies the exact composed ten-package unit mutation closure', async () => {
    const input = await requiredMutationCertificationFixture();
    const { provider, certify } = requiredMutationProvider(input);

    const result = await provider(input.request);

    expect(result).toMatchObject({ outcome: 'success' });
    expect(certify).toHaveBeenCalledOnce();
    expect(result.material?.release_units[0]?.mutation_evidence).toEqual(input.evidence.closure);
    expect(input.evidence.closure.members).toHaveLength(22);
    expect(input.evidence.read).toHaveBeenCalledTimes(23);
  });

  it('refuses required mutation material without each trusted unit evidence prerequisite', async () => {
    const input = await requiredMutationCertificationFixture();
    const missingRequirements = [
      { omit_unit_readers: true },
      { omit_unit_reader: 'closure' as const },
      { omit_unit_reader: 'receipt' as const },
      { omit_unit_reader: 'blob' as const },
      { omit_unit_maximum: true },
      { unit_maximum_bytes: 0 },
      { unit_maximum_bytes: 1.5 },
    ];

    for (const options of missingRequirements) {
      const { provider, certify } = requiredMutationProvider(input, undefined, options);

      await expect(provider(input.request)).resolves.toMatchObject({
        outcome: 'failure',
        code: 'release-certification-generated-output-untrusted',
      });
      expect(certify).not.toHaveBeenCalled();
    }
  });

  it('accepts one byte as the minimum trusted unit evidence limit', async () => {
    const input = await requiredMutationCertificationFixture();
    const { provider, certify } = requiredMutationProvider(input, undefined, {
      unit_maximum_bytes: 1,
    });

    await expect(provider(input.request)).resolves.toMatchObject({
      outcome: 'failure',
      code: 'release-certification-generated-output-untrusted',
    });
    expect(certify).toHaveBeenCalledOnce();
  });

  it('requires mutation readers when any unit in a mixed certification is bound', async () => {
    const fixture = createLifecyclePolicyResolutionSetFixture({
      mutation_roster: DEVAI_ADOPTION.release_verification.mutation_roster,
      profile_overrides: DEVAI_ADOPTION.release_verification,
      changed_packages: [['@aarusso-nyx/devai'], []],
      change_kinds: ['behavioral', 'documentation'],
    });
    const packageBytes = fixture.candidate.read('package.json');
    const packageDigest = createHash('sha256').update(packageBytes).digest('hex');
    const releaseUnits = fixture.receipts.map((receipt) => {
      const candidate = receipt['candidate'] as Readonly<Record<string, unknown>>;
      return {
        release_unit: String(candidate['release_unit']),
        version: String(candidate['version']),
        package_roster: [
          {
            package_id: String(candidate['release_unit']),
            manifest_path: 'package.json',
            manifest_digest_sha256: packageDigest,
          },
        ],
      };
    });
    const value: ReleaseLifecycleRequest = {
      schemaVersion: '1.0.0',
      request_kind: 'release-lifecycle-request',
      action_id: 'release certify',
      repository_locator: fixture.candidate.repository,
      candidate_locator: {
        commit: fixture.candidate.repository.commit,
        tree: fixture.candidate.repository.tree,
        release_units: releaseUnits,
      },
      receipt_locators: fixture.receipts
        .map(receiptLocator)
        .sort((left, right) => left.receipt_id.localeCompare(right.receipt_id, 'en')),
    };
    const requirements = resolveReleaseMutationRequirements(value, {
      resolve_receipt: (locator) =>
        required(
          fixture.receipts.find(
            (receipt) => receipt['receipt_digest_sha256'] === locator.receipt_digest_sha256,
          ),
          'missing mixed-unit receipt',
        ),
      resolve_plan_input: fixture.resolve_plan_input,
    });
    expect(requirements.map((requirement) => requirement.binding === null)).toEqual([false, true]);

    const duplicate = buildResolvedReleasePlanReceipt({
      intent: {
        ...required(fixture.intents[0], 'missing first mixed-unit intent'),
        changed_paths: ['packages/cli/src/services/release-lifecycle.ts'],
      },
      resolution: required(fixture.resolutions[0], 'missing first mixed-unit resolution'),
    });
    const duplicatePlans = [required(fixture.receipts[0], 'missing first plan'), duplicate];
    expect(() =>
      resolveReleaseMutationRequirements(
        {
          ...value,
          receipt_locators: duplicatePlans
            .map(receiptLocator)
            .sort((left, right) => left.receipt_id.localeCompare(right.receipt_id, 'en')),
        },
        {
          resolve_receipt: (locator) =>
            required(
              duplicatePlans.find(
                (receipt) => receipt['receipt_digest_sha256'] === locator.receipt_digest_sha256,
              ),
              'missing duplicate plan receipt',
            ),
          resolve_plan_input: fixture.resolve_plan_input,
        },
      ),
    ).toThrow('release-receipt-identity-mismatch');

    const certify = vi.fn();
    const provider = createReleaseCertificationProvider({
      provider: { kind: 'protected-certification-provider-v3', certify },
      evidence_sink: {
        kind: 'certification-evidence-sink-v3',
        protocol: 'two-phase-content-addressed',
        begin: () => undefined as never,
        readCertificationEvidenceReceipt: () => {
          throw new Error('no generated output');
        },
        readCertificationOutputClosure: (binding) => ({ ...binding, outputs: [] }),
        readGeneratedBlob: () => {
          throw new Error('no generated output');
        },
      },
      content_source: {
        readGitObject: () => {
          throw new Error('must fail before content reads');
        },
        readGitBlob: () => {
          throw new Error('must fail before content reads');
        },
      },
      task_policies: releaseUnits.map((unit) => ({
        release_unit: unit.release_unit,
        task_policy_digest_sha256: TASK_POLICY_DIGEST,
        document: CERTIFICATION_TASK_POLICY,
      })),
      resolve_receipt: (locator) =>
        required(
          fixture.receipts.find(
            (receipt) => receipt['receipt_digest_sha256'] === locator.receipt_digest_sha256,
          ),
          'missing mixed-unit receipt',
        ),
      resolve_plan_input: fixture.resolve_plan_input,
    });

    await expect(provider(value)).resolves.toMatchObject({
      outcome: 'failure',
      code: 'release-certification-generated-output-untrusted',
    });
    expect(certify).not.toHaveBeenCalled();
  });

  it('derives exact immutable mutation requirements from genuine required and optional plans', () => {
    const requiredRequest = requiredMutationRequest();
    const profile = REQUIRED_POLICY_FIXTURE.resolution.readInput('release-verification-profile');
    const policy = REQUIRED_POLICY_FIXTURE.resolution.tools.readJson(
      'dist/law/policy/mutation-evidence-v2.json',
    );
    const required = resolveReleaseMutationRequirements(requiredRequest, {
      resolve_receipt: () => REQUIRED_POLICY_FIXTURE.receipt,
      resolve_plan_input: REQUIRED_POLICY_FIXTURE.resolve_plan_input,
    });
    expect(required).toEqual([
      {
        release_unit: '@aarusso-nyx/devai',
        binding: {
          repository_id: requiredRequest.repository_locator.id,
          candidate_commit: requiredRequest.candidate_locator.commit,
          candidate_tree: requiredRequest.candidate_locator.tree,
          release_unit: '@aarusso-nyx/devai',
          release_plan_receipt_digest_sha256: REQUIRED_POLICY_FIXTURE.receipt.receipt_digest_sha256,
          release_profile_digest_sha256: canonicalSha256(profile),
          mutation_policy_digest_sha256: canonicalSha256(policy),
        },
      },
    ]);
    expect(Object.isFrozen(required)).toBe(true);
    expect(Object.isFrozen(required[0])).toBe(true);
    expect(Object.isFrozen(required[0]?.binding)).toBe(true);

    const optionalRequest = request('release preflight');
    expect(
      resolveReleaseMutationRequirements(optionalRequest, {
        resolve_receipt: () => POLICY_FIXTURE.receipt,
        resolve_plan_input: POLICY_FIXTURE.resolve_plan_input,
      }),
    ).toEqual([{ release_unit: '@aarusso-nyx/devai', binding: null }]);
  });

  it('requires every unit mutation reader and a positive safe byte limit independently', async () => {
    const input = await requiredMutationCertificationFixture();
    const validSink = requiredMutationEvidenceSink(input.evidence);
    const invalidSinks = [
      { ...validSink, readUnitMutationEvidenceClosure: undefined },
      { ...validSink, readUnitMutationEvidenceReceipt: undefined },
      { ...validSink, readUnitMutationEvidenceBlob: undefined },
      { ...validSink, unit_mutation_maximum_bytes: undefined },
      { ...validSink, unit_mutation_maximum_bytes: 0 },
      { ...validSink, unit_mutation_maximum_bytes: 1.5 },
    ];

    for (const evidenceSink of invalidSinks) {
      const certify = vi.fn(() => ({ outcome: 'success' as const, material: input.material }));
      const provider = createReleaseCertificationProvider({
        provider: { kind: 'protected-certification-provider-v3', certify },
        evidence_sink: evidenceSink as Parameters<
          typeof createReleaseCertificationProvider
        >[0]['evidence_sink'],
        content_source: input.content_source,
        task_policies: [
          {
            release_unit: '@aarusso-nyx/devai',
            task_policy_digest_sha256: TASK_POLICY_DIGEST,
            document: CERTIFICATION_TASK_POLICY,
          },
        ],
        resolve_receipt: () => input.fixture.receipt,
        resolve_plan_input: input.fixture.resolve_plan_input,
      });

      await expect(provider(input.request)).resolves.toMatchObject({
        outcome: 'failure',
        code: 'release-certification-generated-output-untrusted',
      });
      expect(certify).not.toHaveBeenCalled();
    }
  });

  it('refuses missing, corrupted, or wrong-bound required unit mutation evidence', async () => {
    const input = await requiredMutationCertificationFixture();
    const missing: ReleaseStateMaterial = {
      ...input.material,
      release_units: input.material.release_units.map((unit) => ({
        ...unit,
        mutation_evidence: null,
      })),
    };
    const missingCertify = vi.fn(() => ({ outcome: 'success' as const, material: missing }));
    const missingProvider = requiredMutationProvider(input, missingCertify).provider;
    await expect(missingProvider(input.request)).resolves.toMatchObject({
      outcome: 'failure',
      code: 'release-certification-generated-output-untrusted',
    });
    expect(missingCertify).toHaveBeenCalledOnce();

    const corrupt = requiredMutationProvider(input, undefined, {
      read_blob: (identity) => {
        const bytes = input.evidence.read(identity);
        return identity.path === input.evidence.closure.output_contract.path
          ? Buffer.from(`${bytes.toString('utf8')} `)
          : bytes;
      },
    });
    await expect(corrupt.provider(input.request)).resolves.toMatchObject({
      outcome: 'failure',
      code: 'release-certification-generated-output-untrusted',
    });
    expect(corrupt.certify).toHaveBeenCalledOnce();

    const wrong = await unitMutationEvidenceFixture({
      binding: { ...input.evidence.binding, release_unit: '@foreign/release' },
      packages: DEVAI_ADOPTION.release_verification.mutation_roster.map((entry) => ({
        packageName: entry.package,
        workspace: entry.manifest_path.replace(/\/package\.json$/u, ''),
      })),
    });
    const wrongBound = requiredMutationProvider(input, undefined, { closure: wrong.closure });
    await expect(wrongBound.provider(input.request)).resolves.toMatchObject({
      outcome: 'failure',
      code: 'release-certification-generated-output-untrusted',
    });
    expect(wrongBound.certify).toHaveBeenCalledOnce();
  });

  it('refuses missing or stale required plans before protected certification runs', async () => {
    const input = await requiredMutationCertificationFixture();
    const missing = requiredMutationProvider(input, undefined, {}, {});
    await expect(missing.provider(input.request)).resolves.toMatchObject({
      outcome: 'failure',
      code: 'release-receipt-provider-unavailable',
    });
    expect(missing.certify).not.toHaveBeenCalled();

    const stale = requiredMutationProvider(
      input,
      undefined,
      {},
      {
        resolve_receipt: () => POLICY_FIXTURE.receipt,
        resolve_plan_input: input.fixture.resolve_plan_input,
      },
    );
    await expect(stale.provider(input.request)).resolves.toMatchObject({
      outcome: 'failure',
      code: 'rpl-semantic-verification-not-performed',
    });
    expect(stale.certify).not.toHaveBeenCalled();
  });

  it('binds resolved plan documents to every locator field and the exact repository', () => {
    const exact = request('release preflight');
    const locator = required(exact.receipt_locators?.[0], 'missing exact plan locator');
    const unit = required(exact.candidate_locator.release_units[0], 'missing exact release unit');
    const resolve = (value: ReleaseLifecycleRequest) =>
      resolveReleaseMutationRequirements(value, {
        resolve_receipt: () => planReceipt(),
        resolve_plan_input: resolvePlanInput,
      });
    const reject = (value: ReleaseLifecycleRequest) =>
      expect(() => resolve(value)).toThrow('release-receipt-identity-mismatch');

    expect(resolve(exact)).toHaveLength(1);
    expect(() => resolveReleaseMutationRequirements(exact, {})).toThrow(
      'release-receipt-provider-unavailable',
    );

    for (const receiptLocator of [
      { ...locator, kind: 'release-offline-verification-receipt' as const },
      { ...locator, receipt_id: `RPL-${'f'.repeat(16)}` },
      { ...locator, receipt_digest_sha256: 'f'.repeat(64) },
    ]) {
      reject({ ...exact, receipt_locators: [receiptLocator] });
    }
    reject({
      ...exact,
      repository_locator: { ...exact.repository_locator, id: 'foreign/repository' },
    });
    for (const releaseUnit of [
      { ...unit, release_unit: '@foreign/release' },
      { ...unit, version: '1.5.1' },
    ]) {
      reject({
        ...exact,
        candidate_locator: { ...exact.candidate_locator, release_units: [releaseUnit] },
      });
    }
  });

  it("verifies a resolved plan receipt's own digest and derived identifier before locator binding", () => {
    const exact = request('release preflight');
    const receipt = planReceipt();
    for (const resolved of [
      { ...receipt, receipt_digest_sha256: 'f'.repeat(64) },
      { ...receipt, receipt_id: `RPL-${'f'.repeat(16)}` },
    ]) {
      const value = { ...exact, receipt_locators: [receiptLocator(resolved)] };
      expect(
        () =>
          resolveReleaseMutationRequirements(value, {
            resolve_receipt: () => resolved,
            resolve_plan_input: resolvePlanInput,
          }),
        JSON.stringify(receiptLocator(resolved)),
      ).toThrow('release-receipt-identity-mismatch');
    }
  });

  it('keeps current plan schema failures distinct from historical plan receipts', () => {
    const invalid = rehashReceipt(planReceipt(), { schemaVersion: '3.0.0' });
    const value = {
      ...request('release preflight'),
      receipt_locators: [receiptLocator(invalid)],
    } as ReleaseLifecycleRequest;
    expect(() =>
      resolveReleaseMutationRequirements(value, {
        resolve_receipt: () => invalid,
        resolve_plan_input: resolvePlanInput,
      }),
    ).toThrow('release-receipt-identity-mismatch');
  });

  it('checks historical plan population before reporting it as non-authoritative', async () => {
    const planSchema = JSON.parse(
      readFileSync(join(process.cwd(), 'law/schemas/release-plan-receipt.schema.json'), 'utf8'),
    ) as { examples: readonly Readonly<Record<string, unknown>>[] };
    const stateSchema = JSON.parse(
      readFileSync(join(process.cwd(), 'law/schemas/release-lifecycle-state.schema.json'), 'utf8'),
    ) as { examples: readonly Readonly<Record<string, unknown>>[] };
    const historical = required(planSchema.examples[0], 'missing historical plan fixture');
    const exactState = required(stateSchema.examples[0], 'missing historical state fixture');
    const { state_id: _stateId, record_digest_sha256: _recordDigest, ...stateDraft } = exactState;
    const requiredPlans = exactState['bound_receipts'];
    if (!Array.isArray(requiredPlans)) throw new Error('missing historical plan bindings');
    const requiredPlan = objectValue(required(requiredPlans[0], 'missing historical plan binding'));
    const historicalInputs = historical['inputs'];
    if (!Array.isArray(historicalInputs)) throw new Error('missing historical plan inputs');
    const alternate = rehashReceipt(historical, {
      inputs: historicalInputs.map((input, index) =>
        index === 0 ? { ...objectValue(input), sha256: 'e'.repeat(64) } : input,
      ),
    });
    const observe = (
      state: Readonly<Record<string, unknown>>,
      receipts: readonly Readonly<Record<string, unknown>>[] = [historical],
    ) =>
      resumeReleaseLifecycleExecution({
        states: [state],
        repository: state['repository'] as ReleaseLifecycleRequest['repository_locator'],
        candidate: state['candidate'] as ReleaseLifecycleStateV2['candidate'],
        receipt_documents: receipts,
      });

    await expect(observe(exactState)).resolves.toMatchObject({
      next_outcome: 'blocked',
      blocked_reason: 'legacy-plan-non-authoritative',
    });

    const mismatched = finalizeReleaseStateV2({
      ...stateDraft,
      bound_receipts: [{ ...requiredPlan, receipt_digest_sha256: 'f'.repeat(64) }],
    } as Parameters<typeof finalizeReleaseStateV2>[0]);
    await expect(observe(mismatched)).resolves.toMatchObject({
      next_outcome: 'blocked',
      blocked_reason: 'receipt-identity-mismatch',
    });

    await expect(observe(exactState, [historical, alternate])).resolves.toMatchObject({
      next_outcome: 'blocked',
      blocked_reason: 'legacy-plan-non-authoritative',
    });
  });

  it('dispatches offline v1 receipts through their schema parser before lifecycle controls', async () => {
    const initial = request('release evidence-publish');
    const unit = required(initial.candidate_locator.release_units[0], 'missing release unit');
    const bound = rehashReceipt(offlineReceipt(), {
      repository: initial.repository_locator,
      candidate: {
        release_unit: unit.release_unit,
        version: unit.version,
        commit: initial.candidate_locator.commit,
        tree: initial.candidate_locator.tree,
      },
    });
    const value = request('release evidence-publish', bound);
    const common = {
      request: value,
      action: 'release evidence-publish' as const,
      authority: authorityFor('release evidence-publish'),
      store: new ReleaseLifecycleFileStore(root(), value),
      resolvePlanInput,
      authorization: authorizationBridge(),
      recorded_at: '2026-09-03T00:00:00.000Z',
    };
    await expect(
      executeReleaseLifecycleAction({ ...common, resolveReceipt: () => bound }),
    ).resolves.toMatchObject({
      ok: false,
      phase: 'validation',
      code: 'release-offline-verifier-provider-unavailable',
    });

    const { checks: _checks, ...withoutChecks } = bound;
    const malformed = rehashReceipt(withoutChecks, {});
    const malformedRequest = request('release evidence-publish', malformed);
    await expect(
      executeReleaseLifecycleAction({
        ...common,
        request: malformedRequest,
        store: new ReleaseLifecycleFileStore(root(), malformedRequest),
        resolveReceipt: () => malformed,
      }),
    ).resolves.toMatchObject({
      ok: false,
      phase: 'validation',
      code: 'release-receipt-identity-mismatch',
    });
  });

  it('binds a provider only to its durable attempt and immutable verified parent', async () => {
    const value = request('release prepare');
    const store = new ReleaseLifecycleFileStore(root(), value);
    await seedCertified(store);
    const parent = required(store.readStateRecords().at(-1), 'missing certified parent');
    const preparedMaterial = materialFor('release prepare');
    let escaped: unknown;
    const provider = vi.fn((providerRequest, context) => {
      const bound = assertReleaseProviderInvocationContext(providerRequest, context);
      const attempt = required(store.readStoreRecords().at(-1), 'missing durable provider attempt');

      expect(providerRequest).not.toBe(value);
      expect(bound.request_digest_sha256).toBe(computeReleaseRequestDigest(value));
      expect(bound.action_id).toBe('release prepare');
      expect(bound.attempt_id).toBe(attempt.attempt_id);
      expect(bound.attempt_record).toEqual({
        sequence: attempt.sequence,
        record_id: attempt.record_id,
        record_digest_sha256: attempt.record_digest_sha256,
      });
      expect(bound.prior_state).toEqual(parent);
      expect(bound.prior_state).not.toBe(parent);
      expect(Object.isFrozen(bound)).toBe(true);
      expect(Object.isFrozen(bound.attempt_record)).toBe(true);
      expect(Object.isFrozen(bound.prior_state)).toBe(true);
      expect(Object.isFrozen(bound.prior_state?.repository)).toBe(true);
      expect(Reflect.set(bound.attempt_record, 'sequence', 999)).toBe(false);
      if (bound.prior_state === null) throw new Error('fixture provider parent missing');
      expect(Reflect.set(bound.prior_state.repository, 'id', 'mutated/repository')).toBe(false);
      expect(parent.repository.id).toBe('aarusso-nyx/devai');
      expect(() => assertReleaseProviderInvocationContext(value, bound)).toThrow(
        'release-provider-invocation-unbound',
      );
      expect(() => assertReleaseProviderInvocationContext(providerRequest, { ...bound })).toThrow(
        'release-provider-invocation-unbound',
      );
      escaped = bound;
      return { outcome: 'success' as const, material: preparedMaterial };
    });

    const result = await withReleasePrepareAuthorityFixture(value, () =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release prepare',
        authority: authorityFor('release prepare'),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );

    expect(result).toMatchObject({ ok: true });
    expect(provider).toHaveBeenCalledOnce();
    expect(() => assertReleaseProviderInvocationContext(value, escaped)).toThrow(
      'release-provider-invocation-unbound',
    );
  });

  it('never mints provider context if durable attempt append fails', async () => {
    const value = request('release prepare');
    const store = new ReleaseLifecycleFileStore(root(), value);
    await seedCertified(store);
    const provider = vi.fn(() => ({
      outcome: 'success' as const,
      material: materialFor('release prepare'),
    }));
    vi.spyOn(store, 'appendStoreRecord').mockImplementationOnce(() => {
      throw new Error('fixture-attempt-append-failed');
    });

    const result = await withReleasePrepareAuthorityFixture(value, () =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release prepare',
        authority: authorityFor('release prepare'),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      phase: 'append',
      code: 'fixture-attempt-append-failed',
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it.each(['success', 'unknown'] as const)(
    'retains a local export transaction handle for %s without remote authorization',
    async (outcome) => {
      const value = request('release export');
      const store = new ReleaseLifecycleFileStore(root(), value);
      await advanceToPrepared(store);
      const base = providerFor('release export');
      const provider = vi.fn(async (...args: Parameters<ReleaseProvider>) =>
        outcome === 'unknown'
          ? {
              outcome: 'unknown' as const,
              dispatch_status: 'unknown' as const,
              provider_handle: 'local-export-transaction',
              code: 'release-provider-result-unknown',
            }
          : {
              ...(await base(...args)),
              dispatch_status: 'dispatched' as const,
              provider_handle: 'local-export-transaction',
            },
      );
      const invoke = () =>
        withReleaseExportAuthorityFixture(value, () =>
          executeReleaseLifecycleAction({
            request: value,
            action: 'release export',
            authority: authorityFor('release export'),
            store,
            resolveReceipt: () => planReceipt(),
            resolvePlanInput,
            provider,
            artifactReader: artifactReaderFor('release prepare'),
            recorded_at: '2026-09-03T00:00:00.000Z',
          }),
        );
      const result = await invoke();
      expect(result.ok).toBe(outcome === 'success');
      const record = store.readStoreRecords().at(-1);
      expect(record).toMatchObject({
        record_kind: outcome === 'success' ? 'completion' : 'unknown-provider-result',
        authorization_event_id: null,
        provider_handle: 'local-export-transaction',
        provider_dispatch: {
          status: outcome === 'success' ? 'dispatched' : 'unknown',
          handle_observed: true,
        },
      });
      for (const invalid of [
        { ...record, authorization_event_id: 'EA-0123456789abcdef' },
        { ...record, action_id: 'release prepare' },
        { ...record, action_id: 'release evidence-publish' },
        { ...record, provider_dispatch: { status: 'not-dispatched', handle_observed: true } },
      ])
        expect(() => verifyStoreRecordIdentity(invalid)).toThrow(
          'release-state-store-record-invalid',
        );
      if (outcome === 'unknown') {
        expect(record?.unknown).toMatchObject({ redispatch_permitted: false });
        const unknown = required(record, 'missing unknown export record');
        const {
          record_id: _recordId,
          record_digest_sha256: _recordDigest,
          ...unknownDraft
        } = unknown;
        const impossibleTail = finalizeStoreRecord({
          ...unknownDraft,
          sequence: unknown.sequence + 1,
          predecessor_record: {
            sequence: unknown.sequence,
            record_id: unknown.record_id,
            record_digest_sha256: unknown.record_digest_sha256,
          },
        });
        expect(reduceStoreRecords([...store.readStoreRecords(), impossibleTail]).errors).toContain(
          'release-provider-result-unknown',
        );
        const records = store.readStoreRecords();
        const exportAttempt = required(records.at(-2), 'missing export attempt');
        expect(exportAttempt.record_kind).toBe('attempt');
        const {
          record_id: _attemptRecordId,
          record_digest_sha256: _attemptRecordDigest,
          ...attemptDraft
        } = exportAttempt;
        const retrySequence = unknown.sequence + 1;
        const retryPredecessor = {
          sequence: unknown.sequence,
          record_id: unknown.record_id,
          record_digest_sha256: unknown.record_digest_sha256,
        };
        const retryAttempt = finalizeStoreRecord({
          ...attemptDraft,
          sequence: retrySequence,
          predecessor_record: retryPredecessor,
          attempt_id: `RLA-${canonicalSha256({
            request_digest_sha256: exportAttempt.request_digest_sha256,
            action_id: exportAttempt.action_id,
            sequence: retrySequence,
            predecessor_record: retryPredecessor,
          }).slice(0, 16)}`,
        });
        expect(reduceStoreRecords([...records, retryAttempt]).errors).toContain(
          'release-store-attempt-predecessor-invalid',
        );
        expect(await invoke()).toMatchObject({
          ok: false,
          phase: 'reconciliation',
          code: 'release-provider-result-unknown',
        });
        expect(provider).toHaveBeenCalledOnce();
      }
    },
  );

  it('treats an export provider exception or post-sign material defect as unknown without cleanup or redispatch', async () => {
    for (const kind of [
      'throw',
      'missing-material',
      'invalid-material',
      'missing-trust',
    ] as const) {
      const value = request('release export');
      const store = new ReleaseLifecycleFileStore(root(), value);
      await advanceToPrepared(store);
      const rollback = vi.fn();
      const dispose = vi.fn();
      const provider = vi.fn(() => {
        if (kind === 'throw') throw new Error('fixture signer result lost');
        if (kind === 'missing-material')
          return {
            outcome: 'success' as const,
            transaction: { commit: vi.fn(), rollback, dispose },
          };
        const material = materialFor('release export');
        const unit = required(material.release_units[0], 'missing exported release unit');
        const pkg = required(unit.packages[0], 'missing exported package');
        return {
          outcome: 'success' as const,
          material:
            kind === 'missing-trust'
              ? {
                  ...material,
                  release_units: [{ ...unit, packages: [{ ...pkg, trust: null }] }],
                }
              : { ...material, release_units: [] },
          transaction: { commit: vi.fn(), rollback, dispose },
        };
      });

      const first = await withReleaseExportAuthorityFixture(value, () =>
        executeReleaseLifecycleAction({
          request: value,
          action: 'release export',
          authority: authorityFor('release export'),
          store,
          resolveReceipt: () => planReceipt(),
          resolvePlanInput,
          provider,
          artifactReader: artifactReaderFor('release prepare'),
          recorded_at: '2026-09-03T00:00:00.000Z',
        }),
      );

      expect(first).toMatchObject({
        ok: false,
        phase: 'ambiguous',
        code: 'release-provider-result-unknown',
      });
      expect(rollback).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
      expect(store.readStateRecords().at(-1)?.state).toBe('prepared');
      expect(
        store
          .readStoreRecords()
          .slice(-2)
          .map((record) => record.record_kind),
      ).toEqual(['attempt', 'unknown-provider-result']);

      const retry = await withReleaseExportAuthorityFixture(value, () =>
        executeReleaseLifecycleAction({
          request: value,
          action: 'release export',
          authority: authorityFor('release export'),
          store,
          resolveReceipt: () => planReceipt(),
          resolvePlanInput,
          provider,
          artifactReader: artifactReaderFor('release prepare'),
          recorded_at: '2026-09-03T00:00:01.000Z',
        }),
      );
      expect(retry).toMatchObject({
        ok: false,
        phase: 'reconciliation',
        code: 'release-provider-result-unknown',
      });
      expect(provider).toHaveBeenCalledOnce();
    }
  });

  it.each(['release_units', 'inputs', 'evidence', 'artifacts', 'artifact_sink'] as const)(
    'refuses evidence publication when provider material changes prior %s',
    async (field) => {
      const initial = request('release evidence-publish');
      const store = new ReleaseLifecycleFileStore(root(), initial);
      await advanceToExported(store);
      const prior = required(store.readStateRecords().at(-1), 'missing exported state');
      const receipt = boundOfflineReceipt(prior);
      const value = request('release evidence-publish', receipt);
      const unit = required(prior.release_units[0], 'missing exported release unit');
      const pkg = required(unit.packages[0], 'missing exported package');
      const trust = required(pkg.trust, 'missing exported package trust');
      const input = required(prior['inputs'][0], 'missing exported input');
      const artifact = required(prior['artifacts'][0], 'missing exported artifact');
      const sink = required(prior.artifact_sink, 'missing exported artifact sink');
      const exact: ReleaseStateMaterial = {
        release_units: prior.release_units,
        inputs: prior['inputs'],
        evidence: prior['evidence'],
        artifacts: prior['artifacts'],
        artifact_sink: sink,
      };
      const changed: ReleaseStateMaterial = {
        ...exact,
        ...(field === 'release_units'
          ? {
              release_units: [
                {
                  ...unit,
                  packages: [
                    { ...pkg, trust: { ...trust, trust_store_digest_sha256: 'f'.repeat(64) } },
                  ],
                },
              ],
            }
          : {}),
        ...(field === 'inputs'
          ? { inputs: [{ ...input, sha256: 'f'.repeat(64) }, ...prior['inputs'].slice(1)] }
          : {}),
        ...(field === 'evidence'
          ? { evidence: { ...prior['evidence'], manifest_digest_sha256: 'f'.repeat(64) } }
          : {}),
        ...(field === 'artifacts'
          ? { artifacts: [{ ...artifact, sha256: 'f'.repeat(64) }, ...prior['artifacts'].slice(1)] }
          : {}),
        ...(field === 'artifact_sink'
          ? { artifact_sink: { ...sink, transaction_handle: 'changed-transaction' } }
          : {}),
      };
      const provider = vi.fn(() => ({
        outcome: 'success' as const,
        provider_handle: 'evidence-publish-run-1',
        material: changed,
      }));

      const result = await withAuthorityHostTestScope(() =>
        executeReleaseLifecycleAction({
          request: value,
          action: 'release evidence-publish',
          authority: authorityFor('release evidence-publish'),
          store,
          resolveReceipt: () => receipt,
          resolvePlanInput,
          offlineReceiptVerifier: { verify: ({ receipt: document }) => document },
          artifactReader: artifactReaderFor('release export'),
          authorization: authorizationBridge(),
          provider,
          recorded_at: '2026-09-03T00:00:00.000Z',
        }),
      );

      expect(result, field).toMatchObject({
        ok: false,
        phase: 'ambiguous',
        code: 'release-provider-result-unknown',
      });
      expect(provider).toHaveBeenCalledOnce();
      expect(store.readStateRecords().at(-1)?.state).toBe('exported');
      expect(store.readStoreRecords().at(-1)).toMatchObject({
        record_kind: 'unknown-provider-result',
        provider_dispatch: { status: 'unknown', handle_observed: true },
      });
    },
  );

  it('refuses publication when provider material changes prior inputs', async () => {
    const value = request('release publish');
    const store = new ReleaseLifecycleFileStore(root(), value);
    await advanceToEvidencePublished(store);
    const prior = required(store.readStateRecords().at(-1), 'missing evidence-published state');
    const input = required(prior['inputs'][0], 'missing evidence-published input');
    const provider = vi.fn(() => ({
      outcome: 'success' as const,
      provider_handle: 'publish-run-1',
      material: {
        release_units: prior.release_units,
        inputs: [{ ...input, sha256: 'f'.repeat(64) }, ...prior['inputs'].slice(1)],
        evidence: prior['evidence'],
        artifacts: prior['artifacts'],
        artifact_sink: prior.artifact_sink,
      } as ReleaseStateMaterial,
    }));

    const result = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release publish',
        authority: authorityFor('release publish'),
        publication_controls: publicationControls(),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        artifactReader: artifactReaderFor('release evidence-publish'),
        authorization: authorizationBridge(),
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      phase: 'ambiguous',
      code: 'release-provider-result-unknown',
    });
    expect(provider).toHaveBeenCalledOnce();
    expect(store.readStateRecords().at(-1)?.state).toBe('evidence_published');
    expect(store.readStoreRecords().at(-1)).toMatchObject({
      record_kind: 'unknown-provider-result',
      provider_dispatch: { status: 'unknown', handle_observed: true },
    });
  });

  it('captures export results only from inert, enumerable, allowlisted own data properties', async () => {
    const invoke = async (provider: ReleaseProvider) => {
      const value = request('release export');
      const store = new ReleaseLifecycleFileStore(root(), value);
      await advanceToPrepared(store);
      const result = await withReleaseExportAuthorityFixture(value, () =>
        executeReleaseLifecycleAction({
          request: value,
          action: 'release export',
          authority: authorityFor('release export'),
          store,
          resolveReceipt: () => planReceipt(),
          resolvePlanInput,
          provider,
          artifactReader: artifactReaderFor('release prepare'),
          recorded_at: '2026-09-03T00:00:00.000Z',
        }),
      );
      return { result, store };
    };
    const managedFailure = (transaction: {
      rollback: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    }) => ({
      outcome: 'failure' as const,
      dispatch_status: 'failed-before-dispatch' as const,
      code: 'release-export-before-sign-failed',
      transaction: { commit: vi.fn(), ...transaction },
    });

    const validTransaction = { rollback: vi.fn(), dispose: vi.fn() };
    const validProvider = vi.fn(() =>
      Object.assign(Object.create(null) as object, managedFailure(validTransaction)),
    ) as unknown as ReleaseProvider;
    const valid = await invoke(validProvider);
    expect(valid.result).toMatchObject({
      ok: false,
      phase: 'provider',
      code: 'release-export-before-sign-failed',
    });
    expect(validTransaction.rollback).toHaveBeenCalledOnce();
    expect(validTransaction.dispose).toHaveBeenCalledOnce();

    let accessorReads = 0;
    let proxyPrototypeReads = 0;
    const malformedResults: readonly [
      string,
      (transaction: {
        rollback: ReturnType<typeof vi.fn>;
        dispose: ReturnType<typeof vi.fn>;
      }) => unknown,
    ][] = [
      ['null', () => null],
      ['primitive', () => 'success'],
      [
        'proxy',
        (transaction) =>
          new Proxy(managedFailure(transaction), {
            getPrototypeOf: () => {
              proxyPrototypeReads += 1;
              return Object.prototype;
            },
          }),
      ],
      [
        'foreign prototype',
        (transaction) =>
          Object.assign(Object.create({ inherited: true }), managedFailure(transaction)),
      ],
      [
        'symbol key',
        (transaction) => ({ ...managedFailure(transaction), [Symbol('hidden')]: true }),
      ],
      ['unknown key', (transaction) => ({ ...managedFailure(transaction), extra: true })],
      [
        'non-enumerable property',
        (transaction) => {
          const { code: _code, ...base } = managedFailure(transaction);
          return Object.defineProperty(base, 'code', { value: 'hidden-code' });
        },
      ],
      [
        'accessor property',
        (transaction) => {
          const { code: _code, ...base } = managedFailure(transaction);
          return Object.defineProperty(base, 'code', {
            enumerable: true,
            get: () => {
              accessorReads += 1;
              return 'accessor-code';
            },
          });
        },
      ],
      [
        'missing outcome',
        (transaction) => {
          const { outcome: _outcome, ...base } = managedFailure(transaction);
          return base;
        },
      ],
      ['invalid outcome', (transaction) => ({ ...managedFailure(transaction), outcome: 'maybe' })],
    ];

    for (const [label, malformed] of malformedResults) {
      const transaction = { rollback: vi.fn(), dispose: vi.fn() };
      const provider = vi.fn(() => malformed(transaction)) as unknown as ReleaseProvider;
      const { result, store } = await invoke(provider);

      expect(result, label).toMatchObject({
        ok: false,
        phase: 'ambiguous',
        code: 'release-provider-result-unknown',
      });
      expect(provider, label).toHaveBeenCalledOnce();
      expect(transaction.rollback, label).not.toHaveBeenCalled();
      expect(transaction.dispose, label).not.toHaveBeenCalled();
      expect(store.readStateRecords().at(-1)?.state, label).toBe('prepared');
      expect(store.readStoreRecords().at(-1), label).toMatchObject({
        record_kind: 'unknown-provider-result',
        provider_dispatch: { status: 'not-dispatched', handle_observed: false },
      });
    }
    expect(accessorReads).toBe(0);
    expect(proxyPrototypeReads).toBe(1);
  });

  it('keeps an explicitly managed pre-sign export failure retryable', async () => {
    const value = request('release export');
    const store = new ReleaseLifecycleFileStore(root(), value);
    await advanceToPrepared(store);
    const rollback = vi.fn();
    const dispose = vi.fn();
    const provider = vi.fn(() => ({
      outcome: 'failure' as const,
      dispatch_status: 'failed-before-dispatch' as const,
      code: 'release-export-before-sign-failed',
      transaction: { commit: vi.fn(), rollback, dispose },
    }));

    const result = await withReleaseExportAuthorityFixture(value, () =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release export',
        authority: authorityFor('release export'),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider,
        artifactReader: artifactReaderFor('release prepare'),
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      phase: 'provider',
      code: 'release-export-before-sign-failed',
    });
    expect(rollback).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(store.readStateRecords().at(-1)?.state).toBe('prepared');
    expect(store.readStoreRecords().at(-1)?.record_kind).toBe('failure');
  });

  it('preserves an ambiguous prepare sink commit without cleanup or redispatch until external reconciliation', async () => {
    const initial = request();
    const store = new ReleaseLifecycleFileStore(root(), initial);
    await seedPreflight(store);
    const certified = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: request('release certify'),
        action: 'release certify',
        authority: authorityFor('release certify'),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider: providerFor('release certify'),
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(certified.ok).toBe(true);
    const rollback = vi.fn();
    const dispose = vi.fn();
    const provider = vi.fn(() => ({
      outcome: 'success' as const,
      material: materialFor('release prepare'),
      transaction: {
        commit: () => {
          throw new Error('lost sink response');
        },
        rollback,
        dispose,
      },
    }));
    const prepared = await withReleasePrepareAuthorityFixture(request('release prepare'), () =>
      executeReleaseLifecycleAction({
        request: request('release prepare'),
        action: 'release prepare',
        authority: authorityFor('release prepare'),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider,
        recorded_at: '2026-09-03T00:00:01.000Z',
      }),
    );
    expect(prepared).toMatchObject({
      ok: false,
      phase: 'ambiguous',
      code: 'release-artifact-sink-commit-unknown',
    });
    expect(rollback).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    const terminal = store.readStoreRecords().at(-1);
    expect(terminal).toMatchObject({
      record_kind: 'unknown-provider-result',
      provider_dispatch: { status: 'not-dispatched', handle_observed: false },
      unknown: {
        code: 'release-provider-result-unknown',
        redispatch_permitted: false,
        artifact_sink: materialFor('release prepare').artifact_sink,
        artifacts: materialFor('release prepare').artifacts,
      },
    });
    const observation = await resumeReleaseLifecycleExecution({
      states: store.readStateRecords(),
      store_records: store.readStoreRecords(),
      store_head: store.readHead(),
      repository: initial.repository_locator,
      candidate: required(store.readStateRecords().at(-1), 'missing certified state').candidate,
      candidate_locator: request('release prepare').candidate_locator,
      receipt_documents: [planReceipt()],
      resolve_plan_input: resolvePlanInput,
    });
    expect(observation).toMatchObject({
      next_action: null,
      next_outcome: 'ambiguous',
      reconciliation_requirements: ['external_sink_commit_reconciliation_required'],
    });
    const retry = await withReleasePrepareAuthorityFixture(request('release prepare'), () =>
      executeReleaseLifecycleAction({
        request: request('release prepare'),
        action: 'release prepare',
        authority: authorityFor('release prepare'),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider,
        recorded_at: '2026-09-03T00:00:02.000Z',
      }),
    );
    expect(retry).toMatchObject({
      ok: false,
      phase: 'reconciliation',
      code: 'release-provider-result-unknown',
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('rejects recursive authority injection, identity drift, and non-canonical rosters', () => {
    const valid = request();
    const unit = required(valid.candidate_locator.release_units[0], 'missing release unit');
    const planLocator = required(valid.receipt_locators?.[0], 'missing plan receipt');
    expect(validateReleaseLifecycleRequest(valid, 'release preflight')).toEqual(valid);
    expect(() => validateReleaseLifecycleRequest(valid, 'release certify')).toThrow(
      'release-request-action-mismatch',
    );
    expect(() =>
      validateReleaseLifecycleRequest({
        ...valid,
        candidate_locator: { ...valid.candidate_locator, authorization: 'invented' },
      }),
    ).toThrow('release-request-projection-invalid:authorization');
    expect(() =>
      validateReleaseLifecycleRequest({
        ...valid,
        candidate_locator: { ...valid.candidate_locator, tree: 'f'.repeat(40) },
      }),
    ).toThrow('release-request-identity-mismatch');
    expect(() =>
      validateReleaseLifecycleRequest({
        ...valid,
        repository_locator: { ...valid.repository_locator, commit: 'f'.repeat(40) },
      }),
    ).toThrow('release-request-identity-mismatch');

    const secondUnit = { ...unit, release_unit: '@z/release' };
    const thirdUnit = { ...unit, release_unit: '@zz/release' };
    const secondLocator = {
      ...planLocator,
      receipt_id: `RPL-${'f'.repeat(16)}`,
      receipt_digest_sha256: 'f'.repeat(64),
      path: 'receipts/second-plan.json',
    };
    const thirdLocator = {
      ...planLocator,
      receipt_id: `RPL-${'e'.repeat(16)}`,
      receipt_digest_sha256: 'e'.repeat(64),
      path: 'receipts/third-plan.json',
    };
    expect(() =>
      validateReleaseLifecycleRequest({
        ...valid,
        candidate_locator: {
          ...valid.candidate_locator,
          release_units: [secondUnit, unit, thirdUnit],
        },
        receipt_locators: [planLocator, secondLocator, thirdLocator].sort((left, right) =>
          left.receipt_id.localeCompare(right.receipt_id, 'en'),
        ),
      }),
    ).toThrow('release-release-unit-bijection-invalid');

    const sortedLocators = [planLocator, secondLocator, thirdLocator].sort((left, right) =>
      `${left.kind}\0${left.receipt_id}`.localeCompare(`${right.kind}\0${right.receipt_id}`, 'en'),
    );
    expect(() =>
      validateReleaseLifecycleRequest({
        ...valid,
        candidate_locator: {
          ...valid.candidate_locator,
          release_units: [unit, secondUnit, thirdUnit],
        },
        receipt_locators: [
          required(sortedLocators[1], 'missing second sorted locator'),
          required(sortedLocators[0], 'missing first sorted locator'),
          required(sortedLocators[2], 'missing third sorted locator'),
        ],
      }),
    ).toThrow('release-request-receipt-order-invalid');
    const twoPackages = {
      ...valid,
      candidate_locator: {
        ...valid.candidate_locator,
        release_units: [
          {
            ...valid.candidate_locator.release_units[0],
            package_roster: [
              {
                package_id: 'z-package',
                manifest_path: 'z/package.json',
                manifest_digest_sha256: MANIFEST_DIGEST,
              },
              ...required(
                valid.candidate_locator.release_units[0],
                'missing candidate release unit',
              ).package_roster,
            ],
          },
        ],
      },
    };
    expect(() => validateReleaseLifecycleRequest(twoPackages)).toThrow(
      'release-release-unit-bijection-invalid',
    );
  });

  it.each([
    'state_id',
    'generation',
    'digest',
    'record_digest_sha256',
    'actor',
    'role',
    'authority',
    'consent',
    'effective_authorities',
    'provider_result',
    'provider_handle',
  ] as const)('rejects protected request projection key %s at a nested boundary', (key) => {
    const valid = request('release preflight');
    expect(() =>
      validateReleaseLifecycleRequest({
        ...valid,
        candidate_locator: {
          ...valid.candidate_locator,
          release_units: valid.candidate_locator.release_units.map((unit) => ({
            ...unit,
            package_roster: unit.package_roster.map((pkg) => ({ ...pkg, [key]: 'injected' })),
          })),
        },
      }),
    ).toThrow(`release-request-projection-invalid:${key}`);
  });

  it('binds receipt kind and population to the requested lifecycle action', () => {
    const preflight = request();
    const unit = required(preflight.candidate_locator.release_units[0], 'missing release unit');
    const offline = request('release evidence-publish');
    const offlineLocator = required(offline.receipt_locators?.[0], 'missing offline receipt');
    const mixedLocators = [
      required(preflight.receipt_locators?.[0], 'missing plan receipt'),
      offlineLocator,
    ].sort((left, right) =>
      `${left.kind}\0${left.receipt_id}`.localeCompare(`${right.kind}\0${right.receipt_id}`, 'en'),
    );
    expect(() =>
      validateReleaseLifecycleRequest({
        ...preflight,
        candidate_locator: {
          ...preflight.candidate_locator,
          release_units: [unit, { ...unit, release_unit: '@aarusso-nyx/secondary' }],
        },
        receipt_locators: mixedLocators,
      }),
    ).toThrow('release-receipt-identity-mismatch');

    const secondOffline = {
      ...offlineLocator,
      receipt_id: `ROV-${'f'.repeat(16)}`,
      receipt_digest_sha256: 'f'.repeat(64),
      path: 'receipts/offline-secondary.json',
    };
    expect(() =>
      validateReleaseLifecycleRequest({
        ...offline,
        receipt_locators: [offlineLocator, secondOffline].sort((left, right) =>
          left.receipt_id.localeCompare(right.receipt_id, 'en'),
        ),
      }),
    ).toThrow('release-receipt-identity-mismatch');
    expect(() =>
      validateReleaseLifecycleRequest({
        ...offline,
        receipt_locators: [required(preflight.receipt_locators?.[0], 'missing plan receipt')],
      }),
    ).toThrow('release-receipt-identity-mismatch');
  });

  it('persists a valid v2 preflight fixture, completion, and head durably', async () => {
    const value = request();
    const store = new ReleaseLifecycleFileStore(root(), value);
    const result = await seedPreflight(store);
    expect(result.state.schemaVersion).toBe('2.0.0');
    expect(verifyReleaseStateIdentity(result.state, true).state_id).toBe(result.state.state_id);
    expect(store.readHead()).toMatchObject({
      schemaVersion: '2.0.0',
      generation: 0,
      state_id: result.state.state_id,
      state_digest_sha256: result.state.record_digest_sha256,
    });
    expect(store.readStateRecords()).toHaveLength(1);
    expect(store.readStoreRecords().map((record) => record.record_kind)).toEqual([
      'attempt',
      'completion',
    ]);
  });

  it.each(
    [
      {
        defect: 'missing committed artifact sink',
        change: (value: ReleaseStateMaterial) => ({ ...value, artifact_sink: null }),
      },
      {
        defect: 'missing release unit',
        change: (value: ReleaseStateMaterial) => ({ ...value, release_units: [] }),
      },
      {
        defect: 'certified package-manifest digest drift',
        change: (value: ReleaseStateMaterial) => {
          const unit = required(value.release_units[0], 'missing prepared unit');
          const pkg = required(unit.packages[0], 'missing prepared package');
          const certification = required(
            pkg.certification_manifest,
            'missing certification manifest',
          );
          return {
            ...value,
            release_units: [
              {
                ...unit,
                packages: [
                  {
                    ...pkg,
                    certification_manifest: {
                      ...certification,
                      entries: certification.entries.map((entry) =>
                        entry.path === 'package.json'
                          ? { ...entry, sha256: 'f'.repeat(64) }
                          : entry,
                      ),
                    },
                  },
                ],
              },
            ],
          };
        },
      },
      ...(
        [
          [
            'legacy manifest identity',
            { manifest: { path: 'package.json', sha256: MANIFEST_DIGEST } },
          ],
          [
            'legacy tarball identity',
            { tarball: { path: 'package.tgz', sha256: MANIFEST_DIGEST } },
          ],
          ['legacy SBOM identity', { sbom: { path: 'sbom.json', sha256: MANIFEST_DIGEST } }],
          [
            'wrong package-manifest kind',
            { package_manifest: opaqueArtifact('provider-result', 'package-manifest') },
          ],
          [
            'wrong package-tarball kind',
            { package_tarball: opaqueArtifact('provider-result', 'package-tarball') },
          ],
          [
            'wrong package-SBOM kind',
            { package_sbom: opaqueArtifact('provider-result', 'package-sbom') },
          ],
          ['missing package tarball', { package_tarball: null }],
          ['missing package SBOM', { package_sbom: null }],
        ] as const
      ).map(([defect, packageChange]) => ({
        defect,
        change: (value: ReleaseStateMaterial): ReleaseStateMaterial => {
          const unit = required(value.release_units[0], 'missing prepared unit');
          const pkg = required(unit.packages[0], 'missing prepared package');
          return {
            ...value,
            release_units: [{ ...unit, packages: [{ ...pkg, ...packageChange } as typeof pkg] }],
          };
        },
      })),
      {
        defect: 'duplicate top-level artifact identity',
        change: (value: ReleaseStateMaterial) => ({
          ...value,
          artifacts: [
            ...value.artifacts,
            required(value.artifacts[0], 'missing prepared artifact'),
          ],
        }),
      },
      {
        defect: 'missing top-level artifact identity',
        change: (value: ReleaseStateMaterial) => ({
          ...value,
          artifacts: value.artifacts.slice(1),
        }),
      },
      {
        defect: 'non-canonical top-level artifact order',
        change: (value: ReleaseStateMaterial) => ({
          ...value,
          artifacts: [...value.artifacts].reverse(),
        }),
      },
    ].map((entry) => ({ ...entry, action: 'release prepare' as const })),
  )(
    'refuses $action material with $defect before committing its provider transaction',
    async ({ action, change, defect }) => {
      const value = request(action);
      const store = new ReleaseLifecycleFileStore(root(), value);
      await seedCertified(store);
      const commit = vi.fn();
      const rollback = vi.fn();
      const dispose = vi.fn();
      const provider = vi.fn(() => ({
        outcome: 'success' as const,
        material: change(materialFor(action)),
        transaction: { commit, rollback, dispose },
      }));

      const result = await withReleasePrepareAuthorityFixture(value, () =>
        executeReleaseLifecycleAction({
          request: value,
          action,
          authority: authorityFor(action),
          store,
          resolveReceipt: () => planReceipt(),
          resolvePlanInput,
          provider,
          recorded_at: '2026-09-03T00:00:01.000Z',
        }),
      );

      expect(result).toMatchObject({
        ok: false,
        phase: 'validation',
        code:
          defect === 'missing committed artifact sink'
            ? 'release-artifact-sink-protocol-invalid'
            : 'release-release-unit-bijection-invalid',
      });
      expect(provider).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled();
      expect(rollback).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
      expect(store.readStateRecords().at(-1)?.state).toBe('certified');
      expect(store.readStoreRecords().at(-1)).toMatchObject({
        record_kind: 'failure',
        provider_dispatch: { status: 'not-dispatched', handle_observed: false },
      });
    },
  );

  it('commits prepared artifacts only after semantic validation and preserves a committed sink on append failure', async () => {
    const value = request('release prepare');
    const invalidStore = new ReleaseLifecycleFileStore(root(), value);
    await seedCertified(invalidStore);
    const invalidCommit = vi.fn();
    const invalidRollback = vi.fn();
    const invalidDispose = vi.fn();
    const invalid = await withReleasePrepareAuthorityFixture(value, () =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release prepare',
        authority: authorityFor('release prepare'),
        store: invalidStore,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider: () => ({
          outcome: 'success',
          material: { ...materialFor('release prepare'), release_units: [] },
          transaction: {
            commit: invalidCommit,
            rollback: invalidRollback,
            dispose: invalidDispose,
          },
        }),
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(invalid).toMatchObject({ ok: false, phase: 'validation' });
    expect(invalidCommit).not.toHaveBeenCalled();
    expect(invalidRollback).toHaveBeenCalledOnce();
    expect(invalidDispose).toHaveBeenCalledOnce();

    const failingStore = new ReleaseLifecycleFileStore(root(), value);
    await seedCertified(failingStore);
    vi.spyOn(failingStore, 'appendStateAndAdvanceHead').mockImplementation(() => {
      throw new Error('synthetic-append-failure');
    });
    const order: string[] = [];
    const failed = await withReleasePrepareAuthorityFixture(value, () =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release prepare',
        authority: authorityFor('release prepare'),
        store: failingStore,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider: () => ({
          outcome: 'success',
          material: materialFor('release prepare'),
          transaction: {
            commit: () => {
              order.push('commit');
            },
            rollback: () => {
              order.push('rollback');
            },
            dispose: () => {
              order.push('dispose');
            },
          },
        }),
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(failed).toMatchObject({
      ok: false,
      phase: 'append',
      code: 'synthetic-append-failure',
    });
    expect(order).toEqual(['commit']);
  });

  it('refuses invalid authorization before provider availability or invocation', async () => {
    const initial = request('release evidence-publish');
    const store = new ReleaseLifecycleFileStore(root(), initial);
    await advanceToExported(store);
    const exported = required(store.readStateRecords().at(-1), 'missing exported state');
    const receipt = boundOfflineReceipt(exported);
    const value = request('release evidence-publish', receipt);
    const provider = vi.fn(() => ({ outcome: 'unknown' as const }));
    const result = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release evidence-publish',
        authority: authorityFor('release evidence-publish'),
        store,
        resolveReceipt: () => receipt,
        resolvePlanInput,
        offlineReceiptVerifier: { verify: ({ receipt: value }) => value },
        artifactReader: artifactReaderFor('release export'),
        authorization: {
          resolve: () => ({ ok: false, code: 'authorization-identity-mismatch' }),
          consume: () => {
            throw new Error('must not consume');
          },
        },
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      phase: 'authorization',
      code: 'authorization-identity-mismatch',
    });
    expect(provider).not.toHaveBeenCalled();
    const withoutProvider = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release evidence-publish',
        authority: authorityFor('release evidence-publish'),
        store,
        resolveReceipt: () => receipt,
        resolvePlanInput,
        offlineReceiptVerifier: { verify: ({ receipt: value }) => value },
        artifactReader: artifactReaderFor('release export'),
        authorization: {
          resolve: () => ({ ok: false, code: 'authorization-identity-mismatch' }),
          consume: () => {
            throw new Error('must not consume');
          },
        },
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(withoutProvider).toMatchObject({
      ok: false,
      phase: 'authorization',
      code: 'authorization-identity-mismatch',
    });
  });

  it('consumes a remote grant only after the attempt is durable and never redispatches unknown', async () => {
    const initial = request('release evidence-publish');
    const store = new ReleaseLifecycleFileStore(root(), initial);
    await advanceToExported(store);
    const exported = required(store.readStateRecords().at(-1), 'missing exported state');
    const receipt = boundOfflineReceipt(exported);
    const value = request('release evidence-publish', receipt);
    const order: string[] = [];
    let authorizationBinding: AuthorizationAttemptBinding | undefined;
    const provider = vi.fn(() => {
      order.push('provider');
      return { outcome: 'unknown' as const, provider_handle: 'run-1' };
    });
    const first = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release evidence-publish',
        authority: authorityFor('release evidence-publish'),
        store,
        resolveReceipt: () => receipt,
        resolvePlanInput,
        offlineReceiptVerifier: { verify: ({ receipt: value }) => value },
        artifactReader: artifactReaderFor('release export'),
        authorization: authorizationBridge((binding) => {
          authorizationBinding = binding;
          order.push(store.readStoreRecords().at(-1)?.record_kind ?? 'missing');
        }),
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(first).toMatchObject({ ok: false, phase: 'ambiguous' });
    expect(authorizationBinding?.destination.operation).toBe('create');
    expect(order.at(-2)).toBe('attempt');
    expect(order.at(-1)).toBe('provider');
    const unknownObservation = await resumeReleaseLifecycleExecution({
      states: store.readStateRecords(),
      store_records: store.readStoreRecords(),
      store_head: store.readHead(),
      repository: value.repository_locator,
      candidate: required(store.readStateRecords().at(-1), 'missing exported state').candidate,
      candidate_locator: value.candidate_locator,
      receipt_documents: [planReceipt(), receipt],
      resolve_plan_input: resolvePlanInput,
      offline_receipt_verifier: { verify: ({ receipt: document }) => document },
    });
    expect(unknownObservation).toMatchObject({ next_action: null, next_outcome: 'ambiguous' });
    expect(unknownObservation).not.toHaveProperty('blocked_requirements');
    expect(
      store
        .readStoreRecords()
        .slice(-2)
        .map((record) => record.record_kind),
    ).toEqual(['attempt', 'unknown-provider-result']);

    const second = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release evidence-publish',
        authority: authorityFor('release evidence-publish'),
        store,
        resolveReceipt: () => receipt,
        resolvePlanInput,
        offlineReceiptVerifier: { verify: ({ receipt: value }) => value },
        artifactReader: artifactReaderFor('release export'),
        authorization: authorizationBridge(),
        provider,
        recorded_at: '2026-09-03T00:00:01.000Z',
      }),
    );
    expect(second).toMatchObject({
      ok: false,
      phase: 'reconciliation',
      code: 'release-provider-result-unknown',
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('reports deterministic next actions, failures, and unknown outcomes without writes', async () => {
    const value = request();
    const store = new ReleaseLifecycleFileStore(root(), value);
    const success = await seedPreflight(store);
    const before = JSON.stringify(store.readStoreRecords());
    const observation = await resumeReleaseLifecycleExecution({
      states: store.readStateRecords(),
      store_records: store.readStoreRecords(),
      store_head: store.readHead(),
      repository: value.repository_locator,
      candidate: success.state.candidate,
      receipt_documents: [planReceipt()],
      resolve_plan_input: resolvePlanInput,
    });
    expect(observation).toMatchObject({
      next_action: 'release certify',
      next_outcome: 'ready',
    });
    expect(JSON.stringify(store.readStoreRecords())).toBe(before);

    const attempt = store.readStoreRecords()[0] as StoreRecord;
    const ambiguous = await resumeReleaseLifecycleExecution({
      states: [],
      store_records: [attempt],
      store_head: null,
      repository: value.repository_locator,
      candidate: success.state.candidate,
      receipt_documents: [planReceipt()],
      resolve_plan_input: resolvePlanInput,
    });
    expect(ambiguous).toMatchObject({ next_action: null, next_outcome: 'ambiguous' });
  });

  it('binds the complete resume observation to exact candidate, store, locator, and head identities', async () => {
    const value = request();
    const store = new ReleaseLifecycleFileStore(root(), value);
    const success = await seedPreflight(store);
    const exactState = success.state;
    const exactRecords = store.readStoreRecords();
    const exactHead = required(store.readHead(), 'missing exact store head');
    const repository = value.repository_locator;
    const candidate = exactState.candidate;
    const candidateLocator = value.candidate_locator;
    const stateHead = {
      state: exactState.state,
      state_id: exactState.state_id,
      record_digest_sha256: exactState.record_digest_sha256,
    };
    const identify = (draft: Readonly<Record<string, unknown>>) => {
      const digest = canonicalSha256(draft);
      return {
        ...draft,
        observation_id: `RLO-${digest.slice(0, 16)}`,
        observation_digest_sha256: digest,
      };
    };
    const observation = (input: {
      readonly head: Readonly<Record<string, unknown>> | null;
      readonly next_action: string | null;
      readonly next_outcome: 'ready' | 'blocked';
      readonly blocked_reason?: 'candidate-identity-mismatch' | 'stale-head';
      readonly derived_states?: readonly Readonly<Record<string, unknown>>[];
    }) =>
      identify({
        schemaVersion: '1.1.0',
        observation_kind: 'release-lifecycle-observation',
        repository,
        candidate,
        verification_kernel: {
          kernel_id: 'devai.kernel.release-lifecycle-observation.v1',
          policy_source: 'law/policy/release-lifecycle.json#/observation_kernel',
          schema_validation_alone_derives_published: false,
        },
        head: input.head,
        derived_states: input.derived_states ?? [],
        published: { observed: false, receipt: null, verified_against: null },
        next_action: input.next_action,
        next_outcome: input.next_outcome,
        ...(input.next_outcome === 'blocked'
          ? {
              blocked_reason: input.blocked_reason,
              blocked_requirements: [],
            }
          : {}),
        emitted_by: {
          action_id: 'release resume',
          effect: 'read',
          output_channel: 'stdout',
          persists_repository_state: false,
          appends_state_record: false,
          writes_receipt_file: false,
        },
        grants: {
          authority: false,
          publication_authority: false,
          lifecycle_transition: false,
          appends_published_state: false,
        },
        determinism: {
          deterministic: true,
          derived_from_bound_inputs_only: true,
          contains_wall_clock_time: false,
        },
      });
    const exactPlanState = {
      state: 'planned',
      receipt_kind: 'release-plan-receipt',
      receipt_id: planReceipt()['receipt_id'],
      receipt_digest_sha256: planReceipt()['receipt_digest_sha256'],
      verified: true,
    };
    const base = {
      states: [exactState],
      store_records: exactRecords,
      store_head: exactHead,
      repository,
      candidate,
      candidate_locator: candidateLocator,
      receipt_documents: [planReceipt()],
      resolve_plan_input: resolvePlanInput,
    };

    await expect(resumeReleaseLifecycleExecution(base)).resolves.toEqual(
      observation({
        head: stateHead,
        derived_states: [exactPlanState],
        next_action: 'release certify',
        next_outcome: 'ready',
      }),
    );

    const refinalizeRecord = (
      record: StoreRecord,
      patch: Partial<Omit<StoreRecord, 'record_id' | 'record_digest_sha256'>>,
    ) => {
      const { record_id: _recordId, record_digest_sha256: _digest, ...draft } = record;
      return finalizeStoreRecord({ ...draft, ...patch });
    };
    const terminal = required(exactRecords.at(-1), 'missing exact completion');
    const storeDrifts: readonly [string, Partial<StoreRecord>][] = [
      ['repository', { repository: { ...repository, id: 'aarusso-nyx/other' } }],
      [
        'candidate commit',
        { candidate: { ...objectValue(terminal.candidate), commit: 'f'.repeat(40) } },
      ],
      [
        'candidate tree',
        { candidate: { ...objectValue(terminal.candidate), tree: 'f'.repeat(40) } },
      ],
    ];
    for (const [label, patch] of storeDrifts) {
      const changed = refinalizeRecord(terminal, patch);
      await expect(
        resumeReleaseLifecycleExecution({
          ...base,
          store_records: [...exactRecords.slice(0, -1), changed],
        }),
        label,
      ).resolves.toEqual(
        observation({
          head: stateHead,
          next_action: null,
          next_outcome: 'blocked',
          blocked_reason: 'candidate-identity-mismatch',
        }),
      );
    }

    const { state_id: _stateId, record_digest_sha256: _stateDigest, ...stateDraft } = exactState;
    const stateDrifts = [
      ['repository', { repository: { ...repository, id: 'aarusso-nyx/other' } }],
      ['candidate', { candidate: { ...candidate, version: '1.5.1' } }],
    ] as const;
    for (const [label, patch] of stateDrifts) {
      const changed = finalizeReleaseStateV2({ ...stateDraft, ...patch });
      await expect(
        resumeReleaseLifecycleExecution({
          states: [changed],
          repository,
          candidate,
          receipt_documents: [planReceipt()],
          resolve_plan_input: resolvePlanInput,
        }),
        label,
      ).resolves.toEqual(
        observation({
          head: {
            state: changed.state,
            state_id: changed.state_id,
            record_digest_sha256: changed.record_digest_sha256,
          },
          next_action: null,
          next_outcome: 'blocked',
          blocked_reason: 'candidate-identity-mismatch',
        }),
      );
    }

    const locatorDrifts = [
      ['commit', { ...candidateLocator, commit: 'f'.repeat(40) }],
      ['tree', { ...candidateLocator, tree: 'f'.repeat(40) }],
      [
        'release unit',
        {
          ...candidateLocator,
          release_units: [
            {
              ...required(candidateLocator.release_units[0], 'missing unit'),
              release_unit: 'other',
            },
          ],
        },
      ],
      [
        'version',
        {
          ...candidateLocator,
          release_units: [
            { ...required(candidateLocator.release_units[0], 'missing unit'), version: '1.5.1' },
          ],
        },
      ],
    ] as const;
    for (const [label, changed] of locatorDrifts) {
      await expect(
        resumeReleaseLifecycleExecution({
          states: [],
          repository,
          candidate,
          candidate_locator: changed,
        }),
        label,
      ).resolves.toEqual(
        observation({
          head: null,
          next_action: null,
          next_outcome: 'blocked',
          blocked_reason: 'candidate-identity-mismatch',
        }),
      );
    }

    const { head_digest_sha256: _headDigest, ...headDraft } = exactHead;
    const differentHead = finalizeStoreHead({
      ...headDraft,
      generation: exactHead.generation + 1,
    });
    const headDrifts: readonly [string, Readonly<Record<string, unknown>>][] = [
      ['null', { ...base, store_head: null }],
      ['invalid', { ...base, store_head: { ...exactHead, head_digest_sha256: '0'.repeat(64) } }],
      ['different', { ...base, store_head: differentHead }],
    ];
    for (const [label, changed] of headDrifts) {
      await expect(
        resumeReleaseLifecycleExecution(
          changed as Parameters<typeof resumeReleaseLifecycleExecution>[0],
        ),
        label,
      ).resolves.toEqual(
        observation({
          head: stateHead,
          next_action: null,
          next_outcome: 'blocked',
          blocked_reason: 'stale-head',
        }),
      );
    }
    const { store_head: _storeHead, ...withoutHead } = base;
    await expect(resumeReleaseLifecycleExecution(withoutHead)).resolves.toEqual(
      observation({
        head: stateHead,
        next_action: null,
        next_outcome: 'blocked',
        blocked_reason: 'stale-head',
      }),
    );
  });

  it('reduces exact current and historical state transitions while reporting every identity drift', async () => {
    const store = new ReleaseLifecycleFileStore(root(), request('release export'));
    await advanceToExported(store);
    const states = store.readStateRecords();
    const preflight = required(states[0], 'missing preflight state');
    const certified = required(states[1], 'missing certified state');
    const prepared = required(states[2], 'missing prepared state');
    const exported = required(states[3], 'missing exported state');
    expect(reduceReleaseStates(states)).toEqual({ ok: true, head: exported, errors: [] });
    expect(reduceReleaseStates([])).toEqual({ ok: true, head: null, errors: [] });

    const refinalize = (
      state: ReleaseLifecycleStateV2,
      patch: Partial<Parameters<typeof finalizeReleaseStateV2>[0]>,
    ) => {
      const { state_id: _stateId, record_digest_sha256: _digest, ...draft } = state;
      return finalizeReleaseStateV2({ ...draft, ...patch });
    };
    const assertReduction = (
      label: string,
      values: readonly unknown[],
      head: ReleaseLifecycleStateV2 | null,
      errors: readonly string[],
    ) =>
      expect(reduceReleaseStates(values), label).toEqual({ ok: errors.length === 0, head, errors });

    const emptyPlans = refinalize(certified, { bound_receipts: [] });
    assertReduction(
      'empty later plan bindings are historical-compatible',
      [preflight, emptyPlans],
      emptyPlans,
      [],
    );

    const plan = required(certified.bound_receipts[0], 'missing certified plan binding');
    const driftedPlan = refinalize(certified, {
      bound_receipts: [{ ...plan, receipt_digest_sha256: 'f'.repeat(64) }],
    });
    assertReduction('plan binding', [preflight, driftedPlan], driftedPlan, [
      'release-receipt-identity-mismatch',
    ]);

    const repositoryDrift = refinalize(certified, {
      repository: { ...certified.repository, id: 'aarusso-nyx/other' },
    });
    assertReduction('repository identity', [preflight, repositoryDrift], repositoryDrift, [
      'release-state-identity-mismatch',
    ]);
    const candidateDrift = refinalize(certified, {
      candidate: { ...certified.candidate, version: '1.5.1' },
    });
    assertReduction('candidate identity', [preflight, candidateDrift], candidateDrift, [
      'release-state-identity-mismatch',
    ]);

    const predecessorDrift = refinalize(certified, {
      prior_state: {
        ...required(certified.prior_state, 'missing certified predecessor'),
        record_digest_sha256: 'f'.repeat(64),
      },
    });
    assertReduction('predecessor', [preflight, predecessorDrift], predecessorDrift, [
      'release-state-predecessor-mismatch',
    ]);
    const generationDrift = refinalize(certified, {
      storage: { ...certified.storage, generation: certified.storage.generation + 1 },
    });
    assertReduction('generation', [preflight, generationDrift], generationDrift, [
      'release-state-head-mismatch',
    ]);
    const headGenerationDrift = refinalize(certified, {
      storage: {
        ...certified.storage,
        head_before: {
          ...required(certified.storage.head_before, 'missing certified head'),
          generation: preflight.storage.generation + 1,
        },
      },
    });
    assertReduction('head generation', [preflight, headGenerationDrift], headGenerationDrift, [
      'release-state-head-mismatch',
    ]);
    const headDigestDrift = refinalize(certified, {
      storage: {
        ...certified.storage,
        head_before: {
          ...required(certified.storage.head_before, 'missing certified head'),
          record_digest_sha256: 'f'.repeat(64),
        },
      },
    });
    assertReduction('head digest', [preflight, headDigestDrift], headDigestDrift, [
      'release-state-head-mismatch',
    ]);
    const preparedGenerationDrift = refinalize(prepared, {
      storage: { ...prepared.storage, generation: prepared.storage.generation + 1 },
    });
    assertReduction(
      'v2.1 generation',
      [preflight, certified, preparedGenerationDrift],
      preparedGenerationDrift,
      ['release-state-head-mismatch'],
    );
    const preparedHeadDrift = refinalize(prepared, {
      storage: {
        ...prepared.storage,
        head_before: {
          ...required(prepared.storage.head_before, 'missing prepared head'),
          record_digest_sha256: 'f'.repeat(64),
        },
      },
    });
    assertReduction('v2.1 head', [preflight, certified, preparedHeadDrift], preparedHeadDrift, [
      'release-state-head-mismatch',
    ]);
    assertReduction(
      'v2.1 prior generation independent of array index',
      [prepared, exported],
      exported,
      ['release-state-transition-invalid'],
    );

    assertReduction('invalid first phase', [certified], certified, [
      'release-state-transition-invalid',
    ]);
    assertReduction('skipped phase', [preflight, prepared], prepared, [
      'release-state-predecessor-mismatch',
      'release-state-head-mismatch',
      'release-state-transition-invalid',
    ]);
    assertReduction(
      'invalid state identity',
      [{ ...preflight, record_digest_sha256: 'f'.repeat(64) }],
      null,
      ['release-state-id-or-digest-mismatch'],
    );

    const historical = (
      state: ReleaseLifecycleStateV2,
      prior: Readonly<Record<string, unknown>> | null,
    ) => {
      const {
        canonicalization: _canonicalization,
        release_units: _releaseUnits,
        storage: _storage,
        record_digest_sha256: _recordDigest,
        ...common
      } = state;
      const draft = {
        ...common,
        schemaVersion: '1.0.0',
        prior_state:
          prior === null
            ? null
            : {
                state: prior['state'],
                state_id: prior['state_id'],
                record_digest_sha256: prior['record_digest_sha256'],
              },
      };
      return { ...draft, record_digest_sha256: canonicalSha256(draft) };
    };
    const historicalPreflight = historical(preflight, null);
    const historicalCertified = historical(certified, historicalPreflight);
    assertReduction(
      'historical index generations',
      [historicalPreflight, historicalCertified],
      verifyReleaseStateIdentity(historicalCertified),
      [],
    );
  });

  it('derives each remaining next action from the exact verified lifecycle head', async () => {
    await withAuthorityHostTestScope(async () => {
      const observe = async (
        store: ReleaseLifecycleFileStore,
        options: {
          readonly offlineReceipt?: Readonly<Record<string, unknown>>;
        } = {},
      ) => {
        const head = required(store.readStateRecords().at(-1), 'missing lifecycle head');
        return resumeReleaseLifecycleExecution({
          states: store.readStateRecords(),
          store_records: store.readStoreRecords(),
          store_head: store.readHead(),
          repository: head.repository,
          candidate: head.candidate,
          candidate_locator: request('release publish').candidate_locator,
          receipt_documents: [
            planReceipt(),
            ...(options.offlineReceipt === undefined ? [] : [options.offlineReceipt]),
          ],
          resolve_plan_input: resolvePlanInput,
          ...(options.offlineReceipt === undefined
            ? {}
            : {
                offline_receipt_verifier: {
                  verify: ({ receipt }: { receipt: Readonly<Record<string, unknown>> }) => receipt,
                },
              }),
        });
      };

      const certified = new ReleaseLifecycleFileStore(root(), request('release certify'));
      await seedCertified(certified);
      await expect(observe(certified)).resolves.toMatchObject({
        next_action: 'release prepare',
        next_outcome: 'ready',
      });

      const prepared = new ReleaseLifecycleFileStore(root(), request('release prepare'));
      await advanceToPrepared(prepared);
      await expect(observe(prepared)).resolves.toMatchObject({
        next_action: 'release export',
        next_outcome: 'ready',
      });

      const exported = new ReleaseLifecycleFileStore(root(), request('release export'));
      await advanceToExported(exported);
      await expect(observe(exported)).resolves.toMatchObject({
        next_action: 'release offline-verify',
        next_outcome: 'ready',
      });
      const exportedState = required(exported.readStateRecords().at(-1), 'missing exported state');
      const verifiedOfflineReceipt = boundOfflineReceipt(exportedState);
      await expect(
        observe(exported, { offlineReceipt: verifiedOfflineReceipt }),
      ).resolves.toMatchObject({
        next_action: 'release evidence-publish',
        next_outcome: 'ready',
        derived_states: expect.arrayContaining([
          expect.objectContaining({
            state: 'offline_verified',
            receipt_id: verifiedOfflineReceipt['receipt_id'],
            verified: true,
          }),
        ]),
      });
      const reconstructedCandidateVerifier = vi.fn(
        ({
          candidate_locator,
          receipt,
        }: Parameters<TrustedOfflineReceiptVerifier['verify']>[0]) => {
          expect(candidate_locator).toEqual(request('release publish').candidate_locator);
          return receipt;
        },
      );
      await expect(
        resumeReleaseLifecycleExecution({
          states: exported.readStateRecords(),
          store_records: exported.readStoreRecords(),
          store_head: exported.readHead(),
          repository: exportedState.repository,
          candidate: exportedState.candidate,
          receipt_documents: [planReceipt(), verifiedOfflineReceipt],
          resolve_plan_input: resolvePlanInput,
          offline_receipt_verifier: { verify: reconstructedCandidateVerifier },
        }),
      ).resolves.toMatchObject({
        next_action: 'release evidence-publish',
        next_outcome: 'ready',
      });
      expect(reconstructedCandidateVerifier).toHaveBeenCalledOnce();

      const evidencePublished = new ReleaseLifecycleFileStore(
        root(),
        request('release evidence-publish'),
      );
      await advanceToEvidencePublished(evidencePublished);
      await expect(observe(evidencePublished)).resolves.toMatchObject({
        next_action: 'release publish',
        next_outcome: 'ready',
      });

      const publicationDispatched = new ReleaseLifecycleFileStore(
        root(),
        request('release publish'),
      );
      await advanceToPublicationDispatched(publicationDispatched);
      await expect(observe(publicationDispatched)).resolves.toMatchObject({
        next_action: 'release resume',
        next_outcome: 'awaiting-external-receipt',
      });
    });
  });

  it('rejects corrupted and forked append-only records and symlinked stores', async () => {
    const value = request();
    const store = new ReleaseLifecycleFileStore(root(), value);
    await seedPreflight(store);
    const records = store.readStoreRecords();
    expect(
      reduceStoreRecords([{ ...records[0], request_digest_sha256: 'f'.repeat(64) }, records[1]]).ok,
    ).toBe(false);

    const unsafeRoot = root();
    const target = root();
    symlinkSync(target, join(unsafeRoot, 'linked'));
    const unsafe = new ReleaseLifecycleFileStore(join(unsafeRoot, 'linked'), value);
    await expect(
      withReleasePrepareAuthorityFixture(request('release prepare'), () =>
        executeReleaseLifecycleAction({
          request: request('release prepare'),
          action: 'release prepare',
          authority: authorityFor('release prepare'),
          store: unsafe,
          resolveReceipt: () => planReceipt(),
          resolvePlanInput,
          provider: () => ({ outcome: 'success', material: materialFor('release prepare') }),
          recorded_at: '2026-09-03T00:00:00.000Z',
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      phase: 'reconciliation',
      code: 'release-state-store-unsafe',
    });
  });

  it('accepts v1 only for observation and writes only content-derived v2 state', async () => {
    const value = request();
    const store = new ReleaseLifecycleFileStore(root(), value);
    const success = await seedPreflight(store);
    const {
      state_id: _stateId,
      record_digest_sha256: _recordDigest,
      ...currentDraft
    } = success.state;
    expect(() => verifyReleaseStateIdentity({})).toThrow('release-state-schema-invalid');
    for (const schemaVersion of ['2.0.0', '2.1.0'] as const) {
      const current = finalizeReleaseStateV2({ ...currentDraft, schemaVersion });
      expect(() =>
        verifyReleaseStateIdentity({ ...current, record_digest_sha256: 'f'.repeat(64) }),
      ).toThrow('release-state-id-or-digest-mismatch');
      expect(() =>
        verifyReleaseStateIdentity({ ...current, state_id: `RLS-${'f'.repeat(16)}` }),
      ).toThrow('release-state-id-or-digest-mismatch');
    }
    const {
      canonicalization: _canonicalization,
      release_units: _units,
      storage: _storage,
      ...v2
    } = success.state;
    const { record_digest_sha256: _digest, ...v1Draft } = v2;
    const v1 = {
      ...v1Draft,
      schemaVersion: '1.0.0',
      record_digest_sha256: canonicalSha256({ ...v1Draft, schemaVersion: '1.0.0' }),
    };
    expect(verifyReleaseStateIdentity(v1).schemaVersion).toBe('1.0.0');
    expect(() => verifyReleaseStateIdentity(v1, true)).toThrow('release-state-v1-write-refused');
  });

  it('requires trusted declared authority and never fabricates actor or consent', async () => {
    const value = request();
    const provider = vi.fn(() => ({ outcome: 'success' as const, material: material() }));
    const missing = await executeReleaseLifecycleAction({
      request: value,
      action: 'release preflight',
      store: new ReleaseLifecycleFileStore(root(), value),
      resolveReceipt: () => planReceipt(),
      resolvePlanInput,
      provider,
      recorded_at: '2026-09-03T00:00:00.000Z',
    });
    expect(missing).toMatchObject({ ok: false, code: 'release-authority-context-invalid' });
    expect(provider).not.toHaveBeenCalled();

    const trusted = authorityFor('release preflight');
    const invalidAuthorities = [
      { ...trusted, actor: { ...trusted.actor, kind: 'machine' } },
      { ...trusted, actor: { ...trusted.actor, role: 'engineer' } },
      { ...trusted, actor: { ...trusted.actor, declaration_source: 'ambient' } },
      { ...trusted, consent: { ...trusted.consent, write: false } },
      { ...trusted, consent: { ...trusted.consent, experimental: true } },
      { ...trusted, consent: { ...trusted.consent, allow_publish: true } },
    ] as unknown as readonly TrustedReleaseAuthority[];
    for (const authority of invalidAuthorities) {
      const wrong = await executeReleaseLifecycleAction({
        request: value,
        action: 'release preflight',
        authority,
        store: new ReleaseLifecycleFileStore(root(), value),
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      });
      expect(wrong).toMatchObject({ ok: false, code: 'release-authority-context-invalid' });
    }
    expect(provider).not.toHaveBeenCalled();

    const accepted = await executeReleaseLifecycleAction({
      request: value,
      action: 'release preflight',
      authority: {
        ...trusted,
        actor: { ...trusted.actor, declaration_source: 'session-state' },
      },
      store: new ReleaseLifecycleFileStore(root(), value),
      resolveReceipt: () => planReceipt(),
      resolvePlanInput,
      provider,
      recorded_at: '2026-09-03T00:00:00.000Z',
    });
    expect(accepted).toMatchObject({
      ok: false,
      phase: 'provider',
      code: 'release-certification-provider-unavailable',
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it('refuses a no-op or mismatched authorization consumption proof before dispatch', async () => {
    const initial = request('release evidence-publish');
    const store = new ReleaseLifecycleFileStore(root(), initial);
    await advanceToExported(store);
    const exported = required(store.readStateRecords().at(-1), 'missing exported state');
    const receipt = boundOfflineReceipt(exported);
    const value = request('release evidence-publish', receipt);
    const valid = authorizationBridge();
    const provider = vi.fn(() => ({ outcome: 'unknown' as const }));
    const result = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release evidence-publish',
        authority: authorityFor('release evidence-publish'),
        store,
        resolveReceipt: () => receipt,
        resolvePlanInput,
        offlineReceiptVerifier: { verify: ({ receipt: value }) => value },
        artifactReader: artifactReaderFor('release export'),
        authorization: {
          ...valid,
          consume: async (binding) => {
            const stale = await valid.resolve(binding);
            if (!stale.ok) throw new Error('expected valid grant');
            return { durable: true, ledger: stale.ledger, events: stale.events };
          },
        },
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      phase: 'authorization',
      code: 'release-authorization-consumption-not-durable',
    });
    expect(provider).not.toHaveBeenCalled();
    expect(store.readStoreRecords().at(-1)?.record_kind).toBe('failure');
  });

  it.each([
    ['a different action', { action_id: 'release publish' }],
    ['a different effect', { effect: 'local-write' }],
    [
      'a grant that is not active yet',
      { not_before: '2026-09-03T00:00:00.001Z', expires_at: '2026-09-03T01:00:00.000Z' },
    ],
    [
      'a grant at its exclusive expiry boundary',
      { not_before: '2026-09-02T23:00:00.000Z', expires_at: '2026-09-03T00:00:00.000Z' },
    ],
  ] as const)('persists refusal for a recomputed grant with %s', async (_label, change) => {
    const initial = request('release evidence-publish');
    const store = new ReleaseLifecycleFileStore(root(), initial);
    await advanceToExported(store);
    const exported = required(store.readStateRecords().at(-1), 'missing exported state');
    const priorRecords = store.readStoreRecords();
    const receipt = boundOfflineReceipt(exported);
    const value = request('release evidence-publish', receipt);
    const valid = authorizationBridge();
    const forged: AuthorizationBridge = {
      ...valid,
      resolve: async (binding) => {
        const resolution = await valid.resolve(binding);
        if (!resolution.ok) return resolution;
        const original = objectValue(required(resolution.events[0], 'missing grant event'));
        const { event_id: _eventId, payload_digest_sha256: _payloadDigest, ...draft } = original;
        const event = finalizeAuthorizationEvent({ ...draft, ...change });
        return { ...resolution, events: [event], ledger: authorizationLedger([event]) };
      },
    };
    const provider = vi.fn(() => ({ outcome: 'unknown' as const }));

    const result = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release evidence-publish',
        authority: authorityFor('release evidence-publish'),
        store,
        resolveReceipt: () => receipt,
        resolvePlanInput,
        offlineReceiptVerifier: { verify: ({ receipt: document }) => document },
        artifactReader: artifactReaderFor('release export'),
        authorization: forged,
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      phase: 'authorization',
      code: 'release-authorization-attempt-binding-invalid',
    });
    expect(provider).not.toHaveBeenCalled();
    expect(store.readStoreRecords()).toEqual(priorRecords);
  });

  it.each(['not-durable', 'consumption-binding'] as const)(
    'persists refusal for a consumed authorization proof with changed %s',
    async (defect) => {
      const initial = request('release evidence-publish');
      const store = new ReleaseLifecycleFileStore(root(), initial);
      await advanceToExported(store);
      const exported = required(store.readStateRecords().at(-1), 'missing exported state');
      const receipt = boundOfflineReceipt(exported);
      const value = request('release evidence-publish', receipt);
      const valid = authorizationBridge();
      const forged: AuthorizationBridge = {
        ...valid,
        consume: async (binding) => {
          const proof = await valid.consume(binding);
          if (defect === 'not-durable')
            return { ...proof, durable: false } as unknown as Awaited<
              ReturnType<typeof valid.consume>
            >;
          const grant = objectValue(required(proof.events[0], 'missing grant event'));
          const consumed = objectValue(required(proof.events[1], 'missing consumed event'));
          const {
            event_id: _eventId,
            payload_digest_sha256: _payloadDigest,
            ...consumedDraft
          } = consumed;
          const bindingValue = objectValue(consumed['consumption_binding']);
          const event = finalizeAuthorizationEvent({
            ...consumedDraft,
            consumption_binding: {
              ...bindingValue,
              request_digest_sha256: 'f'.repeat(64),
            },
          });
          return {
            durable: true,
            events: [grant, event],
            ledger: authorizationLedger([grant, event]),
          };
        },
      };
      const provider = vi.fn(() => ({ outcome: 'unknown' as const }));

      const result = await withAuthorityHostTestScope(() =>
        executeReleaseLifecycleAction({
          request: value,
          action: 'release evidence-publish',
          authority: authorityFor('release evidence-publish'),
          store,
          resolveReceipt: () => receipt,
          resolvePlanInput,
          offlineReceiptVerifier: { verify: ({ receipt: document }) => document },
          artifactReader: artifactReaderFor('release export'),
          authorization: forged,
          provider,
          recorded_at: '2026-09-03T00:00:00.000Z',
        }),
      );

      expect(result).toMatchObject({
        ok: false,
        phase: 'authorization',
        code: 'release-authorization-consumption-not-durable',
      });
      expect(provider).not.toHaveBeenCalled();
      expect(store.readStoreRecords().at(-1)).toMatchObject({
        record_kind: 'failure',
        authorization_event_id: expect.stringMatching(/^EA-[a-f0-9]{16}$/u),
        failure: { code: 'release-authorization-consumption-failed' },
      });
    },
  );

  it.each([
    'grant-reference',
    'action',
    'effect',
    'resource',
    'repository',
    'candidate',
    'grantor',
    'subject-role',
    'consent',
    'invalid-consumed-at',
    'recorded-before-grant',
    'recorded-at-expiry',
  ] as const)(
    'rejects a recomputed consumed authorization event with a changed %s',
    async (defect) => {
      const initial = request('release evidence-publish');
      const store = new ReleaseLifecycleFileStore(root(), initial);
      await advanceToExported(store);
      const exported = required(store.readStateRecords().at(-1), 'missing exported state');
      const receipt = boundOfflineReceipt(exported);
      const value = request('release evidence-publish', receipt);
      const valid = authorizationBridge();
      const forged: AuthorizationBridge = {
        ...valid,
        consume: async (binding) => {
          const proof = await valid.consume(binding);
          const grant = objectValue(required(proof.events[0], 'missing authorization grant'));
          const consumed = objectValue(required(proof.events[1], 'missing consumed event'));
          const {
            event_id: _eventId,
            payload_digest_sha256: _payloadDigest,
            ...consumedDraft
          } = consumed;
          const changed = finalizeAuthorizationEvent({
            ...consumedDraft,
            ...(defect === 'grant-reference' ? { grant_event_id: 'EA-0000000000000000' } : {}),
            ...(defect === 'action' ? { action_id: 'release publish' } : {}),
            ...(defect === 'effect' ? { effect: 'local-write' } : {}),
            ...(defect === 'resource'
              ? { resource: { ...objectValue(consumed.resource), exact_identifier: 'other' } }
              : {}),
            ...(defect === 'repository' ? { repository: { id: 'aarusso-nyx/other' } } : {}),
            ...(defect === 'candidate'
              ? { candidate: { ...objectValue(consumed.candidate), tree: 'f'.repeat(40) } }
              : {}),
            ...(defect === 'grantor'
              ? { grantor: { ...objectValue(consumed.grantor), role: 'engineer' } }
              : {}),
            ...(defect === 'subject-role' ? { subject_role: 'engineer' } : {}),
            ...(defect === 'consent'
              ? { consent: { ...objectValue(consumed.consent), allow_publish: false } }
              : {}),
            ...(defect === 'invalid-consumed-at' ? { recorded_at: 'not-an-instant' } : {}),
            ...(defect === 'recorded-before-grant'
              ? { recorded_at: '2026-09-02T23:59:59.999Z' }
              : {}),
            ...(defect === 'recorded-at-expiry' ? { recorded_at: '2026-09-03T01:00:00.000Z' } : {}),
          });
          return {
            durable: true,
            events: [grant, changed],
            ledger: authorizationLedger([grant, changed]),
          };
        },
      };
      const provider = vi.fn(() => ({ outcome: 'success' as const }));
      const result = await withAuthorityHostTestScope(() =>
        executeReleaseLifecycleAction({
          request: value,
          action: 'release evidence-publish',
          authority: authorityFor('release evidence-publish'),
          store,
          resolveReceipt: () => receipt,
          resolvePlanInput,
          offlineReceiptVerifier: { verify: ({ receipt: document }) => document },
          artifactReader: artifactReaderFor('release export'),
          authorization: forged,
          provider,
          recorded_at: '2026-09-03T00:00:00.000Z',
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        phase: 'authorization',
        code: 'release-authorization-attempt-binding-invalid',
      });
      expect(provider).not.toHaveBeenCalled();
    },
  );

  it('binds plan coverage and offline evidence to every release unit and exported artifact', async () => {
    const single = request();
    const unit = required(single.candidate_locator.release_units[0], 'missing unit');
    expect(() =>
      validateReleaseLifecycleRequest({
        ...single,
        candidate_locator: {
          ...single.candidate_locator,
          release_units: [
            unit,
            { ...unit, release_unit: '@aarusso-nyx/secondary', version: '2.0.0' },
          ],
        },
      }),
    ).toThrow('release-receipt-identity-mismatch');

    const initial = request('release evidence-publish');
    const store = new ReleaseLifecycleFileStore(root(), initial);
    await advanceToExported(store);
    const exported = required(store.readStateRecords().at(-1), 'missing exported state');
    const validReceipt = boundOfflineReceipt(exported);
    const units = validReceipt['release_units'] as readonly Readonly<Record<string, unknown>>[];
    const firstUnit = required(units[0], 'missing receipt unit');
    const packages = firstUnit['packages'] as readonly Readonly<Record<string, unknown>>[];
    const firstPackage = required(packages[0], 'missing receipt package');
    const providerResult = objectValue(firstPackage['provider_result']);
    const driftedReceipt = rehashReceipt(validReceipt, {
      release_units: [
        {
          ...firstUnit,
          packages: [
            {
              ...firstPackage,
              provider_result: { ...providerResult, sha256: 'c'.repeat(64) },
            },
          ],
        },
      ],
    });
    const value = request('release evidence-publish', driftedReceipt);
    const provider = vi.fn(() => ({ outcome: 'unknown' as const }));
    const result = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release evidence-publish',
        authority: authorityFor('release evidence-publish'),
        store,
        resolveReceipt: () => driftedReceipt,
        resolvePlanInput,
        offlineReceiptVerifier: { verify: ({ receipt: value }) => value },
        artifactReader: artifactReaderFor('release export'),
        authorization: authorizationBridge(),
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'release-offline-receipt-binding-invalid' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('enforces the v2 head, exact terminal linkage, and one serialized writer', async () => {
    const value = request();
    const store = new ReleaseLifecycleFileStore(root(), value);
    await seedPreflight(store);
    const records = store.readStoreRecords();
    const completion = required(records[1], 'missing completion');
    const { record_id: _id, record_digest_sha256: _digest, ...terminalDraft } = completion;
    const forged = finalizeStoreRecord({
      ...terminalDraft,
      request_digest_sha256: 'd'.repeat(64),
    });
    expect(reduceStoreRecords([records[0], forged])).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['release-store-terminal-attempt-link-invalid']),
    });

    const competing = new ReleaseLifecycleFileStore(
      store.campaignDirectory.split('/').slice(0, -2).join('/'),
      value,
    );
    const concurrent = await withAuthorityHostTestScope(() =>
      store.withExecutionLock(() =>
        withReleasePrepareAuthorityFixture(request('release prepare'), () =>
          executeReleaseLifecycleAction({
            request: request('release prepare'),
            action: 'release prepare',
            authority: authorityFor('release prepare'),
            store: competing,
            resolveReceipt: () => planReceipt(),
            resolvePlanInput,
            provider: () => ({ outcome: 'success', material: materialFor('release prepare') }),
            recorded_at: '2026-09-03T00:00:00.000Z',
          }),
        ),
      ),
    );
    expect(concurrent).toMatchObject({
      ok: false,
      code: 'release-state-store-concurrent-writer',
    });
  });

  it('accepts a concurrent private-directory creation race and propagates other mkdir failures', async () => {
    const originalMkdirSync = authority.mkdirSync;
    const initializeWith = async (failure: Error & { code: string }, createDirectory: boolean) => {
      const store = new ReleaseLifecycleFileStore(root(), request('release preflight'));
      let injected = false;
      const mkdir = vi.spyOn(authority, 'mkdirSync').mockImplementation((path, options) => {
        if (!injected && path === store.campaignDirectory) {
          injected = true;
          if (createDirectory) originalMkdirSync(path, options);
          throw failure;
        }
        return originalMkdirSync(path, options);
      });
      try {
        await withAuthorityHostTestScope(() => store.initialize());
        return injected;
      } finally {
        mkdir.mockRestore();
      }
    };

    const raced = Object.assign(new Error('mkdir-EEXIST'), { code: 'EEXIST' });
    await expect(initializeWith(raced, true)).resolves.toBe(true);

    const denied = Object.assign(new Error('mkdir-EACCES'), { code: 'EACCES' });
    await expect(initializeWith(denied, false)).rejects.toBe(denied);
  });

  it('rejects independently valid store records that break append-log and attempt bindings', async () => {
    const value = request();
    const store = new ReleaseLifecycleFileStore(root(), value);
    await seedPreflight(store);
    const [attempt, completion] = store.readStoreRecords();
    const completedHead = required(store.readHead(), 'missing completed head');
    const first = required(attempt, 'missing attempt');
    const terminal = required(completion, 'missing completion');

    const refinalize = (
      record: StoreRecord,
      patch: Partial<Omit<StoreRecord, 'record_id' | 'record_digest_sha256'>>,
    ) => {
      const { record_id: _id, record_digest_sha256: _digest, ...draft } = record;
      return finalizeStoreRecord({ ...draft, ...patch });
    };
    const errorsFor = (...records: readonly StoreRecord[]) => reduceStoreRecords(records).errors;
    const attemptIdFor = (
      record: StoreRecord,
      sequence: number,
      predecessor_record: StoreRecord['predecessor_record'],
      action_id = record.action_id,
    ) =>
      `RLA-${canonicalSha256({
        request_digest_sha256: record.request_digest_sha256,
        action_id,
        sequence,
        predecessor_record,
      }).slice(0, 16)}`;

    expect(errorsFor({ ...first, record_id: 'RLE-0000000000000000' })).toContain(
      'release-state-store-record-identity-invalid',
    );
    expect(errorsFor({ ...first, record_digest_sha256: '0'.repeat(64) })).toContain(
      'release-state-store-record-identity-invalid',
    );

    const wrongAttemptId = refinalize(first, { attempt_id: 'RLA-0000000000000000' });
    expect(errorsFor(wrongAttemptId)).toContain('release-store-opening-attempt-invalid');

    const differentPredecessor = {
      sequence: first.sequence,
      record_id: first.record_id,
      record_digest_sha256: '0'.repeat(64),
    };
    const firstReference = {
      sequence: first.sequence,
      record_id: first.record_id,
      record_digest_sha256: first.record_digest_sha256,
    };
    const consecutiveAttempt = refinalize(first, {
      sequence: 1,
      predecessor_record: firstReference,
      attempt_id: attemptIdFor(first, 1, firstReference),
    });
    expect(errorsFor(first, consecutiveAttempt)).toContain(
      'release-store-attempt-predecessor-invalid',
    );

    const prematureCertification = refinalize(first, {
      action_id: 'release certify',
      attempt_id: attemptIdFor(first, 0, null, 'release certify'),
    });
    expect(errorsFor(prematureCertification)).toContain('release-state-transition-invalid');

    expect(
      errorsFor(first, refinalize(terminal, { predecessor_record: differentPredecessor })),
    ).toContain('release-store-terminal-attempt-link-invalid');

    const terminalCases: readonly [
      Partial<Omit<StoreRecord, 'record_id' | 'record_digest_sha256'>>,
      string,
    ][] = [
      [{ sequence: 2 }, 'release-state-store-sequence-invalid'],
      [{ predecessor_record: differentPredecessor }, 'release-state-store-broken-chain'],
      [{ observed_head_before: completedHead }, 'release-state-head-mismatch'],
      [
        { repository: { ...value.repository_locator, id: 'aarusso-nyx/other' } },
        'release-state-store-repository-mismatch',
      ],
      [
        {
          candidate: {
            commit: '0'.repeat(40),
            tree: value.candidate_locator.tree,
            release_units: value.candidate_locator.release_units.map((unit) => ({
              release_unit: unit.release_unit,
              version: unit.version,
              packages: unit.package_roster.map((pkg) => ({ package_id: pkg.package_id })),
            })),
          },
        },
        'release-state-store-candidate-mismatch',
      ],
      [{ attempt_id: 'RLA-0000000000000000' }, 'release-store-terminal-attempt-link-invalid'],
      [{ action_id: 'release certify' }, 'release-store-terminal-attempt-link-invalid'],
      [{ request_digest_sha256: '0'.repeat(64) }, 'release-store-terminal-attempt-link-invalid'],
      [
        {
          completion: {
            ...required(terminal.completion, 'missing completion material'),
            state: 'certified',
          },
        },
        'release-store-terminal-attempt-link-invalid',
      ],
    ];
    for (const [patch, expected] of terminalCases) {
      expect(errorsFor(first, refinalize(terminal, patch)), JSON.stringify(patch)).toContain(
        expected,
      );
    }
  });

  it('binds terminal kind, authorization, action, and observed provider dispatch', async () => {
    const refinalize = (
      record: StoreRecord,
      patch: Partial<Omit<StoreRecord, 'record_id' | 'record_digest_sha256'>>,
    ) => {
      const { record_id: _id, record_digest_sha256: _digest, ...draft } = record;
      return finalizeStoreRecord({ ...draft, ...patch });
    };
    const reference = (record: StoreRecord) => ({
      sequence: record.sequence,
      record_id: record.record_id,
      record_digest_sha256: record.record_digest_sha256,
    });

    const preflightStore = new ReleaseLifecycleFileStore(root(), request());
    await seedPreflight(preflightStore);
    const [attemptValue, completionValue] = preflightStore.readStoreRecords();
    const attempt = required(attemptValue, 'missing preflight attempt');
    const completion = required(completionValue, 'missing preflight completion');
    const completedHead = required(preflightStore.readHead(), 'missing preflight head');
    const repeated = refinalize(completion, {
      sequence: 2,
      predecessor_record: reference(completion),
      observed_head_before: completedHead,
    });
    expect(reduceStoreRecords([attempt, completion, repeated]).errors).toContain(
      'release-store-terminal-attempt-link-invalid',
    );
    const wrongAction = refinalize(completion, {
      action_id: 'release certify',
      completion: {
        ...required(completion.completion, 'missing completion material'),
        state: 'certified',
      },
    });
    expect(reduceStoreRecords([attempt, wrongAction]).errors).toContain(
      'release-store-terminal-attempt-link-invalid',
    );

    const remoteStore = new ReleaseLifecycleFileStore(root(), request('release evidence-publish'));
    await advanceToEvidencePublished(remoteStore);
    const remoteRecords = remoteStore.readStoreRecords();
    const remoteAttempt = required(remoteRecords.at(-2), 'missing remote attempt');
    const remoteCompletion = required(remoteRecords.at(-1), 'missing remote completion');
    const wrongAuthorization = refinalize(remoteCompletion, {
      authorization_event_id: 'EA-0000000000000000',
    });
    expect(
      reduceStoreRecords([...remoteRecords.slice(0, -1), wrongAuthorization]).errors,
    ).toContain('release-store-terminal-attempt-link-invalid');
    expect(remoteAttempt.record_kind).toBe('attempt');

    const exportValue = request('release export');
    const exportStore = new ReleaseLifecycleFileStore(root(), exportValue);
    await advanceToPrepared(exportStore);
    const exportProvider = providerFor('release export');
    const exported = await withReleaseExportAuthorityFixture(exportValue, () =>
      executeReleaseLifecycleAction({
        request: exportValue,
        action: 'release export',
        authority: authorityFor('release export'),
        store: exportStore,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider: async (...args) => ({
          ...(await exportProvider(...args)),
          dispatch_status: 'dispatched',
          provider_handle: 'local-export-transaction',
        }),
        artifactReader: artifactReaderFor('release prepare'),
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(exported.ok).toBe(true);
    const exportRecords = exportStore.readStoreRecords();
    const exportCompletion = required(exportRecords.at(-1), 'missing export completion');
    for (const patch of [
      {
        provider_dispatch: { status: 'unknown' as const, handle_observed: true },
        provider_handle: 'local-export-transaction',
      },
      {
        provider_dispatch: { status: 'dispatched' as const, handle_observed: false },
        provider_handle: null,
      },
    ]) {
      const invalidDispatch = refinalize(exportCompletion, patch);
      expect(reduceStoreRecords([...exportRecords.slice(0, -1), invalidDispatch]).errors).toContain(
        'release-store-terminal-attempt-link-invalid',
      );
    }
  });

  it('derives publication expectation only from trusted controls bound to request and grant', async () => {
    const initial = request('release publish');
    const store = new ReleaseLifecycleFileStore(root(), initial);
    await advanceToEvidencePublished(store);
    const value = request('release publish');
    const prior = required(store.readStateRecords().at(-1), 'missing evidence state');
    const provider = vi.fn(() => ({
      outcome: 'success' as const,
      provider_handle: 'publish-run-1',
      material: {
        release_units: prior.release_units,
        inputs: prior['inputs'],
        evidence: prior['evidence'],
        artifacts: prior['artifacts'],
        artifact_sink: prior.artifact_sink,
        publication_expectation: { destination: { exact_identifier: 'attacker' } },
      } as ReleaseStateMaterial,
    }));
    const refused = await executeReleaseLifecycleAction({
      request: value,
      action: 'release publish',
      authority: authorityFor('release publish'),
      publication_controls: {
        ...publicationControls(),
        destination: {
          ...publicationControls().destination,
          exact_identifier: 'npm:@aarusso-nyx/devai@WRONG',
        },
      },
      store,
      resolveReceipt: () => planReceipt(),
      resolvePlanInput,
      artifactReader: artifactReaderFor('release evidence-publish'),
      authorization: authorizationBridge(),
      provider,
      recorded_at: '2026-09-03T00:00:00.000Z',
    });
    expect(refused).toMatchObject({ ok: false, code: 'rpd-workflow-expectation-invalid' });
    expect(provider).not.toHaveBeenCalled();
    let authorizationBinding: AuthorizationAttemptBinding | undefined;
    const result = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release publish',
        authority: authorityFor('release publish'),
        publication_controls: publicationControls(),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        artifactReader: artifactReaderFor('release evidence-publish'),
        authorization: authorizationBridge((binding) => {
          authorizationBinding = binding;
        }),
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(authorizationBinding?.destination.operation).toBe('publish');
    expect(result.state['publication_expectation']).toMatchObject(publicationControls());
    expect(
      objectValue(objectValue(result.state['publication_expectation'])['destination'])[
        'exact_identifier'
      ],
    ).toBe('npm:@aarusso-nyx/devai@1.5.0');
  });

  it.each([
    'missing-controls',
    'destination-system',
    'destination-operation',
    'workflow-repository',
    'absolute-workflow-path',
    'parent-workflow-path',
    'backslash-workflow-path',
    'nul-workflow-path',
    'empty-workflow-path',
    'workflow-sha',
    'workflow-sha-prefix',
    'workflow-sha-suffix',
    'protected-environment',
    'unprotected-workflow',
    'trust',
  ] as const)('rejects malformed protected publication controls: %s', async (defect) => {
    const initial = request('release publish');
    const store = new ReleaseLifecycleFileStore(root(), initial);
    await advanceToEvidencePublished(store);
    const exact = publicationControls();
    const workflowPath =
      defect === 'absolute-workflow-path'
        ? '/release.yml'
        : defect === 'parent-workflow-path'
          ? '.github/../release.yml'
          : defect === 'backslash-workflow-path'
            ? '.github\\release.yml'
            : defect === 'nul-workflow-path'
              ? '.github/\0release.yml'
              : defect === 'empty-workflow-path'
                ? ''
                : exact.workflow.workflow_path;
    const controls =
      defect === 'missing-controls'
        ? undefined
        : ({
            ...exact,
            destination: {
              ...exact.destination,
              ...(defect === 'destination-system' ? { system_id: 'evidence-destination' } : {}),
              ...(defect === 'destination-operation' ? { operation: 'create' } : {}),
            },
            workflow: {
              ...exact.workflow,
              workflow_path: workflowPath,
              ...(defect === 'workflow-repository' ? { repository: 'aarusso-nyx/other' } : {}),
              ...(defect === 'workflow-sha' ? { workflow_sha: 'not-a-commit' } : {}),
              ...(defect === 'workflow-sha-prefix' ? { workflow_sha: `z${'f'.repeat(40)}` } : {}),
              ...(defect === 'workflow-sha-suffix' ? { workflow_sha: `${'f'.repeat(40)}z` } : {}),
              ...(defect === 'protected-environment' ? { protected_environment: '' } : {}),
              ...(defect === 'unprotected-workflow' ? { protected: false } : {}),
            },
            ...(defect === 'trust'
              ? { trust: { ...exact.trust, trust_store_digest_sha256: 'f'.repeat(64) } }
              : {}),
          } as PublicationControls);
    const provider = vi.fn(() => ({ outcome: 'unknown' as const }));
    const result = await executeReleaseLifecycleAction({
      request: request('release publish'),
      action: 'release publish',
      authority: authorityFor('release publish'),
      publication_controls: controls,
      store,
      resolveReceipt: () => planReceipt(),
      resolvePlanInput,
      artifactReader: artifactReaderFor('release evidence-publish'),
      authorization: authorizationBridge(),
      provider,
      recorded_at: '2026-09-03T00:00:00.000Z',
    });
    expect(result).toMatchObject({
      ok: false,
      phase: 'validation',
      code: 'rpd-workflow-expectation-invalid',
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it('observes publication only from an exact signed receipt for the dispatched state', async () => {
    await withAuthorityHostTestScope(async () => {
      const value = request('release publish');
      const store = new ReleaseLifecycleFileStore(root(), value);
      const dispatched = await advanceToPublicationDispatched(store);
      const receipt = boundPublicationReceipt(dispatched);
      const parsedReceipt = schemaParsers.releasePublicationReceipt.safeParse(receipt);
      if (!parsedReceipt.ok) throw new Error(JSON.stringify(parsedReceipt.error.issues));
      const verifySignature = vi.fn(() => true);
      const observation = await resumeReleaseLifecycleExecution({
        states: store.readStateRecords(),
        store_records: store.readStoreRecords(),
        store_head: store.readHead(),
        repository: value.repository_locator,
        candidate: dispatched['candidate'] as ReleaseLifecycleStateV2['candidate'],
        candidate_locator: value.candidate_locator,
        receipt_documents: [planReceipt()],
        resolve_plan_input: resolvePlanInput,
        publication_receipt: receipt,
        verify_signature: verifySignature,
      });

      expect(observation).toMatchObject({
        next_action: null,
        next_outcome: 'complete',
        published: {
          observed: true,
          receipt: {
            kind: 'release-publication-receipt',
            receipt_id: receipt['receipt_id'],
            receipt_digest_sha256: receipt['receipt_digest_sha256'],
            signature_verified: true,
          },
          verified_against: {
            state: 'publication_dispatched',
            state_id: dispatched['state_id'],
            record_digest_sha256: dispatched['record_digest_sha256'],
            candidate_identity_verified: true,
            artifact_identity_verified: true,
            destination_identity_verified: true,
            workflow_identity_verified: true,
            trust_identity_verified: true,
          },
        },
        derived_states: expect.arrayContaining([
          {
            state: 'published',
            receipt_kind: 'release-publication-receipt',
            receipt_id: receipt['receipt_id'],
            receipt_digest_sha256: receipt['receipt_digest_sha256'],
            verified: true,
          },
        ]),
      });
      expect(verifySignature).toHaveBeenCalledWith({
        signed_payload_digest_sha256: objectValue(receipt['trust'])['signed_payload_digest_sha256'],
        signature: 'AQ==',
        trust: publicationControls().trust,
      });
    });
  });

  it('rejects independently rehashed publication receipt identity and trust substitutions', async () => {
    await withAuthorityHostTestScope(async () => {
      const value = request('release publish');
      const store = new ReleaseLifecycleFileStore(root(), value);
      const dispatched = await advanceToPublicationDispatched(store);
      const candidate = dispatched['candidate'] as ReleaseLifecycleStateV2['candidate'];
      const expectation = objectValue(dispatched['publication_expectation']);
      const exact = boundPublicationReceipt(dispatched);
      const common = {
        states: store.readStateRecords(),
        store_records: store.readStoreRecords(),
        store_head: store.readHead(),
        repository: value.repository_locator,
        candidate,
        candidate_locator: value.candidate_locator,
        receipt_documents: [planReceipt()],
        resolve_plan_input: resolvePlanInput,
      };
      const rehashWholeReceipt = (receipt: Readonly<Record<string, unknown>>) => {
        const { receipt_digest_sha256: _digest, ...projection } = receipt;
        return { ...projection, receipt_digest_sha256: canonicalSha256(projection) };
      };
      const cases: readonly [string, Readonly<Record<string, unknown>>][] = [
        [
          'repository',
          boundPublicationReceipt(dispatched, {
            repository: { ...objectValue(dispatched['repository']), commit: 'f'.repeat(40) },
          }),
        ],
        [
          'candidate',
          boundPublicationReceipt(dispatched, {
            candidate: { ...candidate, tree: 'f'.repeat(40) },
          }),
        ],
        [
          'dispatched state',
          boundPublicationReceipt(dispatched, {
            dispatched_state: {
              state: 'publication_dispatched',
              state_id: dispatched['state_id'],
              record_digest_sha256: 'f'.repeat(64),
            },
          }),
        ],
        [
          'artifact set',
          boundPublicationReceipt(dispatched, {
            artifacts: [
              {
                ...objectValue((dispatched['artifacts'] as readonly unknown[])[0]),
                sha256: 'f'.repeat(64),
              },
            ],
          }),
        ],
        [
          'destination',
          boundPublicationReceipt(dispatched, {
            publication: {
              ...objectValue(expectation['destination']),
              exact_identifier: 'npm:@aarusso-nyx/devai@1.5.1',
            },
          }),
        ],
        [
          'workflow',
          boundPublicationReceipt(dispatched, {
            workflow: {
              ...objectValue(exact['workflow']),
              workflow_sha: 'f'.repeat(40),
            },
          }),
        ],
        [
          'trust',
          boundPublicationReceipt(dispatched, {
            trust: {
              ...objectValue(expectation['trust']),
              key_id: 'substituted-release-key',
            },
          }),
        ],
        ['receipt id', rehashWholeReceipt({ ...exact, receipt_id: `RPU-${'f'.repeat(16)}` })],
        ['receipt digest', { ...exact, receipt_digest_sha256: 'f'.repeat(64) }],
        [
          'signed payload digest',
          rehashWholeReceipt({
            ...exact,
            trust: {
              ...objectValue(exact['trust']),
              signed_payload_digest_sha256: 'f'.repeat(64),
            },
          }),
        ],
      ];

      for (const [label, publicationReceipt] of cases) {
        const verifySignature = vi.fn(() => true);
        const observation = await resumeReleaseLifecycleExecution({
          ...common,
          publication_receipt: publicationReceipt,
          verify_signature: verifySignature,
        });
        expect(observation, label).toMatchObject({
          next_action: 'release resume',
          next_outcome: 'awaiting-external-receipt',
          published: { observed: false, receipt: null, verified_against: null },
        });
      }

      const rejectedSignature = vi.fn(() => false);
      await expect(
        resumeReleaseLifecycleExecution({
          ...common,
          publication_receipt: exact,
          verify_signature: rejectedSignature,
        }),
      ).resolves.toMatchObject({
        next_action: 'release resume',
        next_outcome: 'awaiting-external-receipt',
        published: { observed: false },
      });
      expect(rejectedSignature).toHaveBeenCalledOnce();
    });
  });

  it('derives resume states only from verified receipts and ignores caller booleans', async () => {
    const candidate = {
      release_unit: '@aarusso-nyx/devai',
      version: '1.5.0',
      commit: COMMIT,
      tree: TREE,
    } as const;
    const forged = await resumeReleaseLifecycleExecution({
      states: [],
      repository: { id: 'aarusso-nyx/devai', commit: COMMIT, tree: TREE },
      candidate,
      derived_states: [
        {
          state: 'offline_verified',
          receipt_kind: 'release-offline-verification-receipt',
          receipt_id: `ROV-${'a'.repeat(16)}`,
          receipt_digest_sha256: 'a'.repeat(64),
          verified: true,
        },
      ],
    } as Parameters<typeof resumeReleaseLifecycleExecution>[0] & {
      readonly derived_states: readonly unknown[];
    });
    expect(forged).toMatchObject({
      derived_states: [],
      next_action: 'release plan',
      next_outcome: 'ready',
    });

    const planned = await resumeReleaseLifecycleExecution({
      states: [],
      repository: { id: 'aarusso-nyx/devai', commit: COMMIT, tree: TREE },
      candidate,
      receipt_documents: [planReceipt()],
      resolve_plan_input: resolvePlanInput,
    });
    expect(planned).toMatchObject({ next_action: 'release preflight', next_outcome: 'ready' });
  });

  it('binds a resolved resume receipt to every locator identity field', async () => {
    const receipt = planReceipt();
    const exact = receiptLocator(receipt);
    const common = {
      states: [],
      repository: { id: 'aarusso-nyx/devai', commit: COMMIT, tree: TREE },
      candidate: {
        release_unit: '@aarusso-nyx/devai',
        version: '1.5.0',
        commit: COMMIT,
        tree: TREE,
      },
      resolve_receipt: () => receipt,
      resolve_plan_input: resolvePlanInput,
    } as const;

    await expect(
      resumeReleaseLifecycleExecution({ ...common, receipt_locators: [exact] }),
    ).resolves.toMatchObject({ next_action: 'release preflight', next_outcome: 'ready' });

    for (const locator of [
      { ...exact, kind: 'release-offline-verification-receipt' as const },
      { ...exact, receipt_id: `RPL-${'f'.repeat(16)}` },
      { ...exact, receipt_digest_sha256: 'f'.repeat(64) },
    ]) {
      await expect(
        resumeReleaseLifecycleExecution({ ...common, receipt_locators: [locator] }),
      ).resolves.toMatchObject({
        derived_states: [],
        next_action: null,
        next_outcome: 'blocked',
        blocked_reason: 'receipt-identity-mismatch',
      });
    }
  });

  it('retains every portable legacy artifact kind in an offline projection', () => {
    const schema = JSON.parse(
      readFileSync(join(process.cwd(), 'law/schemas/release-lifecycle-state.schema.json'), 'utf8'),
    ) as { examples: readonly Readonly<Record<string, unknown>>[] };
    const example = required(schema.examples[0], 'missing lifecycle state fixture');
    const {
      state_id: _stateId,
      record_digest_sha256: _recordDigest,
      ...draft
    } = example as unknown as ReleaseLifecycleStateV2;
    const portableKinds = [
      'package-tarball',
      'evidence-bundle',
      'manifest',
      'attestation',
    ] as const;
    const portable = portableKinds.map((kind) => ({
      kind,
      path: `artifacts/${kind}.json`,
      sha256: canonicalSha256(kind),
      size_bytes: kind.length,
    }));
    const localOnly = {
      kind: 'sbom',
      path: 'artifacts/local-sbom.json',
      sha256: canonicalSha256('sbom'),
      size_bytes: 4,
    };
    const state = finalizeReleaseStateV2({ ...draft, artifacts: [...portable, localOnly] });

    expect(offlineArtifactProjection(state)).toEqual(expect.arrayContaining(portable));
    expect(offlineArtifactProjection(state)).not.toContainEqual(localOnly);
  });

  it('offline-verifies exact v2 package and external trust closure without writing state', async () => {
    const value = request('release export');
    const store = new ReleaseLifecycleFileStore(root(), value);
    await advanceToExported(store);
    const exported = required(store.readStateRecords().at(-1), 'missing exported state');
    const offlineRequest = request('release offline-verify');
    expect(
      await executeOfflineVerification({
        request: offlineRequest,
        exported_state: exported,
        artifactReader: artifactReaderFor('release export'),
        policyClosures,
      }),
    ).toMatchObject({
      ok: false,
      phase: 'provider',
      code: 'release-offline-verifier-provider-unavailable',
    });

    const provider = () => boundOfflineReceipt(exported);
    expect(
      await executeOfflineVerification({
        request: offlineRequest,
        exported_state: exported,
        artifactReader: artifactReaderFor('release export'),
        provider,
        policyClosures,
      }),
    ).toMatchObject({ ok: true });

    const drifted = request('release offline-verify');
    const destination = required(drifted.destination, 'missing offline destination');
    const trust = required(destination.trust, 'missing offline trust');
    const mismatched = {
      ...drifted,
      destination: {
        ...destination,
        trust: { ...trust, key_id: 'different-release-key' },
      },
    };
    expect(
      await executeOfflineVerification({
        request: mismatched,
        exported_state: exported,
        artifactReader: artifactReaderFor('release export'),
        provider,
        policyClosures,
      }),
    ).toMatchObject({ ok: false, code: 'release-offline-receipt-binding-invalid' });
  });

  it('refuses a rehashed offline receipt that changes any exported-state identity field', async () => {
    const store = new ReleaseLifecycleFileStore(root(), request('release export'));
    await advanceToExported(store);
    const exported = required(store.readStateRecords().at(-1), 'missing exported state');
    const offlineRequest = request('release offline-verify');
    const validReceipt = boundOfflineReceipt(exported);
    const repository = objectValue(validReceipt['repository']);
    const candidate = objectValue(validReceipt['candidate']);
    const verifiedState = objectValue(validReceipt['verified_state']);
    const defects = [
      ['digest', { ...validReceipt, receipt_digest_sha256: 'f'.repeat(64) }],
      ['receipt id', { ...validReceipt, receipt_id: `ROV-${'f'.repeat(16)}` }],
      ['verdict', rehashReceipt(validReceipt, { verdict: 'fail', state_observed: null })],
      [
        'repository',
        rehashReceipt(validReceipt, {
          repository: { ...repository, id: `${String(repository['id'])}-other` },
        }),
      ],
      [
        'candidate',
        rehashReceipt(validReceipt, {
          candidate: { ...candidate, tree: 'f'.repeat(40) },
        }),
      ],
      [
        'verified state',
        rehashReceipt(validReceipt, {
          verified_state: { ...verifiedState, record_digest_sha256: 'f'.repeat(64) },
        }),
      ],
    ] as const;

    for (const [name, receipt] of defects) {
      expect(
        await executeOfflineVerification({
          request: offlineRequest,
          exported_state: exported,
          artifactReader: artifactReaderFor('release export'),
          provider: () => receipt,
          policyClosures,
        }),
        name,
      ).toStrictEqual({
        ok: false,
        phase: 'validation',
        code: 'release-offline-receipt-binding-invalid',
      });
    }
  });

  it('issues offline context only during a validated provider invocation and binds its inputs', async () => {
    const store = new ReleaseLifecycleFileStore(root(), request('release export'));
    await advanceToExported(store);
    const exported = required(store.readStateRecords().at(-1), 'missing exported state');
    const offlineRequest = request('release offline-verify');
    let retained: VerifiedReleaseOfflineContext | undefined;
    expect(() =>
      readVerifiedReleaseOfflineContext(
        { kind: 'verified-release-offline-context' },
        offlineRequest,
        exported,
      ),
    ).toThrow('release-offline-verification-context-invalid');
    const result = await executeOfflineVerification({
      request: offlineRequest,
      exported_state: exported,
      artifactReader: artifactReaderFor('release export'),
      policyClosures,
      provider: (validatedRequest, validatedState, context) => {
        retained = context;
        const captured = readVerifiedReleaseOfflineContext(
          context,
          validatedRequest,
          validatedState,
        );
        expect(captured.plan_receipts).toEqual([planReceipt()]);
        expect(() =>
          readVerifiedReleaseOfflineContext(
            context,
            {
              ...validatedRequest,
              request_id: 'changed-request',
            },
            validatedState,
          ),
        ).toThrow('release-offline-verification-context-invalid');
        // Consumers receive a copy and cannot change the captured validation.
        (captured.plan_receipts as unknown[]).length = 0;
        expect(
          readVerifiedReleaseOfflineContext(context, validatedRequest, validatedState)
            .plan_receipts,
        ).toHaveLength(1);
        return boundOfflineReceipt(exported);
      },
    });
    expect(result).toMatchObject({ ok: true });
    expect(retained).toBeDefined();
    expect(() => readVerifiedReleaseOfflineContext(retained, offlineRequest, exported)).toThrow(
      'release-offline-verification-context-invalid',
    );
  });

  it('binds current mutation-none evidence to verified plans and rejects a rehashed substitution', async () => {
    const store = new ReleaseLifecycleFileStore(root(), request('release export'));
    await advanceToExported(store);
    const exported = required(store.readStateRecords().at(-1), 'missing exported state');
    const offlineRequest = request('release offline-verify');
    for (const substitute of [false, true]) {
      const result = await executeOfflineVerification({
        request: offlineRequest,
        exported_state: exported,
        artifactReader: artifactReaderFor('release export'),
        policyClosures,
        provider: (validatedRequest, validatedState, context) => {
          const check = createVerifiedReleaseMutationCheck(
            context,
            validatedRequest,
            validatedState,
          );
          expect(check['status']).toBe('not-applicable');
          expect(check['evidence_kind']).toBe('devai.release-unit-mutation-check.v1');
          expect(check).not.toHaveProperty('mutation_report_id');
          const receipt = boundOfflineReceipt(exported);
          const checks = [...(receipt['checks'] as unknown[])];
          checks[8] = substitute
            ? {
                ...check,
                units: (check['units'] as Readonly<Record<string, unknown>>[]).map((unit) => ({
                  ...unit,
                  plan_receipt_digest_sha256: 'a'.repeat(64),
                })),
              }
            : check;
          return rehashReceipt(receipt, { checks });
        },
      });
      expect(result).toMatchObject(
        substitute
          ? {
              ok: false,
              code: 'release-offline-receipt-binding-invalid',
            }
          : { ok: true },
      );
    }
  });

  it('refuses portable export evidence when mixed release units require independent plans', async () => {
    const input = await mixedMutationCertificationFixture();
    const resolveReceipt = (locator: { readonly receipt_digest_sha256: string }) =>
      required(
        input.receipts.find(
          (receipt) => receipt['receipt_digest_sha256'] === locator.receipt_digest_sha256,
        ),
        'missing mixed export receipt',
      );
    const token = await createReleaseExportMutationEvidence({
      request: { ...input.request, action_id: 'release prepare' },
      material: input.material,
      source: requiredMutationEvidenceSink(input.evidence),
      plan: {
        resolve_receipt: resolveReceipt,
        resolve_plan_input: input.resolve_plan_input,
      },
      maximum_provider_result_bytes: 1_000_000,
    });

    expect(() =>
      readReleaseExportMutationEvidence(token, {
        repository: input.request.repository_locator,
        plan_receipt_digest_sha256: String(input.receipts[0]?.['receipt_digest_sha256']),
        release_units: input.material.release_units,
        inputs: input.material.inputs,
      }),
    ).toThrow('release-export-artifact-sink-protocol-invalid');
  });

  it('binds required mutation evidence into a verified current export check', async () => {
    const store = new ReleaseLifecycleFileStore(root(), request('release export'));
    await advanceToExported(store);
    const template = required(store.readStateRecords().at(-1), 'missing exported template');
    const fixture = await requiredExportFixture(template);

    const result = await executeOfflineVerification({
      request: fixture.request,
      exported_state: fixture.state,
      artifactReader: fixture.artifactReader,
      exportLimits: fixture.limits,
      policyClosures: fixture.policyClosures,
      provider: (validatedRequest, validatedState, context) => {
        const check = createVerifiedReleaseMutationCheck(context, validatedRequest, validatedState);
        expect(check).toMatchObject({
          check_id: 'mutation-semantics',
          evidence_kind: 'devai.release-unit-mutation-check.v1',
          status: 'pass',
          units: [
            {
              release_unit: '@aarusso-nyx/devai',
              requirement: 'required',
            },
          ],
        });
        const receipt = boundOfflineReceipt(fixture.state);
        const checks = [...(receipt['checks'] as readonly unknown[])];
        checks[8] = check;
        return rehashReceipt(receipt, { checks });
      },
    });

    expect(result).toMatchObject({ ok: true });
  });

  it('binds an optional v2.1 unit mutation closure into offline receipts without claiming portable mutation semantics', async () => {
    const store = new ReleaseLifecycleFileStore(root(), request('release export'));
    await advanceToExported(store);
    const exported = required(store.readStateRecords().at(-1), 'missing exported state');
    const omittedStateReceipt = boundOfflineReceipt(exported);
    expect(
      (omittedStateReceipt['release_units'] as readonly Readonly<Record<string, unknown>>[])[0],
    ).not.toHaveProperty('mutation_evidence');
    const mutation = await requiredMutationCertificationFixture();
    const closureBound = exportedWithMutationEvidence(exported, mutation.evidence.closure);
    const matchingReceipt = boundOfflineReceipt(closureBound);
    const matchingUnits = matchingReceipt['release_units'] as readonly Readonly<
      Record<string, unknown>
    >[];
    expect(matchingUnits[0]?.['mutation_evidence']).toEqual(mutation.evidence.closure);

    const offlineRequest = request('release offline-verify');
    const run = (receipt: Readonly<Record<string, unknown>>) =>
      executeOfflineVerification({
        request: offlineRequest,
        exported_state: closureBound,
        artifactReader: artifactReaderFor('release export'),
        provider: () => receipt,
        policyClosures,
      });
    await expect(run(matchingReceipt)).resolves.toMatchObject({ ok: true });

    const omitted = rehashReceipt(matchingReceipt, {
      release_units: matchingUnits.map(({ mutation_evidence: _closure, ...unit }) => unit),
    });
    await expect(run(omitted)).resolves.toMatchObject({
      ok: false,
      code: 'release-offline-receipt-binding-invalid',
    });

    const firstMember = required(
      mutation.evidence.closure.members[0],
      'missing mutation closure member',
    );
    const substitutedClosure = {
      ...mutation.evidence.closure,
      members: [
        { ...firstMember, sha256: '0'.repeat(64) },
        ...mutation.evidence.closure.members.slice(1),
      ],
    };
    const substituted = rehashReceipt(matchingReceipt, {
      release_units: matchingUnits.map((unit) => ({
        ...unit,
        mutation_evidence: substitutedClosure,
      })),
    });
    await expect(run(substituted)).resolves.toMatchObject({
      ok: false,
      code: 'release-offline-receipt-binding-invalid',
    });

    const explicitNull = exportedWithMutationEvidence(exported, null);
    const nullReceipt = boundOfflineReceipt(explicitNull);
    expect(
      (nullReceipt['release_units'] as readonly Readonly<Record<string, unknown>>[])[0],
    ).toHaveProperty('mutation_evidence', null);
    await expect(
      executeOfflineVerification({
        request: offlineRequest,
        exported_state: explicitNull,
        artifactReader: artifactReaderFor('release export'),
        provider: () => nullReceipt,
        policyClosures,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('separates append-log tail from completed-state head and permits a fresh retry', async () => {
    const value = request('release prepare');
    const store = new ReleaseLifecycleFileStore(root(), value);
    await seedCertified(store);
    const failed = await withReleasePrepareAuthorityFixture(value, () =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release prepare',
        authority: authorityFor('release prepare'),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider: () => ({ outcome: 'failure', code: 'release-prepare-failed' }),
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(failed, JSON.stringify(failed)).toMatchObject({ ok: false, phase: 'provider' });
    const localFailureObservation = await resumeReleaseLifecycleExecution({
      states: store.readStateRecords(),
      store_records: store.readStoreRecords(),
      store_head: store.readHead(),
      repository: value.repository_locator,
      candidate: {
        release_unit: value.candidate_locator.release_units[0]?.release_unit ?? '',
        version: value.candidate_locator.release_units[0]?.version ?? '',
        commit: value.candidate_locator.commit,
        tree: value.candidate_locator.tree,
      },
      candidate_locator: value.candidate_locator,
      receipt_documents: [planReceipt()],
      resolve_plan_input: resolvePlanInput,
    });
    expect(localFailureObservation).toMatchObject({
      next_action: 'release prepare',
      next_outcome: 'ready',
    });
    const passed = await withReleasePrepareAuthorityFixture(value, () =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release prepare',
        authority: authorityFor('release prepare'),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider: () => ({ outcome: 'success', material: materialFor('release prepare') }),
        recorded_at: '2026-09-03T00:00:01.000Z',
      }),
    );
    expect(passed.ok).toBe(true);
    const records = store.readStoreRecords();
    expect(records.map((record) => record.record_kind)).toEqual([
      'attempt',
      'completion',
      'attempt',
      'completion',
      'attempt',
      'failure',
      'attempt',
      'completion',
    ]);
    expect(records.slice(-4).every((record) => record.observed_head_before !== null)).toBe(true);
    expect(records[6]?.predecessor_record).toMatchObject({ record_id: records[5]?.record_id });
    expect(reduceStoreRecords(records)).toMatchObject({
      ok: true,
      failed: false,
      ambiguous: false,
    });
  });

  it('requires a new exact Owner grant for a remote retry and never retries unknown', async () => {
    const initial = request('release evidence-publish');
    const store = new ReleaseLifecycleFileStore(root(), initial);
    await advanceToExported(store);
    const exported = required(store.readStateRecords().at(-1), 'missing exported state');
    const receipt = boundOfflineReceipt(exported);
    const value = request('release evidence-publish', receipt);
    const common = {
      request: value,
      action: 'release evidence-publish' as const,
      authority: authorityFor('release evidence-publish'),
      store,
      resolveReceipt: () => receipt,
      resolvePlanInput,
      offlineReceiptVerifier: {
        verify: ({ receipt: document }: { receipt: typeof receipt }) => document,
      },
      artifactReader: artifactReaderFor('release export'),
      recorded_at: '2026-09-03T00:00:00.000Z',
    };
    const first = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        ...common,
        authorization: authorizationBridge(),
        provider: () => ({
          outcome: 'failure',
          dispatch_status: 'failed-before-dispatch',
          code: 'release-dispatch-refused',
        }),
      }),
    );
    expect(first, JSON.stringify(first)).toMatchObject({ ok: false, phase: 'provider' });
    const blockedRetry = await resumeReleaseLifecycleExecution({
      states: store.readStateRecords(),
      store_records: store.readStoreRecords(),
      store_head: store.readHead(),
      repository: value.repository_locator,
      candidate: exported.candidate,
      candidate_locator: value.candidate_locator,
      receipt_documents: [planReceipt(), receipt],
      resolve_plan_input: resolvePlanInput,
      offline_receipt_verifier: { verify: ({ receipt: document }) => document },
    });
    expect(blockedRetry).toMatchObject({
      next_action: 'release evidence-publish',
      next_outcome: 'blocked',
      blocked_reason: 'fresh-exact-authorization-required',
      blocked_requirements: ['fresh_exact_owner_authorization_required'],
    });
    const sameGrantProvider = vi.fn(() => ({ outcome: 'unknown' as const }));
    const stale = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        ...common,
        authorization: authorizationBridge(),
        provider: sameGrantProvider,
      }),
    );
    expect(stale).toMatchObject({ ok: false, code: 'fresh-exact-authorization-required' });
    expect(sameGrantProvider).not.toHaveBeenCalled();
    const retried = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        ...common,
        authorization: authorizationBridge(undefined, '2026-09-03T00:00:01.000Z'),
        provider: () => ({
          outcome: 'success',
          provider_handle: 'evidence-retry-2',
          material: materialFor('release evidence-publish'),
        }),
      }),
    );
    expect(retried.ok).toBe(true);
  });

  it('rejects a shape-valid plan receipt unless the semantic plan kernel reproduces it', async () => {
    const valid = planReceipt();
    const determination = objectValue(valid['determination']);
    const forged = rehashReceipt(valid, {
      determination: { ...determination, capabilities: ['lint'] },
    });
    const value = {
      ...request('release preflight'),
      receipt_locators: [receiptLocator(forged)],
    } as ReleaseLifecycleRequest;
    const provider = vi.fn(() => ({ outcome: 'success' as const, material: material() }));
    const result = await executeReleaseLifecycleAction({
      request: value,
      action: 'release preflight',
      authority: authorityFor('release preflight'),
      store: new ReleaseLifecycleFileStore(root(), value),
      resolveReceipt: () => forged,
      resolvePlanInput,
      provider,
      recorded_at: '2026-09-03T00:00:00.000Z',
    });
    expect(result).toMatchObject({ ok: false, code: 'rpl-semantic-verification-not-performed' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('requires the trusted external verifier before evidence publication authorization', async () => {
    const initial = request('release evidence-publish');
    const store = new ReleaseLifecycleFileStore(root(), initial);
    await advanceToExported(store);
    const exported = required(store.readStateRecords().at(-1), 'missing exported state');
    const receipt = boundOfflineReceipt(exported);
    const value = request('release evidence-publish', receipt);
    const provider = vi.fn(() => ({ outcome: 'unknown' as const }));
    const authorization = authorizationBridge();
    const resolve = vi.spyOn(authorization, 'resolve');
    const verifier = vi.fn(() =>
      rehashReceipt(receipt, {
        candidate: { ...objectValue(receipt['candidate']), tree: 'f'.repeat(40) },
      }),
    );
    const result = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release evidence-publish',
        authority: authorityFor('release evidence-publish'),
        store,
        resolveReceipt: () => receipt,
        resolvePlanInput,
        offlineReceiptVerifier: { verify: verifier },
        artifactReader: artifactReaderFor('release export'),
        authorization,
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'rov-semantic-verification-not-performed' });
    expect(verifier).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it('recomputes the complete durable authorization ledger chain and exact head', async () => {
    const initial = request('release evidence-publish');
    const store = new ReleaseLifecycleFileStore(root(), initial);
    await advanceToExported(store);
    const exported = required(store.readStateRecords().at(-1), 'missing exported state');
    const receipt = boundOfflineReceipt(exported);
    const value = request('release evidence-publish', receipt);
    const valid = authorizationBridge();
    const forged: AuthorizationBridge = {
      ...valid,
      resolve: async (binding) => {
        const resolution = await valid.resolve(binding);
        if (!resolution.ok) return resolution;
        return {
          ...resolution,
          ledger: {
            ...objectValue(resolution.ledger),
            head: {
              ...objectValue(objectValue(resolution.ledger)['head']),
              event_digest_sha256: 'f'.repeat(64),
            },
          },
        };
      },
    };
    const provider = vi.fn(() => ({ outcome: 'unknown' as const }));
    const result = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release evidence-publish',
        authority: authorityFor('release evidence-publish'),
        store,
        resolveReceipt: () => receipt,
        resolvePlanInput,
        offlineReceiptVerifier: { verify: ({ receipt: document }) => document },
        artifactReader: artifactReaderFor('release export'),
        authorization: forged,
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      phase: 'authorization',
      code: 'release-authorization-attempt-binding-invalid',
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects authorization ledger entries that have no supplied event', async () => {
    const initial = request('release evidence-publish');
    const store = new ReleaseLifecycleFileStore(root(), initial);
    await advanceToExported(store);
    const exported = required(store.readStateRecords().at(-1), 'missing exported state');
    const receipt = boundOfflineReceipt(exported);
    const value = request('release evidence-publish', receipt);
    const valid = authorizationBridge();
    const forged: AuthorizationBridge = {
      ...valid,
      resolve: async (binding) => {
        const resolution = await valid.resolve(binding);
        if (!resolution.ok) return resolution;
        const grant = required(resolution.events[0], 'missing authorization grant');
        const consumed = await valid.consume({
          ...binding,
          grant_event_id: String(grant['event_id']),
        });
        return {
          ...resolution,
          ledger: {
            ...objectValue(consumed.ledger),
            head: objectValue(objectValue(resolution.ledger)['head']),
          },
        };
      },
    };
    const provider = vi.fn(() => ({ outcome: 'unknown' as const }));

    const result = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release evidence-publish',
        authority: authorityFor('release evidence-publish'),
        store,
        resolveReceipt: () => receipt,
        resolvePlanInput,
        offlineReceiptVerifier: { verify: ({ receipt: document }) => document },
        artifactReader: artifactReaderFor('release export'),
        authorization: forged,
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      phase: 'authorization',
      code: 'release-authorization-attempt-binding-invalid',
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    ['sequence', { sequence: 2 }],
    ['event-id', { event_id: 'EA-0000000000000000' }],
  ] as const)(
    'binds the authorization ledger head %s to its terminal event',
    async (_label, head) => {
      const initial = request('release evidence-publish');
      const store = new ReleaseLifecycleFileStore(root(), initial);
      await advanceToExported(store);
      const exported = required(store.readStateRecords().at(-1), 'missing exported state');
      const receipt = boundOfflineReceipt(exported);
      const value = request('release evidence-publish', receipt);
      const valid = authorizationBridge();
      const forged: AuthorizationBridge = {
        ...valid,
        resolve: async (binding) => {
          const resolution = await valid.resolve(binding);
          if (!resolution.ok) return resolution;
          const ledger = objectValue(resolution.ledger);
          return {
            ...resolution,
            ledger: {
              ...ledger,
              head: { ...objectValue(ledger['head']), ...head },
            },
          };
        },
      };
      const provider = vi.fn(() => ({ outcome: 'unknown' as const }));
      const result = await withAuthorityHostTestScope(() =>
        executeReleaseLifecycleAction({
          request: value,
          action: 'release evidence-publish',
          authority: authorityFor('release evidence-publish'),
          store,
          resolveReceipt: () => receipt,
          resolvePlanInput,
          offlineReceiptVerifier: { verify: ({ receipt: document }) => document },
          artifactReader: artifactReaderFor('release export'),
          authorization: forged,
          provider,
          recorded_at: '2026-09-03T00:00:00.000Z',
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        phase: 'authorization',
        code: 'release-authorization-attempt-binding-invalid',
      });
      expect(provider).not.toHaveBeenCalled();
    },
  );

  it.each(['payload-digest', 'event-id'] as const)(
    'recomputes the authorization event %s before accepting its ledger entry',
    async (defect) => {
      const initial = request('release evidence-publish');
      const store = new ReleaseLifecycleFileStore(root(), initial);
      await advanceToExported(store);
      const exported = required(store.readStateRecords().at(-1), 'missing exported state');
      const receipt = boundOfflineReceipt(exported);
      const value = request('release evidence-publish', receipt);
      const valid = authorizationBridge();
      const forged: AuthorizationBridge = {
        ...valid,
        resolve: async (binding) => {
          const resolution = await valid.resolve(binding);
          if (!resolution.ok) return resolution;
          const event = {
            ...objectValue(required(resolution.events[0], 'missing authorization event')),
            ...(defect === 'payload-digest' ? { payload_digest_sha256: 'f'.repeat(64) } : {}),
            ...(defect === 'event-id' ? { event_id: 'EA-0000000000000000' } : {}),
          };
          return { ...resolution, events: [event], ledger: authorizationLedger([event]) };
        },
      };
      const provider = vi.fn(() => ({ outcome: 'unknown' as const }));
      const result = await withAuthorityHostTestScope(() =>
        executeReleaseLifecycleAction({
          request: value,
          action: 'release evidence-publish',
          authority: authorityFor('release evidence-publish'),
          store,
          resolveReceipt: () => receipt,
          resolvePlanInput,
          offlineReceiptVerifier: { verify: ({ receipt: document }) => document },
          artifactReader: artifactReaderFor('release export'),
          authorization: forged,
          provider,
          recorded_at: '2026-09-03T00:00:00.000Z',
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        phase: 'authorization',
        code: 'release-authorization-attempt-binding-invalid',
      });
      expect(provider).not.toHaveBeenCalled();
    },
  );

  it('accepts the exact recomputed authorization event identity', async () => {
    const initial = request('release evidence-publish');
    const store = new ReleaseLifecycleFileStore(root(), initial);
    await advanceToExported(store);
    const exported = required(store.readStateRecords().at(-1), 'missing exported state');
    const receipt = boundOfflineReceipt(exported);
    const value = request('release evidence-publish', receipt);
    const provider = vi.fn(() => ({ outcome: 'unknown' as const, provider_handle: 'run-1' }));
    const result = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release evidence-publish',
        authority: authorityFor('release evidence-publish'),
        store,
        resolveReceipt: () => receipt,
        resolvePlanInput,
        offlineReceiptVerifier: { verify: ({ receipt: document }) => document },
        artifactReader: artifactReaderFor('release export'),
        authorization: authorizationBridge(),
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      phase: 'ambiguous',
      code: 'release-provider-result-unknown',
    });
    expect(provider).toHaveBeenCalledOnce();
    expect(store.readStoreRecords().at(-1)).toMatchObject({
      record_kind: 'unknown-provider-result',
      authorization_event_id: expect.stringMatching(/^EA-[a-f0-9]{16}$/u),
    });
  });

  it.each([
    [
      'before-not-before',
      {
        not_before: '2026-09-03T00:00:01.000Z',
        expires_at: '2026-09-03T01:00:00.000Z',
      },
    ],
    [
      'at-expiry',
      {
        not_before: '2026-09-02T23:00:00.000Z',
        expires_at: '2026-09-03T00:00:00.000Z',
      },
    ],
  ] as const)('enforces the resolved grant validity window: %s', async (_label, window) => {
    const initial = request('release evidence-publish');
    const store = new ReleaseLifecycleFileStore(root(), initial);
    await advanceToExported(store);
    const exported = required(store.readStateRecords().at(-1), 'missing exported state');
    const receipt = boundOfflineReceipt(exported);
    const value = request('release evidence-publish', receipt);
    const valid = authorizationBridge();
    const forged: AuthorizationBridge = {
      ...valid,
      resolve: async (binding) => {
        const resolution = await valid.resolve(binding);
        if (!resolution.ok) return resolution;
        const original = objectValue(required(resolution.events[0], 'missing authorization event'));
        const {
          event_id: _eventId,
          payload_digest_sha256: _payloadDigest,
          ...eventPayload
        } = original;
        const event = finalizeAuthorizationEvent({ ...eventPayload, ...window });
        return { ...resolution, events: [event], ledger: authorizationLedger([event]) };
      },
    };
    const provider = vi.fn(() => ({ outcome: 'unknown' as const }));
    const result = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release evidence-publish',
        authority: authorityFor('release evidence-publish'),
        store,
        resolveReceipt: () => receipt,
        resolvePlanInput,
        offlineReceiptVerifier: { verify: ({ receipt: document }) => document },
        artifactReader: artifactReaderFor('release export'),
        authorization: forged,
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      phase: 'authorization',
      code: 'release-authorization-attempt-binding-invalid',
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    'event-ledger',
    'event-sequence',
    'entry-sequence',
    'entry-event',
    'entry-digest',
    'entry-predecessor',
    'entry-kind',
    'entry-reference',
    'event-predecessor',
  ] as const)('recomputes every authorization ledger link: %s', async (defect) => {
    const initial = request('release evidence-publish');
    const store = new ReleaseLifecycleFileStore(root(), initial);
    await advanceToExported(store);
    const exported = required(store.readStateRecords().at(-1), 'missing exported state');
    const receipt = boundOfflineReceipt(exported);
    const value = request('release evidence-publish', receipt);
    const valid = authorizationBridge();
    const forged: AuthorizationBridge = {
      ...valid,
      resolve: async (binding) => {
        const resolution = await valid.resolve(binding);
        if (!resolution.ok) return resolution;
        const first = objectValue(required(resolution.events[0], 'missing first grant'));
        const { event_id: _eventId, payload_digest_sha256: _payload, ...draft } = first;
        let second = finalizeAuthorizationEvent({
          ...draft,
          sequence: 2,
          previous_event_digest_sha256: canonicalSha256(first),
        });
        let events = [first, second] as readonly Readonly<Record<string, unknown>>[];
        let ledger: Readonly<Record<string, unknown>> = authorizationLedger(events);
        const entries = ledger['entries'] as readonly Readonly<Record<string, unknown>>[];
        const entry = required(entries[1], 'missing second ledger entry');

        if (defect === 'event-ledger') {
          const changedFirst = finalizeAuthorizationEvent({
            ...draft,
            ledger_id: 'EAL-release-other',
          });
          second = finalizeAuthorizationEvent({
            ...draft,
            sequence: 2,
            previous_event_digest_sha256: canonicalSha256(changedFirst),
          });
          events = [changedFirst, second];
          ledger = authorizationLedger(events);
        } else if (defect === 'event-sequence') {
          second = finalizeAuthorizationEvent({ ...draft, sequence: 3 });
          events = [first, second];
          const rebuilt = authorizationLedger(events);
          const rebuiltEntries = rebuilt.entries as readonly Readonly<Record<string, unknown>>[];
          ledger = {
            ...rebuilt,
            head: { ...objectValue(rebuilt.head), sequence: 2 },
            entries: [rebuiltEntries[0], { ...rebuiltEntries[1], sequence: 2 }],
          };
        } else if (defect === 'event-predecessor') {
          second = finalizeAuthorizationEvent({
            ...draft,
            sequence: 2,
            previous_event_digest_sha256: '0'.repeat(64),
          });
          events = [first, second];
          const rebuilt = authorizationLedger(events);
          const rebuiltEntries = rebuilt.entries as readonly Readonly<Record<string, unknown>>[];
          ledger = {
            ...rebuilt,
            entries: [
              rebuiltEntries[0],
              { ...rebuiltEntries[1], previous_event_digest_sha256: canonicalSha256(first) },
            ],
          };
        } else {
          const changedEntry = {
            ...entry,
            ...(defect === 'entry-sequence' ? { sequence: 3 } : {}),
            ...(defect === 'entry-event' ? { event_id: 'EA-0000000000000000' } : {}),
            ...(defect === 'entry-digest' ? { event_digest_sha256: '0'.repeat(64) } : {}),
            ...(defect === 'entry-predecessor'
              ? { previous_event_digest_sha256: '0'.repeat(64) }
              : {}),
            ...(defect === 'entry-kind' ? { kind: 'consumed' } : {}),
            ...(defect === 'entry-reference' ? { references_event_id: 'EA-0000000000000000' } : {}),
          };
          ledger = { ...ledger, entries: [entries[0], changedEntry] };
        }
        return { ...resolution, ledger, events };
      },
    };
    const provider = vi.fn(() => ({ outcome: 'unknown' as const }));
    const result = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release evidence-publish',
        authority: authorityFor('release evidence-publish'),
        store,
        resolveReceipt: () => receipt,
        resolvePlanInput,
        offlineReceiptVerifier: { verify: ({ receipt: document }) => document },
        artifactReader: artifactReaderFor('release export'),
        authorization: forged,
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      phase: 'authorization',
      code: 'release-authorization-attempt-binding-invalid',
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it('refuses hard-linked state records through the no-follow fstat boundary', async () => {
    const value = request('release preflight');
    const store = new ReleaseLifecycleFileStore(root(), value);
    await seedPreflight(store);
    const attempts = join(store.campaignDirectory, 'attempts');
    const name = required(
      // The store accepts exactly one opening attempt in this fixture.
      (await import('node:fs')).readdirSync(attempts)[0],
      'missing attempt record',
    );
    linkSync(join(attempts, name), join(root(), 'linked-record.json'));
    expect(() => store.readStoreRecords()).toThrow('release-state-store-unsafe');
  });

  it.each(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const)(
    'refuses a state record whose opened identity changes during the read: %s',
    async (property) => {
      const value = request('release preflight');
      const store = new ReleaseLifecycleFileStore(root(), value);
      await seedPreflight(store);
      const originalFstatSync = fs.fstatSync;
      let regularFileObservations = 0;
      fs.fstatSync = ((descriptor: number) => {
        const stat = originalFstatSync(descriptor);
        if (!stat.isFile() || ++regularFileObservations !== 2) return stat;
        return new Proxy(stat, {
          get(target, key, receiver) {
            if (key === property) return Reflect.get(target, key, receiver) + 1;
            return Reflect.get(target, key, receiver);
          },
        });
      }) as typeof fs.fstatSync;
      syncBuiltinESMExports();
      try {
        expect(() => store.readStoreRecords()).toThrow('release-state-store-unsafe');
      } finally {
        fs.fstatSync = originalFstatSync;
        syncBuiltinESMExports();
      }
      expect(regularFileObservations).toBe(2);
    },
  );

  it('fails a missing action adapter before creating the state store', async () => {
    const value = request('release preflight');
    const store = new ReleaseLifecycleFileStore(root(), value);
    const result = await executeReleaseLifecycleAction({
      request: value,
      action: 'release preflight',
      authority: authorityFor('release preflight'),
      store,
      resolveReceipt: () => planReceipt(),
      resolvePlanInput,
      recorded_at: '2026-09-03T00:00:00.000Z',
    });
    expect(result).toMatchObject({
      ok: false,
      phase: 'provider',
      code: 'release-certification-provider-unavailable',
    });
    expect(existsSync(store.campaignDirectory)).toBe(false);
  });
});
