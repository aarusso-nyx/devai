import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
const { assertDevaiMutationExportBindings } = await import(
  pathToFileURL(resolve('scripts/process/devai-mutation-export-bindings.mjs')).href
);
const { mutationSemanticFixture } = await import(
  pathToFileURL(resolve('tests/fixtures/mutation-semantic-fixture.mjs')).href
);
function at<T>(values: T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error('TEST_FIXTURE_MEMBER_MISSING');
  return value;
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const { plan, contract } = mutationSemanticFixture();
  const bytes = Buffer.from(JSON.stringify(contract));
  const digest = sha(bytes);
  const provider = Buffer.from(
    JSON.stringify({
      mutation_evidence: {
        output_contract: {
          bytes_base64: bytes.toString('base64'),
          sha256: digest,
          size_bytes: bytes.length,
        },
      },
    }),
  );
  const closure = {
    output_contract: { sha256: digest },
    members: Array.from({ length: 22 }, (_, i) => ({ index: i })),
    receipt: {
      referent: {
        repository_id: plan.repository.id,
        candidate_commit: plan.repository.commit,
        candidate_tree: plan.repository.tree,
        release_unit: plan.release_unit,
        release_plan_receipt_digest_sha256: plan.release_plan_receipt_digest,
        release_profile_digest_sha256: plan.release_profile_digest,
        mutation_policy_digest_sha256: plan.mutation_policy_digest,
        output_contract_digest_sha256: digest,
      },
    },
  };
  const ids = [
    'candidate-tree-identity',
    'receipt-envelope-canonicality',
    'signer-trust',
    'policy-identity',
    'result-dag-integrity',
    'artifact-population',
    'artifact-digests',
    'artifact-safety',
    'mutation-semantics',
  ];
  const unit = {
    release_unit: plan.release_unit,
    requirement: 'required',
    plan_receipt_digest_sha256: plan.release_plan_receipt_digest,
    mutation_evidence: closure,
  };
  return {
    plan,
    receipt: { checks: ids.map((check_id) => ({ check_id, status: 'pass', units: [unit] })) },
    state: {
      release_units: [
        {
          release_unit: plan.release_unit,
          packages: [{ provider_result: { sha256: sha(provider) } }],
        },
      ],
    },
    objects: new Map([[sha(provider), provider]]),
  };
}
// These are binding checks following authenticated offline verification, not
// synthetic certification evidence or a substitute for the installed-chain test.
it('binds the full ten-package contract after authenticated verification', () => {
  expect(() => assertDevaiMutationExportBindings(fixture())).not.toThrow();
});
it.each(['not-applicable', 'fail', 'blocked'])('rejects a %s offline check', (status) => {
  const f = fixture();
  at(f.receipt.checks, 8).status = status;
  expect(() => assertDevaiMutationExportBindings(f)).toThrow(
    'DEVAI_MUTATION_OFFLINE_CHECKS_REQUIRED',
  );
});
it('rejects reordered checks and an empty mutation roster', () => {
  const f = fixture();
  f.receipt.checks.reverse();
  expect(() => assertDevaiMutationExportBindings(f)).toThrow();
  const g = fixture();
  at(at(g.receipt.checks, 8).units, 0).requirement = 'none';
  expect(() => assertDevaiMutationExportBindings(g)).toThrow();
});
it.each([
  'repository_id',
  'candidate_commit',
  'candidate_tree',
  'release_unit',
  'release_plan_receipt_digest_sha256',
  'release_profile_digest_sha256',
  'mutation_policy_digest_sha256',
  'output_contract_digest_sha256',
])('rejects changed %s', (key) => {
  const f = fixture();
  const ref = at(at(f.receipt.checks, 8).units, 0).mutation_evidence.receipt.referent;
  Reflect.set(ref, key, 'different');
  expect(() => assertDevaiMutationExportBindings(f)).toThrow();
});
it('requires every exported package to carry the same verified contract', () => {
  const f = fixture();
  at(f.state.release_units, 0).packages.push({ provider_result: { sha256: 'b'.repeat(64) } });
  expect(() => assertDevaiMutationExportBindings(f)).toThrow(
    'DEVAI_MUTATION_EXPORT_PROVIDER_MISSING',
  );
});
it('rejects a contract with changed test inputs despite matching package names', () => {
  const f = fixture();
  f.plan.packages[0].input_digest = 'c'.repeat(64);
  expect(() => assertDevaiMutationExportBindings(f)).toThrow('MUTATION_EVIDENCE_INPUT_MISMATCH');
});
it('rejects a closure missing one of the required 22 members', () => {
  const f = fixture();
  at(at(f.receipt.checks, 8).units, 0).mutation_evidence.members.pop();
  expect(() => assertDevaiMutationExportBindings(f)).toThrow('DEVAI_MUTATION_EXPORT_PLAN_MISMATCH');
});
