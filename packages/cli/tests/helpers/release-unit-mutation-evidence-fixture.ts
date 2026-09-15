import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson } from '@devai-nyx/utils';
import { vi } from 'vitest';
import type {
  ReleaseUnitMutationEvidenceClosure,
  UnitMutationEvidenceBinding,
  UnitMutationEvidenceMember,
  UnitMutationEvidenceObject,
  UnitMutationEvidenceProjection,
} from '../../src/services/release-unit-mutation-evidence.js';

export const PACKAGE_NAMES = Array.from(
  { length: 10 },
  (_, index) => `@fixture/internal-${String(index).padStart(2, '0')}`,
);
export const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');
export const bytes = (value: unknown): Buffer => Buffer.from(canonicalJson(value));
export const sortMembers = (members: readonly UnitMutationEvidenceMember[]) =>
  [...members].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));

type Json = Readonly<Record<string, unknown>>;
interface Composition {
  readonly summary: Json;
  readonly semanticReceipt: Json;
  readonly artifacts: readonly { readonly path: string; readonly bytes: Buffer }[];
}
interface HistoricalSnapshot {
  readonly options: unknown;
  readonly binding: UnitMutationEvidenceBinding;
  readonly projection: UnitMutationEvidenceProjection;
  readonly closure: ReleaseUnitMutationEvidenceClosure;
  readonly objects: readonly (readonly [string, string])[];
  readonly contract: Json;
  readonly composed: Composition;
  readonly initial: Composition;
}

/** Read immutable historical documents; never invoke a normalizer, composer or engine. */
export async function fixture(
  options: {
    reused?: boolean;
    notRequired?: boolean;
    binding?: Partial<UnitMutationEvidenceBinding>;
    sinkId?: string;
    packages?: readonly { readonly packageName: string; readonly workspace: string }[];
  } = {},
) {
  const snapshot = JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        '../fixtures/historical-unit-mutation',
        `${sha256(canonicalJson(options))}.json`,
      ),
      'utf8',
    ),
    (_key: string, value: unknown): unknown => {
      if (value !== null && typeof value === 'object' && 'buffer_base64' in value) {
        return Buffer.from(String(value.buffer_base64), 'base64');
      }
      return value;
    },
  ) as HistoricalSnapshot;
  if (canonicalJson(snapshot.options) !== canonicalJson(options))
    throw new Error('historical fixture options mismatch');
  const objects = new Map<string, Buffer>(
    snapshot.objects.map(([digest, value]) => [digest, Buffer.from(value, 'base64')]),
  );
  const read = vi.fn((object: UnitMutationEvidenceObject): Buffer => {
    const value = objects.get(object.sha256);
    if (value === undefined) throw new Error('fixture object missing');
    return Buffer.from(value);
  });
  return {
    binding: snapshot.binding,
    projection: snapshot.projection,
    closure: snapshot.closure,
    objects,
    read,
    contract: snapshot.contract,
    composed: snapshot.composed,
    initial: snapshot.initial,
  };
}
