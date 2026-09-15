import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { captureExportMutationUnitProjections } from '@devai-nyx/authority';
import type { ReleaseExportMutationUnitProjection } from './release-export-mutation-contract.js';
import {
  validateReleaseLifecycleRequest,
  resolveReleaseMutationRequirements,
  type ReleaseLifecycleRequest,
  type ReleaseStateMaterial,
} from './release-lifecycle-execution.js';
import {
  type ReleaseMutationPlanReaders,
  type ReleaseUnitMutationEvidenceReader,
} from './release-prepare-kernel.js';
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
  readonly mutation_units: readonly ReleaseExportMutationUnitProjection[];
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
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function clone<T>(value: T, maximum: number): T {
  return captureReleaseExportJson(value, maximum) as T;
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
    const source: ReleaseUnitMutationEvidenceReader = {};
    const mutationUnits: ReleaseExportMutationUnitProjection[] = requirements.map((unit) => ({
      release_unit: unit.release_unit,
      mutation_evidence: null,
    }));
    const portableUnits = requirements.map((unit) => ({
      release_unit: unit.release_unit,
      mutation_evidence: null,
    }));
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
