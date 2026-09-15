import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const { inspectMutationInputPlan, assertMutationContractBindings } = await import(
  pathToFileURL(resolve('scripts/process/mutation-evidence-bindings.mjs')).href
);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const limits = {
    break: 60,
    high: 60,
    low: 60,
    scoreMin: 60,
    survivedMax: Number.MAX_SAFE_INTEGER,
  };
  const plan = {
    repository: { id: 'aarusso-nyx/devai', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    release_unit: '@aarusso-nyx/devai',
    mutation_policy_digest: 'c'.repeat(64),
    release_plan_receipt_digest: 'd'.repeat(64),
    release_profile_digest: 'e'.repeat(64),
    packages: [
      'authority',
      'cli',
      'effects-check',
      'evidence',
      'loop',
      'schemas',
      'sensors',
      'skills',
      'spec',
      'utils',
    ].map((id, index) => {
      const packageName = id === 'cli' ? '@aarusso-nyx/devai' : `@devai-nyx/${id}`;
      const workspace = `packages/${id}`;
      return {
        id,
        input_digest: sha(Buffer.from(String(index))),
        expected: {
          packageName,
          workspace,
          thresholds: { ...limits },
          inputProjection: {
            packageName,
            workspace,
            bindings: { source: 'original', tests: 'original' },
          },
        },
      };
    }),
  };
  const contract = {
    expectedPackageCount: 10,
    policyDigest: plan.mutation_policy_digest,
    releasePlanReceiptDigest: plan.release_plan_receipt_digest,
    releaseProfileDigest: plan.release_profile_digest,
    packages: plan.packages.map((p) => ({
      requirement: 'required',
      packageName: p.expected.packageName,
      workspace: p.expected.workspace,
      inputDigest: p.input_digest,
      inputProjection: structuredClone(p.expected.inputProjection),
      thresholds: { ...p.expected.thresholds },
    })),
  };
  const inspect = () => {
    const bytes = Buffer.from(JSON.stringify(plan));
    return inspectMutationInputPlan(bytes, {
      sha256: sha(bytes),
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
    });
  };
  return { plan, contract, inspect };
}
it('binds the ten-package inputs without requiring any generated output or readiness receipt', () => {
  const f = fixture();
  expect(f.inspect()).toEqual(f.plan);
  expect(() => assertMutationContractBindings(f.contract, f.inspect())).not.toThrow();
});
it('rejects changed input-plan bytes against the independently supplied digest', () => {
  const f = fixture();
  const bytes = Buffer.from(JSON.stringify(f.plan));
  expect(() =>
    inspectMutationInputPlan(Buffer.concat([bytes, Buffer.from(' ')]), {
      sha256: sha(bytes),
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
    }),
  ).toThrow('MUTATION_INPUT_PLAN_DIGEST_MISMATCH');
});
it.each(['commit', 'tree', 'id'] as const)(
  'rejects changed candidate %s even in a selected plan',
  (key) => {
    const f = fixture();
    f.plan.repository[key] = 'f'.repeat(40);
    expect(f.inspect).toThrow('MUTATION_INPUT_PLAN_CANDIDATE_MISMATCH');
  },
);
it.each(['missing', 'duplicate', 'reordered', 'score', 'survivors'])(
  'refuses weakened input plan: %s',
  (change) => {
    const f = fixture();
    const first = f.plan.packages[0];
    if (!first) throw new Error('fixture missing first package');
    if (change === 'missing') f.plan.packages.pop();
    if (change === 'duplicate') f.plan.packages[1] = structuredClone(first);
    if (change === 'reordered') f.plan.packages.reverse();
    if (change === 'score') first.expected.thresholds.scoreMin = 59;
    if (change === 'survivors') first.expected.thresholds.survivedMax = 51;
    expect(f.inspect).toThrow(/MUTATION_INPUT_PLAN_(ROSTER|LIMITS)_MISMATCH/);
  },
);
it.each([
  'missing',
  'not-required',
  'policy',
  'plan',
  'profile',
  'input',
  'tests',
  'source',
  'score',
  'survivors',
])('rejects post-execution contract substitution: %s', (change) => {
  const f = fixture();
  const c = f.contract;
  const first = c.packages[0];
  if (!first) throw new Error('fixture missing first package');
  if (change === 'missing') c.packages.pop();
  if (change === 'not-required') first.requirement = 'not-required';
  if (change === 'policy') c.policyDigest = 'f'.repeat(64);
  if (change === 'plan') c.releasePlanReceiptDigest = 'f'.repeat(64);
  if (change === 'profile') c.releaseProfileDigest = 'f'.repeat(64);
  if (change === 'input') first.inputDigest = 'f'.repeat(64);
  if (change === 'tests') first.inputProjection.bindings.tests = 'hidden tests';
  if (change === 'source') first.inputProjection.bindings.source = 'different source';
  if (change === 'score') first.thresholds.scoreMin = 59;
  if (change === 'survivors') first.thresholds.survivedMax = 51;
  expect(() => assertMutationContractBindings(c, f.inspect())).toThrow(/MUTATION_EVIDENCE_/);
});
