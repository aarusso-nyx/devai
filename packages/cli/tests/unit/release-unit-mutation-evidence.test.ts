import { canonicalSha256 } from '@devai-nyx/utils';
import { describe, expect, it, vi } from 'vitest';
import {
  captureUnitMutationEvidenceBinding,
  finalizeUnitMutationEvidenceClosure,
  verifyUnitMutationEvidenceClosure,
  verifyUnitMutationEvidenceDocuments,
  type ReleaseUnitMutationEvidenceClosure,
  type UnitMutationEvidenceObject,
} from '../../src/services/release-unit-mutation-evidence.js';
import {
  fixture,
  PACKAGE_NAMES,
  bytes,
  sha256,
  sortMembers,
} from '../helpers/release-unit-mutation-evidence-fixture.js';

const REFUSAL = 'release-certification-generated-output-untrusted';

function verify(value: Awaited<ReturnType<typeof fixture>>, closure = value.closure) {
  return verifyUnitMutationEvidenceDocuments({
    closure,
    expected: value.binding,
    maximum_bytes: 1_000_000,
    read: value.read,
  });
}

describe('unit-scoped mutation evidence closure (ADR-MUT-0008 IA-002 through IA-004)', () => {
  it('semantically verifies ten internal package pairs plus summary/receipt and a separate contract', async () => {
    const value = await fixture();
    await expect(verify(value)).resolves.toBeUndefined();
    expect(value.closure.members).toHaveLength(22);
    expect(value.read).toHaveBeenCalledTimes(23);
    expect(value.closure.release_unit).toBe('@fixture/publishable');
    expect(value.closure).not.toHaveProperty('packages');
    expect(value.closure.members.map((member) => member.path)).not.toContain(
      value.closure.output_contract.path,
    );
    expect(value.closure.receipt.referent.output_contract_digest_sha256).toBe(
      sha256(bytes(value.contract)),
    );
    expect(value.closure.receipt.referent.member_projection_digest_sha256).toBe(
      canonicalSha256(value.projection.members),
    );
    const { receipt_digest_sha256, ...receipt } = value.closure.receipt;
    expect(receipt_digest_sha256).toBe(canonicalSha256(receipt));
    for (const packageName of PACKAGE_NAMES) {
      expect(
        value.closure.members
          .filter((member) => member.package_name === packageName)
          .map((member) => member.document_kind)
          .sort(),
      ).toEqual(['mutation-normalized-stryker-report-v2', 'mutation-package-result-v2']);
    }
    expect(value.read.mock.calls.map(([identity]) => identity)).toEqual([
      value.closure.output_contract,
      ...value.closure.members.map(
        ({ path, sha256, size_bytes, evidence_sink_id, opaque_handle }) => ({
          path,
          sha256,
          size_bytes,
          evidence_sink_id,
          opaque_handle,
        }),
      ),
    ]);
  });

  it('preserves a reused immutable pair and not-required row without adding another pair', async () => {
    const value = await fixture({ reused: true, notRequired: true });
    await expect(verify(value)).resolves.toBeUndefined();
    expect(value.closure.members).toHaveLength(22);
    expect(value.composed.summary).toMatchObject({
      aggregate: {
        packageCount: 11,
        executedPackageCount: 9,
        reusedPackageCount: 1,
        notRequiredPackageCount: 1,
      },
    });
    expect(value.closure.members.some((member) => member.package_name === '@fixture/zero')).toBe(
      false,
    );
    for (const member of value.closure.members.filter(
      (entry) => entry.package_name === PACKAGE_NAMES[0],
    )) {
      expect(value.objects.get(member.sha256)).toEqual(
        value.initial.artifacts.find((entry) => entry.path === member.path)?.bytes,
      );
    }
    expect(value.composed.semanticReceipt['packages']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packageName: '@fixture/zero', disposition: 'not-required' }),
        expect.objectContaining({ packageName: PACKAGE_NAMES[0], disposition: 'reused' }),
      ]),
    );
  });

  it.each([
    'repository_id',
    'candidate_commit',
    'candidate_tree',
    'release_unit',
    'release_plan_receipt_digest_sha256',
    'release_profile_digest_sha256',
    'mutation_policy_digest_sha256',
    'task_policy_digests_sha256',
  ] as const)('refuses changed %s before reading documents', async (field) => {
    const value = await fixture();
    const expected = structuredClone(value.binding);
    Object.assign(expected, {
      [field]:
        field === 'task_policy_digests_sha256'
          ? ['0'.repeat(64)]
          : field === 'candidate_commit' || field === 'candidate_tree'
            ? '0'.repeat(40)
            : field.endsWith('_sha256')
              ? '0'.repeat(64)
              : 'different/referent',
    });
    await expect(
      verifyUnitMutationEvidenceDocuments({
        closure: value.closure,
        expected,
        maximum_bytes: 1_000_000,
        read: value.read,
      }),
    ).rejects.toThrow(REFUSAL);
    expect(value.read).not.toHaveBeenCalled();
  });

  it.each(['contract', 'report', 'result', 'summary', 'receipt'] as const)(
    'refuses missing and corrupt %s bytes',
    async (kind) => {
      const value = await fixture();
      const identity =
        kind === 'contract'
          ? value.closure.output_contract
          : value.closure.members.find((entry) =>
              kind === 'report'
                ? entry.document_kind === 'mutation-normalized-stryker-report-v2'
                : kind === 'result'
                  ? entry.document_kind === 'mutation-package-result-v2'
                  : kind === 'summary'
                    ? entry.path === value.closure.summary_path
                    : entry.path === value.closure.semantic_receipt_path,
            );
      if (identity === undefined) throw new Error('fixture member missing');
      const original = value.objects.get(identity.sha256);
      if (original === undefined) throw new Error('fixture bytes missing');
      value.objects.delete(identity.sha256);
      await expect(verify(value)).rejects.toThrow(REFUSAL);
      const corrupt = Buffer.from(original);
      corrupt[0] = 0;
      value.objects.set(identity.sha256, corrupt);
      await expect(verify(value)).rejects.toThrow(REFUSAL);
    },
  );

  it.each(['label', 'report-path', 'contract-drift', 'missing-pair', 'extra-pair'] as const)(
    'refuses structurally refinalized %s through real document semantics',
    async (change) => {
      const value = await fixture();
      const projection = structuredClone(value.projection);
      const reports = projection.members.filter(
        (entry) => entry.document_kind === 'mutation-normalized-stryker-report-v2',
      );
      const first = reports[0],
        second = reports[1];
      if (first === undefined || second === undefined) throw new Error('fixture reports missing');
      if (change === 'label') {
        Object.assign(first, { package_name: second.package_name });
        Object.assign(second, {
          package_name: value.projection.members.find((entry) => entry.path === first.path)
            ?.package_name,
        });
      } else if (change === 'report-path') {
        const firstPath = first.path;
        Object.assign(first, { path: second.path });
        Object.assign(second, { path: firstPath });
      } else if (change === 'contract-drift') {
        const changed = bytes({ ...value.contract, releaseProfileDigest: '0'.repeat(64) });
        value.objects.set(sha256(changed), changed);
        Object.assign(projection.output_contract, {
          sha256: sha256(changed),
          size_bytes: changed.length,
          opaque_handle: `sha256:${sha256(changed)}`,
        });
      } else if (change === 'missing-pair') {
        Object.assign(projection, {
          members: projection.members.filter((entry) => entry.package_name !== first.package_name),
        });
      } else {
        Object.assign(projection, {
          members: [
            ...projection.members,
            ...projection.members
              .filter((entry) => entry.package_name === first.package_name)
              .map((entry) => ({
                ...entry,
                package_name: '@fixture/extra',
                path: `extra/${entry.path}`,
              })),
          ],
        });
      }
      Object.assign(projection, { members: sortMembers(projection.members) });
      const closure = finalizeUnitMutationEvidenceClosure(value.binding, projection);
      expect(() => verifyUnitMutationEvidenceClosure(closure, value.binding)).not.toThrow();
      await expect(verify(value, closure)).rejects.toThrow(REFUSAL);
    },
  );

  it.each(['closure', 'receipt', 'referent', 'contract', 'member'] as const)(
    'refuses unknown fields and accessors in %s without evaluating them',
    async (level) => {
      const value = await fixture();
      const target = (closure: ReleaseUnitMutationEvidenceClosure) =>
        level === 'closure'
          ? closure
          : level === 'receipt'
            ? closure.receipt
            : level === 'referent'
              ? closure.receipt.referent
              : level === 'contract'
                ? closure.output_contract
                : closure.members[0];
      const extended = structuredClone(value.closure);
      Object.assign(target(extended) ?? {}, { unknown: true });
      await expect(verify(value, extended)).rejects.toThrow(REFUSAL);
      const accessor = structuredClone(value.closure);
      const object = target(accessor);
      if (object === undefined) throw new Error('fixture identity missing');
      const key = Object.keys(object)[0];
      if (key === undefined) throw new Error('fixture field missing');
      const getter = vi.fn(() => Reflect.get(object, key));
      Object.defineProperty(object, key, { enumerable: true, get: getter });
      await expect(verify(value, accessor)).rejects.toThrow(REFUSAL);
      expect(getter).not.toHaveBeenCalled();
      expect(value.read).not.toHaveBeenCalled();
    },
  );

  it('captures binding and closure before an asynchronous reader can mutate caller-owned identities', async () => {
    const value = await fixture();
    const captured = captureUnitMutationEvidenceBinding(value.binding);
    const closure = structuredClone(value.closure);
    const expected = structuredClone(value.binding);
    const read = async (identity: UnitMutationEvidenceObject) => {
      await Promise.resolve();
      Object.assign(closure, { release_unit: 'changed/unit' });
      Object.assign(expected, { candidate_commit: '0'.repeat(40) });
      return value.read(identity);
    };
    await expect(
      verifyUnitMutationEvidenceDocuments({ closure, expected, read, maximum_bytes: 1_000_000 }),
    ).resolves.toBeUndefined();
    expect(captured).toEqual(value.binding);
    expect(expected.candidate_commit).not.toBe(captured.candidate_commit);
  });

  it('refuses reader substitution even when it mutates its supplied identity to match returned bytes', async () => {
    const value = await fixture();
    const read = (identity: UnitMutationEvidenceObject) => {
      const replacement = bytes({ substituted: true });
      Object.assign(identity, { sha256: sha256(replacement), size_bytes: replacement.length });
      return replacement;
    };
    await expect(
      verifyUnitMutationEvidenceDocuments({
        closure: value.closure,
        expected: value.binding,
        read,
        maximum_bytes: 1_000_000,
      }),
    ).rejects.toThrow(REFUSAL);
  });

  it('refuses reordered or duplicate members and total byte quota exhaustion', async () => {
    const value = await fixture();
    for (const members of [
      [...value.projection.members].reverse(),
      sortMembers([...value.projection.members, ...value.projection.members.slice(0, 1)]),
    ]) {
      expect(() =>
        finalizeUnitMutationEvidenceClosure(value.binding, { ...value.projection, members }),
      ).toThrow(REFUSAL);
    }
    await expect(
      verifyUnitMutationEvidenceDocuments({
        closure: value.closure,
        expected: value.binding,
        read: value.read,
        maximum_bytes: 1,
      }),
    ).rejects.toThrow(REFUSAL);
    expect(value.read).not.toHaveBeenCalled();
  });
});
