import { createHash } from 'node:crypto';

const requireValue = (value, code) => {
  if (!value) throw new Error(code);
};
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const objectId = (value) => typeof value === 'string' && /^(?!0{40}$)[a-f0-9]{40}$/u.test(value);
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const roster = [
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
];
const limits = {
  break: 60,
  high: 60,
  low: 60,
  scoreMin: 60,
  survivedMax: Number.MAX_SAFE_INTEGER,
};

/** Inspect an operator-selected installed-host input plan before execution.
 * The protected digest must be established independently of candidate evidence.
 * This binds inputs only; no result, receipt or generated output is required. */
export function inspectMutationInputPlan(bytes, expected) {
  requireValue(
    Buffer.isBuffer(bytes) && bytes.length <= 16 * 1024 * 1024 && hash(expected?.sha256),
    'MUTATION_INPUT_PLAN_EXPECTATION_REQUIRED',
  );
  requireValue(
    createHash('sha256').update(bytes).digest('hex') === expected.sha256,
    'MUTATION_INPUT_PLAN_DIGEST_MISMATCH',
  );
  const plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  requireValue(
    objectId(expected.commit) &&
      objectId(expected.tree) &&
      plan.repository?.id === 'aarusso-nyx/devai' &&
      plan.repository.commit === expected.commit &&
      plan.repository.tree === expected.tree &&
      plan.release_unit === '@aarusso-nyx/devai',
    'MUTATION_INPUT_PLAN_CANDIDATE_MISMATCH',
  );
  for (const name of [
    'mutation_policy_digest',
    'release_plan_receipt_digest',
    'release_profile_digest',
  ])
    requireValue(hash(plan[name]), 'MUTATION_INPUT_PLAN_BINDING_INVALID');
  requireValue(
    Array.isArray(plan.packages) && plan.packages.length === roster.length,
    'MUTATION_INPUT_PLAN_ROSTER_MISMATCH',
  );
  for (const [index, id] of roster.entries()) {
    const entry = plan.packages[index];
    const name = id === 'cli' ? '@aarusso-nyx/devai' : `@devai-nyx/${id}`;
    requireValue(
      entry?.id === id &&
        entry.expected?.packageName === name &&
        entry.expected.workspace === `packages/${id}` &&
        hash(entry.input_digest) &&
        entry.expected.inputProjection?.packageName === name &&
        entry.expected.inputProjection?.workspace === `packages/${id}`,
      'MUTATION_INPUT_PLAN_ROSTER_MISMATCH',
    );
    requireValue(
      canonical(entry.expected.thresholds) === canonical(limits),
      'MUTATION_INPUT_PLAN_LIMITS_MISMATCH',
    );
  }
  return plan;
}

/** Additional DEVAI repository requirements, before the approved version-specific
 * kernel verifies artifact population, contents, provenance, reuse and semantics.
 * Passing this comparison alone never establishes mutation acceptance. */
export function assertMutationContractBindings(contract, plan) {
  requireValue(
    contract?.expectedPackageCount === roster.length &&
      Array.isArray(contract.packages) &&
      contract.packages.length === roster.length,
    'MUTATION_EVIDENCE_ROSTER_MISMATCH',
  );
  for (const [contractKey, planKey] of [
    ['policyDigest', 'mutation_policy_digest'],
    ['releasePlanReceiptDigest', 'release_plan_receipt_digest'],
    ['releaseProfileDigest', 'release_profile_digest'],
  ])
    requireValue(
      hash(plan[planKey]) && contract[contractKey] === plan[planKey],
      'MUTATION_EVIDENCE_PLAN_MISMATCH',
    );
  for (const [index, entry] of contract.packages.entries()) {
    const expected = plan.packages[index];
    requireValue(
      entry.requirement === 'required' &&
        entry.packageName === expected.expected.packageName &&
        entry.workspace === expected.expected.workspace,
      'MUTATION_EVIDENCE_ROSTER_MISMATCH',
    );
    requireValue(
      entry.inputDigest === expected.input_digest &&
        canonical(entry.inputProjection) === canonical(expected.expected.inputProjection),
      'MUTATION_EVIDENCE_INPUT_MISMATCH',
    );
    requireValue(
      canonical(entry.thresholds) === canonical(limits) &&
        canonical(entry.thresholds) === canonical(expected.expected.thresholds),
      'MUTATION_EVIDENCE_LIMITS_MISMATCH',
    );
  }
}
