import { createHash } from 'node:crypto';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import {
  captureExportMutationUnitProjections,
  type ExportMutationUnitProjection,
} from '@devai-nyx/authority';
import {
  validateReleaseLifecycleRequest,
  resolveReleaseMutationRequirements,
  type ReleaseLifecycleRequest,
  type ReleaseStateMaterial,
} from './release-lifecycle-execution.js';
import {
  verifyCertificationMutationEvidence,
  type ReleaseMutationPlanReaders,
  type ReleaseUnitMutationEvidenceReader,
} from './release-prepare-kernel.js';
import {
  captureUnitMutationEvidenceBinding,
  type UnitMutationEvidenceBinding,
  type UnitMutationEvidenceObject,
} from './release-unit-mutation-evidence.js';
import {
  captureReleaseExportJson,
  type ReleaseUnitMutationPortable,
} from './release-export-transcript-v2.js';

type Material = Pick<ReleaseStateMaterial, 'release_units' | 'inputs'>;
export interface ReleaseExportMutationEvidence {
  readonly kind: 'protected-release-export-mutation-evidence';
}
export interface ReleaseExportMutationEvidenceInput {
  readonly request: ReleaseLifecycleRequest;
  readonly material: Material;
  readonly source: ReleaseUnitMutationEvidenceReader;
  readonly plan: ReleaseMutationPlanReaders;
  readonly maximum_provider_result_bytes: number;
}
export interface ReleaseExportMutationEvidenceExpected extends Material {
  readonly repository: ReleaseLifecycleRequest['repository_locator'];
  readonly plan_receipt_digest_sha256: string;
}
export interface ReleaseExportMutationEvidenceSnapshot {
  readonly mutation_units: readonly ExportMutationUnitProjection[];
  readonly portable_units: readonly {
    readonly release_unit: string;
    readonly mutation_evidence: ReleaseUnitMutationPortable | null;
  }[];
}
interface Capture {
  readonly input: ReleaseExportMutationEvidenceInput;
  readonly plans: readonly string[];
  readonly snapshot: ReleaseExportMutationEvidenceSnapshot;
}
const captures = new WeakMap<ReleaseExportMutationEvidence, Capture>();
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
function encoded(bytes: Buffer) {
  return { sha256: hash(bytes), size_bytes: bytes.length, bytes_base64: bytes.toString('base64') };
}

/** Pure read/verification only. No transaction, mutation task, signing or storage write is available. */
export async function createReleaseExportMutationEvidence(
  input: ReleaseExportMutationEvidenceInput,
): Promise<ReleaseExportMutationEvidence> {
  try {
    const maximum = input.maximum_provider_result_bytes;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 0x7fffffff) fail();
    const request = validateReleaseLifecycleRequest(clone(input.request, maximum));
    const material = clone(input.material, maximum);
    const resolveReceipt = input.plan.resolve_receipt;
    const resolvePlanInput = input.plan.resolve_plan_input;
    const plan: ReleaseMutationPlanReaders = {
      ...(resolveReceipt === undefined ? {} : { resolve_receipt: resolveReceipt }),
      ...(resolvePlanInput === undefined ? {} : { resolve_plan_input: resolvePlanInput }),
    };
    // Fail cheap on the genuine candidate/plan before touching evidence storage.
    const requirements = resolveReleaseMutationRequirements(request, plan);
    const originalSource = input.source;
    const readClosure = originalSource.readUnitMutationEvidenceClosure;
    const readReceipt = originalSource.readUnitMutationEvidenceReceipt;
    const readBlob = originalSource.readUnitMutationEvidenceBlob;
    const source: ReleaseUnitMutationEvidenceReader = {
      unit_mutation_maximum_bytes: originalSource.unit_mutation_maximum_bytes,
      ...(readClosure === undefined
        ? {}
        : { readUnitMutationEvidenceClosure: readClosure.bind(originalSource) }),
      ...(readReceipt === undefined
        ? {}
        : { readUnitMutationEvidenceReceipt: readReceipt.bind(originalSource) }),
      ...(readBlob === undefined
        ? {}
        : { readUnitMutationEvidenceBlob: readBlob.bind(originalSource) }),
    };
    if (
      requirements.some((unit) => unit.binding !== null) &&
      (source.unit_mutation_maximum_bytes === undefined ||
        !Number.isSafeInteger(source.unit_mutation_maximum_bytes) ||
        source.unit_mutation_maximum_bytes < 1 ||
        typeof source.readUnitMutationEvidenceClosure !== 'function' ||
        typeof source.readUnitMutationEvidenceReceipt !== 'function' ||
        typeof source.readUnitMutationEvidenceBlob !== 'function')
    )
      fail();
    const budget = Math.min(source.unit_mutation_maximum_bytes ?? maximum, maximum);
    if (!Number.isSafeInteger(budget) || budget < 1) fail();
    const closures = new Map<
      string,
      ReturnType<NonNullable<ReleaseUnitMutationEvidenceReader['readUnitMutationEvidenceClosure']>>
    >();
    const receipts = new Map<
      string,
      ReturnType<NonNullable<ReleaseUnitMutationEvidenceReader['readUnitMutationEvidenceReceipt']>>
    >();
    const documents = new Map<string, Buffer>();
    const totals = new Map<string, number>();
    const key = (binding: UnitMutationEvidenceBinding, identity: UnitMutationEvidenceObject) =>
      canonicalJson({
        binding,
        identity: {
          path: identity.path,
          sha256: identity.sha256,
          size_bytes: identity.size_bytes,
          evidence_sink_id: identity.evidence_sink_id,
          opaque_handle: identity.opaque_handle,
        },
      });
    const cached: ReleaseUnitMutationEvidenceReader = {
      unit_mutation_maximum_bytes: budget,
      readUnitMutationEvidenceClosure(binding) {
        const id = canonicalJson(captureUnitMutationEvidenceBinding(binding));
        let value = closures.get(id);
        if (value === undefined) {
          value = clone(
            source.readUnitMutationEvidenceClosure?.(clone(binding, maximum)) ?? fail(),
            maximum,
          );
          closures.set(id, value);
        }
        return clone(value, maximum);
      },
      readUnitMutationEvidenceReceipt(identity) {
        const id = canonicalJson(identity);
        let value = receipts.get(id);
        if (value === undefined) {
          value = clone(
            source.readUnitMutationEvidenceReceipt?.(clone(identity, maximum)) ?? fail(),
            maximum,
          );
          receipts.set(id, value);
        }
        return clone(value, maximum);
      },
      readUnitMutationEvidenceBlob(input) {
        const id = key(input.binding, input.identity);
        let value = documents.get(id);
        if (value === undefined) {
          const total = (totals.get(input.binding.release_unit) ?? 0) + input.identity.size_bytes;
          if (!Number.isSafeInteger(total) || total > budget) fail();
          totals.set(input.binding.release_unit, total);
          const raw = source.readUnitMutationEvidenceBlob?.(clone(input, maximum)) ?? fail();
          if (
            !Buffer.isBuffer(raw) ||
            raw.length !== input.identity.size_bytes ||
            hash(raw) !== input.identity.sha256
          )
            fail();
          value = Buffer.from(raw);
          documents.set(id, value);
        }
        return Buffer.from(value);
      },
    };
    await verifyCertificationMutationEvidence(request, material, cached, plan);
    const mutationUnits: ExportMutationUnitProjection[] = [];
    const portableUnits: ReleaseExportMutationEvidenceSnapshot['portable_units'][number][] = [];
    for (const [index, requirement] of requirements.entries()) {
      const unit = material.release_units[index] ?? fail();
      const roster = request.candidate_locator.release_units[index]?.package_roster ?? fail();
      if (unit.release_unit !== requirement.release_unit || roster.length === 0) fail();
      if (requirement.binding === null) {
        mutationUnits.push({ release_unit: unit.release_unit, mutation_evidence: null });
        portableUnits.push({ release_unit: unit.release_unit, mutation_evidence: null });
        continue;
      }
      const closure = unit.mutation_evidence ?? fail();
      const {
        member_projection_digest_sha256,
        output_contract_digest_sha256: _controlDigest,
        ...binding
      } = closure.receipt.referent;
      const closureBytes = Buffer.from(canonicalJson(closure));
      const receiptBytes = Buffer.from(canonicalJson(closure.receipt));
      let total = closureBytes.length + receiptBytes.length;
      let encodedTotal =
        Math.ceil(closureBytes.length / 3) * 4 + Math.ceil(receiptBytes.length / 3) * 4;
      const retained = [closure.output_contract, ...closure.members].map((identity) => {
        const value = documents.get(key(binding, identity)) ?? fail();
        total += value.length;
        encodedTotal += Math.ceil(value.length / 3) * 4;
        if (
          !Number.isSafeInteger(total) ||
          !Number.isSafeInteger(encodedTotal) ||
          total > maximum ||
          encodedTotal > maximum
        )
          fail();
        return { path: identity.path, ...encoded(value) };
      });
      const portable: ReleaseUnitMutationPortable = {
        version: 'devai.release-unit-mutation-portable-json.v1',
        closure: encoded(closureBytes),
        receipt: encoded(receiptBytes),
        output_contract: retained[0] ?? fail(),
        members: retained.slice(1),
      };
      if (Buffer.byteLength(canonicalJson(portable)) > maximum) fail();
      mutationUnits.push({
        release_unit: unit.release_unit,
        mutation_evidence: {
          carrier_package_id:
            roster
              .map((row) => row.package_id)
              .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))[0] ?? fail(),
          binding,
          closure: { sha256: hash(closureBytes), size_bytes: closureBytes.length },
          receipt: {
            sha256: hash(receiptBytes),
            size_bytes: receiptBytes.length,
            receipt_digest_sha256: closure.receipt.receipt_digest_sha256,
          },
          output_contract: closure.output_contract,
          members: closure.members,
          member_projection_digest_sha256,
        },
      });
      portableUnits.push({ release_unit: unit.release_unit, mutation_evidence: portable });
    }
    const order = (a: { release_unit: string }, b: { release_unit: string }) =>
      Buffer.compare(Buffer.from(a.release_unit), Buffer.from(b.release_unit));
    mutationUnits.sort(order);
    portableUnits.sort(order);
    const token: ReleaseExportMutationEvidence = Object.freeze({
      kind: 'protected-release-export-mutation-evidence',
    });
    const plans = (request.receipt_locators ?? [])
      .filter((entry) => entry.kind === 'release-plan-receipt')
      .map((entry) => entry.receipt_digest_sha256);
    captures.set(token, {
      input: { request, material, source, plan, maximum_provider_result_bytes: maximum },
      plans,
      snapshot: { mutation_units: mutationUnits, portable_units: portableUnits },
    });
    return token;
  } catch {
    return fail();
  }
}

export function readReleaseExportMutationEvidence(
  token: ReleaseExportMutationEvidence,
  expected: ReleaseExportMutationEvidenceExpected,
): ReleaseExportMutationEvidenceSnapshot {
  try {
    const captured = captures.get(token) ?? fail();
    const maximum = captured.input.maximum_provider_result_bytes;
    const material = clone(expected, maximum);
    if (
      !same(material.repository, captured.input.request.repository_locator) ||
      !same(material.release_units, captured.input.material.release_units) ||
      !same(material.inputs, captured.input.material.inputs) ||
      captured.plans.length !== 1 ||
      captured.plans[0] !== material.plan_receipt_digest_sha256
    )
      fail();
    const packages = captured.input.request.candidate_locator.release_units.flatMap((unit) =>
      unit.package_roster.map((pkg) => ({
        package_id: pkg.package_id,
        release_unit: unit.release_unit,
      })),
    );
    captureExportMutationUnitProjections(
      captured.snapshot.mutation_units,
      packages,
      {
        repository: material.repository,
        plan_receipt_digest_sha256: material.plan_receipt_digest_sha256,
      },
      packages.length,
    );
    return {
      mutation_units: captured.snapshot.mutation_units.map((unit) => clone(unit, maximum)),
      portable_units: captured.snapshot.portable_units.map((unit) => ({
        release_unit: unit.release_unit,
        mutation_evidence: clone(unit.mutation_evidence, maximum),
      })),
    };
  } catch {
    return fail();
  }
}

/** A changed reread is failure, never a replacement snapshot or an implicit retry. */
export async function reverifyReleaseExportMutationEvidence(
  token: ReleaseExportMutationEvidence,
): Promise<void> {
  try {
    const captured = captures.get(token) ?? fail();
    const observedToken = await createReleaseExportMutationEvidence(captured.input);
    const observed = captures.get(observedToken) ?? fail();
    if (canonicalSha256(observed.snapshot) !== canonicalSha256(captured.snapshot)) fail();
  } catch {
    fail();
  }
}
