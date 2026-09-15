/**
 * Portable mutation-evidence projection carried by the public CLI package.
 *
 * The private authority boundary validates this structural value again at every
 * runtime crossing.  It is intentionally defined here so emitted declarations
 * remain installable without a private workspace dependency.
 */
export interface ReleaseExportMutationObjectIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly evidence_sink_id: string;
  readonly opaque_handle: string;
}

export interface ReleaseExportMutationMemberIdentity extends ReleaseExportMutationObjectIdentity {
  readonly document_kind:
    | 'mutation-normalized-stryker-report-v2'
    | 'mutation-package-result-v2'
    | 'mutation-composed-report-set-v2'
    | 'mutation-semantic-verification-receipt-v2';
  readonly package_name: string | null;
}

export interface ReleaseExportMutationUnitProjection {
  readonly release_unit: string;
  readonly mutation_evidence: null | {
    readonly carrier_package_id: string;
    readonly binding: {
      readonly repository_id: string;
      readonly candidate_commit: string;
      readonly candidate_tree: string;
      readonly release_unit: string;
      readonly release_plan_receipt_digest_sha256: string;
      readonly release_profile_digest_sha256: string;
      readonly mutation_policy_digest_sha256: string;
      readonly task_policy_digests_sha256: readonly string[];
    };
    readonly closure: { readonly sha256: string; readonly size_bytes: number };
    readonly receipt: {
      readonly sha256: string;
      readonly size_bytes: number;
      readonly receipt_digest_sha256: string;
    };
    readonly output_contract: ReleaseExportMutationObjectIdentity;
    readonly members: readonly ReleaseExportMutationMemberIdentity[];
    readonly member_projection_digest_sha256: string;
  };
}
