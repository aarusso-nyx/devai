import { createHash } from 'node:crypto';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import {
  validateReleaseLifecycleRequest,
  type ReleaseLifecycleRequest,
  type ReleaseStateMaterial,
} from './release-lifecycle-execution.js';
import type { CertifiedEvidenceCarrierBinding } from './release-lifecycle-certification.js';
import { readCertifiedEvidenceCarrier } from './release-certified-evidence-carrier.js';
import { captureReleaseExportJson } from './release-export-transcript-v2.js';

type Material = Pick<ReleaseStateMaterial, 'release_units'>;

/** Reads committed carrier bytes only. It never opens a checkout, cache or network. */
export interface ReleaseCertifiedEvidenceCarrierReader {
  readonly certified_evidence_carrier_maximum_bytes?: number;
  readonly readCertifiedEvidenceCarrier?: (
    binding: CertifiedEvidenceCarrierBinding,
  ) => Buffer | Promise<Buffer>;
}

export interface ReleaseExportByteIdentity {
  readonly sha256: string;
  readonly size_bytes: number;
}

/** Fully enumerated identities the aggregate signing preimage binds for one unit. */
export interface ReleaseExportCertificationUnitProjection {
  readonly release_unit: string;
  readonly carrier_package_id: string;
  readonly carrier: ReleaseExportByteIdentity;
  readonly derivation_binding_digest_sha256: string;
  readonly candidate_receipt: ReleaseExportByteIdentity;
  readonly task_policy: ReleaseExportByteIdentity;
  readonly task_results: readonly ReleaseExportByteIdentity[];
  readonly namespace_census: ReleaseExportByteIdentity;
  readonly census_member_projection_digest_sha256: string;
  readonly census_member_count: number;
}

export interface ReleaseExportCertificationEvidence {
  readonly kind: 'protected-release-export-certification-evidence';
}

export interface ReleaseExportCertificationEvidenceInput {
  readonly request: ReleaseLifecycleRequest;
  readonly material: Material;
  readonly source: ReleaseCertifiedEvidenceCarrierReader;
  readonly maximum_provider_result_bytes: number;
}

export interface ReleaseExportCertificationEvidenceExpected extends Material {
  readonly repository: ReleaseLifecycleRequest['repository_locator'];
}

export interface ReleaseExportCertificationEvidenceSnapshot {
  readonly certification_units: readonly ReleaseExportCertificationUnitProjection[];
  readonly portable_units: readonly {
    readonly release_unit: string;
    readonly carrier_bytes_base64: string;
  }[];
}

interface Capture {
  readonly input: ReleaseExportCertificationEvidenceInput;
  readonly snapshot: ReleaseExportCertificationEvidenceSnapshot;
}

const captures = new WeakMap<ReleaseExportCertificationEvidence, Capture>();
const ERROR = 'release-export-artifact-sink-protocol-invalid';

function fail(): never {
  throw new Error(ERROR);
}
function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function clone<T>(value: T, maximum: number): T {
  return captureReleaseExportJson(value, maximum) as T;
}
function identity(bytes: Buffer): ReleaseExportByteIdentity {
  return { sha256: hash(bytes), size_bytes: bytes.length };
}
function utf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/**
 * Resolves exactly one complete certification carrier for every resolved release unit,
 * including units whose mutation outcome is none. Missing, duplicate, extra, substituted
 * or cross-unit carriers refuse here, before any sink transaction or signer dispatch.
 */
export async function createReleaseExportCertificationEvidence(
  input: ReleaseExportCertificationEvidenceInput,
): Promise<ReleaseExportCertificationEvidence> {
  try {
    const maximum = input.maximum_provider_result_bytes;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 0x7fffffff) fail();
    const request = validateReleaseLifecycleRequest(clone(input.request, maximum));
    const material = clone(input.material, maximum);
    const source = input.source;
    const read = source.readCertifiedEvidenceCarrier;
    const bound = source.certified_evidence_carrier_maximum_bytes;
    if (
      typeof read !== 'function' ||
      bound === undefined ||
      !Number.isSafeInteger(bound) ||
      bound < 1
    )
      fail();
    const budget = Math.min(bound, maximum);
    if (!Number.isSafeInteger(budget) || budget < 1) fail();
    const units = request.candidate_locator.release_units;
    if (units.length === 0 || units.length !== material.release_units.length) fail();
    const projections: ReleaseExportCertificationUnitProjection[] = [];
    const portable: ReleaseExportCertificationEvidenceSnapshot['portable_units'][number][] = [];
    const seen = new Set<string>();
    let encodedTotal = 0;
    for (const [index, unit] of units.entries()) {
      const evidence = material.release_units[index] ?? fail();
      if (evidence.release_unit !== unit.release_unit || seen.has(unit.release_unit)) fail();
      seen.add(unit.release_unit);
      const roster = unit.package_roster;
      if (roster.length === 0 || evidence.packages.length === 0) fail();
      // Exactly one task policy governs a unit; a split policy is not a certified unit.
      const digests = new Set(
        evidence.packages.map((pkg) => {
          const manifest = pkg.certification_manifest;
          if (
            manifest === undefined ||
            manifest === null ||
            typeof manifest.task_policy_digest_sha256 !== 'string' ||
            manifest.candidate.commit !== request.candidate_locator.commit ||
            manifest.candidate.tree !== request.candidate_locator.tree
          )
            return fail();
          return manifest.task_policy_digest_sha256;
        }),
      );
      if (digests.size !== 1) fail();
      const taskPolicyDigest = [...digests][0] ?? fail();
      const binding: CertifiedEvidenceCarrierBinding = {
        repository: request.repository_locator,
        candidate: {
          commit: request.candidate_locator.commit,
          tree: request.candidate_locator.tree,
        },
        task_policy_digest_sha256: taskPolicyDigest,
        release_unit: unit.release_unit,
      };
      const raw = await read(clone(binding, maximum));
      if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > budget) fail();
      const bytes = Buffer.from(raw);
      encodedTotal += Math.ceil(bytes.length / 3) * 4;
      if (!Number.isSafeInteger(encodedTotal) || encodedTotal > maximum) fail();
      const decoded = readCertifiedEvidenceCarrier(bytes, budget);
      if (
        decoded.carrier.release_unit !== unit.release_unit ||
        !same(decoded.carrier.derivation, {
          repository: binding.repository,
          candidate: binding.candidate,
          task_policy_digest_sha256: binding.task_policy_digest_sha256,
        })
      )
        fail();
      // Deterministic election: the unit's lexicographically first package carries it.
      const carrierPackageId =
        roster.map((entry) => entry.package_id).sort((a, b) => utf8(a, b))[0] ?? fail();
      projections.push({
        release_unit: unit.release_unit,
        carrier_package_id: carrierPackageId,
        carrier: identity(bytes),
        derivation_binding_digest_sha256: decoded.derivation_binding_digest_sha256,
        candidate_receipt: identity(decoded.candidate_receipt),
        task_policy: identity(decoded.task_policy),
        task_results: decoded.task_results.map((result) => identity(result)),
        namespace_census: identity(decoded.namespace_census),
        census_member_projection_digest_sha256: canonicalSha256(decoded.census.entries),
        census_member_count: decoded.census.entries.length,
      });
      portable.push({
        release_unit: unit.release_unit,
        carrier_bytes_base64: bytes.toString('base64'),
      });
    }
    const order = (a: { release_unit: string }, b: { release_unit: string }) =>
      utf8(a.release_unit, b.release_unit);
    projections.sort(order);
    portable.sort(order);
    const token: ReleaseExportCertificationEvidence = Object.freeze({
      kind: 'protected-release-export-certification-evidence',
    });
    captures.set(token, {
      input: { request, material, source, maximum_provider_result_bytes: maximum },
      snapshot: { certification_units: projections, portable_units: portable },
    });
    return token;
  } catch {
    return fail();
  }
}

export function readReleaseExportCertificationEvidence(
  token: ReleaseExportCertificationEvidence,
  expected: ReleaseExportCertificationEvidenceExpected,
): ReleaseExportCertificationEvidenceSnapshot {
  try {
    const captured = captures.get(token) ?? fail();
    const maximum = captured.input.maximum_provider_result_bytes;
    const material = clone(expected, maximum);
    if (
      !same(material.repository, captured.input.request.repository_locator) ||
      !same(material.release_units, captured.input.material.release_units)
    )
      fail();
    return {
      certification_units: captured.snapshot.certification_units.map((unit) =>
        clone(unit, maximum),
      ),
      portable_units: captured.snapshot.portable_units.map((unit) => clone(unit, maximum)),
    };
  } catch {
    return fail();
  }
}

/** A changed reread is failure, never a replacement snapshot or an implicit retry. */
export async function reverifyReleaseExportCertificationEvidence(
  token: ReleaseExportCertificationEvidence,
): Promise<void> {
  try {
    const captured = captures.get(token) ?? fail();
    const observedToken = await createReleaseExportCertificationEvidence(captured.input);
    const observed = captures.get(observedToken) ?? fail();
    if (canonicalSha256(observed.snapshot) !== canonicalSha256(captured.snapshot)) fail();
  } catch {
    fail();
  }
}
