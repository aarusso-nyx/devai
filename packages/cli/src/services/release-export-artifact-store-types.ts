import type { DurableReleaseContentStoreOptions } from './release-content-store.js';
import type {
  ArtifactSinkCommitIdentity,
  OpaqueArtifactIdentity,
  ReleaseLifecycleStateV2,
  TrustedArtifactReader,
} from './release-lifecycle-execution.js';
import type { ArtifactSinkCommitReceipt } from './release-prepare-kernel.js';
import type { ReleasePackageIdentity, ReleasePackageSnapshot } from './release-package-snapshot.js';
import type { ReleasePolicyClosureLimits } from './release-policy-closure.js';
import type { ReleasePolicyClosureTransportLimits } from './release-policy-closure-transport.js';
import type { ReleasePolicyExpectedIdentity } from './release-policy-resolution.js';
import {
  RELEASE_EXPORT_SPEC_ID,
  type ReleaseExportTranscriptBinding,
  type ReleaseExportTranscriptLimits,
} from './release-export-transcript.js';
import { RELEASE_EXPORT_SPEC_V3_ID } from './release-export-transcript-v2.js';
import type { ReleaseExportMutationEvidence } from './release-export-mutation-evidence.js';
import type { ReleaseExportMutationUnitProjection } from './release-export-mutation-contract.js';
import type {
  ReleaseExportCertificationEvidence,
  ReleaseExportCertificationUnitProjection,
} from './release-export-certification-evidence.js';
import { RELEASE_EXPORT_SPEC_V4_ID } from './release-export-transcript-v3.js';

type ExportKind = 'evidence-manifest' | 'provider-result';
export type ReadInput = Parameters<TrustedArtifactReader['readArtifact']>[0];

/** Portable host data contract. The private authority adapter independently validates it. */
export interface LegacyProtectedReleaseExportBinding extends ReleaseExportTranscriptBinding {
  readonly export_spec_digest_sha256: string;
  readonly closure_inputs: readonly {
    readonly package_id: string;
    readonly sha256: string;
    readonly size_bytes: number;
    readonly expected_installed_package: ReleasePackageIdentity;
    readonly policy_resolution_digest_sha256: string;
  }[];
}
/**
 * Portable copy of the sealed mutation projection contract.  The authority package
 * independently validates this value at the runtime boundary; keeping the public
 * declaration structural prevents the private workspace package from leaking into
 * the installed CLI's declaration closure.
 */
export interface ProtectedReleaseExportBindingV3 extends Omit<
  LegacyProtectedReleaseExportBinding,
  'closure_inputs'
> {
  readonly closure_inputs: readonly (LegacyProtectedReleaseExportBinding['closure_inputs'][number] & {
    readonly release_unit: string;
  })[];
  readonly mutation_units: readonly ReleaseExportMutationUnitProjection[];
}
export interface ProtectedReleaseExportBindingV4 extends ProtectedReleaseExportBindingV3 {
  readonly certification_units: readonly ReleaseExportCertificationUnitProjection[];
}
export type ProtectedReleaseExportBinding =
  | LegacyProtectedReleaseExportBinding
  | ProtectedReleaseExportBindingV3
  | ProtectedReleaseExportBindingV4;

export interface ReleaseExportArtifactObjectReceipt {
  readonly sink_id: string;
  readonly transaction_handle: string;
  readonly opaque_handle: string;
  readonly kind: ExportKind | 'committed-manifest';
  readonly package_id: string | null;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly export_spec_id:
    | typeof RELEASE_EXPORT_SPEC_ID
    | typeof RELEASE_EXPORT_SPEC_V3_ID
    | typeof RELEASE_EXPORT_SPEC_V4_ID;
  readonly export_spec_digest_sha256: string;
}

export type ReleaseExportArtifactObject = {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly size_bytes: number;
} & (
  | { readonly kind: ExportKind; readonly package_id: string }
  | { readonly kind: 'committed-manifest'; readonly package_id: null }
);

export interface ReleaseExportArtifactCommitManifest {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'release-artifact-sink-commit-manifest';
  readonly sink_id: string;
  readonly transaction_handle: string;
  readonly repository: ProtectedReleaseExportBinding['repository'];
  readonly candidate: ProtectedReleaseExportBinding['candidate'];
  readonly export_spec_id:
    | typeof RELEASE_EXPORT_SPEC_ID
    | typeof RELEASE_EXPORT_SPEC_V3_ID
    | typeof RELEASE_EXPORT_SPEC_V4_ID;
  readonly export_spec_digest_sha256: string;
  readonly parent_artifact_sink: ArtifactSinkCommitIdentity;
  readonly binding: ProtectedReleaseExportBinding;
  readonly artifacts: readonly OpaqueArtifactIdentity[];
}

export interface TrustedExportArtifactSinkTransaction extends TrustedArtifactReader {
  readonly sink_id: string;
  readonly transaction_handle: string;
  readonly put: (input: ReleaseExportArtifactObject) => Promise<ReleaseExportArtifactObjectReceipt>;
  /** The sole canonical signing preimage. No signing or trust assertion occurs here. */
  readonly readTranscript: () => Promise<Buffer>;
  /** Call immediately before external signer dispatch. This permanently disables abort. */
  readonly markSigningStarted: () => Promise<Buffer>;
  readonly readCommitManifest: () => Promise<Buffer>;
  readonly commit: (
    manifest: ReleaseExportArtifactObjectReceipt,
  ) => Promise<ArtifactSinkCommitReceipt>;
  readonly abort: () => Promise<void>;
  /** Pure terminalization for unknown outcomes; retains every allocated handle and all disk evidence. */
  readonly preserve: () => readonly ReleaseExportArtifactObjectReceipt[];
}

export interface TrustedExportArtifactSink extends TrustedArtifactReader {
  readonly begin: () => Promise<TrustedExportArtifactSinkTransaction>;
}

/** All controls are externally selected before candidate input; there is no default root or signer. */
export interface ReleaseExportArtifactStoreOptions extends DurableReleaseContentStoreOptions {
  readonly binding: ProtectedReleaseExportBinding;
  readonly prepared_state: ReleaseLifecycleStateV2;
  readonly parent_reader: TrustedArtifactReader;
  readonly implementation: ReleasePackageSnapshot;
  readonly closures: readonly {
    readonly package_id: string;
    readonly bytes: Buffer;
    readonly expected: ReleasePolicyExpectedIdentity;
  }[];
  readonly closure_limits: ReleasePolicyClosureLimits;
  readonly transport_limits: ReleasePolicyClosureTransportLimits;
  readonly transcript_limits: ReleaseExportTranscriptLimits;
  /** Required only in the exact forward v3 branch; legacy export rejects it. */
  readonly mutation_evidence?: ReleaseExportMutationEvidence;
  /** Required only in the exact forward v4 branch; earlier branches reject it. */
  readonly certification_evidence?: ReleaseExportCertificationEvidence;
}
