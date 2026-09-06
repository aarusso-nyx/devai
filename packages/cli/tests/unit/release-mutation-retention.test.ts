import { createHash } from 'node:crypto';
import { canonicalJson } from '@devai-nyx/utils';
import { describe, expect, it, vi } from 'vitest';
import type {
  ReleaseMutationPackageArtifactsV21,
  ReleaseMutationPackageInputsV21,
} from '../../src/services/release-mutation-artifacts.js';
import type { ReleaseMutationInputPlanV21 } from '../../src/services/release-mutation-inputs.js';
import {
  retainReleaseMutationEvidenceV21,
  type ReleaseMutationRetentionInputV21,
} from '../../src/services/release-mutation-retention.js';
import {
  finalizeUnitMutationEvidenceClosure,
  type ReleaseUnitMutationEvidenceClosure,
  type UnitMutationEvidenceBinding,
  type UnitMutationEvidenceObject,
  type UnitMutationEvidenceSink,
  type UnitMutationEvidenceTransaction,
} from '../../src/services/release-unit-mutation-evidence.js';
import { fixture as evidenceFixture } from '../helpers/release-unit-mutation-evidence-fixture.js';

// This suite isolates the sidecar adapter. Production-only plan derivation and its fixture gate
// have independent coverage; semantic finalization, canonical composition and closure rereads are real.
vi.mock('../../src/services/release-mutation-inputs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/release-mutation-inputs.js')>()),
  isDerivedReleaseMutationInputPlanV21: () => true,
}));

const REFUSAL = 'release-certification-generated-output-untrusted';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

type Package = {
  readonly packageName: string;
  readonly disposition: 'executed' | 'reused';
  readonly origin: unknown;
  readonly artifacts: ReleaseMutationPackageArtifactsV21;
};

function snapshot<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function first<T>(value: readonly T[]): T {
  const result = value[0];
  if (result === undefined) throw new Error('fixture package missing');
  return result;
}

function adapterFixture(
  source: Awaited<ReturnType<typeof evidenceFixture>>,
  options: {
    readonly reused?: boolean;
    readonly mutateReadback?: boolean;
    readonly mutateReceipt?: boolean;
    readonly mutateBlob?: boolean;
    readonly failVerify?: boolean;
    readonly failPutAt?: number;
    readonly failCommit?: boolean;
  } = {},
) {
  const rows = source.contract['packages'] as readonly Record<string, unknown>[];
  const artifacts = new Map(source.composed.artifacts.map((entry) => [entry.path, entry.bytes]));
  const expected: ReleaseMutationPackageInputsV21[] = rows.map((row) => {
    const resultPath = row['resultPath'];
    if (typeof resultPath !== 'string') throw new Error('fixture result path missing');
    const bytes = artifacts.get(resultPath);
    if (bytes === undefined) throw new Error('fixture result missing');
    const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    return {
      packageName: value['packageName'] as string,
      workspace: value['workspace'] as string,
      inputProjection: value['inputProjection'] as Readonly<Record<string, unknown>>,
      thresholds: value['thresholds'] as ReleaseMutationPackageInputsV21['thresholds'],
      toolVersions: value['toolVersions'] as Readonly<Record<string, string>>,
    };
  });
  const packages: Package[] = rows.map((row, index) => {
    const reportPath = row['reportPath'],
      resultPath = row['resultPath'],
      inputDigest = row['inputDigest'];
    if (
      typeof reportPath !== 'string' ||
      typeof resultPath !== 'string' ||
      typeof inputDigest !== 'string'
    )
      throw new Error('fixture package row malformed');
    const report = artifacts.get(reportPath),
      result = artifacts.get(resultPath);
    if (report === undefined || result === undefined) throw new Error('fixture artifact missing');
    const reused = options.reused === true && index === 0;
    return {
      packageName: row['packageName'] as string,
      disposition: reused ? 'reused' : 'executed',
      origin: reused
        ? {
            candidate: {
              releaseUnit: source.binding.release_unit,
              commit: source.binding.candidate_commit,
              tree: source.binding.candidate_tree,
            },
            semanticReceiptDigest: source.initial.semanticReceipt['receiptDigest'],
            evidenceSetDigest: (source.initial.summary['aggregate'] as Record<string, unknown>)[
              'evidenceSetDigest'
            ],
          }
        : null,
      artifacts: {
        inputDigest,
        report: { path: reportPath, sha256: digest(report), bytes: Buffer.from(report) },
        result: { path: resultPath, sha256: digest(result), bytes: Buffer.from(result) },
      },
    };
  });
  const plan = {
    repository: {
      id: source.binding.repository_id,
      commit: source.binding.candidate_commit,
      tree: source.binding.candidate_tree,
    },
    release_unit: source.binding.release_unit,
    release_plan_receipt_digest: source.binding.release_plan_receipt_digest_sha256,
    release_profile_digest: source.binding.release_profile_digest_sha256,
    mutation_policy_digest: source.binding.mutation_policy_digest_sha256,
    execution_template_version: '1.2.0',
    packages: expected.map((entry) => ({ expected: entry, reuse: { unresolved: [] } })),
  } as unknown as ReleaseMutationInputPlanV21;
  const sink = sinkFixture(source.binding, options);
  const input: ReleaseMutationRetentionInputV21 = {
    plan,
    packages,
    task_policy_digests_sha256: source.binding.task_policy_digests_sha256,
    evidence_sink: sink.value,
    authority_owner: sink.owner,
    sink_host: sink.host,
    ...(options.reused
      ? {
          resolve_reuse_origin: () => ({
            composition: source.initial.summary,
            semanticReceipt: source.initial.semanticReceipt,
          }),
        }
      : {}),
  };
  return { input, packages, sink };
}

function sinkFixture(
  binding: UnitMutationEvidenceBinding,
  options: {
    readonly mutateReadback?: boolean;
    readonly mutateReceipt?: boolean;
    readonly mutateBlob?: boolean;
    readonly failVerify?: boolean;
    readonly failPutAt?: number;
    readonly failCommit?: boolean;
  },
) {
  const objects = new Map<string, Buffer>();
  const owner = Object.freeze({});
  let closure: ReleaseUnitMutationEvidenceClosure | undefined;
  let committed = false;
  let aborted = false;
  let puts = 0;
  const transaction: UnitMutationEvidenceTransaction = {
    evidence_sink_id: 'retention-test-sink',
    transaction_handle: 'retention-test-transaction',
    put: ({ bytes, sha256, size_bytes }) => {
      if (committed || aborted || bytes.byteLength !== size_bytes || digest(bytes) !== sha256)
        throw new Error(REFUSAL);
      puts += 1;
      if (options.failPutAt === puts) throw new Error(REFUSAL);
      objects.set(sha256, Buffer.from(bytes));
      return {
        evidence_sink_id: 'retention-test-sink',
        opaque_handle: `sha256:${sha256}`,
        sha256,
        size_bytes,
      };
    },
    verify: async (projection) => {
      if (aborted || committed) throw new Error(REFUSAL);
      if (options.failVerify) throw new Error(REFUSAL);
      const draft = finalizeUnitMutationEvidenceClosure(binding, projection);
      for (const identity of [draft.output_contract, ...draft.members]) {
        const bytes = objects.get(identity.sha256);
        if (
          bytes === undefined ||
          bytes.byteLength !== identity.size_bytes ||
          digest(bytes) !== identity.sha256
        )
          throw new Error(REFUSAL);
      }
    },
    commit: (projection) => {
      if (aborted || committed) throw new Error(REFUSAL);
      if (options.failCommit) throw new Error(REFUSAL);
      committed = true;
      closure = finalizeUnitMutationEvidenceClosure(binding, projection);
      return snapshot(closure);
    },
    abort: () => {
      if (committed || aborted) throw new Error(REFUSAL);
      aborted = true;
    },
  };
  const identity = (value: UnitMutationEvidenceObject) => ({
    path: value.path,
    sha256: value.sha256,
    size_bytes: value.size_bytes,
    evidence_sink_id: value.evidence_sink_id,
    opaque_handle: value.opaque_handle,
  });
  const value: UnitMutationEvidenceSink = {
    unit_mutation_maximum_bytes: 1_000_000,
    beginUnitMutationEvidence: (actual) => {
      if (canonicalJson(actual) !== canonicalJson(binding)) throw new Error(REFUSAL);
      return transaction;
    },
    readUnitMutationEvidenceClosure: (actual) => {
      if (closure === undefined || canonicalJson(actual) !== canonicalJson(binding))
        throw new Error(REFUSAL);
      const result = snapshot(closure);
      const firstMember = result.members[0] as { sha256: string } | undefined;
      if (options.mutateReadback && firstMember !== undefined) firstMember.sha256 = '0'.repeat(64);
      return result;
    },
    readUnitMutationEvidenceReceipt: ({ evidence_sink_id, receipt_digest_sha256 }) => {
      if (
        closure === undefined ||
        evidence_sink_id !== 'retention-test-sink' ||
        receipt_digest_sha256 !== closure.receipt.receipt_digest_sha256
      )
        throw new Error(REFUSAL);
      const result = snapshot(closure.receipt);
      if (options.mutateReceipt)
        (result as { receipt_digest_sha256: string }).receipt_digest_sha256 = '0'.repeat(64);
      return result;
    },
    readUnitMutationEvidenceBlob: ({ binding: actual, identity: requested }) => {
      if (closure === undefined || canonicalJson(actual) !== canonicalJson(binding))
        throw new Error(REFUSAL);
      const member = [closure.output_contract, ...closure.members].find(
        (candidate) => canonicalJson(identity(candidate)) === canonicalJson(requested),
      );
      if (member === undefined) throw new Error(REFUSAL);
      const bytes = objects.get(member.sha256);
      if (bytes === undefined) throw new Error(REFUSAL);
      const result = Buffer.from(bytes);
      if (
        options.mutateBlob &&
        member.path !== closure.output_contract.path &&
        result.byteLength > 0
      )
        result[0] = (result[0] ?? 0) ^ 1;
      return result;
    },
  };
  return {
    value,
    owner,
    host: {
      invokeSink: <T>(callback: () => T, actualOwner?: object) => {
        if (actualOwner !== owner) throw new Error(REFUSAL);
        return callback();
      },
      spawnSync: (() => {
        throw new Error('unexpected process invocation');
      }) as never,
    },
    state: {
      objects,
      get committed() {
        return committed;
      },
      get aborted() {
        return aborted;
      },
      get puts() {
        return puts;
      },
    },
  };
}

async function refuses(operation: () => Promise<unknown>) {
  await expect(operation()).rejects.toThrow(REFUSAL);
}

describe('release mutation retention adapter', () => {
  it('retains and rereads exact complete executed and mixed reused closures without package outputs', async () => {
    const executedSource = await evidenceFixture();
    const executed = adapterFixture(executedSource);
    const closure = await retainReleaseMutationEvidenceV21(executed.input);
    expect(closure.members).toHaveLength(22);
    expect(closure.output_contract.path).toBe('mutation/output-contract.json');
    expect(closure.members.every((member) => member.path !== closure.output_contract.path)).toBe(
      true,
    );
    expect(executed.sink.state.committed).toBe(true);
    expect(executed.sink.state.aborted).toBe(false);

    const reusedSource = await evidenceFixture({ reused: true });
    const reused = adapterFixture(reusedSource, { reused: true });
    const retained = await retainReleaseMutationEvidenceV21(reused.input);
    expect(retained.members).toHaveLength(22);
    expect(retained.receipt.referent.release_unit).toBe(reused.input.plan.release_unit);
    const summary = retained.members.find((member) => member.path === retained.summary_path);
    if (summary === undefined) throw new Error('retained summary missing');
    expect(
      JSON.parse(
        (reused.sink.state.objects.get(summary.sha256) ?? Buffer.alloc(0)).toString('utf8'),
      ),
    ).toMatchObject({
      aggregate: { executedPackageCount: 9, reusedPackageCount: 1 },
    });
  });

  it('refuses missing or altered caller artifacts before a committed receipt', async () => {
    const source = await evidenceFixture();
    const missing = adapterFixture(source);
    missing.packages.pop();
    await expect(retainReleaseMutationEvidenceV21(missing.input)).rejects.toThrow(
      'MUTATION_ROSTER_MISMATCH',
    );
    expect(missing.sink.state.committed).toBe(false);
    expect(missing.sink.state.objects).toHaveLength(0);

    const altered = adapterFixture(source);
    const report = first(altered.packages).artifacts.report.bytes;
    if (report.byteLength === 0) throw new Error('fixture report missing');
    report[0] = (report[0] ?? 0) ^ 1;
    await refuses(() => retainReleaseMutationEvidenceV21(altered.input));
    expect(altered.sink.state.committed).toBe(false);
  });

  it('captures caller artifacts before async semantic finalization and does not observe later mutation', async () => {
    const source = await evidenceFixture();
    const value = adapterFixture(source);
    const packageValue = first(value.packages);
    const original = Buffer.from(packageValue.artifacts.report.bytes);
    const retained = retainReleaseMutationEvidenceV21(value.input);
    packageValue.artifacts.report.bytes.fill(0);
    const closure = await retained;
    const report = closure.members.find(
      (member) => member.path === packageValue.artifacts.report.path,
    );
    expect(report?.sha256).toBe(digest(original));
  });

  it('refuses substituted closure or receipt rereads after commit and never aborts that committed record', async () => {
    const source = await evidenceFixture();
    for (const options of [{ mutateReadback: true }, { mutateReceipt: true }]) {
      const value = adapterFixture(source, options);
      await refuses(() => retainReleaseMutationEvidenceV21(value.input));
      expect(value.sink.state.committed).toBe(true);
      expect(value.sink.state.aborted).toBe(false);
      expect(value.sink.state.objects.size).toBeGreaterThan(0);
    }
  });

  it('aborts pre-commit verification failures while preserving already-written content-addressed blobs', async () => {
    const source = await evidenceFixture();
    const value = adapterFixture(source, { failVerify: true });
    await refuses(() => retainReleaseMutationEvidenceV21(value.input));
    expect(value.sink.state.committed).toBe(false);
    expect(value.sink.state.aborted).toBe(true);
    expect(value.sink.state.objects.size).toBeGreaterThan(0);
  });

  it('aborts a failed put while retaining earlier content-addressed blobs', async () => {
    const source = await evidenceFixture();
    const value = adapterFixture(source, { failPutAt: 2 });
    await refuses(() => retainReleaseMutationEvidenceV21(value.input));
    expect(value.sink.state.committed).toBe(false);
    expect(value.sink.state.aborted).toBe(true);
    expect(value.sink.state.puts).toBe(2);
    expect(value.sink.state.objects.size).toBe(1);
  });

  it('does not abort or repair a commit whose terminal operation throws', async () => {
    const source = await evidenceFixture();
    const value = adapterFixture(source, { failCommit: true });
    await refuses(() => retainReleaseMutationEvidenceV21(value.input));
    expect(value.sink.state.committed).toBe(false);
    expect(value.sink.state.aborted).toBe(false);
    expect(value.sink.state.objects.size).toBeGreaterThan(0);
  });

  it('refuses a corrupted retained member after commit without aborting the finalized record', async () => {
    const source = await evidenceFixture();
    const value = adapterFixture(source, { mutateBlob: true });
    await refuses(() => retainReleaseMutationEvidenceV21(value.input));
    expect(value.sink.state.committed).toBe(true);
    expect(value.sink.state.aborted).toBe(false);
    expect(value.sink.state.objects.size).toBeGreaterThan(0);
  });

  it('uses pre-await sink methods, owner, host and reuse resolver captures after caller substitution', async () => {
    const source = await evidenceFixture({ reused: true });
    const value = adapterFixture(source, { reused: true });
    const originalOwner = value.input.authority_owner;
    const originalResolver = value.input.resolve_reuse_origin;
    if (originalResolver === undefined) throw new Error('fixture reuse resolver missing');
    const resolver = vi.fn((origin: unknown) => originalResolver(origin));
    const mutable = value.input as {
      evidence_sink: UnitMutationEvidenceSink;
      authority_owner: object;
      sink_host: ReleaseMutationRetentionInputV21['sink_host'];
      resolve_reuse_origin?: ReleaseMutationRetentionInputV21['resolve_reuse_origin'];
    };
    mutable.resolve_reuse_origin = resolver;
    const retained = retainReleaseMutationEvidenceV21(value.input);
    mutable.evidence_sink = Object.freeze({
      unit_mutation_maximum_bytes: 1,
      beginUnitMutationEvidence: () => {
        throw new Error('substituted sink used');
      },
      readUnitMutationEvidenceClosure: () => {
        throw new Error('substituted sink used');
      },
      readUnitMutationEvidenceReceipt: () => {
        throw new Error('substituted sink used');
      },
      readUnitMutationEvidenceBlob: () => {
        throw new Error('substituted sink used');
      },
    });
    mutable.authority_owner = Object.freeze({ substituted: true });
    mutable.sink_host = Object.freeze({
      invokeSink: () => {
        throw new Error('substituted host used');
      },
      spawnSync: (() => {
        throw new Error('substituted host used');
      }) as never,
    });
    mutable.resolve_reuse_origin = () => {
      throw new Error('substituted resolver used');
    };
    await expect(retained).resolves.toMatchObject({
      receipt: { referent: { release_unit: source.binding.release_unit } },
    });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(originalOwner).not.toBe(mutable.authority_owner);
  });
});
