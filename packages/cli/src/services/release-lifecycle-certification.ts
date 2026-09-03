import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import type {
  CertificationOutputBlobHandle,
  ReleaseLifecycleRequest,
  ReleaseProvider,
  ReleaseProviderResult,
} from './release-lifecycle-execution.js';
import {
  verifyCertificationMaterial,
  type CertificationOutputClosure,
  type CertificationOutputClosureBinding,
  type ImmutableReleaseContentSource,
} from './release-prepare-kernel.js';

export interface ImmutableCertificationTaskPolicy {
  readonly release_unit: string;
  readonly task_policy_digest_sha256: string;
  /** Exact, content-addressed selected execution policy, not a candidate-controlled callback. */
  readonly document: unknown;
}

export interface CertificationEvidenceTransaction {
  readonly evidence_sink_id: string;
  readonly transaction_handle: string;
  readonly put: (input: {
    readonly bytes: Buffer;
    readonly sha256: string;
    readonly size_bytes: number;
  }) => CertificationOutputBlobHandle | Promise<CertificationOutputBlobHandle>;
  /** The external sink, not the producer, creates and atomically finalizes the receipts. */
  readonly commit: (
    closures: readonly (CertificationOutputClosureBinding & {
      readonly outputs: readonly Omit<
        CertificationOutputClosure['outputs'][number],
        'certification_evidence_receipt'
      >[];
    })[],
  ) => readonly CertificationOutputClosure[] | Promise<readonly CertificationOutputClosure[]>;
  readonly abort: () => void | Promise<void>;
}

export interface TrustedCertificationEvidenceSink extends Pick<
  ImmutableReleaseContentSource,
  'readCertificationEvidenceReceipt' | 'readCertificationOutputClosure' | 'readGeneratedBlob'
> {
  readonly kind: 'certification-evidence-sink-v3';
  readonly protocol: 'two-phase-content-addressed';
  readonly begin: (
    bindings: readonly CertificationOutputClosureBinding[],
  ) => CertificationEvidenceTransaction | Promise<CertificationEvidenceTransaction>;
}

export interface ProtectedCertificationProvider {
  readonly kind: 'protected-certification-provider-v3';
  /** Host implementation executes outside candidate authority, captures only declared outputs,
   * and finalizes them through the supplied sink before returning success. */
  readonly certify: (input: {
    readonly request: ReleaseLifecycleRequest;
    readonly task_policies: readonly ImmutableCertificationTaskPolicy[];
    readonly evidence_sink: TrustedCertificationEvidenceSink;
  }) => ReleaseProviderResult | Promise<ReleaseProviderResult>;
}

const protectedProviders = new WeakSet<ReleaseProvider>();

export function isProtectedReleaseCertificationProvider(
  provider: ReleaseProvider | undefined,
): boolean {
  return provider !== undefined && protectedProviders.has(provider);
}

/** Only a trusted host composition root can supply these capabilities. No CLI document selects code. */
export function createReleaseCertificationProvider(input: {
  readonly provider: ProtectedCertificationProvider;
  readonly evidence_sink: TrustedCertificationEvidenceSink;
  readonly content_source: Pick<ImmutableReleaseContentSource, 'readGitObject' | 'readGitBlob'>;
  readonly task_policies: readonly ImmutableCertificationTaskPolicy[];
}): ReleaseProvider {
  if (
    input.provider?.kind !== 'protected-certification-provider-v3' ||
    typeof input.provider.certify !== 'function'
  ) {
    throw new Error('release-certification-provider-unavailable');
  }
  const sink = input.evidence_sink;
  if (
    sink?.kind !== 'certification-evidence-sink-v3' ||
    sink.protocol !== 'two-phase-content-addressed' ||
    typeof sink.begin !== 'function' ||
    typeof sink.readCertificationEvidenceReceipt !== 'function' ||
    typeof sink.readCertificationOutputClosure !== 'function' ||
    typeof sink.readGeneratedBlob !== 'function'
  ) {
    throw new Error('release-certification-evidence-sink-unavailable');
  }
  if (
    typeof input.content_source?.readGitObject !== 'function' ||
    typeof input.content_source?.readGitBlob !== 'function'
  ) {
    throw new Error('release-prepare-git-tree-membership-invalid');
  }
  // Freeze by value so neither candidate mutation nor a provider can rewrite the selected policy.
  const policies = JSON.parse(
    canonicalJson(input.task_policies),
  ) as readonly ImmutableCertificationTaskPolicy[];
  const provider: ReleaseProvider = async (request) => {
    try {
      if (
        request.action_id !== 'release certify' ||
        canonicalJson(policies.map((policy) => policy.release_unit)) !==
          canonicalJson(request.candidate_locator.release_units.map((unit) => unit.release_unit)) ||
        policies.some(
          (policy) => canonicalSha256(policy.document) !== policy.task_policy_digest_sha256,
        )
      ) {
        throw new Error('release-task-policy-identity-mismatch');
      }
      const result = await input.provider.certify({
        request: JSON.parse(canonicalJson(request)) as ReleaseLifecycleRequest,
        task_policies: JSON.parse(
          canonicalJson(policies),
        ) as readonly ImmutableCertificationTaskPolicy[],
        evidence_sink: sink,
      });
      if (result.outcome !== 'success') return result;
      if (result.material === undefined || result.transaction !== undefined) {
        throw new Error('release-certification-generated-output-untrusted');
      }
      for (const [index, unit] of result.material.release_units.entries()) {
        if (
          unit.packages.some(
            (pkg) =>
              pkg.certification_manifest?.task_policy_digest_sha256 !==
              policies[index]?.task_policy_digest_sha256,
          )
        ) {
          throw new Error('release-task-policy-identity-mismatch');
        }
      }
      await verifyCertificationMaterial(request, result.material, {
        readGitObject: (value) => input.content_source.readGitObject(value),
        readGitBlob: (value) => input.content_source.readGitBlob(value),
        readCertificationEvidenceReceipt: (value) => sink.readCertificationEvidenceReceipt(value),
        readCertificationOutputClosure: (value) => sink.readCertificationOutputClosure(value),
        readGeneratedBlob: (value) => sink.readGeneratedBlob(value),
      });
      return result;
    } catch (error) {
      return {
        outcome: 'failure',
        code:
          error instanceof Error
            ? error.message
            : 'release-certification-generated-output-untrusted',
      };
    }
  };
  protectedProviders.add(provider);
  return provider;
}
