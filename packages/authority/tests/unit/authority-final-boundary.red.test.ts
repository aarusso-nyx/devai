import { describe, expect, it } from 'vitest';
import {
  authorizedBoundaryFixture,
  authorizedBoundarySetFixture,
  boundaryApi,
  boundaryDependencies,
  dbTarget,
  expectBoundaryFailure,
  gitTarget,
  remoteTarget,
} from './authority-boundary-testkit.js';
import {
  boundedSubject,
  canonicalSha256,
  exactSubject,
  expectSuccess,
  fsTarget,
  secondFsTarget,
} from './authority-runtime-testkit.js';

// Invariants: INV-AUTH-002, INV-AUTH-003, INV-AUTH-004

async function exactRuntime(target: Record<string, unknown> = fsTarget) {
  const api = await boundaryApi();
  const fixture = await authorizedBoundaryFixture(target);
  const events: string[] = [];
  const runtime = api.createAuthorityBoundaryRuntime(boundaryDependencies(fixture.issuer, events));
  const planHandle = expectSuccess(
    runtime.plannerRegistry.registerPlan({
      subject: fixture.subject,
      context_receipt: fixture.context_receipt,
      invocation_id: 'invocation-1',
    }),
  );
  return { api, fixture, events, runtime, planHandle };
}

describe('R19 final boundary is load-bearing', () => {
  it.each([
    ['missing receipt', undefined, 'AUTHORITY_DECISION_RECEIPT_UNKNOWN'],
    ['plain structural receipt', { receipt_id: 'decision' }, 'AUTHORITY_DECISION_RECEIPT_UNKNOWN'],
    [
      'evidence record',
      { record_kind: 'audit-only-non-capability' },
      'AUTHORITY_DECISION_RECEIPT_UNKNOWN',
    ],
    [
      'denial decision',
      { evaluation: 'deny', disposition: 'refuse' },
      'AUTHORITY_DECISION_RECEIPT_UNKNOWN',
    ],
  ])('%s cannot prepare an effect', async (_name, receipt, code) => {
    const { fixture, events, runtime, planHandle } = await exactRuntime();
    const result = runtime.prepare({
      target: fsTarget,
      subject: fixture.subject,
      context_receipt: fixture.context_receipt,
      decision_receipt: receipt,
      plan_handle: planHandle,
      adapter_id: 'fs-authority-boundary',
    });
    expectBoundaryFailure(result, 'refused', code);
    expect(events).toEqual([]);
  });

  it.each([
    ['structural clone', (receipt: unknown) => ({ ...(receipt as object) })],
    ['JSON round trip', (receipt: unknown) => JSON.parse(JSON.stringify(receipt))],
  ])('%s of a genuine receipt cannot prepare an effect', async (_name, clone) => {
    const { fixture, events, runtime, planHandle } = await exactRuntime();
    expectBoundaryFailure(
      runtime.prepare({
        target: fsTarget,
        subject: fixture.subject,
        context_receipt: fixture.context_receipt,
        decision_receipt: clone(fixture.decision_receipt),
        plan_handle: planHandle,
        adapter_id: 'fs-authority-boundary',
      }),
      'refused',
      'AUTHORITY_DECISION_RECEIPT_UNKNOWN',
    );
    expect(events).toEqual([]);
  });

  it('receipt for a different final adapter refuses before side effects', async () => {
    const { fixture, events, runtime, planHandle } = await exactRuntime();
    expectBoundaryFailure(
      runtime.prepare({
        target: fsTarget,
        subject: fixture.subject,
        context_receipt: fixture.context_receipt,
        decision_receipt: fixture.decision_receipt,
        plan_handle: planHandle,
        adapter_id: 'git-ref-authority-boundary',
      }),
      'refused',
      'AUTHORITY_DECISION_RECEIPT_BINDING_MISMATCH',
    );
    expect(events).toEqual([]);
  });

  it('caller-selected time cannot extend a receipt lifetime', async () => {
    const { fixture, events, runtime, planHandle } = await exactRuntime();
    expectBoundaryFailure(
      runtime.prepare({
        target: fsTarget,
        subject: fixture.subject,
        context_receipt: fixture.context_receipt,
        decision_receipt: fixture.decision_receipt,
        plan_handle: planHandle,
        adapter_id: 'fs-authority-boundary',
        now: '2000-01-01T00:00:00.000Z',
      }),
      'usage-error',
      'AUTHORITY_CALLER_TIME_FORBIDDEN',
    );
    expect(events).toEqual([]);
  });

  it.each(['router', 'direct handler', 'direct skill', 'direct library'])(
    '%s allow without final preparation cannot bypass the boundary',
    async (source) => {
      const { fixture, events, runtime } = await exactRuntime();
      expectBoundaryFailure(
        runtime.apply({
          prepared: {
            authority: `${source}-allowed`,
            receipt: fixture.decision_receipt,
            target: fsTarget,
          },
        }),
        'refused',
        'AUTHORITY_PREPARED_MUTATION_UNKNOWN',
      );
      expect(events).toEqual([]);
    },
  );

  it('exact plan prepares and applies atomically once', async () => {
    const { fixture, events, runtime, planHandle } = await exactRuntime();
    const prepared = expectSuccess(
      runtime.prepare({
        target: fsTarget,
        subject: fixture.subject,
        context_receipt: fixture.context_receipt,
        decision_receipt: fixture.decision_receipt,
        plan_handle: planHandle,
        adapter_id: 'fs-authority-boundary',
      }),
    );
    expect(events).toEqual([]);
    expectSuccess(runtime.apply({ prepared }));
    expect(events).toEqual(['fs:write:packages/core/src/index.ts']);
    expectBoundaryFailure(
      runtime.apply({ prepared }),
      'refused',
      'AUTHORITY_PREPARED_MUTATION_REPLAYED',
    );
    expect(events).toHaveLength(1);
  });

  it('filesystem identity race between prepare and apply refuses without effect', async () => {
    const api = await boundaryApi();
    const fixture = await authorizedBoundaryFixture(fsTarget);
    const events: string[] = [];
    let statCall = 0;
    const runtime = api.createAuthorityBoundaryRuntime(
      boundaryDependencies(fixture.issuer, events, {
        fs: {
          realpath: (path: string) => path,
          lstat: () => ({ kind: 'file', inode: ++statCall, mtime_ms: statCall }),
          writeAtomic: (path: string) => events.push(`fs:write:${path}`),
        },
      }),
    );
    const planHandle = expectSuccess(
      runtime.plannerRegistry.registerPlan({
        subject: fixture.subject,
        context_receipt: fixture.context_receipt,
        invocation_id: 'invocation-1',
      }),
    );
    const prepared = expectSuccess(
      runtime.prepare({
        target: fsTarget,
        subject: fixture.subject,
        context_receipt: fixture.context_receipt,
        decision_receipt: fixture.decision_receipt,
        plan_handle: planHandle,
        adapter_id: 'fs-authority-boundary',
      }),
    );
    expectBoundaryFailure(
      runtime.apply({ prepared }),
      'refused',
      'AUTHORITY_RESOURCE_CHANGED_AFTER_PREPARE',
    );
    expect(events).toEqual([]);
  });
});

describe('R19 target-specific final adapters', () => {
  it.each([
    ['git-ref', gitTarget, 'git:update:refs/heads/main'],
    ['database', dbTarget, 'db:devai-control:ddl'],
    ['remote', remoteTarget, 'remote:sensor-runtime:observations:invoke'],
  ])('%s effect occurs only after authentic prepare/apply', async (_name, target, event) => {
    const { fixture, events, runtime, planHandle } = await exactRuntime(target);
    const adapterId = `${String(target.kind)}-authority-boundary`;
    const prepared = expectSuccess(
      runtime.prepare({
        target,
        subject: fixture.subject,
        context_receipt: fixture.context_receipt,
        decision_receipt: fixture.decision_receipt,
        plan_handle: planHandle,
        adapter_id: adapterId,
      }),
    );
    expect(events).toEqual([]);
    expectSuccess(runtime.apply({ prepared }));
    expect(events).toEqual([event]);
  });
});

describe('R19 private planner and batch registry', () => {
  async function boundedFixture(targets: readonly unknown[] = [fsTarget]) {
    const fixture = await authorizedBoundaryFixture(fsTarget, {
      subjectFactory: (plant) => boundedSubject(targets, plant),
    });
    const subject = fixture.subject;
    const api = await boundaryApi();
    const events: string[] = [];
    const runtime = api.createAuthorityBoundaryRuntime(
      boundaryDependencies(fixture.issuer, events),
    );
    const planHandle = expectSuccess(
      runtime.plannerRegistry.registerPlan({
        subject,
        context_receipt: fixture.context_receipt,
        invocation_id: 'invocation-1',
      }),
    );
    const batch = (subject as { batch: unknown }).batch;
    return { api, batch, events, fixture, planHandle, runtime, subject };
  }

  it.each([
    [
      'missing allow',
      (resolutions: readonly unknown[]) => resolutions.slice(0, 1),
      'AUTHORITY_DECISION_RESOLUTION_MISSING',
    ],
    [
      'extra allow',
      (resolutions: readonly unknown[]) => resolutions,
      'AUTHORITY_DECISION_RESOLUTION_EXTRA',
    ],
    [
      'duplicate allow',
      (resolutions: readonly unknown[]) => [resolutions[0], resolutions[0]],
      'AUTHORITY_DECISION_RESOLUTION_DUPLICATE',
    ],
    [
      'structural allow clone',
      (resolutions: readonly unknown[]) => [{ ...(resolutions[0] as object) }, resolutions[1]],
      'AUTHORITY_DECISION_INPUT_INVALID',
    ],
    [
      'JSON allow clone',
      (resolutions: readonly unknown[]) => [
        JSON.parse(JSON.stringify(resolutions[0])),
        resolutions[1],
      ],
      'AUTHORITY_DECISION_INPUT_INVALID',
    ],
  ])('%s cannot issue a multi-target boundary receipt', async (_name, select, code) => {
    const targets = [
      fsTarget,
      secondFsTarget,
      {
        ...fsTarget,
        id: 'fs:packages/core/src/authority/principals.ts',
        canonical_relative_path: 'packages/core/src/authority/principals.ts',
      },
    ];
    const fixture = await authorizedBoundarySetFixture(targets);
    const events: string[] = [];
    const api = await boundaryApi();
    api.createAuthorityBoundaryRuntime(boundaryDependencies(fixture.issuer, events));
    const result = fixture.issuer.issueAllow({
      resolutions: select(fixture.resolutions),
      subject: exactSubject(targets.slice(0, 2), fixture.plant),
      context_receipt: fixture.context_receipt,
      invocation_id: 'invocation-1',
      boundary_adapter_id: 'fs-authority-boundary',
    });
    expectBoundaryFailure(result, 'refused', code);
    expect(result).not.toHaveProperty('receipt');
    expect(events).toEqual([]);
  });

  it('fabricated in-plan batch plus genuine issuer receipt has zero effect without membership', async () => {
    const { batch, events, fixture, planHandle, runtime, subject } = await boundedFixture();
    expectBoundaryFailure(
      runtime.prepare({
        target: fsTarget,
        subject,
        batch,
        context_receipt: fixture.context_receipt,
        decision_receipt: fixture.decision_receipt,
        plan_handle: planHandle,
        adapter_id: 'fs-authority-boundary',
      }),
      'refused',
      'AUTHORITY_BATCH_REGISTRY_MEMBERSHIP_REQUIRED',
    );
    expect(events).toEqual([]);
  });

  it('refuses an out-of-selector target at private batch registration', async () => {
    const { batch, events, planHandle, runtime, subject } = await boundedFixture();
    const outside = {
      ...fsTarget,
      id: 'fs:docs/README.md',
      canonical_relative_path: 'docs/README.md',
    };
    expectBoundaryFailure(
      runtime.plannerRegistry.registerBatch({
        plan_handle: planHandle,
        batch: { ...(batch as object), targets: [outside] },
        invocation_id: 'invocation-1',
        plan_digest_sha256: canonicalSha256((subject as { plan: unknown }).plan),
        target_digest_sha256: canonicalSha256([outside.id]),
        recovery: {
          applied_batch_ids: [],
          applied_target_count: 0,
          partial_effect_evidence_refs: [],
        },
      }),
      'refused',
      'AUTHORITY_BATCH_BINDING_MISMATCH',
    );
    expect(events).toEqual([]);
  });

  it('registered batch binds invocation, plan digest, ID, ordinal, target digest and recovery', async () => {
    const { batch, fixture, planHandle, runtime, subject } = await boundedFixture();
    const batchHandle = expectSuccess(
      runtime.plannerRegistry.registerBatch({
        plan_handle: planHandle,
        batch,
        invocation_id: 'invocation-1',
        plan_digest_sha256: canonicalSha256((subject as { plan: unknown }).plan),
        target_digest_sha256: canonicalSha256([fsTarget.id]),
        recovery: {
          applied_batch_ids: [],
          applied_target_count: 0,
          partial_effect_evidence_refs: [],
        },
      }),
    );
    expect(batchHandle).toMatchObject({
      invocation_id: 'invocation-1',
      plan_id: 'plan-bounded',
      batch_id: 'batch-1',
      ordinal: 1,
    });
    expect(fixture.decision_receipt).toBeDefined();
  });

  it('a registered batch prepares and applies at most once', async () => {
    const { batch, events, fixture, planHandle, runtime, subject } = await boundedFixture();
    const batchHandle = expectSuccess(
      runtime.plannerRegistry.registerBatch({
        plan_handle: planHandle,
        batch,
        invocation_id: 'invocation-1',
        plan_digest_sha256: canonicalSha256((subject as { plan: unknown }).plan),
        target_digest_sha256: canonicalSha256([fsTarget.id]),
        recovery: {
          applied_batch_ids: [],
          applied_target_count: 0,
          partial_effect_evidence_refs: [],
        },
      }),
    );
    const prepared = expectSuccess(
      runtime.prepare({
        target: fsTarget,
        subject,
        batch,
        batch_handle: batchHandle,
        context_receipt: fixture.context_receipt,
        decision_receipt: fixture.decision_receipt,
        plan_handle: planHandle,
        adapter_id: 'fs-authority-boundary',
      }),
    );
    expectSuccess(runtime.apply({ prepared }));
    expect(events).toEqual(['fs:write:packages/core/src/index.ts']);
    expectBoundaryFailure(
      runtime.apply({ prepared }),
      'refused',
      'AUTHORITY_PREPARED_MUTATION_REPLAYED',
    );
    expect(events).toHaveLength(1);
  });

  it.each([
    ['wrong order', { ordinal: 2 }, 'AUTHORITY_BATCH_ORDER_INVALID'],
    ['target drift', { target_digest_sha256: 'f'.repeat(64) }, 'AUTHORITY_BATCH_TARGET_DRIFT'],
    ['cross invocation', { invocation_id: 'invocation-other' }, 'AUTHORITY_BATCH_BINDING_MISMATCH'],
    [
      'stale recovery',
      { recovery: { applied_batch_ids: ['batch-0'], applied_target_count: 1 } },
      'AUTHORITY_BATCH_RECOVERY_STALE',
    ],
  ])('%s is refused before bounded side effects', async (_name, override, code) => {
    const { batch, events, fixture, planHandle, runtime, subject } = await boundedFixture();
    const result = runtime.plannerRegistry.registerBatch({
      plan_handle: planHandle,
      batch,
      invocation_id: 'invocation-1',
      plan_digest_sha256: canonicalSha256((subject as { plan: unknown }).plan),
      target_digest_sha256: canonicalSha256([fsTarget.id]),
      recovery: {
        applied_batch_ids: [],
        applied_target_count: 0,
        partial_effect_evidence_refs: [],
      },
      ...override,
    });
    expectBoundaryFailure(result, 'refused', code);
    expect(fixture.decision_receipt).toBeDefined();
    expect(events).toEqual([]);
  });

  it.each([
    [
      'max_total_targets',
      {
        applied_batch_ids: ['batch-0'],
        applied_target_count: 3,
        partial_effect_evidence_refs: ['evidence:batch-0'],
        recovery_checkpoint_ref: 'checkpoint:batch-0',
      },
    ],
    [
      'max_batches',
      {
        applied_batch_ids: ['batch-minus-1', 'batch-0'],
        applied_target_count: 2,
        partial_effect_evidence_refs: ['evidence:batch-minus-1', 'evidence:batch-0'],
        recovery_checkpoint_ref: 'checkpoint:batch-0',
      },
    ],
  ])(
    'cumulative %s overflow refuses and preserves the prior recovery record',
    async (_name, prior) => {
      const { batch, events, planHandle, runtime, subject } = await boundedFixture();
      expectBoundaryFailure(
        runtime.plannerRegistry.registerBatch({
          plan_handle: planHandle,
          batch,
          invocation_id: 'invocation-1',
          plan_digest_sha256: canonicalSha256((subject as { plan: unknown }).plan),
          target_digest_sha256: canonicalSha256([fsTarget.id]),
          recovery: prior,
        }),
        'refused',
        'AUTHORITY_BATCH_CUMULATIVE_LIMIT_EXCEEDED',
      );
      expect(expectSuccess(runtime.plannerRegistry.recovery({ plan_handle: planHandle }))).toEqual(
        prior,
      );
      expect(events).toEqual([]);
    },
  );
});

describe('R19 issuer disposal closes final-boundary authority', () => {
  it('invalidates outstanding receipt, context and later operations', async () => {
    const { fixture, events, runtime, planHandle } = await exactRuntime();
    expectSuccess(runtime.dispose());
    expectBoundaryFailure(
      runtime.prepare({
        target: fsTarget,
        subject: fixture.subject,
        context_receipt: fixture.context_receipt,
        decision_receipt: fixture.decision_receipt,
        plan_handle: planHandle,
        adapter_id: 'fs-authority-boundary',
      }),
      'refused',
      'AUTHORITY_DECISION_ISSUER_CLOSED',
    );
    expectBoundaryFailure(runtime.dispose(), 'refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
    expect(events).toEqual([]);
  });
});
