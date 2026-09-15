import { describe, expect, it } from 'vitest';
import {
  authorizedBoundaryFixture,
  boundaryApi,
  boundaryDependencies,
  expectBoundaryFailure,
  gitTarget,
  remoteTarget,
  type AuthorityBoundaryRuntime,
} from './authority-boundary-testkit.js';
import {
  CONSENT,
  REPOSITORY_ID,
  boundedSubject,
  canonicalSha256,
  exactSubject,
  expectSuccess,
  fsTarget,
  secondFsTarget,
  type AuthorityDecisionIssuer,
} from './authority-runtime-testkit.js';

// Boundary runtime contract cases written against the retained authority mutation
// diagnostic (candidate 3dfdc316, report 414957d9). Each block names the surviving mutant
// IDs it pins. The private planner registry is exercised directly where a refusal precedes
// receipt consumption, and through the authorized fixture where an effect must be observed.

type Target = Readonly<Record<string, unknown>> & { readonly id: string };
type Batch = {
  batch_id: string;
  plan_id: string;
  ordinal: number;
  targets: readonly Target[];
  atomicity: string;
};
type Subject = { plan: Record<string, unknown>; batch?: Batch };

const thirdFsTarget = {
  ...fsTarget,
  id: 'fs:packages/core/src/third.ts',
  canonical_relative_path: 'packages/core/src/third.ts',
} as const;
const outsideTarget = {
  ...fsTarget,
  id: 'fs:docs/README.md',
  canonical_relative_path: 'docs/README.md',
} as const;
const selectorFor = (glob: string) => ({
  kind: 'fs',
  repository_id: REPOSITORY_ID,
  canonical_relative_path_glob: glob,
  operations: ['update'],
});

function fresh() {
  return { applied_batch_ids: [], applied_target_count: 0, partial_effect_evidence_refs: [] };
}

function bounded(targets: readonly Target[] = [fsTarget]): Subject {
  return boundedSubject(targets) as Subject;
}

function registration(
  planHandle: unknown,
  subject: Subject,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const batch = subject.batch as Batch;
  return {
    plan_handle: planHandle,
    batch,
    invocation_id: 'invocation-1',
    plan_digest_sha256: canonicalSha256(subject.plan),
    target_digest_sha256: canonicalSha256(batch.targets.map((target) => target.id)),
    recovery: fresh(),
    ...overrides,
  };
}

/** A registry-only runtime: every case here is refused before any receipt is consumed. */
async function registryRuntime() {
  const api = await boundaryApi();
  const events: string[] = [];
  const receiptStore = { dispose: () => ({ ok: true, value: true }) };
  const runtime = api.createAuthorityBoundaryRuntime(
    boundaryDependencies(receiptStore as unknown as AuthorityDecisionIssuer, events),
  );
  const register = (subject: Subject) =>
    expectSuccess<object>(
      runtime.plannerRegistry.registerPlan({ subject, invocation_id: 'invocation-1' }),
    );
  return { runtime, events, register };
}

async function boundedFixture(
  target: Record<string, unknown> = fsTarget,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const fixture = await authorizedBoundaryFixture(target, {
    subjectFactory: (plant) => boundedSubject([target], plant),
  });
  const subject = fixture.subject as Subject;
  const api = await boundaryApi();
  const events: string[] = [];
  const runtime = api.createAuthorityBoundaryRuntime(
    boundaryDependencies(fixture.issuer, events, overrides),
  );
  const planHandle = expectSuccess<object>(
    runtime.plannerRegistry.registerPlan({
      subject,
      context_receipt: fixture.context_receipt,
      invocation_id: 'invocation-1',
    }),
  );
  const batch = subject.batch as Batch;
  const batchHandle = expectSuccess<object>(
    runtime.plannerRegistry.registerBatch(registration(planHandle, subject)),
  );
  const prepareInput = (extra: Record<string, unknown> = {}) => ({
    target,
    subject,
    batch,
    batch_handle: batchHandle,
    context_receipt: fixture.context_receipt,
    decision_receipt: fixture.decision_receipt,
    plan_handle: planHandle,
    adapter_id: `${String(target.kind)}-authority-boundary`,
    ...extra,
  });
  return { batch, batchHandle, events, fixture, planHandle, prepareInput, runtime, subject };
}

async function exactFixture(
  target: Record<string, unknown>,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const fixture = await authorizedBoundaryFixture(target);
  const api = await boundaryApi();
  const events: string[] = [];
  const runtime = api.createAuthorityBoundaryRuntime(
    boundaryDependencies(fixture.issuer, events, overrides),
  );
  const planHandle = expectSuccess<object>(
    runtime.plannerRegistry.registerPlan({
      subject: fixture.subject,
      context_receipt: fixture.context_receipt,
      invocation_id: 'invocation-1',
    }),
  );
  const prepared = expectSuccess<object>(
    runtime.prepare({
      target,
      subject: fixture.subject,
      context_receipt: fixture.context_receipt,
      decision_receipt: fixture.decision_receipt,
      plan_handle: planHandle,
      adapter_id: `${String(target.kind)}-authority-boundary`,
    }),
  );
  return { events, fixture, planHandle, prepared, runtime };
}

describe('private planner registry contracts', () => {
  // Mutants 2662, 2663, 2664: a registered plan starts from an empty recovery record.
  it('exposes an empty recovery record for a freshly registered plan', async () => {
    const { runtime, register } = await registryRuntime();
    const planHandle = register(bounded());
    expect(expectSuccess(runtime.plannerRegistry.recovery({ plan_handle: planHandle }))).toEqual({
      applied_batch_ids: [],
      applied_target_count: 0,
      partial_effect_evidence_refs: [],
    });
  });

  // Mutants 2837, 2839, 2842: recovery is readable only through a registered plan handle.
  it.each([undefined, null, 'plan', {}, { plan_handle: {} }, { plan_handle: 'plan' }])(
    'refuses a recovery read for %s',
    async (input) => {
      const { runtime } = await registryRuntime();
      expectBoundaryFailure(
        runtime.plannerRegistry.recovery(input),
        'refused',
        'AUTHORITY_PLAN_BINDING_MISMATCH',
      );
    },
  );

  // Mutant 2656: a plan binds the runtime invocation, not the caller's claim.
  it('refuses plan registration under another invocation', async () => {
    const { runtime } = await registryRuntime();
    expectBoundaryFailure(
      runtime.plannerRegistry.registerPlan({ subject: bounded(), invocation_id: 'invocation-2' }),
      'refused',
      'AUTHORITY_PLAN_BINDING_MISMATCH',
    );
  });

  // Mutants 2696, 2708-2716, 2725, 2732, 2733: each binding condition of batch
  // registration is refused on its own, with every other condition satisfied.
  it.each<[string, (subject: Subject) => Record<string, unknown>]>([
    ['a stale plan digest', () => ({ plan_digest_sha256: 'f'.repeat(64) })],
    [
      'a batch bound to another plan id',
      (subject) => ({ batch: { ...(subject.batch as Batch), plan_id: 'plan-other' } }),
    ],
    [
      'an empty target list',
      (subject) => ({
        batch: { ...(subject.batch as Batch), targets: [] },
        target_digest_sha256: canonicalSha256([]),
      }),
    ],
    [
      'a duplicated target',
      (subject) => ({
        batch: { ...(subject.batch as Batch), targets: [fsTarget, fsTarget] },
        target_digest_sha256: canonicalSha256([fsTarget.id, fsTarget.id]),
      }),
    ],
    [
      'a target outside every selector beside one inside',
      (subject) => ({
        batch: { ...(subject.batch as Batch), targets: [fsTarget, outsideTarget] },
        target_digest_sha256: canonicalSha256([fsTarget.id, outsideTarget.id]),
      }),
    ],
    [
      'more targets than the per-batch bound',
      (subject) => ({
        batch: {
          ...(subject.batch as Batch),
          targets: [fsTarget, secondFsTarget, thirdFsTarget],
        },
        target_digest_sha256: canonicalSha256([fsTarget.id, secondFsTarget.id, thirdFsTarget.id]),
      }),
    ],
  ])('refuses batch registration with %s', async (_name, override) => {
    const { runtime, register } = await registryRuntime();
    const subject = bounded();
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.plannerRegistry.registerBatch(registration(planHandle, subject, override(subject))),
      'refused',
      'AUTHORITY_BATCH_BINDING_MISMATCH',
    );
  });

  it.each<[string, (plan: Record<string, unknown>) => Record<string, unknown>]>([
    ['no bounds', (plan) => ({ ...plan, bounds: undefined })],
    ['bounds that are not a record', (plan) => ({ ...plan, bounds: 'unbounded' })],
    ['selectors that are not a list', (plan) => ({ ...plan, selectors: selectorFor('**') })],
  ])('refuses batch registration against a plan with %s', async (_name, rewrite) => {
    const { runtime, register } = await registryRuntime();
    const subject = bounded();
    subject.plan = rewrite(subject.plan);
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.plannerRegistry.registerBatch(registration(planHandle, subject)),
      'refused',
      'AUTHORITY_BATCH_BINDING_MISMATCH',
    );
  });

  // Mutant 2730: a target needs to match one selector, not all of them.
  it('admits a target that matches one of several selectors', async () => {
    const { runtime, register } = await registryRuntime();
    const subject = bounded();
    subject.plan = {
      ...subject.plan,
      selectors: [selectorFor('docs/**'), selectorFor('packages/core/src/**')],
    };
    const planHandle = register(subject);
    expectSuccess(runtime.plannerRegistry.registerBatch(registration(planHandle, subject)));
  });

  // Mutants 2732, 2733: the per-batch bound is inclusive.
  it('admits a batch with exactly the per-batch bound of targets', async () => {
    const { runtime, register } = await registryRuntime();
    const subject = bounded([fsTarget, secondFsTarget]);
    const planHandle = register(subject);
    const handle = expectSuccess(
      runtime.plannerRegistry.registerBatch(registration(planHandle, subject)),
    );
    expect(handle).toMatchObject({ plan_id: 'plan-bounded', batch_id: 'batch-1', ordinal: 1 });
  });

  // Mutants 2746-2751, 2764, 2766, 2769, 2771, 2774, 2777: every recovery invariant is
  // refused as stale on its own.
  it.each<[string, Record<string, unknown>]>([
    ['applied batch ids that are not a list', { ...fresh(), applied_batch_ids: 'batch-0' }],
    ['evidence refs that are not a list', { ...fresh(), partial_effect_evidence_refs: 'ref' }],
    [
      'an empty applied batch id',
      {
        applied_batch_ids: [''],
        applied_target_count: 1,
        partial_effect_evidence_refs: ['evidence:0'],
        recovery_checkpoint_ref: 'checkpoint:0',
      },
    ],
    [
      'a duplicated applied batch id',
      {
        applied_batch_ids: ['batch-0', 'batch-0'],
        applied_target_count: 2,
        partial_effect_evidence_refs: ['evidence:a', 'evidence:b'],
        recovery_checkpoint_ref: 'checkpoint:0',
      },
    ],
    [
      'a non-logical evidence ref',
      {
        applied_batch_ids: ['batch-0'],
        applied_target_count: 1,
        partial_effect_evidence_refs: [42],
        recovery_checkpoint_ref: 'checkpoint:0',
      },
    ],
    [
      'fewer evidence refs than applied batches',
      {
        applied_batch_ids: ['batch-0'],
        applied_target_count: 1,
        partial_effect_evidence_refs: [],
        recovery_checkpoint_ref: 'checkpoint:0',
      },
    ],
    ['a fractional applied target count', { ...fresh(), applied_target_count: 0.5 }],
    [
      'fewer applied targets than applied batches',
      {
        applied_batch_ids: ['batch-0'],
        applied_target_count: 0,
        partial_effect_evidence_refs: ['evidence:0'],
        recovery_checkpoint_ref: 'checkpoint:0',
      },
    ],
    [
      'applied batches without a recovery checkpoint',
      {
        applied_batch_ids: ['batch-0'],
        applied_target_count: 1,
        partial_effect_evidence_refs: ['evidence:0'],
      },
    ],
  ])('refuses %s as a stale recovery record', async (_name, recovery) => {
    const { runtime, register } = await registryRuntime();
    const subject = bounded();
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.plannerRegistry.registerBatch(registration(planHandle, subject, { recovery })),
      'refused',
      'AUTHORITY_BATCH_RECOVERY_STALE',
    );
  });

  // Mutant 2797: a batch already recorded as applied is a replay, whatever its ordinal.
  it('refuses re-registration of an applied batch as a replay', async () => {
    const { runtime, register } = await registryRuntime();
    const subject = bounded();
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.plannerRegistry.registerBatch(
        registration(planHandle, subject, {
          batch: { ...(subject.batch as Batch), ordinal: 2 },
          recovery: {
            applied_batch_ids: ['batch-1'],
            applied_target_count: 1,
            partial_effect_evidence_refs: ['evidence:1'],
            recovery_checkpoint_ref: 'checkpoint:1',
          },
        }),
      ),
      'refused',
      'AUTHORITY_BATCH_REPLAYED',
    );
  });

  // Mutants 2805, 2809: the cumulative batch and target bounds are inclusive.
  it('admits the batch that exactly reaches both cumulative bounds', async () => {
    const { runtime, register } = await registryRuntime();
    const subject = bounded([fsTarget, secondFsTarget]);
    const planHandle = register(subject);
    expectSuccess(
      runtime.plannerRegistry.registerBatch(
        registration(planHandle, subject, {
          batch: { ...(subject.batch as Batch), batch_id: 'batch-2', ordinal: 2 },
          recovery: {
            applied_batch_ids: ['batch-1'],
            applied_target_count: 1,
            partial_effect_evidence_refs: ['evidence:1'],
            recovery_checkpoint_ref: 'checkpoint:1',
          },
        }),
      ),
    );
  });

  // Mutant 2821: the batch ordinal must be the next one after the applied batches.
  it('refuses a batch whose own ordinal skips ahead', async () => {
    const { runtime, register } = await registryRuntime();
    const subject = bounded();
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.plannerRegistry.registerBatch(
        registration(planHandle, subject, {
          batch: { ...(subject.batch as Batch), ordinal: 2 },
        }),
      ),
      'refused',
      'AUTHORITY_BATCH_ORDER_INVALID',
    );
  });

  // Mutants 2787, 2795: once a plan has bound a recovery record, a caller cannot replace it.
  it('refuses a later batch that presents a recovery record the plan did not bind', async () => {
    const { runtime, register } = await registryRuntime();
    const subject = bounded();
    const planHandle = register(subject);
    expectSuccess(runtime.plannerRegistry.registerBatch(registration(planHandle, subject)));
    expectBoundaryFailure(
      runtime.plannerRegistry.registerBatch(
        registration(planHandle, subject, {
          batch: { ...(subject.batch as Batch), batch_id: 'batch-2', ordinal: 2 },
          recovery: {
            applied_batch_ids: ['batch-1'],
            applied_target_count: 1,
            partial_effect_evidence_refs: ['evidence:1'],
            recovery_checkpoint_ref: 'checkpoint:1',
          },
        }),
      ),
      'refused',
      'AUTHORITY_BATCH_RECOVERY_STALE',
    );
    expect(expectSuccess(runtime.plannerRegistry.recovery({ plan_handle: planHandle }))).toEqual(
      fresh(),
    );
  });
});

describe('prepare binding contracts before receipt consumption', () => {
  // Mutants 2856, 2857, 2877: an unregistered record handle is a membership failure, never
  // treated as a registered handle that happens to be missing.
  it('refuses an unregistered plan handle as a membership failure', async () => {
    const { runtime } = await registryRuntime();
    expectBoundaryFailure(
      runtime.prepare({ plan_handle: {}, subject: bounded() }),
      'refused',
      'AUTHORITY_PLAN_REGISTRY_MEMBERSHIP_REQUIRED',
    );
  });

  it('refuses an unregistered batch handle as a membership failure', async () => {
    const { runtime, register } = await registryRuntime();
    const subject = bounded();
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.prepare({ plan_handle: planHandle, subject, batch_handle: {} }),
      'refused',
      'AUTHORITY_BATCH_REGISTRY_MEMBERSHIP_REQUIRED',
    );
  });

  // Mutant 2895: a batch handle is bound to the plan it was registered under.
  it('refuses a batch registered under another plan', async () => {
    const { runtime, register } = await registryRuntime();
    const first = bounded();
    const firstPlan = register(first);
    const batchHandle = expectSuccess<object>(
      runtime.plannerRegistry.registerBatch(registration(firstPlan, first)),
    );
    const second = bounded();
    second.plan = { ...second.plan, plan_id: 'plan-second' };
    second.batch = { ...(second.batch as Batch), plan_id: 'plan-second' };
    const secondPlan = register(second);
    expectBoundaryFailure(
      runtime.prepare({
        plan_handle: secondPlan,
        subject: second,
        batch: second.batch,
        batch_handle: batchHandle,
      }),
      'refused',
      'AUTHORITY_BATCH_BINDING_MISMATCH',
    );
  });

  // Mutants 2900 and 2884: both the batch argument and the subject's batch must be the
  // registered batch byte for byte.
  it('refuses a tampered batch argument for a registered batch handle', async () => {
    const { batchHandle, batch, planHandle, runtime, subject } = await boundedFixture();
    expectBoundaryFailure(
      runtime.prepare({
        plan_handle: planHandle,
        subject,
        batch: { ...batch, ordinal: 2 },
        batch_handle: batchHandle,
      }),
      'refused',
      'AUTHORITY_BATCH_BINDING_MISMATCH',
    );
  });

  it('refuses a subject whose batch differs from the registered batch', async () => {
    const { batchHandle, batch, planHandle, runtime, subject } = await boundedFixture();
    expectBoundaryFailure(
      runtime.prepare({
        plan_handle: planHandle,
        subject: { ...subject, batch: { ...batch, batch_id: 'batch-9' } },
        batch,
        batch_handle: batchHandle,
      }),
      'refused',
      'AUTHORITY_BATCH_BINDING_MISMATCH',
    );
  });

  // Mutants 2906, 2909, 2546, 2547: an exact plan prepares exactly one record target.
  it('refuses an exact plan that carries more than one target', async () => {
    const { runtime, register } = await registryRuntime();
    const subject = exactSubject([fsTarget, secondFsTarget]) as Subject;
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.prepare({ plan_handle: planHandle, subject, target: fsTarget }),
      'refused',
      'AUTHORITY_EXECUTION_UNIT_REQUIRED',
    );
  });

  it('refuses an exact plan whose target list holds a non-record entry', async () => {
    const { runtime, register } = await registryRuntime();
    const subject = exactSubject(['fs:packages/core/src/index.ts']) as Subject;
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.prepare({ plan_handle: planHandle, subject, target: fsTarget }),
      'refused',
      'AUTHORITY_EXECUTION_UNIT_REQUIRED',
    );
  });

  // Mutants 2915, 2916, 2562, 2564, 2565, 2567: the prepared target must match a plan target
  // by id and by content.
  it.each([
    ['same id, different content', { ...fsTarget, operation: 'delete' }],
    ['same content, different id', { ...fsTarget, id: 'fs:packages/core/src/renamed.ts' }],
  ])('refuses a target with %s', async (_name, target) => {
    const { runtime, register } = await registryRuntime();
    const subject = exactSubject([fsTarget]) as Subject;
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.prepare({ plan_handle: planHandle, subject, target }),
      'refused',
      'AUTHORITY_PLAN_TARGET_BINDING_MISMATCH',
    );
  });

  // Mutants 2922, 2924, 2925: publication consent comes from the plan envelope, and a plan
  // without an envelope request is refused rather than dereferenced.
  it('enforces publication consent from the plan envelope before consuming a receipt', async () => {
    const { runtime, register } = await registryRuntime();
    const subject = exactSubject([remoteTarget], undefined, {
      consent: { ...CONSENT, allow_publish: false },
      action_effect: 'remote-write',
    }) as Subject;
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.prepare({
        plan_handle: planHandle,
        subject,
        target: remoteTarget,
        adapter_id: 'remote-authority-boundary',
      }),
      'refused',
      'AUTHORITY_PUBLISH_CONSENT_REQUIRED',
    );
  });

  it('reaches receipt consumption for a plan whose envelope carries no request', async () => {
    const api = await boundaryApi();
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
      boundaryDependencies(receiptStore as unknown as AuthorityDecisionIssuer, []),
    );
    const subject: Subject = {
      plan: { plan_id: 'plan-bare', strategy: 'exact-plan', targets: [fsTarget], envelope: {} },
    };
    const planHandle = expectSuccess<object>(
      runtime.plannerRegistry.registerPlan({ subject, invocation_id: 'invocation-1' }),
    );
    // A missing envelope request must not be dereferenced: the target still classifies and
    // the only refusal left is the receipt store's own.
    expectBoundaryFailure(
      runtime.prepare({
        plan_handle: planHandle,
        subject,
        target: fsTarget,
        adapter_id: 'fs-authority-boundary',
      }),
      'refused',
      'FIXTURE_RECEIPT_REFUSED',
    );
  });
});

describe('apply effect and recovery contracts', () => {
  // Mutants 3149, 3152, 3156, 3158, 3159, 3161-3167, 3153, 2897: applying a batch records it in
  // the plan's recovery, retires the batch handle, and lets the next batch bind that record.
  it('records an applied batch in the plan recovery and retires its handle', async () => {
    const { batchHandle, batch, events, planHandle, prepareInput, runtime, subject } =
      await boundedFixture();
    const prepared = expectSuccess(runtime.prepare(prepareInput()));
    expectSuccess(runtime.apply({ prepared }));
    expect(events).toEqual(['fs:write:packages/core/src/index.ts']);
    const recovery = expectSuccess(runtime.plannerRegistry.recovery({ plan_handle: planHandle }));
    expect(recovery).toEqual({
      applied_batch_ids: ['batch-1'],
      applied_target_count: 1,
      partial_effect_evidence_refs: ['authority-boundary:batch-1'],
      recovery_checkpoint_ref: 'authority-boundary:batch-1:applied',
    });
    expectBoundaryFailure(
      runtime.prepare(prepareInput()),
      'refused',
      'AUTHORITY_BATCH_BINDING_MISMATCH',
    );
    expect(batchHandle).toBeDefined();
    expectSuccess(
      runtime.plannerRegistry.registerBatch(
        registration(planHandle, subject, {
          batch: { ...batch, batch_id: 'batch-2', ordinal: 2 },
          recovery,
        }),
      ),
    );
  });

  // Mutants 3158, 3159, 3161: a string effect result is retained as the evidence ref.
  it('retains a string effect result as the batch evidence ref', async () => {
    const { events, planHandle, prepareInput, runtime } = await boundedFixture(fsTarget, {
      fs: {
        realpath: (path: string) => path,
        lstat: () => ({ kind: 'file', inode: 1, mtime_ms: 1 }),
        writeAtomic: (path: string) => {
          events.push(`fs:write:${path}`);
          return 'evidence:write-1';
        },
        renameAtomic: () => 'evidence:rename-1',
      },
    });
    const prepared = expectSuccess(runtime.prepare(prepareInput()));
    expectSuccess(runtime.apply({ prepared }));
    expect(
      expectSuccess(runtime.plannerRegistry.recovery({ plan_handle: planHandle })),
    ).toMatchObject({ partial_effect_evidence_refs: ['evidence:write-1'] });
  });

  // Mutant 3109: a target whose filesystem snapshot changed after prepare is refused before
  // any effect.
  it('refuses to apply when the target snapshot changed after prepare', async () => {
    const snapshot = { kind: 'file', inode: 1, mtime_ms: 1 };
    const { events, prepareInput, runtime } = await boundedFixture(fsTarget, {
      fs: {
        realpath: (path: string) => path,
        lstat: () => ({ ...snapshot }),
        writeAtomic: (path: string) => events.push(`fs:write:${path}`),
        renameAtomic: () => undefined,
      },
    });
    const prepared = expectSuccess(runtime.prepare(prepareInput()));
    snapshot.mtime_ms = 2;
    expectBoundaryFailure(
      runtime.apply({ prepared }),
      'refused',
      'AUTHORITY_RESOURCE_CHANGED_AFTER_PREPARE',
    );
    expect(events).toEqual([]);
  });

  // Mutants 3132, 3134, 3136, 3138, 3143: each domain operation dispatches to its own adapter
  // method, and nothing else is invoked.
  it.each([
    ['delete', 'git:delete:refs/heads/main'],
    ['push', 'git:push:refs/heads/main'],
    ['update', 'git:update:refs/heads/main'],
  ])('dispatches an unprotected git-ref %s to its adapter method', async (operation, event) => {
    const { events, prepared, runtime } = await exactFixture({
      ...gitTarget,
      protected: false,
      operation,
    });
    expect(events).toEqual([]);
    expectSuccess(runtime.apply({ prepared }));
    expect(events).toEqual([event]);
  });

  it('dispatches a remote target to the remote adapter with its exact identifiers', async () => {
    const { events, prepared, runtime } = await exactFixture(remoteTarget);
    expectSuccess(runtime.apply({ prepared }));
    expect(events).toEqual(['remote:sensor-runtime:observations:invoke']);
  });

  it('refuses a prepared record that is not a registered handle', async () => {
    const { runtime } = await registryRuntime();
    for (const prepared of [undefined, 'prepared', {}]) {
      expectBoundaryFailure(
        runtime.apply({ prepared }),
        'refused',
        'AUTHORITY_PREPARED_MUTATION_UNKNOWN',
      );
    }
  });
});

describe('disposal contracts', () => {
  // Mutants 2643, 2668, 2842, 3073, 3267, 3270: every operation, and disposal itself, is
  // refused once the runtime is closed.
  it('refuses every operation and a second disposal after the runtime is closed', async () => {
    const { batch, batchHandle, planHandle, prepareInput, runtime, subject } =
      await boundedFixture();
    const prepared = expectSuccess(runtime.prepare(prepareInput()));
    expectSuccess(runtime.dispose());
    const closed = (result: unknown) =>
      expectBoundaryFailure(result, 'refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
    closed(runtime.plannerRegistry.registerPlan({ subject, invocation_id: 'invocation-1' }));
    closed(
      runtime.plannerRegistry.registerBatch(
        registration(planHandle, subject, {
          batch: { ...batch, batch_id: 'batch-2', ordinal: 2 },
        }),
      ),
    );
    closed(runtime.prepare({ ...prepareInput(), batch_handle: batchHandle }));
    closed(runtime.apply({ prepared }));
    closed(runtime.dispose());
  });

  it('disposal reaches the receipt store exactly once', async () => {
    const api = await boundaryApi();
    let disposals = 0;
    const receiptStore = {
      dispose: () => {
        disposals += 1;
        return { ok: true, value: true };
      },
    };
    const runtime: AuthorityBoundaryRuntime = api.createAuthorityBoundaryRuntime(
      boundaryDependencies(receiptStore as unknown as AuthorityDecisionIssuer, []),
    );
    expectSuccess(runtime.dispose());
    expectBoundaryFailure(runtime.dispose(), 'refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
    expect(disposals).toBe(1);
  });
});
