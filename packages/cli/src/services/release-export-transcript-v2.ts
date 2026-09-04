import { createHash } from 'node:crypto';
import { types } from 'node:util';
import {
  captureExportMutationUnitProjections,
} from '@devai-nyx/authority';
import type { ReleaseExportMutationUnitProjection } from './release-export-mutation-contract.js';
import { canonicalJson } from '@devai-nyx/utils';
import {
  RELEASE_EXPORT_TRANSCRIPT_FORMAT,
  encodeReleaseExportTranscript,
  encodeReleaseExportProviderResult,
  type ReleaseExportTranscript,
  type ReleaseExportTranscriptLimits,
  type ReleaseExportProviderResultInput,
  type ReleaseExportProviderResult,
} from './release-export-transcript.js';
import {
  verifyUnitMutationEvidenceClosure,
  type ReleaseUnitMutationEvidenceClosure,
} from './release-unit-mutation-evidence.js';

export const RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT = 'devai.release-export-transcript-json.v2';
export const RELEASE_EXPORT_PROVIDER_RESULT_V2_FORMAT =
  'devai.release-export-provider-result-json.v2';
export const RELEASE_EXPORT_SPEC_V3_ID = 'devai.release-export-closure.v3';
export const RELEASE_EXPORT_SPEC_V3_DIGEST =
  'aac1c75a539516a38b567aea9be4490eb3f82fe0ab7b75e46e55e46d3166e37f';

export interface ReleaseExportTranscriptV2 extends Omit<
  ReleaseExportTranscript,
  'version' | 'closures'
> {
  readonly version: typeof RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT;
  readonly closures: readonly (ReleaseExportTranscript['closures'][number] & {
    readonly release_unit: string;
  })[];
  readonly mutation_units: readonly ReleaseExportMutationUnitProjection[];
}

export interface ReleaseExportByteDocument {
  readonly sha256: string;
  readonly size_bytes: number;
  readonly bytes_base64: string;
}
export interface ReleaseExportPathByteDocument extends ReleaseExportByteDocument {
  readonly path: string;
}
export interface ReleaseUnitMutationPortable {
  readonly version: 'devai.release-unit-mutation-portable-json.v1';
  readonly closure: ReleaseExportByteDocument;
  readonly receipt: ReleaseExportByteDocument;
  readonly output_contract: ReleaseExportPathByteDocument;
  readonly members: readonly ReleaseExportPathByteDocument[];
}
export interface ReleaseExportProviderResultV2 extends Omit<
  ReleaseExportProviderResult,
  'version'
> {
  readonly version: typeof RELEASE_EXPORT_PROVIDER_RESULT_V2_FORMAT;
  readonly release_unit: string;
  readonly mutation_evidence: ReleaseUnitMutationPortable | null;
}
export interface ReleaseExportProviderResultV2Input extends ReleaseExportProviderResultInput {
  readonly mutation_evidence: ReleaseUnitMutationPortable | null;
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
function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
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
function array(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  for (let i = 0; i < value.length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !('value' in descriptor)) return fail();
  }
  return value;
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
function limitsValid(limits: ReleaseExportTranscriptLimits): void {
  const fields = closed(limits, [
    'maximum_transcript_bytes',
    'maximum_provider_result_bytes',
    'maximum_packages',
  ]);
  for (const value of Object.values(fields))
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 0x7fffffff)
      fail();
}

export function captureReleaseExportTranscriptLimits(
  value: ReleaseExportTranscriptLimits,
): ReleaseExportTranscriptLimits {
  return guarded(() => {
    limitsValid(value);
    return {
      maximum_transcript_bytes: value.maximum_transcript_bytes,
      maximum_provider_result_bytes: value.maximum_provider_result_bytes,
      maximum_packages: value.maximum_packages,
    };
  });
}

/** Capture descriptors, never property reads or toJSON; callers cannot change a validated value. */
export function captureReleaseExportJson(value: unknown, maximum: number): unknown {
  let remaining = maximum;
  const ancestors = new Set<object>();
  const visit = (input: unknown): unknown => {
    remaining -= 1;
    if (remaining < 0) return fail();
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') {
      remaining -= input.length;
      if (remaining < 0) return fail();
      return input;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) return fail();
      return input;
    }
    if (typeof input !== 'object' || types.isProxy(input) || ancestors.has(input)) return fail();
    ancestors.add(input);
    let captured: unknown;
    if (Array.isArray(input)) {
      const items = array(input, maximum);
      captured = items.map((_, index) =>
        visit(Object.getOwnPropertyDescriptor(input, String(index))?.value),
      );
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) return fail();
      const entries = Reflect.ownKeys(input).map((key) => {
        if (typeof key !== 'string') return fail();
        remaining -= key.length;
        if (remaining < 0) return fail();
        const property = Object.getOwnPropertyDescriptor(input, key);
        if (!property?.enumerable || !('value' in property)) return fail();
        return [key, visit(property.value)] as const;
      });
      captured = Object.fromEntries(entries);
    }
    ancestors.delete(input);
    return captured;
  };
  return visit(value);
}

/** Validation reuses the immutable v1 common-field kernel, never a semantic-failure fallback. */
function validate(
  value: unknown,
  limits: ReleaseExportTranscriptLimits,
): ReleaseExportTranscriptV2 {
  limitsValid(limits);
  const current = closed(captureReleaseExportJson(value, limits.maximum_transcript_bytes), [
    'version',
    'binding',
    'parent',
    'closures',
    'mutation_units',
    'destination',
    'trust',
  ]);
  if (current['version'] !== RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT) fail();
  const mappings: { package_id: string; release_unit: string }[] = [];
  const closures = array(current['closures'], limits.maximum_packages).map((raw) => {
    const row = closed(raw, [
      'package_id',
      'release_unit',
      'evidence_manifest',
      'expected_installed_package',
      'policy_resolution_digest_sha256',
    ]);
    if (typeof row['package_id'] !== 'string' || typeof row['release_unit'] !== 'string')
      return fail();
    mappings.push({ package_id: row['package_id'], release_unit: row['release_unit'] });
    const { release_unit: _unit, ...legacy } = row;
    return legacy as unknown as ReleaseExportTranscript['closures'][number];
  });
  const legacy: ReleaseExportTranscript = {
    version: RELEASE_EXPORT_TRANSCRIPT_FORMAT,
    binding: current['binding'] as ReleaseExportTranscript['binding'],
    parent: current['parent'] as ReleaseExportTranscript['parent'],
    closures,
    destination: current['destination'] as ReleaseExportTranscript['destination'],
    trust: current['trust'] as ReleaseExportTranscript['trust'],
  };
  encodeReleaseExportTranscript(legacy, limits);
  captureExportMutationUnitProjections(
    current['mutation_units'],
    mappings,
    legacy.binding,
    limits.maximum_packages,
  );
  return current as unknown as ReleaseExportTranscriptV2;
}

export function encodeReleaseExportTranscriptV2(
  value: ReleaseExportTranscriptV2,
  limits: ReleaseExportTranscriptLimits,
): Buffer {
  return guarded(() => bytes(validate(value, limits), limits.maximum_transcript_bytes));
}
export function verifyReleaseExportTranscriptV2(
  raw: Buffer,
  expected: ReleaseExportTranscriptV2,
  limits: ReleaseExportTranscriptLimits,
): ReleaseExportTranscriptV2 {
  return guarded(() => {
    if (
      !Buffer.isBuffer(raw) ||
      types.isProxy(raw) ||
      Buffer.compare(raw, encodeReleaseExportTranscriptV2(expected, limits)) !== 0
    )
      return fail();
    return validate(parse(raw, limits.maximum_transcript_bytes), limits);
  });
}

/** Bounded closed-document decoding. It never dereferences a path, handle or origin store. */
function portable(
  value: unknown,
  projection: NonNullable<ReleaseExportMutationUnitProjection['mutation_evidence']>,
  maximum: number,
): ReleaseUnitMutationPortable {
  const envelope = closed(value, ['version', 'closure', 'receipt', 'output_contract', 'members']);
  if (envelope['version'] !== 'devai.release-unit-mutation-portable-json.v1') return fail();
  const memberDocuments = array(envelope['members'], 100_000);
  if (memberDocuments.length !== projection.members.length) return fail();
  let remaining = maximum;
  let remainingEncoded = maximum;
  // Validate declared/text budgets for every document before any base64 allocation or JSON parse.
  const rawDocuments = [
    envelope['closure'],
    envelope['receipt'],
    envelope['output_contract'],
    ...memberDocuments,
  ];
  const documents = rawDocuments.map((raw, index) => {
    const document = closed(raw, [
      'sha256',
      'size_bytes',
      'bytes_base64',
      ...(index >= 2 ? ['path'] : []),
    ]);
    const size = document['size_bytes'];
    const encoded = document['bytes_base64'];
    if (
      !Number.isSafeInteger(size) ||
      (size as number) < 1 ||
      (size as number) > remaining ||
      typeof encoded !== 'string' ||
      encoded.length === 0 ||
      encoded.length > remainingEncoded ||
      encoded.length !== Math.ceil((size as number) / 3) * 4 ||
      !BASE64.test(encoded) ||
      typeof document['sha256'] !== 'string' ||
      !SHA.test(document['sha256'])
    )
      return fail();
    remaining -= size as number;
    remainingEncoded -= encoded.length;
    return document;
  });
  const decoded = documents.map((document) => {
    const raw = Buffer.from(document['bytes_base64'] as string, 'base64');
    if (
      raw.length !== document['size_bytes'] ||
      raw.toString('base64') !== document['bytes_base64'] ||
      hash(raw) !== document['sha256']
    )
      return fail();
    const value = parse(raw, maximum);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
    return { raw, value };
  });
  const closureDocument = documents[0] ?? fail();
  const receiptDocument = documents[1] ?? fail();
  if (
    !same(
      { sha256: closureDocument['sha256'], size_bytes: closureDocument['size_bytes'] },
      projection.closure,
    ) ||
    !same(
      { sha256: receiptDocument['sha256'], size_bytes: receiptDocument['size_bytes'] },
      { sha256: projection.receipt.sha256, size_bytes: projection.receipt.size_bytes },
    )
  )
    fail();
  const closure = (decoded[0] ?? fail()).value as ReleaseUnitMutationEvidenceClosure;
  verifyUnitMutationEvidenceClosure(closure, projection.binding);
  if (
    !(decoded[1] ?? fail()).raw.equals(bytes(closure.receipt, maximum)) ||
    closure.receipt.receipt_digest_sha256 !== projection.receipt.receipt_digest_sha256 ||
    !same(closure.output_contract, projection.output_contract) ||
    !same(closure.members, projection.members) ||
    closure.receipt.referent.member_projection_digest_sha256 !==
      projection.member_projection_digest_sha256
  )
    fail();
  for (const [index, identity] of [projection.output_contract, ...projection.members].entries()) {
    const document = documents[index + 2] ?? fail();
    if (
      document['path'] !== identity.path ||
      document['sha256'] !== identity.sha256 ||
      document['size_bytes'] !== identity.size_bytes
    )
      fail();
  }
  // This is byte/receipt continuity only. Full profile and canonical mutation semantics remain
  // mandatory in export/offline hosts before these bytes establish a release verdict.
  return envelope as unknown as ReleaseUnitMutationPortable;
}

export function encodeReleaseExportProviderResultV2(
  input: ReleaseExportProviderResultV2Input,
  limits: ReleaseExportTranscriptLimits,
): Buffer {
  return guarded(() => {
    limitsValid(limits);
    closed(input, ['package_id', 'transcript', 'signature', 'mutation_evidence']);
    const transcript = validate(parse(input.transcript, limits.maximum_transcript_bytes), limits);
    const closure =
      transcript.closures.find((row) => row.package_id === input.package_id) ?? fail();
    const unit =
      transcript.mutation_units.find((row) => row.release_unit === closure.release_unit) ?? fail();
    const evidence = unit.mutation_evidence;
    const isCarrier = evidence !== null && evidence.carrier_package_id === input.package_id;
    if (!isCarrier && input.mutation_evidence !== null) fail();
    if (isCarrier)
      portable(input.mutation_evidence, evidence, limits.maximum_provider_result_bytes);
    // Preserve the existing signature grammar without accepting a v1 document on the v2 wire.
    const legacyTranscript: ReleaseExportTranscript = {
      version: RELEASE_EXPORT_TRANSCRIPT_FORMAT,
      binding: transcript.binding,
      parent: transcript.parent,
      closures: transcript.closures.map(({ release_unit: _unit, ...row }) => row),
      destination: transcript.destination,
      trust: transcript.trust,
    };
    encodeReleaseExportProviderResult(
      {
        package_id: input.package_id,
        transcript: encodeReleaseExportTranscript(legacyTranscript, limits),
        signature: input.signature,
      },
      limits,
    );
    const result: ReleaseExportProviderResultV2 = {
      version: RELEASE_EXPORT_PROVIDER_RESULT_V2_FORMAT,
      package_id: input.package_id,
      release_unit: closure.release_unit,
      evidence_manifest: closure.evidence_manifest,
      transcript: Buffer.prototype.toString.call(input.transcript, 'utf8'),
      transcript_sha256: hash(input.transcript),
      signature: input.signature,
      trust: transcript.trust,
      mutation_evidence: input.mutation_evidence,
    };
    return bytes(result, limits.maximum_provider_result_bytes);
  });
}

/** Signature authentication is external; the complete signed transcript is an expected input. */
export function verifyReleaseExportProviderResultV2(
  raw: Buffer,
  expected: ReleaseExportProviderResultInput,
  limits: ReleaseExportTranscriptLimits,
): ReleaseExportProviderResultV2 {
  return guarded(() => {
    limitsValid(limits);
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
    ]);
    if (result['version'] !== RELEASE_EXPORT_PROVIDER_RESULT_V2_FORMAT) fail();
    const rebuilt = encodeReleaseExportProviderResultV2(
      {
        ...expected,
        mutation_evidence: result['mutation_evidence'] as ReleaseUnitMutationPortable | null,
      },
      limits,
    );
    if (Buffer.compare(raw, rebuilt) !== 0) fail();
    return result as unknown as ReleaseExportProviderResultV2;
  });
}

/** Enforce the exact complete package set; a single valid carrier is not a complete export. */
export function verifyReleaseExportProviderResultSetV2(
  raw: readonly Buffer[],
  expected: Omit<ReleaseExportProviderResultInput, 'package_id'>,
  limits: ReleaseExportTranscriptLimits,
): readonly ReleaseExportProviderResultV2[] {
  return guarded(() => {
    limitsValid(limits);
    closed(expected, ['transcript', 'signature']);
    const transcript = validate(
      parse(expected.transcript, limits.maximum_transcript_bytes),
      limits,
    );
    const inputs = array(raw, limits.maximum_packages);
    if (inputs.length !== transcript.closures.length) fail();
    const seen = new Set<string>();
    const results = inputs.map((input) => {
      const document = closed(parse(input as Buffer, limits.maximum_provider_result_bytes), [
        'version',
        'package_id',
        'release_unit',
        'evidence_manifest',
        'transcript',
        'transcript_sha256',
        'signature',
        'trust',
        'mutation_evidence',
      ]);
      if (typeof document['package_id'] !== 'string' || seen.has(document['package_id']))
        return fail();
      seen.add(document['package_id']);
      return verifyReleaseExportProviderResultV2(
        input as Buffer,
        { ...expected, package_id: document['package_id'] },
        limits,
      );
    });
    if (transcript.closures.some((row) => !seen.has(row.package_id))) fail();
    return results;
  });
}
