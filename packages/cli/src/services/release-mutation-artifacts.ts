/** @deprecated Compatibility declarations only. Mutation machinery moved to bedel. */
type Json = Readonly<Record<string, unknown>>;
export interface ReleaseMutationThresholdsV21 {
  readonly break: number;
  readonly high: number;
  readonly low: number;
  readonly scoreMin: number;
  readonly survivedMax: number;
}
export interface ReleaseMutationPackageInputsV21 {
  readonly packageName: string;
  readonly workspace: string;
  readonly inputProjection: Json;
  readonly thresholds: ReleaseMutationThresholdsV21;
  readonly toolVersions: Readonly<Record<string, string>>;
}
export interface ReleaseMutationArtifactV21 {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: Buffer;
}
export interface ReleaseMutationPackageArtifactsV21 {
  readonly inputDigest: string;
  readonly report: ReleaseMutationArtifactV21;
  readonly result: ReleaseMutationArtifactV21;
}
export interface ReleaseMutationArtifactLimitsV21 {
  readonly maximum_raw_report_bytes: number;
  readonly maximum_document_bytes: number;
  readonly maximum_files: number;
  readonly maximum_mutants: number;
}
export interface ReleaseMutationDiscoveredMutantV21 {
  readonly id: string;
  readonly mutatorName: string;
  readonly replacementDigest: string;
  readonly location: {
    readonly start: {
      readonly line: number;
      readonly column: number;
    };
    readonly end: {
      readonly line: number;
      readonly column: number;
    };
  };
}
export function normalizeReleaseMutationPackageV21(input: {
  readonly expected: ReleaseMutationPackageInputsV21;
  readonly raw_report: Uint8Array;
  readonly execution_cwd: string;
  readonly process: {
    readonly errorAbsent: boolean;
    readonly signal: string | null;
    readonly status: number | null;
  };
  readonly source_files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly mutants: readonly ReleaseMutationDiscoveredMutantV21[];
  }[];
  readonly test_files: readonly string[];
  readonly limits: ReleaseMutationArtifactLimitsV21;
}): ReleaseMutationPackageArtifactsV21 {
  void input;
  throw new Error('MUTATION_OFFLOADED_TO_BEDEL: use bedel');
}
export function finalizeReleaseMutationArtifactsV21(input: {
  readonly candidate: {
    readonly releaseUnit: string;
    readonly commit: string;
    readonly tree: string;
  };
  readonly releasePlanReceiptDigest: string;
  readonly releaseProfileDigest: string;
  readonly policyDigest: string;
  readonly summaryPath: string;
  readonly semanticReceiptPath: string;
  readonly expected: readonly ReleaseMutationPackageInputsV21[];
  readonly packages: readonly {
    readonly packageName: string;
    readonly disposition: 'executed' | 'reused';
    readonly origin: unknown;
    readonly artifacts: ReleaseMutationPackageArtifactsV21;
  }[];
  readonly maximum_document_bytes: number;
}): Promise<{
  readonly contract: Json;
  readonly summary: Json;
  readonly materials: readonly Json[];
}> {
  void input;
  throw new Error('MUTATION_OFFLOADED_TO_BEDEL: use bedel');
}
export {};
