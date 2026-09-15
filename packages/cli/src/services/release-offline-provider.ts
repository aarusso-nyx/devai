import { createHash } from 'node:crypto';
import { loadSchema } from '@devai-nyx/schemas';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import {
  createVerifiedReleaseMutationCheck,
  readVerifiedReleaseOfflineContext,
  offlineArtifactProjection,
  offlineReleaseUnitsProjection,
  type OfflineVerificationProvider,
  type OpaqueArtifactIdentity,
  type TrustedArtifactReader,
} from './release-lifecycle-execution.js';
import { verifyPreparedPackageArchive } from './release-prepare-kernel.js';
import { readCertifiedEvidenceCarrier } from './release-certified-evidence-carrier.js';
import {
  verifyReleaseExportProviderResultSetV3,
  type ReleaseExportTranscriptV3,
} from './release-export-transcript-v3.js';
import { captureReleaseExportTranscriptLimits } from './release-export-transcript-v2.js';
import type { ReleaseExportTranscriptLimits } from './release-export-transcript.js';
import {
  verifyPinnedDetachedSignature,
  verifyPinnedArtifactContent,
  type OfflineCandidateEvidenceInput,
} from './mutation-evidence-v21.js';

/** Only installed host controls may supply this independently approved kernel. */
export interface ProtectedOfflineDagControl {
  readonly identity: {
    readonly source_commit: string;
    readonly archive_sha256: string;
  };
  readonly verify: (
    input: OfflineCandidateEvidenceInput & {
      readonly expectedReleaseUnit: string;
    },
  ) => unknown | Promise<unknown>;
}

export interface ReleaseOfflineProviderControls {
  readonly candidate: {
    readonly repository_id: string;
    readonly commit: string;
    readonly tree: string;
  };
  readonly reader: TrustedArtifactReader;
  readonly dag: ProtectedOfflineDagControl;
  /** Reconstructed outside candidate execution; never selected from carrier contents. */
  readonly task_policies: readonly {
    readonly release_unit: string;
    readonly policy: Readonly<Record<string, unknown>>;
  }[];
  readonly trust_store: Readonly<Record<string, unknown>>;
  readonly signer_id: string;
  readonly verifier: {
    readonly package_name: string;
    readonly package_version: string;
    readonly registry: string;
    readonly integrity_sri: string;
    readonly provenance_sha256: string;
    readonly source_commit: string;
  };
  readonly limits: ReleaseExportTranscriptLimits;
  readonly maximum_archive_bytes: number;
  readonly maximum_total_bytes: number;
}

const ERROR = 'release-offline-verifier-failed';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const clone = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(ERROR);
  return value as Record<string, unknown>;
}
function fail(): never {
  throw new Error(ERROR);
}
function equal(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) fail();
  return value;
}
/** Schema constants describe the receipt grammar, never a sample verification result. */
function constants(
  schema: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const properties = record(schema['properties']);
  return Object.fromEntries(
    Object.entries(properties).map(([key, raw]) => {
      if (Object.hasOwn(overrides, key)) return [key, overrides[key]];
      const value = record(raw);
      if (Object.hasOwn(value, 'const')) return [key, clone(value['const'])];
      if (Array.isArray(value['prefixItems']))
        return [
          key,
          value['prefixItems'].map((item) => {
            const definition = record(item);
            if (!Object.hasOwn(definition, 'const')) fail();
            return clone(definition['const']);
          }),
        ];
      return fail();
    }),
  );
}

/** Concrete nine-check adapter. It emits only after every required check succeeds. */
export function createReleaseOfflineVerifierProvider(
  input: ReleaseOfflineProviderControls,
): OfflineVerificationProvider {
  if (typeof input.reader?.readArtifact !== 'function' || typeof input.dag?.verify !== 'function')
    fail();
  const readArtifact = input.reader.readArtifact.bind(input.reader);
  const verifyDag = input.dag.verify.bind(input.dag);
  const control = clone(input.dag.identity);
  if (
    !/^[a-f0-9]{40}$/u.test(control.source_commit) ||
    !/^[a-f0-9]{64}$/u.test(control.archive_sha256)
  )
    fail();
  const candidate = clone(input.candidate);
  const policies = clone(input.task_policies);
  if (new Set(policies.map((unit) => unit.release_unit)).size !== policies.length) fail();
  const trustStore = clone(input.trust_store);
  const signer = input.signer_id;
  const verifier = clone(input.verifier);
  const limits = captureReleaseExportTranscriptLimits(input.limits);
  const maximumArchive = positive(input.maximum_archive_bytes);
  const maximumTotal = positive(input.maximum_total_bytes);
  const properties = record(
    record(loadSchema('release-offline-verification-receipt.schema.json'))['properties'],
  );
  const metadata = {
    canonicalization: constants(record(properties['canonicalization']), {
      kernel_id: 'devai.kernel.release-offline-verification-receipt-canonicalization.v3',
    }),
    verification_kernel: constants(record(properties['verification_kernel']), {
      kernel_id: 'devai.kernel.offline-verification-receipt.v3',
    }),
    emitted_by: constants(record(properties['emitted_by'])),
    grants: constants(record(properties['grants'])),
    determinism: constants(record(properties['determinism'])),
  };
  return async (request, state, context) => {
    const verifiedContext = readVerifiedReleaseOfflineContext(context, request, state);
    if (
      state.schemaVersion !== '2.1.0' ||
      state.state !== 'exported' ||
      !equal(candidate, {
        repository_id: state.repository.id,
        commit: state.candidate.commit,
        tree: state.candidate.tree,
      })
    )
      fail();
    if (
      !equal(
        policies.map((unit) => unit.release_unit).sort(),
        state.release_units.map((unit) => unit.release_unit).sort(),
      )
    )
      fail();
    let total = 0;
    const observed: OpaqueArtifactIdentity[] = [];
    const read = async (identity: unknown): Promise<Buffer> => {
      const ref = record(identity) as unknown as OpaqueArtifactIdentity;
      if (
        ref.sink_id !== state.artifact_sink?.sink_id ||
        !Number.isSafeInteger(ref.size_bytes) ||
        ref.size_bytes < 0
      )
        fail();
      total += ref.size_bytes;
      if (total > maximumTotal) fail();
      const bytes = Buffer.from(
        await readArtifact({ sink_id: ref.sink_id, opaque_handle: ref.opaque_handle }),
      );
      if (bytes.length !== ref.size_bytes || sha(bytes) !== ref.sha256) fail();
      observed.push(clone(ref));
      return bytes;
    };
    const rawResults: Buffer[] = [];
    const packageSafety: unknown[] = [];
    for (const unit of state.release_units) {
      for (const pkg of unit.packages) {
        if ((pkg.provider_result?.size_bytes ?? Infinity) > limits.maximum_provider_result_bytes)
          fail();
        if ((pkg.package_tarball?.size_bytes ?? Infinity) > maximumArchive) fail();
        const manifest = await read(pkg.package_manifest);
        const tarball = await read(pkg.package_tarball);
        const sbom = await read(pkg.package_sbom);
        const evidenceManifest = await read(pkg.evidence_manifest);
        const provider = await read(pkg.provider_result);
        const entries = verifyPreparedPackageArchive({
          package: pkg,
          release_unit: unit.release_unit,
          version: unit.version,
          candidate: state.candidate,
          manifest,
          tarball,
          sbom,
          maximum_archive_bytes: maximumArchive,
        });
        for (const [path, bytes] of [
          ['manifest.json', manifest],
          ['sbom.json', sbom],
          ['evidence.json', evidenceManifest],
          ['provider.json', provider],
        ] as const) {
          await verifyPinnedArtifactContent({ path, bytes });
        }
        for (const entry of entries)
          await verifyPinnedArtifactContent({ path: entry.path, bytes: entry.bytes });
        packageSafety.push({
          package_id: pkg.package_id,
          entries: entries.map(({ bytes, ...entry }) => ({ ...entry, size_bytes: bytes.length })),
        });
        rawResults.push(provider);
      }
    }
    const first = record(JSON.parse((rawResults[0] ?? fail()).toString('utf8')));
    if (typeof first['transcript'] !== 'string' || typeof first['signature'] !== 'string') fail();
    const transcriptBytes = Buffer.from(first['transcript']);
    const signatureText = first['signature'];
    const results = verifyReleaseExportProviderResultSetV3(
      rawResults,
      { transcript: transcriptBytes, signature: signatureText },
      limits,
    );
    const transcript = JSON.parse(transcriptBytes.toString('utf8')) as ReleaseExportTranscriptV3;
    const trust = request.destination?.trust ?? fail();
    if (
      !equal(transcript.trust, trust) ||
      !equal(transcript.binding.repository, state.repository) ||
      !equal(transcript.binding.candidate, {
        commit: state.candidate.commit,
        tree: state.candidate.tree,
      })
    )
      fail();
    const signature = Buffer.from(signatureText, 'base64');
    if (
      signature.toString('base64') !== signatureText ||
      signature.length !== 64 ||
      trust.signature_algorithm !== 'ed25519'
    )
      fail();
    const signerResult = await verifyPinnedDetachedSignature({
      trustStore,
      algorithm: 'ed25519',
      expectedSignerId: signer,
      expectedTrustRootId: trust.trust_root_id,
      expectedTrustStoreDigest: trust.trust_store_digest_sha256,
      expectedKeyId: trust.key_id,
      payloadBytes: transcriptBytes,
      signatureBytes: signature,
    });
    const dags: unknown[] = [];
    for (const result of results) {
      const portable = result.certification_evidence;
      if (portable === null) continue;
      const carrier = readCertifiedEvidenceCarrier(
        Buffer.from(portable.bytes_base64, 'base64'),
        limits.maximum_provider_result_bytes,
      );
      const expected =
        policies.find((unit) => unit.release_unit === portable.release_unit) ?? fail();
      const policy = JSON.parse(carrier.task_policy.toString('utf8')) as unknown;
      if (!equal(policy, expected.policy)) fail();
      const files = new Map(carrier.task_results.map((bytes) => [sha(bytes), bytes]));
      const receipt = JSON.parse(carrier.candidate_receipt.toString('utf8')) as unknown;
      const dag = record(
        await verifyDag({
          receipt,
          taskPolicy: policy,
          namespaceCensus: carrier.census,
          expectedRepository: state.repository.id,
          expectedCommit: state.candidate.commit,
          expectedTree: state.candidate.tree,
          expectedPolicyDigest: canonicalSha256(expected.policy),
          expectedReleaseUnit: portable.release_unit,
          readEvidenceFile: (kind, identity) => {
            if (kind !== 'result') return fail();
            return Buffer.from(files.get(identity) ?? fail());
          },
        }),
      );
      if (dag['ok'] !== true || dag['verification'] !== 'candidate-receipt-dag') fail();
      dags.push({
        release_unit: portable.release_unit,
        control,
        result: dag,
        carrier_sha256: portable.sha256,
      });
    }
    if (dags.length !== policies.length) fail();
    const check = (check_id: string, evidence: unknown) => ({
      check_id,
      status: 'pass',
      result_digest_sha256: canonicalSha256({ check_id, evidence }),
    });
    const checks = [
      check('candidate-tree-identity', {
        repository: state.repository,
        candidate: state.candidate,
        dags,
      }),
      check('receipt-envelope-canonicality', {
        transcript_sha256: sha(transcriptBytes),
        provider_results: rawResults.map(sha),
      }),
      check('signer-trust', { result: signerResult, signature_sha256: sha(signature), trust }),
      check('policy-identity', { plans: verifiedContext.plan_receipts, policies }),
      check('result-dag-integrity', dags),
      check('artifact-population', {
        artifacts: offlineArtifactProjection(state),
        sink: state.artifact_sink,
      }),
      check('artifact-digests', observed),
      check('artifact-safety', packageSafety),
      createVerifiedReleaseMutationCheck(context, request, state),
    ];
    const receipt = {
      schemaVersion: '2.1.0',
      receipt_kind: 'release-offline-verification-receipt',
      ...metadata,
      verdict: 'pass',
      state_observed: 'offline_verified',
      repository: state.repository,
      candidate: state.candidate,
      verified_state: {
        state: state.state,
        state_id: state.state_id,
        record_digest_sha256: state.record_digest_sha256,
      },
      artifacts: offlineArtifactProjection(state),
      release_units: offlineReleaseUnitsProjection(state),
      artifact_sink_commit: state.artifact_sink,
      verifier,

      checks,
      network_access: false,
    };
    const digest = canonicalSha256(receipt);
    return clone({
      ...receipt,
      receipt_digest_sha256: digest,
      receipt_id: `ROV-${digest.slice(0, 16)}`,
    });
  };
}
