import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectApprovedMutationVerifier } from './approved-mutation-verifier.mjs';
import {
  inspectMutationInputPlan,
  assertMutationContractBindings,
} from './mutation-evidence-bindings.mjs';

const loaded = new Map();
const requireValue = (value, code) => {
  if (!value) throw new Error(code);
};

/** Independent semantic checking only. The caller must separately verify signed
 * custody/export and transport, and retain these exact artifact identities in the
 * release evidence. This function grants no publication authority. */
export async function verifyMutationSemantics({
  control,
  planBytes,
  planExpected,
  artifactRoot,
  contractBytes,
  expected,
  resolveReuseOrigin,
}) {
  requireValue(
    ['2.1.0', '2.2.0'].includes(expected?.schemaVersion),
    'MUTATION_EVIDENCE_VERSION_REQUIRED',
  );
  requireValue(
    expected.semanticReceiptProvenance &&
      typeof expected.semanticReceiptProvenance === 'object' &&
      !Array.isArray(expected.semanticReceiptProvenance),
    'MUTATION_EVIDENCE_PROVENANCE_REQUIRED',
  );
  const identity = inspectApprovedMutationVerifier(control);
  const previous = loaded.get(identity.packageRoot);
  requireValue(
    previous === undefined || previous === identity.approvalSha256,
    'MUTATION_CONTROL_PROCESS_IDENTITY_CHANGED',
  );
  loaded.set(identity.packageRoot, identity.approvalSha256);
  const module = (name) => import(pathToFileURL(join(identity.packageRoot, 'src', name)).href);
  const [canonical, safety, paths, kernel] = await Promise.all([
    module('canonical.js'),
    module('artifact-safety.js'),
    module('safe-path.js'),
    module(expected.schemaVersion === '2.1.0' ? 'mutation-v21.js' : 'mutation-v22.js'),
  ]);
  inspectApprovedMutationVerifier(control);
  const plan = inspectMutationInputPlan(planBytes, planExpected);
  const parse = (bytes, path) => {
    safety.validateArtifactContent({ bytes, path, mediaType: 'application/json' });
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    requireValue(
      Buffer.from(bytes).equals(canonical.canonicalBytes(value)),
      'MUTATION_EVIDENCE_NONCANONICAL',
    );
    return { bytes: Buffer.from(bytes), value };
  };
  requireValue(
    Buffer.isBuffer(contractBytes) && contractBytes.length <= 16 * 1024 * 1024,
    'MUTATION_EVIDENCE_CONTRACT_INVALID',
  );
  const contract = parse(contractBytes, 'mutation-output-contract.json').value;
  requireValue(
    contract.schemaVersion === expected.schemaVersion,
    'MUTATION_EVIDENCE_VERSION_MISMATCH',
  );
  const validate =
    expected.schemaVersion === '2.1.0'
      ? kernel.validateMutationContractV21
      : kernel.validateMutationContractV22;
  validate(contract);
  assertMutationContractBindings(contract, plan);
  const root = realpathSync(artifactRoot);
  const candidate = realpathSync(control.candidateRoot);
  const rel = relative(candidate, root);
  requireValue(
    root === resolve(artifactRoot) &&
      (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)),
    'MUTATION_EVIDENCE_ROOT_INVALID',
  );
  const entries = [];
  let total = 0,
    visited = 0;
  const visit = (directory, depth = 0) => {
    requireValue(depth <= 32 && ++visited <= 4096, 'MUTATION_EVIDENCE_SIZE_LIMIT');
    requireValue(lstatSync(directory).isDirectory(), 'MUTATION_EVIDENCE_SPECIAL_FILE');
    for (const name of readdirSync(directory)) {
      const file = join(directory, name),
        stat = lstatSync(file);
      if (stat.isDirectory()) visit(file, depth + 1);
      else {
        requireValue(stat.isFile(), 'MUTATION_EVIDENCE_SPECIAL_FILE');
        total += stat.size;
        requireValue(
          stat.size <= 128 * 1024 * 1024 && total <= 512 * 1024 * 1024 && entries.length < 22,
          'MUTATION_EVIDENCE_SIZE_LIMIT',
        );
        entries.push(relative(root, file).split(sep).join('/'));
      }
    }
  };
  visit(root);
  requireValue(
    entries.length === 22 &&
      canonical.canonicalize(entries.sort()) === canonical.canonicalize([...contract.paths].sort()),
    'MUTATION_EVIDENCE_POPULATION_MISMATCH',
  );
  const snapshots = new Map(
    entries.map((path) => [
      path,
      parse(paths.readRootRelativeRegularFile(root, path, 'mutation artifact'), path),
    ]),
  );
  const receipt = snapshots.get(contract.semanticReceiptPath)?.value;
  requireValue(
    canonical.canonicalize(receipt?.verifierProvenance) ===
      canonical.canonicalize(expected.semanticReceiptProvenance),
    'MUTATION_EVIDENCE_PROVENANCE_MISMATCH',
  );
  const options = {
    ...(expected.schemaVersion === '2.2.0' ? expected.v22 : {}),
    candidateCommit: planExpected.commit,
    candidateTree: planExpected.tree,
    releaseUnit: plan.release_unit,
    expectedRepositoryId: plan.repository.id,
    expectedReleasePlanReceiptDigest: plan.release_plan_receipt_digest,
    expectedReleaseProfileDigest: plan.release_profile_digest,
    expectedPolicyDigest: plan.mutation_policy_digest,
    expectedSemanticReceiptProvenance: expected.semanticReceiptProvenance,
    mutationVerificationMode: 'offline',
    ...(resolveReuseOrigin === undefined
      ? {}
      : {
          resolveReuseOrigin: (origin) => {
            const resolved = resolveReuseOrigin(origin);
            requireValue(
              canonical.canonicalize(resolved?.semanticReceipt?.verifierProvenance) ===
                canonical.canonicalize(expected.semanticReceiptProvenance),
              'MUTATION_EVIDENCE_PROVENANCE_MISMATCH',
            );
            return resolved;
          },
        }),
  };
  const verify =
    expected.schemaVersion === '2.1.0'
      ? kernel.verifyMutationReportSetV21
      : kernel.verifyMutationReportSetV22;
  const result = verify(
    contract,
    (path) => {
      requireValue(snapshots.has(path), 'MUTATION_EVIDENCE_POPULATION_MISMATCH');
      return snapshots.get(path);
    },
    options,
  );
  requireValue(
    result.complete === true &&
      result.passed === true &&
      result.packageCount === 10 &&
      result.notRequiredPackageCount === 0,
    'MUTATION_EVIDENCE_NOT_PASSING',
  );
  inspectApprovedMutationVerifier(control);
  return {
    verification: result,
    control: identity,
    inputPlanSha256: planExpected.sha256,
    contractSha256: canonical.sha256Hex(contractBytes),
    artifacts: Object.fromEntries(
      [...snapshots].map(([path, file]) => [
        path,
        { sha256: canonical.sha256Hex(file.bytes), size: file.bytes.length },
      ]),
    ),
  };
}
