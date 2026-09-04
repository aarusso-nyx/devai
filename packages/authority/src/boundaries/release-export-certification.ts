import { types } from 'node:util';

export interface ExportCertificationByteIdentity {
  readonly sha256: string;
  readonly size_bytes: number;
}

/** Complete identity projection of one release unit's certification evidence carrier. */
export interface ExportCertificationUnitProjection {
  readonly release_unit: string;
  readonly carrier_package_id: string;
  readonly carrier: ExportCertificationByteIdentity;
  readonly derivation_binding_digest_sha256: string;
  readonly candidate_receipt: ExportCertificationByteIdentity;
  readonly task_policy: ExportCertificationByteIdentity;
  readonly task_results: readonly ExportCertificationByteIdentity[];
  readonly namespace_census: ExportCertificationByteIdentity;
  readonly census_member_projection_digest_sha256: string;
  readonly census_member_count: number;
}

const SHA = /^[a-f0-9]{64}$/u;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

function fail(): never {
  throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
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
function list(value: unknown, maximum: number): readonly unknown[] {
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
function text(value: unknown, maximum = 200): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.normalize('NFC') ||
    /[\p{Cc}\p{Cs}]/u.test(value)
  )
    return fail();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !SHA.test(value)) return fail();
  return value;
}
function identity(value: unknown): ExportCertificationByteIdentity {
  const item = record(value, ['sha256', 'size_bytes']);
  digest(item['sha256']);
  if (!Number.isSafeInteger(item['size_bytes']) || (item['size_bytes'] as number) < 1) fail();
  return item as unknown as ExportCertificationByteIdentity;
}
function ordered(previous: string | undefined, next: string): void {
  if (previous !== undefined && Buffer.compare(Buffer.from(previous), Buffer.from(next)) >= 0)
    fail();
}

/**
 * Data-only validation of the complete certification population. Every resolved release
 * unit carries exactly one non-null projection, including units whose mutation outcome is
 * none. Evidence semantics stay with the host; this boundary fixes the signed identities.
 */
export function captureExportCertificationUnitProjections(
  value: unknown,
  packages: readonly { readonly package_id: string; readonly release_unit: string }[],
  maximumPackages: number,
): readonly ExportCertificationUnitProjection[] {
  try {
    if (!Number.isSafeInteger(maximumPackages) || maximumPackages < 1) fail();
    const roster = new Map<string, string[]>();
    const packageIds = new Set<string>();
    for (const raw of list(packages, maximumPackages)) {
      const row = record(raw, ['package_id', 'release_unit']);
      const packageId = text(row['package_id'], 214);
      if (!PACKAGE.test(packageId) || packageIds.has(packageId)) fail();
      packageIds.add(packageId);
      const unit = text(row['release_unit']);
      roster.set(unit, [...(roster.get(unit) ?? []), packageId]);
    }
    const units = list(value, maximumPackages);
    // One complete carrier per resolved unit: no missing, extra, duplicate or cross unit.
    if (roster.size === 0 || units.length !== roster.size) fail();
    let previous: string | undefined;
    const captured = units.map((raw) => {
      const unit = record(raw, [
        'release_unit',
        'carrier_package_id',
        'carrier',
        'derivation_binding_digest_sha256',
        'candidate_receipt',
        'task_policy',
        'task_results',
        'namespace_census',
        'census_member_projection_digest_sha256',
        'census_member_count',
      ]);
      const unitId = text(unit['release_unit']);
      ordered(previous, unitId);
      previous = unitId;
      const unitPackages = roster.get(unitId);
      if (!unitPackages) fail();
      // Deterministic election, recomputed here rather than trusted from the producer.
      if (
        unit['carrier_package_id'] !==
        [...unitPackages].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))[0]
      )
        fail();
      identity(unit['carrier']);
      digest(unit['derivation_binding_digest_sha256']);
      identity(unit['candidate_receipt']);
      identity(unit['task_policy']);
      identity(unit['namespace_census']);
      digest(unit['census_member_projection_digest_sha256']);
      const count = unit['census_member_count'];
      if (!Number.isSafeInteger(count) || (count as number) < 0) fail();
      const results = list(unit['task_results'], 100_000);
      if (results.length === 0) fail();
      let previousResult: string | undefined;
      for (const result of results) {
        const row = identity(result);
        ordered(previousResult, row.sha256);
        previousResult = row.sha256;
      }
      return unit as unknown as ExportCertificationUnitProjection;
    });
    if (new Set(captured.map((unit) => unit.release_unit)).size !== captured.length) fail();
    return captured;
  } catch {
    return fail();
  }
}
