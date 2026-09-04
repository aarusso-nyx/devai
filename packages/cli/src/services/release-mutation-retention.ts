import { createHash } from 'node:crypto';
import { createProtectedReleaseHostAdapter } from '@devai-nyx/authority';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import {
  finalizeReleaseMutationArtifactsV21,
  type ReleaseMutationPackageArtifactsV21,
} from './release-mutation-artifacts.js';
import {
  isDerivedReleaseMutationInputPlanV21,
  type ReleaseMutationInputPlanV21,
} from './release-mutation-inputs.js';
import {
  composeMutationEvidenceV21,
  type MutationVerificationOptionsV21,
} from './mutation-evidence-v21.js';
import {
  verifyUnitMutationEvidenceClosure,
  verifyUnitMutationEvidenceDocuments,
  type ReleaseUnitMutationEvidenceClosure,
  type UnitMutationEvidenceBinding,
  type UnitMutationEvidenceMember,
  type UnitMutationEvidenceObject,
  type UnitMutationEvidenceProjection,
  type UnitMutationEvidenceSink,
} from './release-unit-mutation-evidence.js';

const ERROR = 'release-certification-generated-output-untrusted';
const SHA256 = /^[a-f0-9]{64}$/u;
const DOCUMENT_KINDS = new Set<UnitMutationEvidenceMember['document_kind']>([
  'mutation-normalized-stryker-report-v2',
  'mutation-package-result-v2',
  'mutation-composed-report-set-v2',
  'mutation-semantic-verification-receipt-v2',
]);

type PackageArtifacts = {
  readonly packageName: string;
  readonly disposition: 'executed' | 'reused';
  readonly origin: unknown;
  readonly artifacts: ReleaseMutationPackageArtifactsV21;
};

/**
 * A private sidecar retention input. It accepts already-produced artifacts but is not execution
 * custody, certification authority, or a public lifecycle request field.
 */
export interface ReleaseMutationRetentionInputV21 {
  readonly plan: ReleaseMutationInputPlanV21;
  readonly packages: readonly PackageArtifacts[];
  readonly task_policy_digests_sha256: readonly string[];
  readonly evidence_sink: UnitMutationEvidenceSink;
  readonly authority_owner: object;
  readonly sink_host: ReturnType<typeof createProtectedReleaseHostAdapter>;
  readonly resolve_reuse_origin?: MutationVerificationOptionsV21['resolveReuseOrigin'];
}

function fail(): never {
  throw new Error(ERROR);
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function snapshot<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function captureArtifacts(value: readonly PackageArtifacts[]): readonly PackageArtifacts[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail();
  return value.map((entry) => {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      entry.artifacts === null ||
      typeof entry.artifacts !== 'object' ||
      (entry.disposition === 'executed' && entry.origin !== null)
    )
      fail();
    const capture = (artifact: ReleaseMutationPackageArtifactsV21['report']) => {
      if (
        artifact === null ||
        typeof artifact !== 'object' ||
        typeof artifact.path !== 'string' ||
        typeof artifact.sha256 !== 'string' ||
        !SHA256.test(artifact.sha256) ||
        !(artifact.bytes instanceof Uint8Array)
      )
        fail();
      const bytes = Buffer.from(artifact.bytes);
      if (hash(bytes) !== artifact.sha256) fail();
      return { path: artifact.path, sha256: artifact.sha256, bytes };
    };
    const artifacts = entry.artifacts;
    if (
      typeof entry.packageName !== 'string' ||
      (entry.disposition !== 'executed' && entry.disposition !== 'reused') ||
      typeof artifacts.inputDigest !== 'string' ||
      !SHA256.test(artifacts.inputDigest)
    )
      fail();
    return {
      packageName: entry.packageName,
      disposition: entry.disposition,
      origin: snapshot(entry.origin),
      artifacts: {
        inputDigest: artifacts.inputDigest,
        report: capture(artifacts.report),
        result: capture(artifacts.result),
      },
    };
  });
}

function bindingFor(
  plan: ReleaseMutationInputPlanV21,
  taskPolicyDigests: readonly string[],
): UnitMutationEvidenceBinding {
  if (
    !Array.isArray(taskPolicyDigests) ||
    taskPolicyDigests.length === 0 ||
    taskPolicyDigests.some((digest) => typeof digest !== 'string' || !SHA256.test(digest)) ||
    new Set(taskPolicyDigests).size !== taskPolicyDigests.length ||
    !same(taskPolicyDigests, [...taskPolicyDigests].sort(compare))
  )
    fail();
  return {
    repository_id: plan.repository.id,
    candidate_commit: plan.repository.commit,
    candidate_tree: plan.repository.tree,
    release_unit: plan.release_unit,
    release_plan_receipt_digest_sha256: plan.release_plan_receipt_digest,
    release_profile_digest_sha256: plan.release_profile_digest,
    mutation_policy_digest_sha256: plan.mutation_policy_digest,
    task_policy_digests_sha256: [...taskPolicyDigests],
  };
}

function pathsFor(plan: ReleaseMutationInputPlanV21): {
  readonly summaryPath: string;
  readonly semanticReceiptPath: string;
} {
  const unit = canonicalSha256({ release_unit: plan.release_unit });
  const root = `mutation/unit/${plan.release_plan_receipt_digest}/${unit}`;
  return {
    summaryPath: `${root}/summary.json`,
    semanticReceiptPath: `${root}/semantic-receipt.json`,
  };
}

function memberFor(
  path: string,
  bytes: Buffer,
  evidence_sink_id: string,
  opaque_handle: string,
  packageByPath: ReadonlyMap<string, string>,
): UnitMutationEvidenceMember {
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<
      string,
      unknown
    >;
  } catch {
    return fail();
  }
  const kind = document.kind;
  if (
    typeof kind !== 'string' ||
    !DOCUMENT_KINDS.has(kind as UnitMutationEvidenceMember['document_kind'])
  )
    fail();
  const packageName = packageByPath.get(path);
  if (
    (kind === 'mutation-normalized-stryker-report-v2' || kind === 'mutation-package-result-v2') !==
    (packageName !== undefined)
  )
    fail();
  return {
    path,
    sha256: hash(bytes),
    size_bytes: bytes.byteLength,
    evidence_sink_id,
    opaque_handle,
    document_kind: kind as UnitMutationEvidenceMember['document_kind'],
    package_name: packageName ?? null,
  };
}

function objectFor(
  path: string,
  bytes: Buffer,
  evidence_sink_id: string,
  opaque_handle: string,
): UnitMutationEvidenceObject {
  return {
    path,
    sha256: hash(bytes),
    size_bytes: bytes.byteLength,
    evidence_sink_id,
    opaque_handle,
  };
}

/**
 * Retain a complete, semantically verified unit closure through the existing evidence sink.
 * This function does not execute mutation tests or establish protected execution custody.
 */
export async function retainReleaseMutationEvidenceV21(
  input: ReleaseMutationRetentionInputV21,
): Promise<ReleaseUnitMutationEvidenceClosure> {
  if (
    input === null ||
    typeof input !== 'object' ||
    !isDerivedReleaseMutationInputPlanV21(input.plan) ||
    input.plan.execution_template_version !== '1.2.0' ||
    input.plan.packages.some((entry) => entry.reuse.unresolved.length !== 0) ||
    input.evidence_sink === null ||
    typeof input.evidence_sink !== 'object' ||
    !Number.isSafeInteger(input.evidence_sink.unit_mutation_maximum_bytes) ||
    input.evidence_sink.unit_mutation_maximum_bytes < 1 ||
    typeof input.evidence_sink.beginUnitMutationEvidence !== 'function' ||
    typeof input.evidence_sink.readUnitMutationEvidenceClosure !== 'function' ||
    typeof input.evidence_sink.readUnitMutationEvidenceReceipt !== 'function' ||
    typeof input.evidence_sink.readUnitMutationEvidenceBlob !== 'function' ||
    input.authority_owner === null ||
    typeof input.authority_owner !== 'object' ||
    input.sink_host === null ||
    typeof input.sink_host !== 'object' ||
    typeof input.sink_host.invokeSink !== 'function'
  )
    fail();

  // Capture every host-owned capability and all caller-owned evidence before the first await.
  // The adapter must never observe a substituted sink, owner, resolver, or artifact population.
  const plan = input.plan;
  const evidenceSink = input.evidence_sink;
  const authorityOwner = input.authority_owner;
  const maximumBytes = evidenceSink.unit_mutation_maximum_bytes;
  const begin = evidenceSink.beginUnitMutationEvidence.bind(evidenceSink);
  const readClosure = evidenceSink.readUnitMutationEvidenceClosure.bind(evidenceSink);
  const readReceipt = evidenceSink.readUnitMutationEvidenceReceipt.bind(evidenceSink);
  const readBlob = evidenceSink.readUnitMutationEvidenceBlob.bind(evidenceSink);
  const invokeSink = input.sink_host.invokeSink.bind(input.sink_host);
  const resolveReuseOrigin = input.resolve_reuse_origin;
  const binding = bindingFor(plan, [...input.task_policy_digests_sha256]);
  const packages = captureArtifacts([...input.packages]);
  const expected = plan.packages.map((entry) => entry.expected);
  const suppliedByPath = new Map<string, Buffer>();
  for (const entry of packages) {
    if (
      suppliedByPath.has(entry.artifacts.report.path) ||
      suppliedByPath.has(entry.artifacts.result.path)
    )
      fail();
    suppliedByPath.set(entry.artifacts.report.path, Buffer.from(entry.artifacts.report.bytes));
    suppliedByPath.set(entry.artifacts.result.path, Buffer.from(entry.artifacts.result.bytes));
  }
  const { summaryPath, semanticReceiptPath } = pathsFor(plan);
  const finalized = await finalizeReleaseMutationArtifactsV21({
    candidate: {
      releaseUnit: plan.release_unit,
      commit: plan.repository.commit,
      tree: plan.repository.tree,
    },
    releasePlanReceiptDigest: plan.release_plan_receipt_digest,
    releaseProfileDigest: plan.release_profile_digest,
    policyDigest: plan.mutation_policy_digest,
    summaryPath,
    semanticReceiptPath,
    expected,
    packages,
    maximum_document_bytes: maximumBytes,
  });
  const composed = await composeMutationEvidenceV21(
    {
      contract: finalized.contract,
      candidate: {
        releaseUnit: plan.release_unit,
        commit: plan.repository.commit,
        tree: plan.repository.tree,
      },
      packages: finalized.materials,
    },
    resolveReuseOrigin,
  );
  if (composed.artifacts.length !== 2 * expected.length + 2) fail();

  const contract = finalized.contract;
  const rows = contract['packages'];
  if (!Array.isArray(rows)) fail();
  const packageByPath = new Map<string, string>();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') fail();
    const value = row as Record<string, unknown>;
    if (
      typeof value.packageName !== 'string' ||
      typeof value.reportPath !== 'string' ||
      typeof value.resultPath !== 'string' ||
      packageByPath.has(value.reportPath) ||
      packageByPath.has(value.resultPath)
    )
      fail();
    packageByPath.set(value.reportPath, value.packageName);
    packageByPath.set(value.resultPath, value.packageName);
  }
  const composedByPath = new Map(
    composed.artifacts.map((artifact) => [artifact.path, artifact.bytes]),
  );
  if (composedByPath.size !== composed.artifacts.length) fail();
  for (const [path, bytes] of suppliedByPath) {
    const composedBytes = composedByPath.get(path);
    if (composedBytes === undefined || !Buffer.from(composedBytes).equals(bytes)) fail();
  }

  const transaction = invokeSink(() => begin(binding), authorityOwner);
  let commitStarted = false;
  try {
    const handles = new Map<string, Omit<UnitMutationEvidenceObject, 'path'>>();
    const put = (bytes: Buffer, path: string) => {
      const identity = invokeSink(
        () =>
          transaction.put({
            bytes: Buffer.from(bytes),
            sha256: hash(bytes),
            size_bytes: bytes.byteLength,
          }),
        authorityOwner,
      );
      if (
        identity.evidence_sink_id !== transaction.evidence_sink_id ||
        identity.sha256 !== hash(bytes) ||
        identity.size_bytes !== bytes.byteLength ||
        identity.opaque_handle !== `sha256:${identity.sha256}` ||
        handles.has(path)
      )
        fail();
      handles.set(path, identity);
      return identity;
    };
    const contractBytes = Buffer.from(canonicalJson(contract), 'utf8');
    const contractHandle = put(contractBytes, 'contract');
    const members: UnitMutationEvidenceMember[] = [];
    for (const artifact of composed.artifacts) {
      const bytes = Buffer.from(artifact.bytes);
      const handle = put(bytes, artifact.path);
      members.push(
        memberFor(
          artifact.path,
          bytes,
          handle.evidence_sink_id,
          handle.opaque_handle,
          packageByPath,
        ),
      );
    }
    const projection: UnitMutationEvidenceProjection = {
      summary_path: summaryPath,
      semantic_receipt_path: semanticReceiptPath,
      output_contract: objectFor(
        'mutation/output-contract.json',
        contractBytes,
        contractHandle.evidence_sink_id,
        contractHandle.opaque_handle,
      ),
      members: members.sort((left, right) => compare(left.path, right.path)),
    };
    // `verify` only reads/recomputes; it intentionally runs outside the synchronous write scope.
    await transaction.verify(projection);
    commitStarted = true;
    const committed = snapshot(invokeSink(() => transaction.commit(projection), authorityOwner));
    verifyUnitMutationEvidenceClosure(committed, binding);
    const reread = snapshot(readClosure(binding));
    verifyUnitMutationEvidenceClosure(reread, binding);
    if (!same(committed, reread)) fail();
    const receipt = snapshot(
      readReceipt({
        evidence_sink_id: reread.output_contract.evidence_sink_id,
        receipt_digest_sha256: reread.receipt.receipt_digest_sha256,
      }),
    );
    if (!same(receipt, reread.receipt)) fail();
    await verifyUnitMutationEvidenceDocuments({
      closure: reread,
      expected: binding,
      maximum_bytes: maximumBytes,
      read: (identity) => readBlob({ binding, identity }),
    });
    return reread;
  } catch (error) {
    if (!commitStarted) invokeSink(() => transaction.abort(), authorityOwner);
    throw error;
  }
}
