import * as policyResolver from '../../src/runtime/policy-resolver.js';
import { getValidator } from '@devai-nyx/schemas';
import { describe, expect, it } from 'vitest';
import { createAuthorityBoundaryRuntime } from '../../src/boundaries/boundary-runtime.js';
import { boundaryDependencies } from './authority-boundary-testkit.js';
import {
  CONSENT,
  actionDocument,
  createIssuer,
  declarationDependencies,
  makePolicyPlant,
  policyBindingFromPlant,
  runtimeApi,
  exactSubject,
  expectSuccess,
  canonicalSha256,
  type AuthorityDecisionIssuer,
} from './authority-runtime-testkit.js';
import { classifyAuthorityResource } from '../../src/boundaries/resource-classification.js';

const sha = 'a'.repeat(64);
const targets = [
  {
    kind: 'reconciliation-host',
    id: 'reconciliation-host:repository:worktree:provision',
    repository_id: 'repository',
    worktree_id: 'worktree',
    operation: 'provision',
    binding_sha256: sha,
    plan_sha256: sha,
  },
  {
    kind: 'proof-index',
    id: 'proof-index:repository:worktree:record/proofs/chain.json',
    repository_id: 'repository',
    worktree_id: 'worktree',
    operation: 'chain-cas',
    proof_path: 'record/proofs/chain.json',
    approval_id: sha,
    plan_sha256: sha,
    phase_sha256: sha,
    before_index_sha256: sha,
    other_entries_sha256: sha,
    verified_chain_sha256: sha,
  },
];

describe('explicit trusted typed boundary dependencies (not native host authority)', () => {
  it.each(targets)(
    'admits configured exact $kind and selects only its matching adapter',
    (target) => {
      const seen: unknown[] = [];
      const adapter = {
        admit: (value: unknown) => {
          seen.push(value);
          return true;
        },
        snapshot: () => ({ revision: 1 }),
        apply: () => ({ ok: true }),
      };
      const dependencies =
        target.kind === 'proof-index' ? { proof_index: adapter } : { reconciliation_host: adapter };
      expect(classifyAuthorityResource(target, dependencies)).toMatchObject({
        ok: true,
        value: { target, atomicity: 'whole-plan', adapter_id: `${target.kind}-authority-boundary` },
      });
      expect(seen).toEqual([target]);
    },
  );
  it.each(targets)('preserves unconfigured $kind refusal', (target) => {
    expect(classifyAuthorityResource(target)).toMatchObject({
      ok: false,
      category: 'usage-error',
      code: 'AUTHORITY_RESOURCE_TARGET_INVALID',
    });
  });
});

for (const target of targets) {
  const key = target.kind === 'proof-index' ? 'proof_index' : 'reconciliation_host';
  describe(`${target.kind} dependency admission`, () => {
    const invalid = [
      ['false', { admit: () => false, snapshot: () => ({}), apply: () => undefined }],
      ['nonboolean', { admit: () => 1, snapshot: () => ({}), apply: () => undefined }],
      [
        'throw',
        {
          admit: () => {
            throw new Error('/private/SECRET');
          },
          snapshot: () => ({}),
          apply: () => undefined,
        },
      ],
      ['missing admit', { snapshot: () => ({}), apply: () => undefined }],
      ['missing snapshot', { admit: () => true, apply: () => undefined }],
      ['missing apply', { admit: () => true, snapshot: () => ({}) }],
    ] as const;
    it.each(invalid)('refuses %s without exposing private adapter errors', (_name, adapter) => {
      let result: unknown;
      expect(() => {
        result = classifyAuthorityResource(target, { [key]: adapter });
      }).not.toThrow();
      expect(result).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).not.toContain('SECRET');
    });
    it('cannot borrow the other logical or ordinary adapter', () => {
      let effects = 0;
      const adapter = {
        admit: () => true,
        snapshot: () => ({}),
        apply: () => {
          effects++;
        },
      };
      const other = key === 'proof_index' ? 'reconciliation_host' : 'proof_index';
      expect(
        classifyAuthorityResource(target, {
          [other]: adapter,
          fs: adapter,
          git: adapter,
          remote: adapter,
        }),
      ).toMatchObject({ ok: false });
      expect(effects).toBe(0);
    });
    it.each(['proxy', 'kind-accessor', 'payload-accessor'])(
      'rejects target %s without executing traps',
      (form) => {
        let touches = 0;
        const trap = (): never => {
          touches++;
          throw new Error('untrusted target');
        };
        const value = { ...target };
        if (form === 'kind-accessor')
          Object.defineProperty(value, 'kind', { get: trap, enumerable: true });
        if (form === 'payload-accessor')
          Object.defineProperty(value, 'repository_id', { get: trap, enumerable: true });
        const input =
          form === 'proxy'
            ? new Proxy(value, {
                get: trap,
                ownKeys: trap,
                getPrototypeOf: trap,
                getOwnPropertyDescriptor: trap,
              })
            : value;
        let result: unknown;
        expect(() => {
          result = classifyAuthorityResource(input, {
            [key]: { admit: () => true, snapshot: () => ({}), apply: () => undefined },
          });
        }).not.toThrow();
        expect(result).toMatchObject({ ok: false });
        expect(touches).toBe(0);
      },
    );
  });
}

for (const target of targets) {
  it(`${target.kind} cannot enter a bounded batch using an invented selector`, () => {
    let consumes = 0;
    const store = {
      consume: () => {
        consumes++;
        throw new Error('must not consume');
      },
    };
    const adapter = {
      admit: () => true,
      snapshot: () => ({}),
      apply: () => {
        throw new Error('must not apply');
      },
      applyAtomic: () => {
        throw new Error('must not apply atomic');
      },
    };
    const runtime = createAuthorityBoundaryRuntime(
      boundaryDependencies(store as unknown as AuthorityDecisionIssuer, [], {
        reconciliation_host: adapter,
        proof_index: adapter,
      }),
    );
    const original = exactSubject([target]) as { plan: Record<string, unknown> };
    const plan = {
      ...original.plan,
      strategy: 'bounded-batches',
      selectors: [{ ...target, operations: [target.operation] }],
      bounds: { max_batches: 1, max_targets_per_batch: 1, max_total_targets: 1 },
      batch_atomicity: 'each-batch',
      recovery: 'preserve-and-report',
    };
    const subject = { plan };
    const handle = expectSuccess(
      runtime.plannerRegistry.registerPlan({ subject, invocation_id: 'invocation-1' }),
    );
    const batch = {
      batch_id: 'batch-1',
      plan_id: original.plan.plan_id,
      ordinal: 1,
      targets: [target],
      atomicity: 'whole-batch',
    };
    expect(
      runtime.plannerRegistry.registerBatch({
        plan_handle: handle,
        batch,
        invocation_id: 'invocation-1',
        plan_digest_sha256: canonicalSha256(plan),
        target_digest_sha256: canonicalSha256([target.id]),
        recovery: {
          applied_batch_ids: [],
          applied_target_count: 0,
          partial_effect_evidence_refs: [],
        },
      }),
    ).toMatchObject({ ok: false });
    expect(consumes).toBe(0);
  });
  it(`${target.kind} cannot enter generic atomic execution with applyAtomic`, () => {
    let consumes = 0;
    let effects = 0;
    const store = {
      consume: () => {
        consumes++;
        return { ok: true, value: true };
      },
    };
    const adapter = {
      admit: () => true,
      snapshot: () => ({}),
      apply: () => {
        effects++;
      },
      applyAtomic: () => {
        effects++;
      },
    };
    const runtime = createAuthorityBoundaryRuntime(
      boundaryDependencies(store as unknown as AuthorityDecisionIssuer, [], {
        reconciliation_host: adapter,
        proof_index: adapter,
      }),
    );
    const subject = exactSubject([target]);
    const handle = expectSuccess(
      runtime.plannerRegistry.registerPlan({ subject, invocation_id: 'invocation-1' }),
    );
    expect(
      runtime.prepareUnit({
        subject,
        plan_handle: handle,
        targets: [target],
        adapter_id: `${target.kind}-authority-boundary`,
        decision_receipt: {},
      }),
    ).toMatchObject({ ok: false });
    expect(runtime.applyUnit({ prepared: {} })).toMatchObject({ ok: false });
    expect(consumes).toBe(0);
    expect(effects).toBe(0);
  });
}

// Uses the actual declaration, policy resolution and issuer. The deterministic
// logical adapters below prove dispatch custody only, never native host effects.
async function issued(target: Record<string, unknown>) {
  const api = await runtimeApi();
  const issuer = createIssuer(api);
  const rule = {
    rule_id: 'typed-fixture',
    origin: 'additive-extension',
    precedence: 500,
    action_ids: ['test mutate'],
    selector: {
      kind: target.kind,
      repository_id: target.repository_id,
      operations: [target.operation],
    },
    effect: 'allow',
    subjects: [{ kind: 'human', roles: ['engineer'] }],
    required_consent: CONSENT,
    constitutional_anchors: [6],
    rationale: 'Disposable boundary fixture only.',
  };
  const plant = makePolicyPlant({ additiveRules: [rule] });
  const context = expectSuccess<{ context_receipt: unknown }>(
    api.resolveAuthorityDeclaration(
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-1',
        dry_run: false,
        declaration: { as_role: 'engineer' },
        consent: CONSENT,
      },
      declarationDependencies(issuer, actionDocument(), undefined, policyBindingFromPlant(plant)),
    ),
  );
  expect(getValidator('authority-policy.schema.json')(plant.document)).toBe(true);
  const policy = expectSuccess(api.loadAuthorityPolicy({ document: plant.document }, plant.deps));
  const resolution = api.resolveAuthorityPolicy(
    policy,
    {
      action_id: 'test mutate',
      context_receipt: context.context_receipt,
      consent: CONSENT,
      resource: target,
      operation: target.operation,
    },
    { receiptStore: issuer, canonicalSha256 },
  );
  expect(resolution).toMatchObject({ outcome: 'allow' });
  const subject = exactSubject([target], plant);
  const decision = issuer.issueAllow({
    resolutions: [resolution],
    subject,
    context_receipt: context.context_receipt,
    invocation_id: 'invocation-1',
    boundary_adapter_id: `${String(target.kind)}-authority-boundary`,
  }) as { issued: boolean; receipt: unknown };
  expect(decision.issued).toBe(true);
  return { issuer, subject, receipt: decision.receipt };
}
async function runtimeFixture(
  target: Record<string, unknown>,
  adapterOverrides: Record<string, unknown> = {},
) {
  const grant = await issued(target);
  const effects: unknown[] = [];
  const foreign: string[] = [];
  const state = { admitted: true, snapshot: { revision: 1 }, result: { ok: true } as unknown };
  const adapter = {
    admit: () => state.admitted,
    snapshot: () => state.snapshot,
    apply: (value: unknown) => {
      effects.push(value);
      return state.result;
    },
    ...adapterOverrides,
  };
  const key = target.kind === 'proof-index' ? 'proof_index' : 'reconciliation_host';
  const otherKey = key === 'proof_index' ? 'reconciliation_host' : 'proof_index';
  const dependencies = boundaryDependencies(grant.issuer, foreign, {
    [key]: adapter,
    [otherKey]: {
      admit: () => true,
      snapshot: () => ({}),
      apply: () => {
        foreign.push('foreign-logical');
      },
    },
  });
  const runtime = createAuthorityBoundaryRuntime(dependencies);
  const planHandle = expectSuccess(
    runtime.plannerRegistry.registerPlan({ subject: grant.subject, invocation_id: 'invocation-1' }),
  );
  const input = {
    plan_handle: planHandle,
    subject: grant.subject,
    target,
    decision_receipt: grant.receipt,
    adapter_id: `${String(target.kind)}-authority-boundary`,
  };
  return { runtime, effects, foreign, state, input, grant, dependencies };
}
for (const prototype of targets) {
  describe(`${prototype.kind} authentic policy/issuer boundary dispatch`, () => {
    it('consumes a real receipt, dispatches unchanged exact target once and refuses replay', async () => {
      const target = { ...prototype };
      const f = await runtimeFixture(target);
      const prepared = expectSuccess(f.runtime.prepare(f.input));
      expect(f.runtime.apply({ prepared })).toMatchObject({ ok: true, value: { applied: true } });
      expect(f.effects).toEqual([target]);
      expect(f.effects[0]).toBe(target);
      expect(f.foreign).toEqual([]);
      expect(f.runtime.apply({ prepared })).toMatchObject({
        ok: false,
        code: 'AUTHORITY_PREPARED_MUTATION_REPLAYED',
      });
      expect(f.runtime.prepare(f.input)).toMatchObject({ ok: false });
      expect(f.effects).toHaveLength(1);
    });
    it.each(['replacement', 'same-reference'])(
      'refuses snapshot %s drift with no retry grant',
      async (form) => {
        const f = await runtimeFixture({ ...prototype });
        const prepared = expectSuccess(f.runtime.prepare(f.input));
        if (form === 'replacement') f.state.snapshot = { revision: 2 };
        else f.state.snapshot.revision = 2;
        expect(f.runtime.apply({ prepared })).toMatchObject({
          ok: false,
          code: 'AUTHORITY_RESOURCE_CHANGED_AFTER_PREPARE',
        });
        expect(f.runtime.apply({ prepared })).toMatchObject({
          ok: false,
          code: 'AUTHORITY_PREPARED_MUTATION_REPLAYED',
        });
        expect(f.effects).toEqual([]);
      },
    );
    it('fresh admission loss refuses and burns the prepared handle', async () => {
      const f = await runtimeFixture({ ...prototype });
      const prepared = expectSuccess(f.runtime.prepare(f.input));
      f.state.admitted = false;
      expect(f.runtime.apply({ prepared })).toMatchObject({ ok: false });
      f.state.admitted = true;
      expect(f.runtime.apply({ prepared })).toMatchObject({
        ok: false,
        code: 'AUTHORITY_PREPARED_MUTATION_REPLAYED',
      });
      expect(f.effects).toEqual([]);
    });
    it('propagates explicit adapter failure without applied success', async () => {
      const f = await runtimeFixture({ ...prototype });
      const prepared = expectSuccess(f.runtime.prepare(f.input));
      f.state.result = {
        ok: false,
        category: 'refused',
        code: 'FIXTURE_EFFECT_REFUSED',
        reasons: ['fixture'],
      };
      expect(f.runtime.apply({ prepared })).toEqual(f.state.result);
      expect(f.effects).toHaveLength(1);
    });
    it.each([undefined, null, [], { bad: undefined }, { bad: 1n }, new Proxy({}, {})])(
      'refuses malformed snapshot %# before consuming receipt',
      async (snapshot) => {
        const f = await runtimeFixture({ ...prototype }, { snapshot: () => snapshot });
        expect(f.runtime.prepare(f.input)).toMatchObject({
          ok: false,
          code: 'AUTHORITY_TYPED_RESOURCE_SNAPSHOT_INVALID',
        });
        expect(f.effects).toEqual([]);
      },
    );
    it('rejects cloned handles and freezes the genuine exact target', async () => {
      const target = { ...prototype };
      const f = await runtimeFixture(target);
      expect(f.runtime.prepare({ ...f.input, plan_handle: {} })).toMatchObject({ ok: false });
      const prepared = expectSuccess(f.runtime.prepare(f.input));
      expect(f.runtime.apply({ prepared: {} })).toMatchObject({
        ok: false,
        code: 'AUTHORITY_PREPARED_MUTATION_UNKNOWN',
      });
      expect(Object.isFrozen(target)).toBe(true);
      const before = structuredClone(target);
      expect(() => {
        target.plan_sha256 = 'b'.repeat(64);
      }).toThrow(TypeError);
      expect(target).toEqual(before);
      expect(f.effects).toEqual([]);
      expect(f.runtime.apply({ prepared })).toMatchObject({ ok: true });
      expect(f.effects).toEqual([target]);
    });
  });
}

for (const target of targets) {
  describe(`${target.kind} canonical policy schema vocabulary`, () => {
    const base = {
      kind: target.kind,
      repository_id: target.repository_id,
      operations: [target.operation],
    };
    const selectors = [
      ['valid', base, true],
      ['wildcard repository', { ...base, repository_id: '*' }, false],
      ['trailing newline repository', { ...base, repository_id: 'repository\n' }, false],
      ['trailing carriage-return repository', { ...base, repository_id: 'repository\r' }, false],
      ['path repository', { ...base, repository_id: '../repository' }, false],
      ['unicode repository', { ...base, repository_id: 'répo' }, false],
      ['too long repository', { ...base, repository_id: 'x'.repeat(129) }, false],
      ['empty operations', { ...base, operations: [] }, false],
      [
        'duplicate operations',
        { ...base, operations: [target.operation, target.operation] },
        false,
      ],
      ['wildcard operation', { ...base, operations: ['*'] }, false],
      [
        'foreign operation',
        { ...base, operations: [target.kind === 'proof-index' ? 'provision' : 'chain-cas'] },
        false,
      ],
      ['extra key', { ...base, worktree_id: 'worktree' }, false],
    ] as const;
    it.each(selectors)('%s selector validates exactly as declared', (_name, selector, valid) => {
      const rule = {
        rule_id: 'schema-fixture',
        origin: 'additive-extension',
        precedence: 500,
        action_ids: ['test mutate'],
        selector,
        effect: 'allow',
        subjects: [{ kind: 'human', roles: ['engineer'] }],
        required_consent: CONSENT,
        constitutional_anchors: [6],
        rationale: 'Fixture only.',
      };
      expect(
        getValidator('authority-policy.schema.json')(
          makePolicyPlant({ additiveRules: [rule] }).document,
        ),
      ).toBe(valid);
    });
  });
}

for (const target of targets) {
  describe(`${target.kind} policy-only matching never authorizes batches`, () => {
    it('requires exact kind/repository/finite operation while batch matching remains false', () => {
      const matcher = (
        policyResolver as unknown as {
          policySelectorMatches: (
            selector: unknown,
            resource: unknown,
            classifyOnly?: boolean,
          ) => boolean;
        }
      ).policySelectorMatches;
      expect(typeof matcher).toBe('function');
      const selector = {
        kind: target.kind,
        repository_id: target.repository_id,
        operations: [target.operation],
      };
      expect(matcher(selector, target)).toBe(true);
      expect(matcher(selector, target, true)).toBe(true);
      expect(matcher({ ...selector, repository_id: 'foreign' }, target)).toBe(false);
      expect(
        matcher(
          {
            ...selector,
            kind: target.kind === 'proof-index' ? 'reconciliation-host' : 'proof-index',
          },
          target,
        ),
      ).toBe(false);
      expect(matcher({ ...selector, operations: ['*'] }, target)).toBe(false);
      expect(policyResolver.selectorMatches(selector, target)).toBe(false);
      expect(policyResolver.selectorMatches(selector, target, true)).toBe(false);
    });
    it.each(['proxy', 'accessor', 'sparse', 'operations-proxy', 'extra'])(
      'refuses %s selector without traps',
      (form) => {
        const matcher = (
          policyResolver as unknown as {
            policySelectorMatches: (selector: unknown, resource: unknown) => boolean;
          }
        ).policySelectorMatches;
        expect(typeof matcher).toBe('function');
        let touches = 0;
        const trap = (): never => {
          touches++;
          throw new Error('untrusted selector');
        };
        const selector: Record<string, unknown> = {
          kind: target.kind,
          repository_id: target.repository_id,
          operations: [target.operation],
        };
        if (form === 'accessor')
          Object.defineProperty(selector, 'repository_id', { enumerable: true, get: trap });
        if (form === 'sparse') selector.operations = new Array(1);
        if (form === 'operations-proxy')
          selector.operations = new Proxy([target.operation], {
            get: trap,
            ownKeys: trap,
            getPrototypeOf: trap,
            getOwnPropertyDescriptor: trap,
          });
        if (form === 'extra') selector.worktree_id = 'worktree';
        const input =
          form === 'proxy'
            ? new Proxy(selector, {
                get: trap,
                ownKeys: trap,
                getPrototypeOf: trap,
                getOwnPropertyDescriptor: trap,
              })
            : selector;
        expect(matcher(input, target)).toBe(false);
        expect(touches).toBe(0);
      },
    );
  });
}

for (const target of targets) {
  it(`${target.kind} validates snapshots before consuming the genuine receipt`, async () => {
    let snapshot: unknown = null;
    const f = await runtimeFixture({ ...target }, { snapshot: () => snapshot });
    expect(f.runtime.prepare(f.input)).toMatchObject({
      ok: false,
      code: 'AUTHORITY_TYPED_RESOURCE_SNAPSHOT_INVALID',
    });
    snapshot = { revision: 1 };
    const prepared = expectSuccess(f.runtime.prepare(f.input));
    expect(f.runtime.apply({ prepared })).toMatchObject({ ok: true });
    expect(f.effects).toHaveLength(1);
  });
  it(`${target.kind} sanitizes thrown snapshot diagnostics and preserves unused receipt`, async () => {
    let throwing = true;
    const f = await runtimeFixture(
      { ...target },
      {
        snapshot: () => {
          if (throwing) throw new Error('/private/SECRET/key');
          return { revision: 1 };
        },
      },
    );
    let result: unknown;
    expect(() => {
      result = f.runtime.prepare(f.input);
    }).not.toThrow();
    expect(result).toMatchObject({ ok: false, code: 'AUTHORITY_TYPED_RESOURCE_SNAPSHOT_INVALID' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    throwing = false;
    const prepared = expectSuccess(f.runtime.prepare(f.input));
    expect(f.runtime.apply({ prepared })).toMatchObject({ ok: true });
  });
  it(`${target.kind} rejects foreign, cloned and mismatched receipt/subject/adapter before effects`, async () => {
    const f = await runtimeFixture({ ...target });
    const foreign = await issued({ ...target });
    for (const change of [
      { decision_receipt: {} },
      { decision_receipt: foreign.receipt },
      {
        adapter_id:
          target.kind === 'proof-index'
            ? 'reconciliation-host-authority-boundary'
            : 'proof-index-authority-boundary',
      },
      { target: { ...target, plan_sha256: 'f'.repeat(64) } },
      { subject: exactSubject([{ ...target, plan_sha256: 'f'.repeat(64) }]) },
    ])
      expect(f.runtime.prepare({ ...f.input, ...change })).toMatchObject({ ok: false });
    const prepared = expectSuccess(f.runtime.prepare(f.input));
    const other = await runtimeFixture({ ...target });
    expect(other.runtime.apply({ prepared })).toMatchObject({
      ok: false,
      code: 'AUTHORITY_PREPARED_MUTATION_UNKNOWN',
    });
    expect(f.effects).toEqual([]);
    expect(other.effects).toEqual([]);
    expect(f.runtime.apply({ prepared })).toMatchObject({ ok: true });
  });
}

for (const target of targets) {
  it.each(['accessor', 'nested-proxy', 'cycle', 'infinity', 'sparse', 'prototype'])(
    `${target.kind} rejects snapshot %s without executing hooks`,
    async (form) => {
      let touches = 0;
      const trap = (): never => {
        touches++;
        throw new Error('/private/SECRET/snapshot');
      };
      const value: Record<string, unknown> = {};
      if (form === 'accessor')
        Object.defineProperty(value, 'revision', { enumerable: true, get: trap });
      if (form === 'nested-proxy')
        value.nested = new Proxy(
          {},
          { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap },
        );
      if (form === 'cycle') value.self = value;
      if (form === 'infinity') value.revision = Infinity;
      if (form === 'sparse') value.revision = new Array(1);
      const snapshot = form === 'prototype' ? (Object.create({ revision: 1 }) as unknown) : value;
      const f = await runtimeFixture({ ...target }, { snapshot: () => snapshot });
      let result: unknown;
      expect(() => {
        result = f.runtime.prepare(f.input);
      }).not.toThrow();
      expect(result).toMatchObject({
        ok: false,
        code: 'AUTHORITY_TYPED_RESOURCE_SNAPSHOT_INVALID',
      });
      expect(JSON.stringify(result)).not.toContain('SECRET');
      expect(touches).toBe(0);
      expect(f.effects).toEqual([]);
    },
  );
}

for (const target of targets) {
  it(`${target.kind} rechecks admission after apply-time snapshot callback before effect`, async () => {
    let admitted = true;
    let snapshots = 0;
    const f = await runtimeFixture(
      { ...target },
      {
        admit: () => admitted,
        snapshot: () => {
          snapshots++;
          if (snapshots >= 2) admitted = false;
          return { revision: 1 };
        },
      },
    );
    const prepared = expectSuccess(f.runtime.prepare(f.input));
    expect(f.runtime.apply({ prepared })).toMatchObject({
      ok: false,
      code: 'AUTHORITY_TYPED_RESOURCE_ADAPTER_REQUIRED',
    });
    expect(f.effects).toEqual([]);
    admitted = true;
    expect(f.runtime.apply({ prepared })).toMatchObject({
      ok: false,
      code: 'AUTHORITY_PREPARED_MUTATION_REPLAYED',
    });
  });
  it(`${target.kind} refuses noncanonical lone-surrogate snapshot keys`, async () => {
    const f = await runtimeFixture({ ...target }, { snapshot: () => ({ ['\uD800']: 1 }) });
    expect(f.runtime.prepare(f.input)).toMatchObject({
      ok: false,
      code: 'AUTHORITY_TYPED_RESOURCE_SNAPSHOT_INVALID',
    });
    expect(f.effects).toEqual([]);
  });
}

for (const target of targets) {
  const key = target.kind === 'proof-index' ? 'proof_index' : 'reconciliation_host';
  it(`${target.kind} direct classification refuses dependency getter without executing it`, () => {
    let touches = 0;
    const dependencies = {};
    Object.defineProperty(dependencies, key, {
      enumerable: true,
      get: () => {
        touches++;
        throw new Error('/private/SECRET/dependency');
      },
    });
    let result: unknown;
    expect(() => {
      result = classifyAuthorityResource(target, dependencies);
    }).not.toThrow();
    expect(result).toMatchObject({ ok: false, code: 'AUTHORITY_TYPED_RESOURCE_ADAPTER_REQUIRED' });
    expect(touches).toBe(0);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it.each(['prepare', 'apply'])(
    `${target.kind} refuses %s dependency getter with genuine issuer custody and zero getter touches`,
    async (stage) => {
      const f = await runtimeFixture({ ...target });
      const prepared = stage === 'apply' ? expectSuccess(f.runtime.prepare(f.input)) : undefined;
      let touches = 0;
      Object.defineProperty(f.dependencies, key, {
        enumerable: true,
        get: () => {
          touches++;
          throw new Error('/private/SECRET/dependency');
        },
      });
      let result: unknown;
      expect(() => {
        result = stage === 'apply' ? f.runtime.apply({ prepared }) : f.runtime.prepare(f.input);
      }).not.toThrow();
      expect(result).toMatchObject({
        ok: false,
        code: 'AUTHORITY_TYPED_RESOURCE_ADAPTER_REQUIRED',
      });
      expect(touches).toBe(0);
      expect(JSON.stringify(result)).not.toContain('SECRET');
      expect(f.effects).toEqual([]);
    },
  );
}

for (const target of targets) {
  const key = target.kind === 'proof-index' ? 'proof_index' : 'reconciliation_host';
  it(`${target.kind} refuses revoked target without header traps`, () => {
    let touches = 0;
    const trap = (): never => {
      touches++;
      throw new Error('revoked target trap');
    };
    const value = Proxy.revocable(
      { ...target },
      { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap },
    );
    value.revoke();
    let result: unknown;
    expect(() => {
      result = classifyAuthorityResource(value.proxy);
    }).not.toThrow();
    expect(result).toMatchObject({ ok: false, code: 'AUTHORITY_RESOURCE_TARGET_INVALID' });
    expect(touches).toBe(0);
  });
  it.each(['resource', 'selector'])(
    `${target.kind} policy refuses revoked %s without traps`,
    (form) => {
      const matcher = (
        policyResolver as unknown as {
          policySelectorMatches: (selector: unknown, resource: unknown) => boolean;
        }
      ).policySelectorMatches;
      let touches = 0;
      const trap = (): never => {
        touches++;
        throw new Error('revoked policy trap');
      };
      const selector = {
        kind: target.kind,
        repository_id: target.repository_id,
        operations: [target.operation],
      };
      const value = Proxy.revocable(form === 'resource' ? { ...target } : selector, {
        get: trap,
        ownKeys: trap,
        getPrototypeOf: trap,
        getOwnPropertyDescriptor: trap,
      });
      value.revoke();
      let result: unknown;
      expect(() => {
        result = matcher(
          form === 'selector' ? value.proxy : selector,
          form === 'resource' ? value.proxy : target,
        );
      }).not.toThrow();
      expect(result).toBe(false);
      expect(touches).toBe(0);
    },
  );
  it.each(['classify', 'prepare', 'apply'])(
    `${target.kind} refuses revoked adapter at %s without traps`,
    async (stage) => {
      let touches = 0;
      const trap = (): never => {
        touches++;
        throw new Error('revoked adapter trap');
      };
      const value = Proxy.revocable(
        {},
        { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap },
      );
      value.revoke();
      let result: unknown;
      if (stage === 'classify') {
        expect(() => {
          result = classifyAuthorityResource(target, { [key]: value.proxy });
        }).not.toThrow();
      } else {
        const f = await runtimeFixture({ ...target });
        const prepared = stage === 'apply' ? expectSuccess(f.runtime.prepare(f.input)) : undefined;
        Object.defineProperty(f.dependencies, key, { value: value.proxy, enumerable: true });
        expect(() => {
          result = stage === 'apply' ? f.runtime.apply({ prepared }) : f.runtime.prepare(f.input);
        }).not.toThrow();
        expect(f.effects).toEqual([]);
      }
      expect(result).toMatchObject({
        ok: false,
        code: 'AUTHORITY_TYPED_RESOURCE_ADAPTER_REQUIRED',
      });
      expect(touches).toBe(0);
    },
  );
}

for (const target of targets) {
  it(`${target.kind} policy refuses revoked operations array without traps`, () => {
    const matcher = (
      policyResolver as unknown as {
        policySelectorMatches: (selector: unknown, resource: unknown) => boolean;
      }
    ).policySelectorMatches;
    let touches = 0;
    const trap = (): never => {
      touches++;
      throw new Error('revoked operations trap');
    };
    const value = Proxy.revocable([target.operation], {
      get: trap,
      ownKeys: trap,
      getPrototypeOf: trap,
      getOwnPropertyDescriptor: trap,
    });
    value.revoke();
    let result: unknown;
    expect(() => {
      result = matcher(
        { kind: target.kind, repository_id: target.repository_id, operations: value.proxy },
        target,
      );
    }).not.toThrow();
    expect(result).toBe(false);
    expect(touches).toBe(0);
  });
}
