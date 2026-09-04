import { canonicalJson } from '@devai-nyx/utils';
import { verifyReleaseCandidateSnapshot } from './release-candidate-snapshot.js';
import {
  isVerifiedReleasePackageSnapshot,
  verifyReleasePackageSnapshot,
  type ReleasePackageSnapshot,
} from './release-package-snapshot.js';
import {
  readReleasePolicyResolutionEvidence,
  resolveReleasePolicySnapshot,
  type ReleasePolicyExpectedIdentity,
  type ReleasePolicyResolutionEvidence,
  type VerifiedReleasePolicyResolution,
} from './release-policy-resolution.js';
import { verifyResolvedReleasePlanReceipt } from './release-lifecycle.js';

/** Internal raw-data closure. Host transports it; none of its members selects trust or code. */
export interface ReleasePolicyClosure {
  readonly format: 'devai.release-policy-closure.v1';
  readonly plan: Readonly<Record<string, unknown>>;
  readonly evidence: ReleasePolicyResolutionEvidence;
}

export interface ReleasePolicyClosureLimits {
  readonly maximum_archive_bytes: number;
  readonly maximum_unpacked_bytes: number;
  readonly maximum_git_bytes: number;
  readonly maximum_git_entries: number;
}

const INVALID = 'rpl-policy-resolution-mismatch';
function fail(): never {
  throw new Error(INVALID);
}

function copyPlan(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return JSON.parse(canonicalJson(value)) as Readonly<Record<string, unknown>>;
}

/** Capture only checked immutable bytes. A caller mutating this copy cannot alter the resolution. */
export function createReleasePolicyClosure(input: {
  readonly plan: Readonly<Record<string, unknown>>;
  readonly resolution: VerifiedReleasePolicyResolution;
}): ReleasePolicyClosure {
  if (!verifyResolvedReleasePlanReceipt({ receipt: input.plan, resolution: input.resolution }))
    return fail();
  return Object.freeze({
    format: 'devai.release-policy-closure.v1',
    plan: copyPlan(input.plan),
    evidence: readReleasePolicyResolutionEvidence(input.resolution),
  });
}

/**
 * Reconstruct the policy proof without a checkout, filesystem, network or bundle code.
 * The host must first bind this running verifier to `implementation`; that approved
 * snapshot and every expected identity/limit come from outside the exported bundle.
 * Package bytes are data to the already-loaded matching implementation, never imported.
 */
export function verifyReleasePolicyClosure(input: {
  readonly closure: ReleasePolicyClosure;
  readonly expected: ReleasePolicyExpectedIdentity;
  readonly implementation: ReleasePackageSnapshot;
  readonly limits: ReleasePolicyClosureLimits;
}): VerifiedReleasePolicyResolution {
  try {
    if (
      !isVerifiedReleasePackageSnapshot(input.implementation) ||
      canonicalJson(input.implementation.identity) !==
        canonicalJson(input.expected.installed_package)
    )
      return fail();
    const closure = input.closure;
    if (
      Object.keys(closure).sort().join(',') !== 'evidence,format,plan' ||
      closure.format !== 'devai.release-policy-closure.v1' ||
      Object.keys(closure.evidence).sort().join(',') !==
        (closure.evidence.producer === undefined
          ? 'archive,candidate_objects'
          : 'archive,candidate_objects,producer')
    )
      return fail();
    const directories = new Set<string>();
    const installedFiles = input.implementation.manifest.map((entry) => {
      const parts = entry.path.split('/');
      for (let index = 1; index < parts.length; index += 1)
        directories.add(parts.slice(0, index).join('/'));
      return { path: entry.path, mode: entry.mode, bytes: input.implementation.read(entry.path) };
    });
    const installed = verifyReleasePackageSnapshot({
      expected: input.expected.installed_package,
      archive: closure.evidence.archive,
      installed_files: installedFiles,
      installed_directories: [...directories],
      maximum_archive_bytes: input.limits.maximum_archive_bytes,
      maximum_unpacked_bytes: input.limits.maximum_unpacked_bytes,
    });
    const gitLimits = {
      maximum_bytes: input.limits.maximum_git_bytes,
      maximum_entries: input.limits.maximum_git_entries,
    };
    const candidate = verifyReleaseCandidateSnapshot({
      repository: input.expected.repository,
      objects: closure.evidence.candidate_objects,
      ...gitLimits,
    });
    const producer = closure.evidence.producer;
    let producerInput: Parameters<typeof resolveReleasePolicySnapshot>[0]['producer'];
    if (producer !== undefined) {
      if (Object.keys(producer).sort().join(',') !== 'build_provenance,files,source_objects')
        return fail();
      const expectedSource = input.expected.producer_toolchain?.['producer_source'];
      if (expectedSource === null || typeof expectedSource !== 'object') return fail();
      const source = expectedSource as Record<string, unknown>;
      if (
        typeof source['repository_id'] !== 'string' ||
        typeof source['commit'] !== 'string' ||
        typeof source['tree'] !== 'string'
      )
        return fail();
      producerInput = {
        files: producer.files,
        source: verifyReleaseCandidateSnapshot({
          repository: {
            id: source['repository_id'],
            commit: source['commit'],
            tree: source['tree'],
          },
          objects: producer.source_objects,
          ...gitLimits,
        }),
        build_provenance: producer.build_provenance,
      };
    }
    const resolution = resolveReleasePolicySnapshot({
      expected: input.expected,
      installed_package: installed,
      candidate,
      ...(producerInput === undefined ? {} : { producer: producerInput }),
    });
    if (!verifyResolvedReleasePlanReceipt({ receipt: closure.plan, resolution })) return fail();
    return resolution;
  } catch {
    return fail();
  }
}
