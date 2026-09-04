import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { createProtectedExportSignerAdapter } from '@devai-nyx/authority';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import {
  assertReleaseProviderInvocationContext,
  verifyReleaseStateIdentity,
  type ArtifactSinkCommitIdentity,
  type OpaqueArtifactIdentity,
  type ReleaseProvider,
  type ReleaseStateMaterial,
  type TrustedArtifactReader,
  type TrustIdentity,
} from './release-lifecycle-execution.js';
import {
  createReleaseExportArtifactStore,
  type ProtectedReleaseExportBindingV3,
  type ReleaseExportArtifactObjectReceipt,
  type ReleaseExportArtifactStoreOptions,
  type TrustedExportArtifactSinkTransaction,
} from './release-export-artifact-store.js';
import {
  createReleaseExportMutationEvidence,
  readReleaseExportMutationEvidence,
} from './release-export-mutation-evidence.js';
import {
  captureReleaseExportJson,
  captureReleaseExportTranscriptLimits,
  encodeReleaseExportProviderResultV2,
  encodeReleaseExportTranscriptV2,
  RELEASE_EXPORT_SPEC_V3_DIGEST,
  type ReleaseExportTranscriptV2,
} from './release-export-transcript-v2.js';
import { decodeReleasePolicyClosure } from './release-policy-closure-transport.js';
import { verifyReleasePolicyClosure } from './release-policy-closure.js';
import {
  type ReleaseMutationPlanReaders,
  type ReleaseUnitMutationEvidenceReader,
} from './release-prepare-kernel.js';

/** Private composition inputs. Neither an action request nor candidate code supplies these. */
export interface ReleaseExportProviderOptions {
  readonly store: Omit<
    ReleaseExportArtifactStoreOptions,
    'binding' | 'prepared_state' | 'mutation_evidence'
  >;
  readonly plan: ReleaseMutationPlanReaders;
  readonly mutation_source: ReleaseUnitMutationEvidenceReader;
  readonly provider: { readonly kind: 'evidence-export'; readonly provider_id: string };
  readonly destination: ProtectedReleaseExportBindingV3['destination'];
  readonly trust: TrustIdentity;
  readonly signer: {
    /** One synchronous protected operation; implementations must not return a Promise. */
    readonly sign: (transcript: Buffer) => Buffer;
    /** External trusted verification, independent of the signing result's claims. */
    readonly verify: (transcript: Buffer, signature: Buffer) => boolean | Promise<boolean>;
  };
}

const INVALID = 'release-export-artifact-sink-protocol-invalid';
const UNKNOWN = 'release-provider-result-unknown';
function fail(): never {
  throw new Error(INVALID);
}
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const utf8 = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
function artifact(receipt: ReleaseExportArtifactObjectReceipt): OpaqueArtifactIdentity {
  if (receipt.kind === 'committed-manifest') return fail();
  return {
    kind: receipt.kind,
    sink_id: receipt.sink_id,
    opaque_handle: receipt.opaque_handle,
    sha256: receipt.sha256,
    size_bytes: receipt.size_bytes,
  };
}

/**
 * Coordinate the actual append-only store and one-use protected signer. The lifecycle supplies
 * the genuine predecessor and attempt under its lock. This provider never invents a candidate,
 * invokes a mutation task, dispatches publication, or retries a possibly completed operation.
 */
export function createReleaseExportProvider(input: ReleaseExportProviderOptions): {
  readonly provider: ReleaseProvider;
  readonly reader: TrustedArtifactReader;
} {
  const limits = captureReleaseExportTranscriptLimits(input.store.transcript_limits);
  const maximum = input.store.max_blob_bytes;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 0x7fffffff) fail();
  const copy = <T>(value: T): T => captureReleaseExportJson(value, maximum) as T;
  const controls = copy({
    root: input.store.root,
    sink_id: input.store.sink_id,
    repository_roots: input.store.repository_roots,
    max_blob_bytes: maximum,
    closure_limits: input.store.closure_limits,
    transport_limits: input.store.transport_limits,
    transcript_limits: {
      ...limits,
      maximum_provider_result_bytes: Math.min(maximum, limits.maximum_provider_result_bytes),
    },
  });
  const providerIdentity = copy(input.provider);
  const destination = copy(input.destination);
  const trust = copy(input.trust);
  const implementation = input.store.implementation;
  const closures = input.store.closures.map((entry) => {
    if (!Buffer.isBuffer(entry.bytes) || types.isProxy(entry.bytes) || entry.bytes.length > maximum)
      fail();
    return {
      package_id: entry.package_id,
      expected: copy(entry.expected),
      bytes: Buffer.from(entry.bytes),
    };
  });
  const readParent = input.store.parent_reader.readArtifact.bind(input.store.parent_reader);
  const parentReader: TrustedArtifactReader = { readArtifact: readParent };
  const plan: ReleaseMutationPlanReaders = {
    ...(input.plan.resolve_receipt === undefined
      ? {}
      : { resolve_receipt: input.plan.resolve_receipt }),
    ...(input.plan.resolve_plan_input === undefined
      ? {}
      : { resolve_plan_input: input.plan.resolve_plan_input }),
  };
  const source = input.mutation_source;
  const mutationSource: ReleaseUnitMutationEvidenceReader = {
    unit_mutation_maximum_bytes: source.unit_mutation_maximum_bytes,
    ...(source.readUnitMutationEvidenceClosure === undefined
      ? {}
      : {
          readUnitMutationEvidenceClosure: source.readUnitMutationEvidenceClosure.bind(source),
        }),
    ...(source.readUnitMutationEvidenceReceipt === undefined
      ? {}
      : {
          readUnitMutationEvidenceReceipt: source.readUnitMutationEvidenceReceipt.bind(source),
        }),
    ...(source.readUnitMutationEvidenceBlob === undefined
      ? {}
      : {
          readUnitMutationEvidenceBlob: source.readUnitMutationEvidenceBlob.bind(source),
        }),
  };
  const sign = input.signer.sign.bind(input.signer);
  const verify = input.signer.verify.bind(input.signer);
  let exportedReader: TrustedArtifactReader | undefined;
  let invoked = false;
  return Object.freeze({
    reader: Object.freeze({
      readArtifact: (value) => (exportedReader ?? parentReader).readArtifact(value),
    } satisfies TrustedArtifactReader),
    provider: async (request, suppliedContext) => {
      let transaction: TrustedExportArtifactSinkTransaction | undefined;
      let signingStarted = false;
      let acquiredInvocation = false;
      try {
        const context = assertReleaseProviderInvocationContext(request, suppliedContext);
        if (invoked) fail();
        invoked = true;
        acquiredInvocation = true;
        if (
          request.action_id !== 'release export' ||
          context.action_id !== 'release export' ||
          !same(request.provider, providerIdentity) ||
          !same(request.destination, { ...destination, trust }) ||
          context.prior_state === null
        )
          fail();
        const prepared = verifyReleaseStateIdentity(context.prior_state);
        if (prepared.state !== 'prepared' || prepared.artifact_sink == null) fail();
        const planReceipts = request.receipt_locators?.filter(
          (row) => row.kind === 'release-plan-receipt',
        );
        if (planReceipts?.length !== 1) fail();
        const planDigest = planReceipts[0]?.receipt_digest_sha256 ?? fail();
        const material = {
          release_units: prepared.release_units,
          inputs: prepared['inputs'] as ReleaseStateMaterial['inputs'],
        };
        const mutation = await createReleaseExportMutationEvidence({
          request,
          material,
          source: mutationSource,
          plan,
          maximum_provider_result_bytes: controls.transcript_limits.maximum_provider_result_bytes,
        });
        const snapshot = readReleaseExportMutationEvidence(mutation, {
          ...material,
          repository: request.repository_locator,
          plan_receipt_digest_sha256: planDigest,
        });
        const binding: ProtectedReleaseExportBindingV3 = {
          action_id: 'release export',
          repository: request.repository_locator,
          candidate: {
            commit: request.candidate_locator.commit,
            tree: request.candidate_locator.tree,
          },
          plan_receipt_digest_sha256: planDigest,
          parent_artifact_sink: prepared.artifact_sink,
          sink_id: controls.sink_id,
          destination,
          trust,
          attempt_id: context.attempt_id,
          export_spec_digest_sha256: RELEASE_EXPORT_SPEC_V3_DIGEST,
          mutation_units: snapshot.mutation_units,
          closure_inputs: closures.map((entry) => {
            const resolution = verifyReleasePolicyClosure({
              closure: decodeReleasePolicyClosure(entry.bytes, controls.transport_limits),
              expected: entry.expected,
              implementation,
              limits: controls.closure_limits,
            });
            return {
              package_id: entry.package_id,
              release_unit: entry.expected.release_unit,
              sha256: hash(entry.bytes),
              size_bytes: entry.bytes.length,
              expected_installed_package: entry.expected.installed_package,
              policy_resolution_digest_sha256: canonicalSha256(resolution.resolution),
            };
          }),
        };
        const store = await createReleaseExportArtifactStore({
          ...controls,
          binding,
          prepared_state: prepared,
          parent_reader: parentReader,
          implementation,
          closures,
          mutation_evidence: mutation,
        });
        const signer = createProtectedExportSignerAdapter(binding);
        transaction = await store.begin();
        const tx = transaction;
        const receipts: ReleaseExportArtifactObjectReceipt[] = [];
        const put = async (
          kind: ReleaseExportArtifactObjectReceipt['kind'],
          packageId: string | null,
          value: Buffer,
        ): Promise<ReleaseExportArtifactObjectReceipt> => {
          const object = { bytes: value, sha256: hash(value), size_bytes: value.length };
          if ((kind === 'committed-manifest') !== (packageId === null)) fail();
          const receipt = await tx.put(
            kind === 'committed-manifest'
              ? { ...object, kind, package_id: null }
              : { ...object, kind, package_id: packageId ?? fail() },
          );
          if (
            receipt.kind !== kind ||
            receipt.package_id !== packageId ||
            receipt.sink_id !== tx.sink_id ||
            receipt.transaction_handle !== tx.transaction_handle ||
            receipt.sha256 !== hash(value) ||
            receipt.size_bytes !== value.length ||
            receipt.export_spec_digest_sha256 !== RELEASE_EXPORT_SPEC_V3_DIGEST
          )
            fail();
          const observed = await tx.readArtifact({
            sink_id: receipt.sink_id,
            opaque_handle: receipt.opaque_handle,
          });
          if (!Buffer.isBuffer(observed) || Buffer.compare(observed, value) !== 0) fail();
          receipts.push(receipt);
          return receipt;
        };
        for (const closure of closures)
          await put('evidence-manifest', closure.package_id, closure.bytes);
        const beforeSigning = await tx.readTranscript();
        const transcript = await tx.markSigningStarted();
        // From this point a failure is unknown; abort is permanently forbidden by the sink too.
        signingStarted = true;
        if (Buffer.compare(beforeSigning, transcript) !== 0) fail();
        const parsed = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(transcript),
        ) as ReleaseExportTranscriptV2;
        if (
          Buffer.compare(
            transcript,
            encodeReleaseExportTranscriptV2(parsed, controls.transcript_limits),
          ) !== 0
        )
          fail();
        const signatureBytes = signer.invokeSigner(() => sign(Buffer.from(transcript)));
        if (!Buffer.isBuffer(signatureBytes) || types.isProxy(signatureBytes)) fail();
        const signature = Buffer.from(signatureBytes);
        if (
          signature.length < 1 ||
          signature.length > 12288 ||
          (await verify(Buffer.from(transcript), Buffer.from(signature))) !== true
        )
          fail();
        const encodedSignature = signature.toString('base64');
        for (const closure of closures) {
          const unit =
            snapshot.mutation_units.find(
              (row) => row.release_unit === closure.expected.release_unit,
            ) ?? fail();
          const portable =
            snapshot.portable_units.find((row) => row.release_unit === unit.release_unit) ?? fail();
          const isCarrier = unit.mutation_evidence?.carrier_package_id === closure.package_id;
          await put(
            'provider-result',
            closure.package_id,
            encodeReleaseExportProviderResultV2(
              {
                package_id: closure.package_id,
                transcript,
                signature: encodedSignature,
                mutation_evidence: isCarrier ? portable.mutation_evidence : null,
              },
              controls.transcript_limits,
            ),
          );
        }
        const manifest = await tx.readCommitManifest();
        const manifestReceipt = await put('committed-manifest', null, manifest);
        const artifactSink: ArtifactSinkCommitIdentity = {
          sink_id: tx.sink_id,
          transaction_handle: tx.transaction_handle,
          committed_manifest_handle: manifestReceipt.opaque_handle,
          committed_manifest_sha256: manifestReceipt.sha256,
          committed_manifest_size_bytes: manifestReceipt.size_bytes,
          commit_protocol: 'devai.artifact-sink.two-phase.v1',
        };
        const identity = (packageId: string, kind: 'evidence-manifest' | 'provider-result') =>
          artifact(
            receipts.find((row) => row.package_id === packageId && row.kind === kind) ?? fail(),
          );
        const releaseUnits = prepared.release_units.map((unit) => ({
          ...unit,
          packages: unit.packages.map((pkg) => ({
            ...pkg,
            evidence_manifest: identity(pkg.package_id, 'evidence-manifest'),
            provider_result: identity(pkg.package_id, 'provider-result'),
            trust,
          })),
        }));
        const artifacts = [
          ...(prepared['artifacts'] as readonly OpaqueArtifactIdentity[]),
          ...receipts.filter((row) => row.kind !== 'committed-manifest').map(artifact),
        ].sort((a, b) =>
          utf8(
            `${a.kind}\0${a.sink_id}\0${a.opaque_handle}\0${a.sha256}\0${a.size_bytes}`,
            `${b.kind}\0${b.sink_id}\0${b.opaque_handle}\0${b.sha256}\0${b.size_bytes}`,
          ),
        );
        let terminal = false;
        return {
          outcome: 'success',
          dispatch_status: 'dispatched',
          provider_handle: tx.transaction_handle,
          material: {
            release_units: releaseUnits,
            inputs: material.inputs,
            evidence: {
              ...(prepared['evidence'] as ReleaseStateMaterial['evidence']),
              manifest_digest_sha256: manifestReceipt.sha256,
            },
            artifacts,
            artifact_sink: artifactSink,
          },
          transaction: {
            commit: async () => {
              if (terminal) fail();
              terminal = true;
              const committed = await tx.commit(manifestReceipt);
              if (!same(committed, { committed: true, ...artifactSink })) fail();
              exportedReader = store;
            },
            // No post-sign cleanup path can destroy or reopen the only evidence of this attempt.
            rollback: () => {
              if (!terminal) {
                terminal = true;
                tx.preserve();
              }
            },
            dispose: () => {
              if (!terminal) {
                terminal = true;
                tx.preserve();
              }
            },
          },
        };
      } catch (error) {
        if (signingStarted) {
          transaction?.preserve();
          return {
            outcome: 'unknown',
            dispatch_status: 'unknown',
            code: UNKNOWN,
            ...(transaction === undefined
              ? {}
              : { provider_handle: transaction.transaction_handle }),
          };
        }
        try {
          await transaction?.abort();
        } catch {
          transaction?.preserve();
          return { outcome: 'unknown', dispatch_status: 'unknown', code: UNKNOWN };
        }
        // A later explicitly issued lifecycle attempt may proceed after a proven pre-sign
        // failure. This is not a retry: the current call ends, and its attempt stays recorded.
        // A concurrent rejected caller must never release another invocation's custody.
        if (acquiredInvocation) invoked = false;
        const code =
          error instanceof Error &&
          [
            'release-export-capacity-unavailable',
            'release-export-capacity-insufficient',
            'rpl-package-identity-mismatch',
            'rpl-policy-resolution-mismatch',
            'rpl-adopter-binding-mismatch',
            'rpl-policy-source-unresolved',
          ].includes(error.message)
            ? error.message
            : INVALID;
        return { outcome: 'failure', dispatch_status: 'failed-before-dispatch', code };
      }
    },
  });
}
