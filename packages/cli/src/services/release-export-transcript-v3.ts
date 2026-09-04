import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { captureExportCertificationUnitProjections } from '@devai-nyx/authority';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { readCertifiedEvidenceCarrier } from './release-certified-evidence-carrier.js';
import type { ReleaseExportCertificationUnitProjection } from './release-export-certification-evidence.js';
import type {
  ReleaseExportProviderResultInput,
  ReleaseExportTranscriptLimits,
} from './release-export-transcript.js';
import {
  captureReleaseExportJson,
  encodeReleaseExportProviderResultV2,
  encodeReleaseExportTranscriptV2,
  RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT,
  type ReleaseExportProviderResultV2,
  type ReleaseExportTranscriptV2,
  type ReleaseUnitMutationPortable,
} from './release-export-transcript-v2.js';

export const RELEASE_EXPORT_TRANSCRIPT_V3_FORMAT = 'devai.release-export-transcript-json.v3';
export const RELEASE_EXPORT_PROVIDER_RESULT_V3_FORMAT =
  'devai.release-export-provider-result-json.v3';
export const RELEASE_EXPORT_SPEC_V4_ID = 'devai.release-export-closure.v4';
export const RELEASE_EXPORT_SPEC_V4_DIGEST =
  '245fba3823b7f80a55b73e8721ac5871a40b90cce8789aa49b87228b8d03ac44';

export interface ReleaseExportTranscriptV3 extends Omit<ReleaseExportTranscriptV2, 'version'> {
  readonly version: typeof RELEASE_EXPORT_TRANSCRIPT_V3_FORMAT;
  readonly certification_units: readonly ReleaseExportCertificationUnitProjection[];
}

/** Exact bounded carrier bytes for one unit; never a handle, path or origin store. */
export interface ReleaseUnitCertifiedEvidencePortable {
  readonly version: 'devai.release-certified-evidence-portable-json.v1';
  readonly release_unit: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly bytes_base64: string;
}

export interface ReleaseExportProviderResultV3 extends Omit<
  ReleaseExportProviderResultV2,
  'version'
> {
  readonly version: typeof RELEASE_EXPORT_PROVIDER_RESULT_V3_FORMAT;
  readonly certification_evidence: ReleaseUnitCertifiedEvidencePortable | null;
}

export interface ReleaseExportProviderResultV3Input extends ReleaseExportProviderResultInput {
  readonly mutation_evidence: ReleaseUnitMutationPortable | null;
  readonly certification_evidence: ReleaseUnitCertifiedEvidencePortable | null;
}

const ERROR = 'release-export-transcript-invalid';
const SHA = /^[a-f0-9]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function fail(): never {
  throw new Error(ERROR);
}
function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch {
    return fail();
  }
}
function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return fail();
  }
  return value as Record<string, unknown>;
}
function bytes(value: unknown, maximum: number): Buffer {
  const result = Buffer.from(canonicalJson(value));
  if (result.length === 0 || result.length > maximum) return fail();
  return result;
}
function parse(raw: Buffer, maximum: number): unknown {
  if (!Buffer.isBuffer(raw) || types.isProxy(raw) || raw.length === 0 || raw.length > maximum)
    return fail();
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  if (Buffer.compare(raw, bytes(value, maximum)) !== 0) return fail();
  return value;
}

/** Layers the complete certification population onto the unchanged v2 kernel. */
function validate(
  value: unknown,
  limits: ReleaseExportTranscriptLimits,
): ReleaseExportTranscriptV3 {
  const current = closed(captureReleaseExportJson(value, limits.maximum_transcript_bytes), [
    'version',
    'binding',
    'parent',
    'closures',
    'mutation_units',
    'certification_units',
    'destination',
    'trust',
  ]);
  if (current['version'] !== RELEASE_EXPORT_TRANSCRIPT_V3_FORMAT) fail();
  const trust = current['trust'];
  if (
    trust === null ||
    typeof trust !== 'object' ||
    (trust as { signature_algorithm?: unknown }).signature_algorithm !== 'ed25519'
  )
    fail();
  const { certification_units: certification, ...rest } = current;
  const previous: ReleaseExportTranscriptV2 = {
    ...(rest as unknown as ReleaseExportTranscriptV2),
    version: RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT,
  };
  encodeReleaseExportTranscriptV2(previous, limits);
  captureExportCertificationUnitProjections(
    certification,
    previous.closures.map((row) => ({
      package_id: row.package_id,
      release_unit: row.release_unit,
    })),
    limits.maximum_packages,
  );
  return current as unknown as ReleaseExportTranscriptV3;
}

export function encodeReleaseExportTranscriptV3(
  value: ReleaseExportTranscriptV3,
  limits: ReleaseExportTranscriptLimits,
): Buffer {
  return guarded(() => bytes(validate(value, limits), limits.maximum_transcript_bytes));
}

export function verifyReleaseExportTranscriptV3(
  raw: Buffer,
  expected: ReleaseExportTranscriptV3,
  limits: ReleaseExportTranscriptLimits,
): ReleaseExportTranscriptV3 {
  return guarded(() => {
    if (
      !Buffer.isBuffer(raw) ||
      types.isProxy(raw) ||
      Buffer.compare(raw, encodeReleaseExportTranscriptV3(expected, limits)) !== 0
    )
      return fail();
    return validate(parse(raw, limits.maximum_transcript_bytes), limits);
  });
}

/** Bounded closed-document decoding of the exact carrier the transcript already binds. */
function portableCertification(
  value: unknown,
  projection: ReleaseExportCertificationUnitProjection,
  maximum: number,
): ReleaseUnitCertifiedEvidencePortable {
  const document = closed(value, [
    'version',
    'release_unit',
    'sha256',
    'size_bytes',
    'bytes_base64',
  ]);
  const size = document['size_bytes'];
  const encoded = document['bytes_base64'];
  if (
    document['version'] !== 'devai.release-certified-evidence-portable-json.v1' ||
    document['release_unit'] !== projection.release_unit ||
    typeof document['sha256'] !== 'string' ||
    !SHA.test(document['sha256']) ||
    !Number.isSafeInteger(size) ||
    (size as number) < 1 ||
    (size as number) > maximum ||
    typeof encoded !== 'string' ||
    encoded.length === 0 ||
    encoded.length > maximum ||
    encoded.length !== Math.ceil((size as number) / 3) * 4 ||
    !BASE64.test(encoded)
  )
    return fail();
  const raw = Buffer.from(encoded, 'base64');
  if (
    raw.length !== size ||
    raw.toString('base64') !== encoded ||
    hash(raw) !== document['sha256'] ||
    !same({ sha256: hash(raw), size_bytes: raw.length }, projection.carrier)
  )
    fail();
  // Self-authenticating decode: every retained member must match the signed identities.
  const decoded = readCertifiedEvidenceCarrier(raw, maximum);
  if (
    decoded.carrier.release_unit !== projection.release_unit ||
    decoded.derivation_binding_digest_sha256 !== projection.derivation_binding_digest_sha256 ||
    !same(
      { sha256: hash(decoded.candidate_receipt), size_bytes: decoded.candidate_receipt.length },
      projection.candidate_receipt,
    ) ||
    !same(
      { sha256: hash(decoded.task_policy), size_bytes: decoded.task_policy.length },
      projection.task_policy,
    ) ||
    !same(
      { sha256: hash(decoded.namespace_census), size_bytes: decoded.namespace_census.length },
      projection.namespace_census,
    ) ||
    !same(
      decoded.task_results.map((result) => ({
        sha256: hash(result),
        size_bytes: result.length,
      })),
      projection.task_results,
    ) ||
    canonicalSha256(decoded.census.entries) !== projection.census_member_projection_digest_sha256 ||
    decoded.census.entries.length !== projection.census_member_count
  )
    fail();
  return document as unknown as ReleaseUnitCertifiedEvidencePortable;
}

export function encodeReleaseExportProviderResultV3(
  input: ReleaseExportProviderResultV3Input,
  limits: ReleaseExportTranscriptLimits,
): Buffer {
  return guarded(() => {
    closed(input, [
      'package_id',
      'transcript',
      'signature',
      'mutation_evidence',
      'certification_evidence',
    ]);
    const transcript = validate(parse(input.transcript, limits.maximum_transcript_bytes), limits);
    const closure =
      transcript.closures.find((row) => row.package_id === input.package_id) ?? fail();
    const projection =
      transcript.certification_units.find((row) => row.release_unit === closure.release_unit) ??
      fail();
    const isCarrier = projection.carrier_package_id === input.package_id;
    if (isCarrier === (input.certification_evidence === null)) fail();
    if (isCarrier)
      portableCertification(
        input.certification_evidence,
        projection,
        limits.maximum_provider_result_bytes,
      );
    // Reuse the unchanged v2 grammar for every member the v3 result inherits.
    const { certification_units: _units, ...inherited } = transcript;
    const previousTranscript = encodeReleaseExportTranscriptV2(
      {
        ...(inherited as unknown as ReleaseExportTranscriptV2),
        version: RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT,
      },
      limits,
    );
    const previous = encodeReleaseExportProviderResultV2(
      {
        package_id: input.package_id,
        transcript: previousTranscript,
        signature: input.signature,
        mutation_evidence: input.mutation_evidence,
      },
      limits,
    );
    const decoded = JSON.parse(previous.toString('utf8')) as ReleaseExportProviderResultV2;
    const result: ReleaseExportProviderResultV3 = {
      ...decoded,
      version: RELEASE_EXPORT_PROVIDER_RESULT_V3_FORMAT,
      transcript: Buffer.prototype.toString.call(input.transcript, 'utf8'),
      transcript_sha256: hash(input.transcript),
      certification_evidence: input.certification_evidence,
    };
    return bytes(result, limits.maximum_provider_result_bytes);
  });
}

/** Signature authentication is external; the complete signed transcript is an expected input. */
export function verifyReleaseExportProviderResultV3(
  raw: Buffer,
  expected: ReleaseExportProviderResultInput,
  limits: ReleaseExportTranscriptLimits,
): ReleaseExportProviderResultV3 {
  return guarded(() => {
    closed(expected, ['package_id', 'transcript', 'signature']);
    const result = closed(parse(raw, limits.maximum_provider_result_bytes), [
      'version',
      'package_id',
      'release_unit',
      'evidence_manifest',
      'transcript',
      'transcript_sha256',
      'signature',
      'trust',
      'mutation_evidence',
      'certification_evidence',
    ]);
    if (result['version'] !== RELEASE_EXPORT_PROVIDER_RESULT_V3_FORMAT) fail();
    const rebuilt = encodeReleaseExportProviderResultV3(
      {
        ...expected,
        mutation_evidence: result['mutation_evidence'] as ReleaseUnitMutationPortable | null,
        certification_evidence: result[
          'certification_evidence'
        ] as ReleaseUnitCertifiedEvidencePortable | null,
      },
      limits,
    );
    if (Buffer.compare(raw, rebuilt) !== 0) fail();
    return result as unknown as ReleaseExportProviderResultV3;
  });
}

/** Enforce the exact complete package set; a single valid carrier is not a complete export. */
export function verifyReleaseExportProviderResultSetV3(
  raw: readonly Buffer[],
  expected: Omit<ReleaseExportProviderResultInput, 'package_id'>,
  limits: ReleaseExportTranscriptLimits,
): readonly ReleaseExportProviderResultV3[] {
  return guarded(() => {
    closed(expected, ['transcript', 'signature']);
    const transcript = validate(
      parse(expected.transcript, limits.maximum_transcript_bytes),
      limits,
    );
    if (
      !Array.isArray(raw) ||
      raw.length !== transcript.closures.length ||
      raw.length > limits.maximum_packages
    )
      fail();
    const seen = new Set<string>();
    const carriers = new Set<string>();
    const results = raw.map((input) => {
      const document = parse(input, limits.maximum_provider_result_bytes) as Record<
        string,
        unknown
      >;
      const packageId = document['package_id'];
      if (typeof packageId !== 'string' || seen.has(packageId)) return fail();
      seen.add(packageId);
      const value = verifyReleaseExportProviderResultV3(
        input,
        { ...expected, package_id: packageId },
        limits,
      );
      if (value.certification_evidence !== null) {
        if (carriers.has(value.certification_evidence.release_unit)) fail();
        carriers.add(value.certification_evidence.release_unit);
      }
      return value;
    });
    // Every resolved unit contributes exactly one carrier across the complete set.
    if (
      transcript.closures.some((row) => !seen.has(row.package_id)) ||
      carriers.size !== transcript.certification_units.length ||
      transcript.certification_units.some((unit) => !carriers.has(unit.release_unit))
    )
      fail();
    return results;
  });
}
