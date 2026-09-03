import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@devai-nyx/utils';
import { buildReleasePlanReceipt } from '../../src/services/release-lifecycle.js';
import { finalizeCertificationManifest } from '../../src/services/release-prepare-kernel.js';
import { createReleaseCertificationProvider } from '../../src/services/release-lifecycle-certification.js';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import {
  ReleaseLifecycleFileStore,
  executeReleaseLifecycleAction,
  executeOfflineVerification,
  finalizeStoreRecord,
  reduceStoreRecords,
  resumeReleaseLifecycleExecution,
  validateReleaseLifecycleRequest,
  verifyReleaseStateIdentity,
  type ReleaseLifecycleRequest,
  type ReleaseStateMaterial,
  type StoreRecord,
  type AuthorizationAttemptBinding,
  type AuthorizationBridge,
  type PublicationControls,
  type TrustedReleaseAuthority,
} from '../../src/services/release-lifecycle-execution.js';

const ARTIFACT_BYTES = Buffer.from(JSON.stringify({ name: '@aarusso-nyx/devai', version: '1.5.0' }));
const BLOB = createHash('sha1').update(Buffer.from(`blob ${String(ARTIFACT_BYTES.byteLength)}\0`)).update(ARTIFACT_BYTES).digest('hex');
const TREE_BYTES = Buffer.concat([Buffer.from('100644 package.json\0'), Buffer.from(BLOB, 'hex')]);
const TREE = createHash('sha1').update(Buffer.from(`tree ${String(TREE_BYTES.byteLength)}\0`)).update(TREE_BYTES).digest('hex');
const COMMIT_BYTES = Buffer.from(`tree ${TREE}\n\nfixture\n`);
const COMMIT = createHash('sha1').update(Buffer.from(`commit ${String(COMMIT_BYTES.byteLength)}\0`)).update(COMMIT_BYTES).digest('hex');
const MANIFEST_DIGEST = createHash('sha256').update(ARTIFACT_BYTES).digest('hex');
const EVIDENCE_DIGEST = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const CERTIFICATION_TASK_POLICY = { nodes: ['certify'] };
const TASK_POLICY_DIGEST = canonicalSha256(CERTIFICATION_TASK_POLICY);
const SINK_ID = 'release-test-sink';
const TRANSACTION_HANDLE = 'release-test-transaction';
const COMMIT_MANIFEST_HANDLE = 'release-test-commit-manifest';

function planReceipt(): Readonly<Record<string, unknown>> {
  return buildReleasePlanReceipt({
    repository_id: 'aarusso-nyx/devai',
    intent_path: 'release-intent.json',
    intent: {
      schemaVersion: '1.0.0',
      release_unit: '@aarusso-nyx/devai',
      current_version: '1.4.5',
      target_version: '1.5.0',
      support: 'current',
      change_kind: 'behavioral',
      changed_paths: ['packages/cli/src/services/release-lifecycle-execution.ts'],
      changed_packages: ['@aarusso-nyx/devai'],
      candidate: { commit: COMMIT, tree: TREE },
      base: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    },
    release_verification_profile: JSON.parse(
      readFileSync(join(process.cwd(), 'law/policy/release-verification.json'), 'utf8'),
    ),
    release_lifecycle_policy: JSON.parse(
      readFileSync(join(process.cwd(), 'law/policy/release-lifecycle.json'), 'utf8'),
    ),
    action_registry: JSON.parse(
      readFileSync(join(process.cwd(), 'law/policy/action-registry.json'), 'utf8'),
    ),
  });
}

function resolvePlanInput(input: Readonly<Record<string, unknown>>): unknown {
  if (input['kind'] === 'release-intent') return input['inline_document'];
  const paths: Readonly<Record<string, string>> = {
    'release-verification-profile': 'law/policy/release-verification.json',
    'release-lifecycle-policy': 'law/policy/release-lifecycle.json',
    'action-registry-policy': 'law/policy/action-registry.json',
  };
  const path = paths[String(input['kind'])];
  if (path === undefined) throw new Error('unknown plan input');
  return JSON.parse(readFileSync(join(process.cwd(), path), 'utf8')) as unknown;
}

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
) {
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
    JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'release-artifact-sink-commit-manifest',
      sink_id: SINK_ID,
      transaction_handle: TRANSACTION_HANDLE,
      repository: { id: 'aarusso-nyx/devai', commit: COMMIT, tree: TREE },
      candidate: { commit: COMMIT, tree: TREE },
      pack_spec_id: 'devai.pure-npm-compatible-pack.v3',
      pack_spec_digest_sha256: 'd287db048eb09efaea20c7e4d6b8b721d34e08eb05b6cbc7f19fba4c666917bd',
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
  const prepared = {
    package_id: certified.package_id,
    package_manifest: opaqueArtifact('package-manifest', 'package-manifest'),
    package_tarball: opaqueArtifact('package-tarball', 'package-tarball'),
    package_sbom: opaqueArtifact('package-sbom', 'package-sbom'),
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
  const exported = {
    ...prepared,
    evidence_manifest: opaqueArtifact('evidence-manifest', 'evidence-manifest'),
    provider_result: opaqueArtifact('provider-result', 'provider-result'),
    trust: {
      trust_root_id: 'release-root',
      trust_store_digest_sha256: 'b'.repeat(64),
      key_id: 'release-key',
      signature_algorithm: 'ed25519' as const,
    },
  };
  const artifacts = [
    exported.evidence_manifest,
    prepared.package_manifest,
    prepared.package_sbom,
    prepared.package_tarball,
    exported.provider_result,
  ];
  return {
    ...base,
    release_units: [{ ...baseUnit, packages: [exported] }],
    artifacts,
    artifact_sink: committedSink(artifacts).identity,
  };
}

function providerFor(action: ReleaseLifecycleRequest['action_id']) {
  if (action !== 'release certify') return () => ({ outcome: 'success' as const, material: materialFor(action) });
  return createReleaseCertificationProvider({
    provider: {
      kind: 'protected-certification-provider-v3',
      certify: () => ({ outcome: 'success' as const, material: materialFor('release certify') }),
    },
    evidence_sink: {
      kind: 'certification-evidence-sink-v3',
      protocol: 'two-phase-content-addressed',
      begin: () => undefined as never,
      readCertificationEvidenceReceipt: () => { throw new Error('no generated output'); },
      readCertificationOutputClosure: binding => ({ ...binding, outputs: [] }),
      readGeneratedBlob: () => { throw new Error('no generated output'); },
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

function artifactReaderFor(action: ReleaseLifecycleRequest['action_id']) {
  const material = materialFor(action);
  const sink = committedSink(material.artifacts);
  return {
    readArtifact: ({ opaque_handle }: { readonly opaque_handle: string }) =>
      opaque_handle === COMMIT_MANIFEST_HANDLE ? sink.manifest : ARTIFACT_BYTES,
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
  for (const action of [
    'release preflight',
    'release certify',
    'release prepare',
    'release export',
  ] as const) {
    const value = request(action);
    const result = await withAuthorityHostTestScope(() =>
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
      }),
    );
    if (!result.ok) throw new Error(`advance failed: ${result.code}`);
  }
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
  return mkdtempSync(join(tmpdir(), 'devai-release-lifecycle-'));
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

describe('release lifecycle execution kernel', () => {
  it('refuses v3 certify before task execution or state append without a protected provider and two-phase evidence sink', async () => {
    const value = request('release certify');
    const store = new ReleaseLifecycleFileStore(root(), value);
    const genericProvider = vi.fn(() => ({ outcome: 'success' as const, material: materialFor('release certify') }));
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

  it('preserves an ambiguous prepare sink commit without cleanup or redispatch until external reconciliation', async () => {
    const initial = request();
    const store = new ReleaseLifecycleFileStore(root(), initial);
    for (const action of ['release preflight', 'release certify'] as const) {
      const result = await withAuthorityHostTestScope(() =>
        executeReleaseLifecycleAction({
          request: request(action), action, authority: authorityFor(action), store,
          resolveReceipt: () => planReceipt(), resolvePlanInput, provider: providerFor(action),
          recorded_at: '2026-09-03T00:00:00.000Z',
        }),
      );
      expect(result.ok).toBe(true);
    }
    const rollback = vi.fn();
    const dispose = vi.fn();
    const provider = vi.fn(() => ({
      outcome: 'success' as const,
      material: materialFor('release prepare'),
      transaction: { commit: () => { throw new Error('lost sink response'); }, rollback, dispose },
    }));
    const prepared = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: request('release prepare'), action: 'release prepare',
        authority: authorityFor('release prepare'), store,
        resolveReceipt: () => planReceipt(), resolvePlanInput, provider,
        recorded_at: '2026-09-03T00:00:01.000Z',
      }),
    );
    expect(prepared).toMatchObject({ ok: false, phase: 'ambiguous', code: 'release-artifact-sink-commit-unknown' });
    expect(rollback).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    const terminal = store.readStoreRecords().at(-1);
    expect(terminal).toMatchObject({
      record_kind: 'unknown-provider-result',
      provider_dispatch: { status: 'not-dispatched', handle_observed: false },
      unknown: {
        code: 'release-provider-result-unknown', redispatch_permitted: false,
        artifact_sink: materialFor('release prepare').artifact_sink,
        artifacts: materialFor('release prepare').artifacts,
      },
    });
    const observation = await resumeReleaseLifecycleExecution({
      states: store.readStateRecords(), store_records: store.readStoreRecords(), store_head: store.readHead(),
      repository: initial.repository_locator,
      candidate: required(store.readStateRecords().at(-1), 'missing certified state').candidate,
      candidate_locator: request('release prepare').candidate_locator,
      receipt_documents: [planReceipt()], resolve_plan_input: resolvePlanInput,
    });
    expect(observation).toMatchObject({
      next_action: null, next_outcome: 'ambiguous',
      reconciliation_requirements: ['external_sink_commit_reconciliation_required'],
    });
    const retry = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: request('release prepare'), action: 'release prepare',
        authority: authorityFor('release prepare'), store,
        resolveReceipt: () => planReceipt(), resolvePlanInput, provider,
        recorded_at: '2026-09-03T00:00:02.000Z',
      }),
    );
    expect(retry).toMatchObject({ ok: false, phase: 'reconciliation', code: 'release-provider-result-unknown' });
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

  it('persists a v2 preflight attempt, state, completion, and head durably', async () => {
    const value = request();
    const store = new ReleaseLifecycleFileStore(root(), value);
    const result = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release preflight',
        authority: authorityFor('release preflight'),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider: () => ({ outcome: 'success', material: material() }),
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
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

  it('commits prepared artifacts only after semantic validation and rolls them back on store failure', async () => {
    const value = request();
    const invalidStore = new ReleaseLifecycleFileStore(root(), value);
    const invalidCommit = vi.fn();
    const invalidRollback = vi.fn();
    const invalidDispose = vi.fn();
    const invalid = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release preflight',
        authority: authorityFor('release preflight'),
        store: invalidStore,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider: () => ({
          outcome: 'success',
          material: { ...material(), release_units: [] },
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
    vi.spyOn(failingStore, 'appendStateAndAdvanceHead').mockImplementation(() => {
      throw new Error('synthetic-append-failure');
    });
    const order: string[] = [];
    const failed = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release preflight',
        authority: authorityFor('release preflight'),
        store: failingStore,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider: () => ({
          outcome: 'success',
          material: material(),
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
    expect(order).toEqual(['commit', 'rollback', 'dispose']);
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
      receipt_documents: [receipt],
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
    const success = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release preflight',
        authority: authorityFor('release preflight'),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider: () => ({ outcome: 'success', material: material() }),
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(success.ok).toBe(true);
    if (!success.ok) return;
    const before = JSON.stringify(store.readStoreRecords());
    const observation = await resumeReleaseLifecycleExecution({
      states: store.readStateRecords(),
      store_records: store.readStoreRecords(),
      store_head: store.readHead(),
      repository: value.repository_locator,
      candidate: success.state.candidate,
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
    });
    expect(ambiguous).toMatchObject({ next_action: null, next_outcome: 'ambiguous' });
  });

  it('rejects corrupted and forked append-only records and symlinked stores', async () => {
    const value = request();
    const store = new ReleaseLifecycleFileStore(root(), value);
    const success = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release preflight',
        authority: authorityFor('release preflight'),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider: () => ({ outcome: 'success', material: material() }),
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(success.ok).toBe(true);
    const records = store.readStoreRecords();
    expect(
      reduceStoreRecords([{ ...records[0], request_digest_sha256: 'f'.repeat(64) }, records[1]]).ok,
    ).toBe(false);

    const unsafeRoot = root();
    const target = root();
    symlinkSync(target, join(unsafeRoot, 'linked'));
    const unsafe = new ReleaseLifecycleFileStore(join(unsafeRoot, 'linked'), value);
    await expect(
      withAuthorityHostTestScope(() =>
        executeReleaseLifecycleAction({
          request: value,
          action: 'release preflight',
          authority: authorityFor('release preflight'),
          store: unsafe,
          resolveReceipt: () => planReceipt(),
          resolvePlanInput,
          provider: () => ({ outcome: 'success', material: material() }),
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
    const success = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release preflight',
        authority: authorityFor('release preflight'),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider: () => ({ outcome: 'success', material: material() }),
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(success.ok).toBe(true);
    if (!success.ok) return;
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
    const success = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release preflight',
        authority: authorityFor('release preflight'),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider: () => ({ outcome: 'success', material: material() }),
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(success.ok).toBe(true);
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
        executeReleaseLifecycleAction({
          request: value,
          action: 'release preflight',
          authority: authorityFor('release preflight'),
          store: competing,
          resolveReceipt: () => planReceipt(),
          resolvePlanInput,
          provider: () => ({ outcome: 'success', material: material() }),
          recorded_at: '2026-09-03T00:00:00.000Z',
        }),
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
    expect(result.ok).toBe(true);
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
      }),
    ).toMatchObject({ ok: false, code: 'release-offline-receipt-binding-invalid' });
  });

  it('separates append-log tail from completed-state head and permits a fresh retry', async () => {
    const value = request('release preflight');
    const store = new ReleaseLifecycleFileStore(root(), value);
    const failed = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release preflight',
        authority: authorityFor('release preflight'),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider: () => ({ outcome: 'failure', code: 'release-preflight-failed' }),
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
      next_action: 'release preflight',
      next_outcome: 'ready',
    });
    const passed = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release preflight',
        authority: authorityFor('release preflight'),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider: () => ({ outcome: 'success', material: material() }),
        recorded_at: '2026-09-03T00:00:01.000Z',
      }),
    );
    expect(passed.ok).toBe(true);
    const records = store.readStoreRecords();
    expect(records.map((record) => record.record_kind)).toEqual([
      'attempt',
      'failure',
      'attempt',
      'completion',
    ]);
    expect(records.every((record) => record.observed_head_before === null)).toBe(true);
    expect(records[2]?.predecessor_record).toMatchObject({ record_id: records[1]?.record_id });
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
      receipt_documents: [receipt],
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
    const result = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release preflight',
        authority: authorityFor('release preflight'),
        store,
        resolveReceipt: () => planReceipt(),
        resolvePlanInput,
        provider: () => ({ outcome: 'success', material: material() }),
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(result.ok).toBe(true);
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
      code: 'release-provider-unavailable',
    });
    expect(existsSync(store.campaignDirectory)).toBe(false);
  });
});
