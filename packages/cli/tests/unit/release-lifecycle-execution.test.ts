import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
  type ProtectedReleaseExportCapacityBinding,
} from '@devai-nyx/authority';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { createLifecyclePolicyFixture } from '../helpers/release-policy-resolution-fixture.js';
import { fixture as unitMutationEvidenceFixture } from '../helpers/release-unit-mutation-evidence-fixture.js';
import { withReleasePrepareAuthorityFixture } from '../helpers/release-prepare-authority-fixture.js';
import { createReleasePolicyClosure } from '../../src/services/release-policy-closure.js';
import {
  RELEASE_EXPORT_SPEC_DIGEST,
  RELEASE_EXPORT_SPEC_ID,
} from '../../src/services/release-export-artifact-store.js';
import {
  encodeReleaseExportProviderResult,
  encodeReleaseExportTranscript,
} from '../../src/services/release-export-transcript.js';
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
  finalizeReleaseStateV2,
  finalizeStoreRecord,
  reduceStoreRecords,
  resumeReleaseLifecycleExecution,
  resolveReleaseMutationRequirements,
  validateReleaseLifecycleRequest,
  verifyReleaseStateIdentity,
  type ReleaseLifecycleRequest,
  type ReleaseStateMaterial,
  type OpaqueArtifactIdentity,
  type StoreRecord,
  type AuthorizationAttemptBinding,
  type AuthorizationBridge,
  type PublicationControls,
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

function requiredMutationEvidenceSink(
  evidence: Awaited<ReturnType<typeof unitMutationEvidenceFixture>>,
  options: {
    readonly closure?: typeof evidence.closure;
    readonly read_blob?: (identity: Parameters<typeof evidence.read>[0]) => Buffer;
    readonly omit_unit_readers?: boolean;
  } = {},
) {
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
    ...(options.omit_unit_readers
      ? {}
      : {
          unit_mutation_maximum_bytes: 1_000_000,
          readUnitMutationEvidenceClosure: () => options.closure ?? evidence.closure,
          readUnitMutationEvidenceReceipt: () => (options.closure ?? evidence.closure).receipt,
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
  }));
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

  it('refuses required mutation material without the trusted unit closure readers', async () => {
    const input = await requiredMutationCertificationFixture();
    const { provider, certify } = requiredMutationProvider(input, undefined, {
      omit_unit_readers: true,
    });

    await expect(provider(input.request)).resolves.toMatchObject({
      outcome: 'failure',
      code: 'release-certification-generated-output-untrusted',
    });
    expect(certify).not.toHaveBeenCalled();
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

  it('treats an export provider exception or post-sign material defect as unknown without cleanup or redispatch', async () => {
    for (const kind of ['throw', 'missing-material', 'invalid-material'] as const) {
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
        return {
          outcome: 'success' as const,
          material: { ...materialFor('release export'), release_units: [] },
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
    expect(validateReleaseLifecycleRequest(valid, 'release preflight')).toEqual(valid);
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
        authorization: authorizationBridge(() => {
          order.push(store.readStoreRecords().at(-1)?.record_kind ?? 'missing');
        }),
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(first).toMatchObject({ ok: false, phase: 'ambiguous' });
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

    const wrong = await executeReleaseLifecycleAction({
      request: value,
      action: 'release preflight',
      authority: {
        actor: { kind: 'human', role: 'engineer', declaration_source: 'session-state' },
        consent: { write: true, allow_publish: false, experimental: false },
      },
      store: new ReleaseLifecycleFileStore(root(), value),
      resolveReceipt: () => planReceipt(),
      resolvePlanInput,
      provider,
      recorded_at: '2026-09-03T00:00:00.000Z',
    });
    expect(wrong).toMatchObject({ ok: false, code: 'release-authority-context-invalid' });
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
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.state['publication_expectation']).toMatchObject(publicationControls());
    expect(
      objectValue(objectValue(result.state['publication_expectation'])['destination'])[
        'exact_identifier'
      ],
    ).toBe('npm:@aarusso-nyx/devai@1.5.0');
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
