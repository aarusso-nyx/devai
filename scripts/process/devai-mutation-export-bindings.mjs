import { createHash } from 'node:crypto';
import { assertMutationContractBindings } from './mutation-evidence-bindings.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const checks = [
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
const requireValue = (value, code) => {
  if (!value) throw new Error(code);
};

/** Repository-specific bindings, only after the installed offline action verifies
 * the signed export and its complete object population. This is not a verifier
 * for caller-supplied receipts or unauthenticated provider results. */
export function assertDevaiMutationExportBindings({ receipt, state, objects, plan }) {
  requireValue(
    receipt.checks?.length === checks.length &&
      receipt.checks.every((check, i) => check.check_id === checks[i] && check.status === 'pass'),
    'DEVAI_MUTATION_OFFLINE_CHECKS_REQUIRED',
  );
  const units = receipt.checks[8].units;
  requireValue(
    units?.length === 1 &&
      units[0].release_unit === plan.release_unit &&
      units[0].requirement === 'required' &&
      units[0].mutation_evidence &&
      units[0].plan_receipt_digest_sha256 === plan.release_plan_receipt_digest &&
      state.release_units?.length === 1 &&
      state.release_units[0].release_unit === plan.release_unit &&
      state.release_units[0].packages?.length > 0,
    'DEVAI_MUTATION_EXPORT_UNIT_MISMATCH',
  );
  const closure = units[0].mutation_evidence;
  const binding = closure.receipt?.referent;
  requireValue(
    binding?.repository_id === plan.repository.id &&
      binding.candidate_commit === plan.repository.commit &&
      binding.candidate_tree === plan.repository.tree &&
      binding.release_unit === plan.release_unit &&
      binding.release_plan_receipt_digest_sha256 === plan.release_plan_receipt_digest &&
      binding.release_profile_digest_sha256 === plan.release_profile_digest &&
      binding.mutation_policy_digest_sha256 === plan.mutation_policy_digest &&
      closure.members?.length === 22,
    'DEVAI_MUTATION_EXPORT_PLAN_MISMATCH',
  );
  for (const pkg of state.release_units[0].packages) {
    const bytes = objects.get(pkg.provider_result?.sha256);
    requireValue(
      bytes && sha(bytes) === pkg.provider_result.sha256,
      'DEVAI_MUTATION_EXPORT_PROVIDER_MISSING',
    );
    const provider = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const contract = provider.mutation_evidence?.output_contract;
    requireValue(
      typeof contract?.bytes_base64 === 'string',
      'DEVAI_MUTATION_EXPORT_CONTRACT_MISSING',
    );
    const document = Buffer.from(contract.bytes_base64, 'base64');
    requireValue(
      document.toString('base64') === contract.bytes_base64 &&
        document.length === contract.size_bytes &&
        sha(document) === contract.sha256 &&
        contract.sha256 === closure.output_contract?.sha256 &&
        contract.sha256 === binding.output_contract_digest_sha256,
      'DEVAI_MUTATION_EXPORT_CONTRACT_MISMATCH',
    );
    assertMutationContractBindings(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(document)),
      plan,
    );
  }
}
