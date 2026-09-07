import { describe, expect, it } from 'vitest';
import {
  authorizedBoundarySetFixture,
  boundaryApi,
  boundaryDependencies,
  expectBoundaryFailure,
  gitTarget,
} from './authority-boundary-testkit.js';
import {
  boundedSubject,
  canonicalSha256,
  exactSubject,
  expectSuccess,
  fsTarget,
  secondFsTarget,
  type AuthorityDecisionIssuer,
} from './authority-runtime-testkit.js';

// Execution-unit contract cases written against the retained authority mutation diagnostic
// (candidate 3dfdc316, report 414957d9). prepareUnit and applyUnit had no test coverage at
// all (report lines 628-707 and 783-846). Refusals that precede receipt consumption run
// against a registry-only runtime; effects and recovery run through a genuine multi-target
// receipt issued for the whole unit.

type Target = Readonly<Record<string, unknown>> & { readonly id: string };
type Batch = { batch_id: string; plan_id: string; ordinal: number; targets: readonly Target[] };
type Subject = { plan: Record<string, unknown>; batch?: Batch };

interface UnitRuntime {
  readonly plannerRegistry: {
    registerPlan(input: unknown): unknown;
    registerBatch(input: unknown): unknown;
    recovery(input: unknown): unknown;
  };
  prepareUnit(input: unknown): unknown;
  applyUnit(input: unknown): unknown;
  dispose(): unknown;
}

const UNIT = [fsTarget, secondFsTarget] as const;

function atomicFs(events: string[], result?: (targets: readonly Target[]) => unknown) {
  return {
    realpath: (path: string) => path,
    lstat: () => ({ kind: 'file', inode: 1, mtime_ms: 1 }),
    writeAtomic: (path: string) => events.push(`fs:write:${path}`),
    renameAtomic: () => undefined,
    applyAtomic: (targets: readonly Target[]) => {
      events.push(`fs:atomic:${targets.map((target) => target.id).join('+')}`);
      return result?.(targets);
    },
  };
}

async function registryRuntime(overrides: Record<string, unknown> = {}) {
  const api = await boundaryApi();
  const events: string[] = [];
  const receiptStore = {
    consume: () => ({
      ok: false,
      category: 'refused',
      code: 'FIXTURE_RECEIPT_REFUSED',
      reasons: [],
    }),
    dispose: () => ({ ok: true, value: true }),
  };
  const runtime = api.createAuthorityBoundaryRuntime(
    boundaryDependencies(receiptStore as unknown as AuthorityDecisionIssuer, events, {
      fs: atomicFs(events),
      ...overrides,
    }),
  ) as unknown as UnitRuntime;
  const register = (subject: Subject) =>
    expectSuccess<object>(
      runtime.plannerRegistry.registerPlan({ subject, invocation_id: 'invocation-1' }),
    );
  return { runtime, events, register };
}

/** A genuine unit receipt: one decision over every target, bound to the fs boundary. */
async function unitFixture(
  strategy: 'exact-plan' | 'bounded-batches',
  overrides: Record<string, unknown> = {},
  atomicResult?: (targets: readonly Target[]) => unknown,
) {
  const fixture = await authorizedBoundarySetFixture([...UNIT]);
  const subject = (
    strategy === 'exact-plan'
      ? exactSubject([...UNIT], fixture.plant)
      : boundedSubject([...UNIT], fixture.plant)
  ) as Subject;
  const decision = fixture.issuer.issueAllow({
    resolutions: fixture.resolutions,
    subject,
    context_receipt: fixture.context_receipt,
    invocation_id: 'invocation-1',
    boundary_adapter_id: 'fs-authority-boundary',
  }) as { issued: boolean; receipt?: unknown };
  if (decision.issued !== true)
    throw new Error(`unit receipt refused: ${JSON.stringify(decision)}`);
  const api = await boundaryApi();
  const events: string[] = [];
  const runtime = api.createAuthorityBoundaryRuntime(
    boundaryDependencies(fixture.issuer, events, {
      fs: atomicFs(events, atomicResult),
      ...overrides,
    }),
  ) as unknown as UnitRuntime;
  const planHandle = expectSuccess<object>(
    runtime.plannerRegistry.registerPlan({
      subject,
      context_receipt: fixture.context_receipt,
      invocation_id: 'invocation-1',
    }),
  );
  let batchHandle: object | undefined;
  if (strategy === 'bounded-batches') {
    const batch = subject.batch as Batch;
    batchHandle = expectSuccess<object>(
      runtime.plannerRegistry.registerBatch({
        plan_handle: planHandle,
        batch,
        invocation_id: 'invocation-1',
        plan_digest_sha256: canonicalSha256(subject.plan),
        target_digest_sha256: canonicalSha256(batch.targets.map((target) => target.id)),
        recovery: {
          applied_batch_ids: [],
          applied_target_count: 0,
          partial_effect_evidence_refs: [],
        },
      }),
    );
  }
  const prepareInput = (extra: Record<string, unknown> = {}) => ({
    plan_handle: planHandle,
    subject,
    targets: [...UNIT],
    adapter_id: 'fs-authority-boundary',
    context_receipt: fixture.context_receipt,
    decision_receipt: decision.receipt,
    ...(batchHandle === undefined ? {} : { batch_handle: batchHandle, batch: subject.batch }),
    ...extra,
  });
  return { events, fixture, planHandle, batchHandle, prepareInput, runtime, subject };
}

describe('prepareUnit binding contracts before receipt consumption', () => {
  it.each([undefined, null, 'unit', 42])('refuses non-record input %s', async (input) => {
    const { runtime } = await registryRuntime();
    expectBoundaryFailure(
      runtime.prepareUnit(input),
      'refused',
      'AUTHORITY_DECISION_RECEIPT_UNKNOWN',
    );
  });

  it('refuses caller-supplied time', async () => {
    const { runtime, register } = await registryRuntime();
    const subject = exactSubject([...UNIT]) as Subject;
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.prepareUnit({ plan_handle: planHandle, subject, now: '2026-07-15T12:00:00.000Z' }),
      'usage-error',
      'AUTHORITY_CALLER_TIME_FORBIDDEN',
    );
  });

  it('refuses an unregistered plan handle as a membership failure', async () => {
    const { runtime } = await registryRuntime();
    expectBoundaryFailure(
      runtime.prepareUnit({ plan_handle: {}, subject: exactSubject([...UNIT]) }),
      'refused',
      'AUTHORITY_PLAN_REGISTRY_MEMBERSHIP_REQUIRED',
    );
  });

  it('refuses a subject that does not match the registered plan', async () => {
    const { runtime, register } = await registryRuntime();
    const planHandle = register(exactSubject([...UNIT]) as Subject);
    expectBoundaryFailure(
      runtime.prepareUnit({ plan_handle: planHandle, subject: exactSubject([fsTarget]) }),
      'refused',
      'AUTHORITY_PLAN_BINDING_MISMATCH',
    );
  });

  it('requires a registered batch handle for a bounded plan', async () => {
    const { runtime, register } = await registryRuntime();
    const subject = boundedSubject([...UNIT]) as Subject;
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.prepareUnit({ plan_handle: planHandle, subject, batch_handle: {} }),
      'refused',
      'AUTHORITY_BATCH_REGISTRY_MEMBERSHIP_REQUIRED',
    );
  });

  it('refuses a tampered batch argument against a registered bounded batch', async () => {
    const { runtime, register } = await registryRuntime();
    const subject = boundedSubject([...UNIT]) as Subject;
    const planHandle = register(subject);
    const batch = subject.batch as Batch;
    const batchHandle = expectSuccess<object>(
      runtime.plannerRegistry.registerBatch({
        plan_handle: planHandle,
        batch,
        invocation_id: 'invocation-1',
        plan_digest_sha256: canonicalSha256(subject.plan),
        target_digest_sha256: canonicalSha256(batch.targets.map((target) => target.id)),
        recovery: {
          applied_batch_ids: [],
          applied_target_count: 0,
          partial_effect_evidence_refs: [],
        },
      }),
    );
    expectBoundaryFailure(
      runtime.prepareUnit({
        plan_handle: planHandle,
        subject,
        batch_handle: batchHandle,
        batch: { ...batch, ordinal: 2 },
      }),
      'refused',
      'AUTHORITY_BATCH_BINDING_MISMATCH',
    );
  });

  it.each<[string, unknown]>([
    ['targets that are not a list', 'fs:packages/core/src/index.ts'],
    ['a target list holding a non-record', [fsTarget, 'fs:packages/core/src/authority/types.ts']],
    ['a subset of the plan targets', [fsTarget]],
    ['the plan targets in another order', [secondFsTarget, fsTarget]],
    ['a target whose content differs', [fsTarget, { ...secondFsTarget, operation: 'delete' }]],
  ])('refuses %s as a unit target mismatch', async (_name, targets) => {
    const { runtime, register } = await registryRuntime();
    const subject = exactSubject([...UNIT]) as Subject;
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.prepareUnit({
        plan_handle: planHandle,
        subject,
        targets,
        adapter_id: 'fs-authority-boundary',
      }),
      'refused',
      'AUTHORITY_EXECUTION_UNIT_TARGET_MISMATCH',
    );
  });

  it('refuses a plan whose target list is empty', async () => {
    const { runtime, register } = await registryRuntime();
    const subject = exactSubject([]) as Subject;
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.prepareUnit({
        plan_handle: planHandle,
        subject,
        targets: [],
        adapter_id: 'fs-authority-boundary',
      }),
      'refused',
      'AUTHORITY_EXECUTION_UNIT_TARGET_MISMATCH',
    );
  });

  it('refuses a unit whose targets span more than one adapter', async () => {
    const { runtime, register } = await registryRuntime();
    const targets = [fsTarget, { ...gitTarget, protected: false }];
    const subject = exactSubject(targets) as Subject;
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.prepareUnit({
        plan_handle: planHandle,
        subject,
        targets,
        adapter_id: 'fs-authority-boundary',
      }),
      'refused',
      'AUTHORITY_EXECUTION_UNIT_ADAPTER_MISMATCH',
    );
  });

  it.each(['git-ref-authority-boundary', 'fs', undefined])(
    'refuses adapter id %s that is not the unit adapter',
    async (adapter_id) => {
      const { runtime, register } = await registryRuntime();
      const subject = exactSubject([...UNIT]) as Subject;
      const planHandle = register(subject);
      expectBoundaryFailure(
        runtime.prepareUnit({ plan_handle: planHandle, subject, targets: [...UNIT], adapter_id }),
        'refused',
        'AUTHORITY_EXECUTION_UNIT_ADAPTER_MISMATCH',
      );
    },
  );

  it('requires an atomic adapter for the unit domain', async () => {
    const { runtime, register, events } = await registryRuntime({
      fs: { ...atomicFs([]), applyAtomic: undefined },
    });
    const subject = exactSubject([...UNIT]) as Subject;
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.prepareUnit({
        plan_handle: planHandle,
        subject,
        targets: [...UNIT],
        adapter_id: 'fs-authority-boundary',
      }),
      'dependency-error',
      'AUTHORITY_ATOMIC_UNIT_ADAPTER_REQUIRED',
    );
    expect(events).toEqual([]);
  });

  it('classifies every unit target and returns the first refusal', async () => {
    const { runtime, register } = await registryRuntime({
      repository_root: '/workspace/devai',
      fs: { ...atomicFs([]), realpath: (path: string) => `/private/outside/${path}` },
    });
    const subject = exactSubject([...UNIT]) as Subject;
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.prepareUnit({
        plan_handle: planHandle,
        subject,
        targets: [...UNIT],
        adapter_id: 'fs-authority-boundary',
      }),
      'refused',
      'AUTHORITY_FS_SYMLINK_ESCAPE',
    );
  });

  it('reaches receipt consumption only after every unit check passes', async () => {
    const { runtime, register } = await registryRuntime();
    const subject = exactSubject([...UNIT]) as Subject;
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.prepareUnit({
        plan_handle: planHandle,
        subject,
        targets: [...UNIT],
        adapter_id: 'fs-authority-boundary',
      }),
      'refused',
      'FIXTURE_RECEIPT_REFUSED',
    );
  });
});

describe('applyUnit effect and recovery contracts', () => {
  it('applies an exact-plan unit atomically exactly once', async () => {
    const { events, prepareInput, runtime } = await unitFixture('exact-plan');
    const prepared = expectSuccess(runtime.prepareUnit(prepareInput()));
    expect(events).toEqual([]);
    expect(runtime.applyUnit({ prepared })).toEqual({
      ok: true,
      value: { applied: true, target_count: 2 },
    });
    expect(events).toEqual([`fs:atomic:${fsTarget.id}+${secondFsTarget.id}`]);
    expectBoundaryFailure(
      runtime.applyUnit({ prepared }),
      'refused',
      'AUTHORITY_PREPARED_UNIT_REPLAYED',
    );
    expect(events).toHaveLength(1);
  });

  it.each([undefined, 'prepared', {}])('refuses unknown prepared unit %s', async (prepared) => {
    const { runtime } = await registryRuntime();
    expectBoundaryFailure(
      runtime.applyUnit({ prepared }),
      'refused',
      'AUTHORITY_PREPARED_UNIT_UNKNOWN',
    );
  });

  it('refuses to apply when any unit target snapshot changed after prepare', async () => {
    const snapshots = new Map<string, { kind: string; inode: number; mtime_ms: number }>([
      [fsTarget.canonical_relative_path, { kind: 'file', inode: 1, mtime_ms: 1 }],
      [secondFsTarget.canonical_relative_path, { kind: 'file', inode: 2, mtime_ms: 1 }],
    ]);
    const events: string[] = [];
    const { prepareInput, runtime } = await unitFixture('exact-plan', {
      fs: {
        ...atomicFs(events),
        lstat: (path: string) => ({ ...(snapshots.get(path) as object) }),
      },
    });
    const prepared = expectSuccess(runtime.prepareUnit(prepareInput()));
    (snapshots.get(secondFsTarget.canonical_relative_path) as { mtime_ms: number }).mtime_ms = 2;
    expectBoundaryFailure(
      runtime.applyUnit({ prepared }),
      'refused',
      'AUTHORITY_RESOURCE_CHANGED_AFTER_PREPARE',
    );
    expect(events).toEqual([]);
  });

  it('returns the atomic adapter refusal unchanged and records no recovery', async () => {
    const refusal = {
      ok: false,
      category: 'dependency-error',
      code: 'FIXTURE_ATOMIC_FAILED',
      reasons: [],
    };
    const { planHandle, prepareInput, runtime } = await unitFixture(
      'bounded-batches',
      {},
      () => refusal,
    );
    const prepared = expectSuccess(runtime.prepareUnit(prepareInput()));
    expect(runtime.applyUnit({ prepared })).toEqual(refusal);
    expect(expectSuccess(runtime.plannerRegistry.recovery({ plan_handle: planHandle }))).toEqual({
      applied_batch_ids: [],
      applied_target_count: 0,
      partial_effect_evidence_refs: [],
    });
  });

  it('records a bounded unit in the plan recovery with the default evidence ref', async () => {
    const { events, planHandle, prepareInput, runtime, subject } =
      await unitFixture('bounded-batches');
    const prepared = expectSuccess(runtime.prepareUnit(prepareInput()));
    expect(runtime.applyUnit({ prepared })).toEqual({
      ok: true,
      value: { applied: true, target_count: 2 },
    });
    expect(events).toEqual([`fs:atomic:${fsTarget.id}+${secondFsTarget.id}`]);
    expect(expectSuccess(runtime.plannerRegistry.recovery({ plan_handle: planHandle }))).toEqual({
      applied_batch_ids: ['batch-1'],
      applied_target_count: 2,
      partial_effect_evidence_refs: ['authority-boundary:batch-1'],
      recovery_checkpoint_ref: 'authority-boundary:batch-1:applied',
    });
    expectBoundaryFailure(
      runtime.prepareUnit(prepareInput()),
      'refused',
      'AUTHORITY_BATCH_BINDING_MISMATCH',
    );
    expect(subject.batch?.batch_id).toBe('batch-1');
  });

  it('retains a string atomic result as the unit evidence ref', async () => {
    const { planHandle, prepareInput, runtime } = await unitFixture(
      'bounded-batches',
      {},
      () => 'evidence:atomic-1',
    );
    const prepared = expectSuccess(runtime.prepareUnit(prepareInput()));
    expectSuccess(runtime.applyUnit({ prepared }));
    expect(
      expectSuccess(runtime.plannerRegistry.recovery({ plan_handle: planHandle })),
    ).toMatchObject({
      partial_effect_evidence_refs: ['evidence:atomic-1'],
      applied_target_count: 2,
    });
  });

  it('refuses every unit operation after disposal', async () => {
    const { prepareInput, runtime } = await unitFixture('exact-plan');
    const prepared = expectSuccess(runtime.prepareUnit(prepareInput()));
    expectSuccess(runtime.dispose());
    expectBoundaryFailure(
      runtime.prepareUnit(prepareInput()),
      'refused',
      'AUTHORITY_DECISION_ISSUER_CLOSED',
    );
    expectBoundaryFailure(
      runtime.applyUnit({ prepared }),
      'refused',
      'AUTHORITY_DECISION_ISSUER_CLOSED',
    );
  });
});
