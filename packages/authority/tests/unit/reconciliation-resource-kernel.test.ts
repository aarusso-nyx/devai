import { describe, expect, it } from 'vitest';
import { malformedPlan } from '../../src/decision-plan.js';
import { resourceValid, selectorMatches } from '../../src/runtime/policy-resolver.js';
import { classifyAuthorityResource } from '../../src/boundaries/resource-classification.js';
import type { MutationBatch, MutationPlan } from '../../src/types.js';
import { exactSubject } from './authority-runtime-testkit.js';

type RecordData = Record<string, unknown>;
const digest = 'a'.repeat(64);
function proof(worktree = 'worktree'): RecordData {
  return {
    kind: 'proof-index',
    id: `proof-index:repository:${worktree}:record/proofs/chain.json`,
    repository_id: 'repository',
    worktree_id: worktree,
    operation: 'chain-cas',
    proof_path: 'record/proofs/chain.json',
    approval_id: digest,
    plan_sha256: digest,
    phase_sha256: digest,
    before_index_sha256: digest,
    other_entries_sha256: digest,
    verified_chain_sha256: digest,
  };
}
function host(operation = 'provision', phase = '01', worktree = 'worktree'): RecordData {
  const suffix =
    operation === 'provision'
      ? ''
      : `:${digest}${operation === 'consume-phase' ? `:${phase}` : ''}`;
  return {
    kind: 'reconciliation-host',
    id: `reconciliation-host:repository:${worktree}:${operation}${suffix}`,
    repository_id: 'repository',
    worktree_id: worktree,
    operation,
    binding_sha256: digest,
    plan_sha256: digest,
    ...(operation === 'provision' ? {} : { approval_id: digest }),
    ...(operation === 'consume-phase' ? { phase } : {}),
  };
}
function exact(targets: readonly unknown[]): MutationPlan {
  return (exactSubject(targets) as { plan: MutationPlan }).plan;
}
const targets = [
  proof(),
  host(),
  ...['approve', 'renew', 'revoke', 'recover-owned-lease'].map((op) => host(op)),
  ...['01', '02', '03', '04'].map((phase) => host('consume-phase', phase)),
];
const selectors: RecordData[] = [
  {
    kind: 'fs',
    repository_id: 'repository',
    canonical_relative_path_glob: '**',
    operations: ['chain-cas', 'provision'],
  },
  {
    kind: 'git-ref',
    repository_id: 'repository',
    ref_glob: '**',
    operations: ['chain-cas', 'provision'],
  },
  {
    kind: 'db',
    connection_id: 'repository',
    database_id_glob: '**',
    object_id_glob: '**',
    operations: ['chain-cas', 'provision'],
  },
  {
    kind: 'remote',
    system_id: 'repository',
    endpoint_ids: ['worktree'],
    operation_ids: ['chain-cas', 'provision'],
    publication: true,
  },
];
function bounded(target: RecordData, selector: RecordData): string[] {
  const plan = {
    ...exact([]),
    strategy: 'bounded-batches',
    selectors: [selector],
    bounds: { max_batches: 1, max_targets_per_batch: 1, max_total_targets: 1 },
    batch_atomicity: 'each-batch',
    recovery: 'preserve-and-report',
  } as unknown as MutationPlan;
  const batch = {
    batch_id: 'batch',
    plan_id: plan.plan_id,
    ordinal: 1,
    targets: [target],
    atomicity: 'whole-batch',
  } as unknown as MutationBatch;
  return malformedPlan(plan, batch);
}

describe('reconciliation typed data kernel, without effect authority', () => {
  it.each(targets.map((target, index) => [index, target] as const))(
    'admits exact closed shape %s only as data',
    (_index, target) => {
      const before = structuredClone(target);
      expect(malformedPlan(exact([target]), undefined)).toEqual([]);
      expect(resourceValid(target)).toBe(true);
      expect(target).toEqual(before);
    },
  );
  const invalid: [string, RecordData][] = [];
  for (const target of [proof(), host()]) {
    for (const [key, value] of Object.entries({
      id: undefined,
      repository_id: '../repository',
      worktree_id: 'worktree\n',
      operation: 'write',
      plan_sha256: 'A'.repeat(64),
      physical_path: '/tmp/index',
      unknown: true,
    })) {
      invalid.push([`${String(target.kind)} ${key}`, { ...target, [key]: value }]);
    }
  }
  invalid.push(
    ['wrong proof path', { ...proof(), proof_path: '.git/index' }],
    ['host phase forbidden', { ...host(), phase: '01' }],
    ['host approval forbidden', { ...host(), approval_id: digest }],
    ['missing consume phase', { ...host('consume-phase'), phase: undefined }],
    ['bad host binding', { ...host(), binding_sha256: 'x' }],
  );
  it.each(invalid)('rejects %s without exception or mutation', (_name, target) => {
    const before = structuredClone(target);
    let errors: string[] = [];
    expect(() => {
      errors = malformedPlan(exact([target]), undefined);
    }).not.toThrow();
    expect(errors.length).toBeGreaterThan(0);
    expect(malformedPlan(exact([target]), undefined)).toEqual(errors);
    expect(resourceValid(target)).toBe(false);
    expect(target).toEqual(before);
  });
  for (const target of [proof(), host()]) {
    for (const api of ['exact-plan', 'query-input'] as const) {
      it(`refuses ${String(target.kind)} accessor id at ${api} without executing it`, () => {
        let calls = 0;
        const malformed = { ...target };
        Object.defineProperty(malformed, 'id', {
          enumerable: true,
          get() {
            calls++;
            throw new Error('untrusted id getter');
          },
        });
        if (api === 'exact-plan') {
          expect(() => {
            expect(malformedPlan(exact([malformed]), undefined).length).toBeGreaterThan(0);
          }).not.toThrow();
        } else {
          expect(() => {
            expect(resourceValid(malformed)).toBe(false);
          }).not.toThrow();
        }
        expect(calls).toBe(0);
      });
    }
  }
  for (const target of [proof(), host()]) {
    for (const form of ['kind-accessor', 'proxy'] as const) {
      for (const api of ['exact-plan', 'query-input'] as const) {
        it(`refuses ${String(target.kind)} ${form} at ${api} without executing header traps`, () => {
          let calls = 0;
          const trap = (): never => {
            calls++;
            throw new Error('untrusted header');
          };
          const malformed = { ...target };
          if (form === 'kind-accessor') {
            Object.defineProperty(malformed, 'kind', { enumerable: true, get: trap });
          }
          const input =
            form === 'proxy'
              ? new Proxy(malformed, {
                  get: trap,
                  ownKeys: trap,
                  getPrototypeOf: trap,
                  getOwnPropertyDescriptor: trap,
                })
              : malformed;
          if (api === 'exact-plan') {
            expect(() => {
              expect(malformedPlan(exact([input]), undefined).length).toBeGreaterThan(0);
            }).not.toThrow();
          } else {
            expect(() => {
              expect(resourceValid(input)).toBe(false);
            }).not.toThrow();
          }
          expect(calls).toBe(0);
        });
      }
    }
  }
  it('refuses a malformed id without calling its methods', () => {
    let calls = 0;
    const target = {
      ...proof(),
      id: {
        trim() {
          calls++;
          throw new Error('untrusted trim');
        },
      },
    };
    expect(() => malformedPlan(exact([target]), undefined)).not.toThrow();
    expect(calls).toBe(0);
    expect(resourceValid(target)).toBe(false);
  });
  it('refuses an own payload accessor without executing it', () => {
    let calls = 0;
    const target = proof();
    Object.defineProperty(target, 'repository_id', {
      enumerable: true,
      get() {
        calls++;
        throw new Error('untrusted getter');
      },
    });
    expect(() => {
      expect(malformedPlan(exact([target]), undefined).length).toBeGreaterThan(0);
    }).not.toThrow();
    expect(resourceValid(target)).toBe(false);
    expect(calls).toBe(0);
  });
  it('keeps proof identity independent of approval and digest witnesses', () => {
    const changed = {
      ...proof(),
      approval_id: 'b'.repeat(64),
      verified_chain_sha256: 'c'.repeat(64),
    };
    expect(malformedPlan(exact([proof(), changed]), undefined)).toContain(
      'resource target identities must be unique',
    );
  });
  it('keeps host identity independent of binding and plan witnesses', () => {
    expect(
      malformedPlan(
        exact([host(), { ...host(), binding_sha256: 'b'.repeat(64), plan_sha256: 'c'.repeat(64) }]),
        undefined,
      ),
    ).toContain('resource target identities must be unique');
  });
  it('distinguishes worktrees, host operations, approvals, and consume phases', () => {
    const approval = 'b'.repeat(64);
    const otherApproval = {
      ...host('approve'),
      approval_id: approval,
      id: `reconciliation-host:repository:worktree:approve:${approval}`,
    };
    expect(
      malformedPlan(
        exact([...targets, proof('second'), host('provision', '01', 'second'), otherApproval]),
        undefined,
      ),
    ).toEqual([]);
  });
  it.each([proof(), host()])('refuses all bounded and policy selectors for $kind', (target) => {
    for (const selector of [...selectors, { ...target, operations: [target.operation] }]) {
      expect(bounded(target, selector)).toContain(
        `batch target '${String(target.id)}' is outside the pre-authorized selectors`,
      );
      expect(selectorMatches(selector, target)).toBe(false);
      expect(selectorMatches(selector, target, true)).toBe(false);
    }
  });
  it.each(targets.map((target, index) => [index, target] as const))(
    'retains actual classifier refusal for shape %s',
    (_index, target) => {
      expect(classifyAuthorityResource(target)).toMatchObject({
        ok: false,
        category: 'usage-error',
        code: 'AUTHORITY_RESOURCE_TARGET_INVALID',
      });
      expect(classifyAuthorityResource(target)).not.toHaveProperty('applied', true);
    },
  );
});
