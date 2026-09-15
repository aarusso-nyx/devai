import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createReleaseExportMutationEvidence,
  readReleaseExportMutationEvidence,
  reverifyReleaseExportMutationEvidence,
  type ReleaseExportMutationEvidenceExpected,
  type ReleaseExportMutationEvidenceInput,
} from '../../src/services/release-export-mutation-evidence.js';
import type {
  ReleaseLifecycleRequest,
  ReleaseLifecycleStateV2,
  ReleaseStateMaterial,
} from '../../src/services/release-lifecycle-execution.js';
import {
  verifyPortableReleaseMutationEvidence,
  type ReleaseMutationPlanReaders,
} from '../../src/services/release-prepare-kernel.js';
import {
  createLifecyclePolicyFixture,
  type LifecyclePolicyFixture,
} from '../helpers/release-policy-resolution-fixture.js';

const ERROR = 'release-export-artifact-sink-protocol-invalid';
const TASK_POLICY_DIGEST = 'f'.repeat(64);

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function lifecycle(): LifecyclePolicyFixture {
  return createLifecyclePolicyFixture();
}

function request(value: LifecyclePolicyFixture): ReleaseLifecycleRequest {
  const candidate = value.candidate.repository;
  return {
    schemaVersion: '1.0.0',
    request_kind: 'release-lifecycle-request',
    action_id: 'release prepare',
    repository_locator: candidate,
    candidate_locator: {
      commit: candidate.commit,
      tree: candidate.tree,
      release_units: [
        {
          release_unit: value.resolution.release_unit,
          version: '1.5.0',
          package_roster: [
            {
              package_id: value.resolution.release_unit,
              manifest_path: 'package.json',
              manifest_digest_sha256: sha256(value.package_json),
            },
          ],
        },
      ],
    },
    receipt_locators: [
      {
        kind: 'release-plan-receipt',
        receipt_id: String(value.receipt.receipt_id),
        receipt_digest_sha256: String(value.receipt.receipt_digest_sha256),
        path: 'receipts/plan.json',
      },
    ],
  };
}

function readers(value: LifecyclePolicyFixture): ReleaseMutationPlanReaders {
  return { resolve_receipt: () => value.receipt, resolve_plan_input: value.resolve_plan_input };
}

function material(
  value: LifecyclePolicyFixture,
  closure: null,
): Pick<ReleaseStateMaterial, 'release_units' | 'inputs'> {
  return {
    release_units: [
      {
        release_unit: value.resolution.release_unit,
        version: '1.5.0',
        packages: [
          {
            package_id: value.resolution.release_unit,
            manifest: null,
            tarball: null,
            sbom: null,
            evidence_manifest: null,
            provider_result: null,
            trust: null,
            certification_manifest: {
              task_policy_digest_sha256: TASK_POLICY_DIGEST,
            },
          },
        ],
        mutation_evidence: closure,
      },
    ],
    inputs: [
      {
        kind: 'task-policy',
        path: 'task-policy/certify/selection',
        sha256: TASK_POLICY_DIGEST,
      },
    ],
  } as unknown as Pick<ReleaseStateMaterial, 'release_units' | 'inputs'>;
}

describe('mutation-free release export', () => {
  function setup() {
    const value = lifecycle();
    const selected = request(value);
    const input: ReleaseExportMutationEvidenceInput = {
      request: selected,
      material: material(value, null),
      source: {},
      plan: readers(value),
      maximum_provider_result_bytes: 1_000_000,
    };
    const expected: ReleaseExportMutationEvidenceExpected = {
      repository: selected.repository_locator,
      plan_receipt_digest_sha256: String(value.receipt.receipt_digest_sha256),
      ...input.material,
    };
    return { input, expected };
  }
  it('exports no mutation evidence without a reader, report, driver or Bedel', async () => {
    const { input, expected } = setup();
    const token = await createReleaseExportMutationEvidence(input);
    const result = readReleaseExportMutationEvidence(token, expected);
    expect(result.mutation_units).toEqual([
      { release_unit: expected.release_units[0]?.release_unit, mutation_evidence: null },
    ]);
    expect(result.portable_units).toEqual(result.mutation_units);
    await expect(reverifyReleaseExportMutationEvidence(token)).resolves.toBeUndefined();
  });
  it('never consults optional invalid mutation controls or reports', async () => {
    const { input, expected } = setup();
    const source = new Proxy(
      {},
      {
        get() {
          throw new Error('optional mutation source accessed');
        },
      },
    );
    const token = await createReleaseExportMutationEvidence({ ...input, source });
    expect(
      readReleaseExportMutationEvidence(token, expected).mutation_units[0]?.mutation_evidence,
    ).toBeNull();
  });
  it('retains candidate and plan token integrity checks', async () => {
    const { input, expected } = setup();
    const token = await createReleaseExportMutationEvidence(input);
    expect(() =>
      readReleaseExportMutationEvidence(
        { kind: 'protected-release-export-mutation-evidence' },
        expected,
      ),
    ).toThrow(ERROR);
    expect(() =>
      readReleaseExportMutationEvidence(token, {
        ...expected,
        plan_receipt_digest_sha256: '0'.repeat(64),
      }),
    ).toThrow(ERROR);
    expect(() =>
      readReleaseExportMutationEvidence(token, {
        ...expected,
        repository: { ...expected.repository, commit: '0'.repeat(40) },
      }),
    ).toThrow(ERROR);
  });
  it('does not weaken genuine plan verification', async () => {
    const { input } = setup();
    await expect(createReleaseExportMutationEvidence({ ...input, plan: {} })).rejects.toThrow(
      ERROR,
    );
  });
  it('does not require portable mutation archives or a mutation reader', async () => {
    const { input } = setup();
    await expect(
      verifyPortableReleaseMutationEvidence(
        input.request,
        { ...input.material, schemaVersion: '2.1.0' } as ReleaseLifecycleStateV2,
        undefined,
        input.plan,
      ),
    ).resolves.toBeUndefined();
  });
});
