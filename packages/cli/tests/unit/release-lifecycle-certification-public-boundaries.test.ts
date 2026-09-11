import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalSha256 } from '@devai-nyx/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLifecyclePolicyFixture } from '../helpers/release-policy-resolution-fixture.js';
import {
  createReleaseCertificationProvider,
  isProtectedReleaseCertificationProvider,
} from '../../src/services/release-lifecycle-certification.js';
import {
  resolveReleaseMutationRequirements,
  type ReleaseLifecycleRequest,
} from '../../src/services/release-lifecycle-execution.js';
import { builtInReleaseLifecycleLocalProvider } from '../../src/services/release-lifecycle-local-adapters.js';

const ADOPTION = JSON.parse(
  readFileSync(join(process.cwd(), 'law/policy/devai-adoption.json'), 'utf8'),
) as {
  readonly release_verification: Readonly<Record<string, unknown>> & {
    readonly mutation_roster: readonly Record<string, unknown>[];
  };
};

function requestFor(
  value: ReturnType<typeof createLifecyclePolicyFixture>,
): ReleaseLifecycleRequest {
  const repository = value.candidate.repository;
  return {
    schemaVersion: '1.0.0',
    request_kind: 'release-lifecycle-request',
    action_id: 'release certify',
    repository_locator: repository,
    candidate_locator: {
      commit: repository.commit,
      tree: repository.tree,
      release_units: [
        {
          release_unit: value.resolution.release_unit,
          version: '1.5.0',
          package_roster: [
            {
              package_id: value.resolution.release_unit,
              manifest_path: 'package.json',
              manifest_digest_sha256: createHash('sha256').update(value.package_json).digest('hex'),
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

function boundary(
  value: ReturnType<typeof createLifecyclePolicyFixture>,
  certify: ReturnType<typeof vi.fn> = vi.fn(() => ({
    outcome: 'failure' as const,
    code: 'provider-declined',
  })),
) {
  const document = { schemaVersion: '1.0.0', nodes: ['certify'] };
  const input = {
    provider: {
      kind: 'protected-certification-provider-v3' as const,
      certify: certify as Parameters<
        typeof createReleaseCertificationProvider
      >[0]['provider']['certify'],
    },
    evidence_sink: {
      kind: 'certification-evidence-sink-v3' as const,
      protocol: 'two-phase-content-addressed' as const,
      begin: vi.fn(),
      readCertificationEvidenceReceipt: vi.fn(),
      readCertificationOutputClosure: vi.fn(),
      readGeneratedBlob: vi.fn(),
    },
    content_source: { readGitObject: vi.fn(), readGitBlob: vi.fn() },
    task_policies: [
      {
        release_unit: value.resolution.release_unit,
        task_policy_digest_sha256: canonicalSha256(document),
        document,
      },
    ],
    resolve_receipt: () => value.receipt,
    resolve_plan_input: value.resolve_plan_input,
  } satisfies Parameters<typeof createReleaseCertificationProvider>[0];
  return { certify, input, request: requestFor(value) };
}

describe('release certification public capability boundaries', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['provider', undefined, 'release-certification-provider-unavailable'],
    ['evidence_sink', undefined, 'release-certification-evidence-sink-unavailable'],
    ['content_source', undefined, 'release-prepare-git-tree-membership-invalid'],
  ] as const)('refuses an absent %s with its exact public error', (property, missing, code) => {
    const value = createLifecyclePolicyFixture();
    const selected = boundary(value);
    expect(() =>
      createReleaseCertificationProvider({ ...selected.input, [property]: missing } as never),
    ).toThrowError(new Error(code));
    expect(selected.certify).not.toHaveBeenCalled();
  });

  it('brands only a fully constructed protected provider', () => {
    const selected = boundary(createLifecyclePolicyFixture());
    const provider = createReleaseCertificationProvider(selected.input);
    expect(isProtectedReleaseCertificationProvider(provider)).toBe(true);
    expect(
      isProtectedReleaseCertificationProvider(() => ({
        outcome: 'failure',
        code: 'unprotected-provider',
      })),
    ).toBe(false);
  });

  it('refuses a non-certification request before protected provider dispatch', async () => {
    const selected = boundary(createLifecyclePolicyFixture());
    await expect(
      createReleaseCertificationProvider(selected.input)({
        ...selected.request,
        action_id: 'release preflight',
      }),
    ).resolves.toStrictEqual({
      outcome: 'failure',
      code: 'release-task-policy-identity-mismatch',
    });
    expect(selected.certify).not.toHaveBeenCalled();
  });

  it.each([
    'readUnitMutationEvidenceClosure',
    'readUnitMutationEvidenceReceipt',
    'readUnitMutationEvidenceBlob',
    'unit_mutation_maximum_bytes',
  ] as const)('requires the independent %s capability before certification', async (property) => {
    const value = createLifecyclePolicyFixture(
      ADOPTION.release_verification.mutation_roster,
      ADOPTION.release_verification,
    );
    const selected = boundary(value);
    const complete = {
      ...selected.input.evidence_sink,
      readUnitMutationEvidenceClosure: vi.fn(),
      readUnitMutationEvidenceReceipt: vi.fn(),
      readUnitMutationEvidenceBlob: vi.fn(),
      unit_mutation_maximum_bytes: 1,
    };
    const provider = createReleaseCertificationProvider({
      ...selected.input,
      evidence_sink: { ...complete, [property]: undefined },
    } as Parameters<typeof createReleaseCertificationProvider>[0]);

    await expect(provider(selected.request)).resolves.toStrictEqual({
      outcome: 'failure',
      code: 'release-certification-generated-output-untrusted',
    });
    expect(selected.certify).not.toHaveBeenCalled();
  });

  it.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1] as const)(
    'refuses the exact unsafe unit evidence byte limit %s before certification',
    async (maximum) => {
      const value = createLifecyclePolicyFixture(
        ADOPTION.release_verification.mutation_roster,
        ADOPTION.release_verification,
      );
      const selected = boundary(value);
      const provider = createReleaseCertificationProvider({
        ...selected.input,
        evidence_sink: {
          ...selected.input.evidence_sink,
          readUnitMutationEvidenceClosure: vi.fn(),
          readUnitMutationEvidenceReceipt: vi.fn(),
          readUnitMutationEvidenceBlob: vi.fn(),
          unit_mutation_maximum_bytes: maximum,
        },
      });

      await expect(provider(selected.request)).resolves.toStrictEqual({
        outcome: 'failure',
        code: 'release-certification-generated-output-untrusted',
      });
      expect(selected.certify).not.toHaveBeenCalled();
    },
  );

  it('admits the exact one-byte lower bound when every required reader is present', async () => {
    const value = createLifecyclePolicyFixture(
      ADOPTION.release_verification.mutation_roster,
      ADOPTION.release_verification,
    );
    const selected = boundary(value);
    const provider = createReleaseCertificationProvider({
      ...selected.input,
      evidence_sink: {
        ...selected.input.evidence_sink,
        readUnitMutationEvidenceClosure: vi.fn(),
        readUnitMutationEvidenceReceipt: vi.fn(),
        readUnitMutationEvidenceBlob: vi.fn(),
        unit_mutation_maximum_bytes: 1,
      },
    });

    await expect(provider(selected.request)).resolves.toStrictEqual({
      outcome: 'failure',
      code: 'provider-declined',
    });
    expect(selected.certify).toHaveBeenCalledOnce();
  });

  it.each([
    [{ outcome: 'success' as const }, 'release-certification-generated-output-untrusted'],
    [
      {
        outcome: 'success' as const,
        material: { release_units: [] } as never,
        transaction: { commit: vi.fn(), rollback: vi.fn(), dispose: vi.fn() },
      },
      'release-certification-generated-output-untrusted',
    ],
  ] as const)('refuses an incomplete protected success result', async (result, code) => {
    const selected = boundary(
      createLifecyclePolicyFixture(),
      vi.fn(() => result),
    );
    await expect(
      createReleaseCertificationProvider(selected.input)(selected.request),
    ).resolves.toStrictEqual({ outcome: 'failure', code });
    expect(selected.certify).toHaveBeenCalledOnce();
  });

  it('preserves a closed provider refusal without reading certification artifacts', async () => {
    const selected = boundary(createLifecyclePolicyFixture());
    const result = await createReleaseCertificationProvider(selected.input)(selected.request);
    expect(result).toStrictEqual({ outcome: 'failure', code: 'provider-declined' });
    expect(selected.certify).toHaveBeenCalledOnce();
    expect(selected.input.content_source.readGitObject).not.toHaveBeenCalled();
    expect(selected.input.content_source.readGitBlob).not.toHaveBeenCalled();
  });

  it('refuses a successful material whose package policy is not the selected policy', async () => {
    const value = createLifecyclePolicyFixture();
    const certify = vi.fn(() => ({
      outcome: 'success' as const,
      material: {
        release_units: [
          {
            release_unit: value.resolution.release_unit,
            packages: [
              {
                certification_manifest: { task_policy_digest_sha256: '0'.repeat(64) },
              },
            ],
          },
        ],
      },
    }));
    const selected = boundary(value, certify);

    await expect(
      createReleaseCertificationProvider(selected.input)(selected.request),
    ).resolves.toStrictEqual({
      outcome: 'failure',
      code: 'release-task-policy-identity-mismatch',
    });
    expect(certify).toHaveBeenCalledOnce();
    expect(selected.input.content_source.readGitObject).not.toHaveBeenCalled();
  });

  it('keeps a native provider exception out of the ledger and emits the exact stable code', async () => {
    const error = new TypeError('native provider detail');
    error.stack = undefined;
    const selected = boundary(
      createLifecyclePolicyFixture(),
      vi.fn(() => {
        throw error;
      }),
    );

    await expect(
      createReleaseCertificationProvider(selected.input)(selected.request),
    ).resolves.toStrictEqual({
      outcome: 'failure',
      code: 'release-certification-generated-output-untrusted',
    });
    expect(process.stderr.write).toHaveBeenCalledWith(
      'release certify: cause: native provider detail\n',
    );
    expect(selected.certify).toHaveBeenCalledOnce();
  });
});

describe('release mutation requirement and local-provider public projections', () => {
  it('returns the exact frozen null binding for a verified mutation-none plan', () => {
    const value = createLifecyclePolicyFixture();
    const requirements = resolveReleaseMutationRequirements(requestFor(value), {
      resolve_receipt: () => value.receipt,
      resolve_plan_input: value.resolve_plan_input,
    });
    expect(requirements).toStrictEqual([
      { release_unit: value.resolution.release_unit, binding: null },
    ]);
    expect(Object.isFrozen(requirements)).toBe(true);
    expect(Object.isFrozen(requirements[0])).toBe(true);
  });

  it('returns every exact immutable field for a verified required mutation plan', () => {
    const value = createLifecyclePolicyFixture(
      ADOPTION.release_verification.mutation_roster,
      ADOPTION.release_verification,
    );
    const profile = value.resolution.readInput('release-verification-profile');
    const policy = value.resolution.tools.readJson('dist/law/policy/mutation-evidence-v2.json');
    const requirements = resolveReleaseMutationRequirements(requestFor(value), {
      resolve_receipt: () => value.receipt,
      resolve_plan_input: value.resolve_plan_input,
    });
    expect(requirements).toStrictEqual([
      {
        release_unit: value.resolution.release_unit,
        binding: {
          repository_id: value.candidate.repository.id,
          candidate_commit: value.candidate.repository.commit,
          candidate_tree: value.candidate.repository.tree,
          release_unit: value.resolution.release_unit,
          release_plan_receipt_digest_sha256: value.receipt.receipt_digest_sha256,
          release_profile_digest_sha256: canonicalSha256(profile),
          mutation_policy_digest_sha256: canonicalSha256(policy),
        },
      },
    ]);
    expect(Object.isFrozen(requirements[0]?.binding)).toBe(true);
  });

  it('exposes only the preflight local provider and returns the exact refusal', async () => {
    const context = {
      repo_root: '/fixture/repository',
      resolve_receipt: vi.fn(),
      resolve_plan_input: vi.fn(),
      read_contained_bytes: vi.fn(),
    };
    expect(builtInReleaseLifecycleLocalProvider(context, 'release certify')).toBeUndefined();
    const provider = builtInReleaseLifecycleLocalProvider(context, 'release preflight');
    expect(provider).toBeTypeOf('function');
    expect(provider?.({} as never)).toStrictEqual({
      outcome: 'failure',
      code: 'release-certification-provider-unavailable',
    });
    expect(context.resolve_receipt).not.toHaveBeenCalled();
    expect(context.resolve_plan_input).not.toHaveBeenCalled();
    expect(context.read_contained_bytes).not.toHaveBeenCalled();
  });
});
