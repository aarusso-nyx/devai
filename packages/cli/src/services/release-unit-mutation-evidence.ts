import { createHash } from 'node:crypto';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { verifyMutationEvidenceV21 } from './mutation-evidence-v21.js';

type Json = Readonly<Record<string, unknown>>;
const ERROR = 'release-certification-generated-output-untrusted';
const SHA = /^[a-f0-9]{64}$/u;
const GIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ORDER = 'ascending-utf-8-byte-collation-by-path;duplicates-refuse';
const KINDS = [
  'mutation-normalized-stryker-report-v2',
  'mutation-package-result-v2',
  'mutation-composed-report-set-v2',
  'mutation-semantic-verification-receipt-v2',
] as const;

export interface UnitMutationEvidenceObject {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly evidence_sink_id: string;
  readonly opaque_handle: string;
}

export interface UnitMutationEvidenceMember extends UnitMutationEvidenceObject {
  readonly document_kind: (typeof KINDS)[number];
  readonly package_name: string | null;
}

export interface UnitMutationEvidenceBinding {
  readonly repository_id: string;
  readonly candidate_commit: string;
  readonly candidate_tree: string;
  readonly release_unit: string;
  readonly release_plan_receipt_digest_sha256: string;
  readonly release_profile_digest_sha256: string;
  readonly mutation_policy_digest_sha256: string;
  readonly task_policy_digests_sha256: readonly string[];
}

export interface UnitMutationEvidenceReceipt {
  readonly kind: 'release-unit-mutation-evidence-receipt-v1';
  readonly receipt_digest_sha256: string;
  readonly canonicalization: 'utf-8-rfc8785-jcs-sha256';
  readonly referent: UnitMutationEvidenceBinding & {
    readonly member_projection_digest_sha256: string;
    readonly output_contract_digest_sha256: string;
  };
}

export interface ReleaseUnitMutationEvidenceClosure {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'release-unit-mutation-evidence-closure-v1';
  readonly release_unit: string;
  readonly member_order: typeof ORDER;
  readonly summary_path: string;
  readonly semantic_receipt_path: string;
  readonly output_contract: UnitMutationEvidenceObject;
  readonly members: readonly UnitMutationEvidenceMember[];
  readonly receipt: UnitMutationEvidenceReceipt;
}

export type UnitMutationEvidenceProjection = Pick<
  ReleaseUnitMutationEvidenceClosure,
  'summary_path' | 'semantic_receipt_path' | 'output_contract' | 'members'
>;

export interface UnitMutationEvidenceTransaction {
  readonly evidence_sink_id: string;
  readonly transaction_handle: string;
  readonly put: (input: {
    readonly bytes: Buffer;
    readonly sha256: string;
    readonly size_bytes: number;
  }) => Omit<UnitMutationEvidenceObject, 'path'>;
  readonly verify: (projection: UnitMutationEvidenceProjection) => Promise<void>;
  readonly commit: (
    projection: UnitMutationEvidenceProjection,
  ) => ReleaseUnitMutationEvidenceClosure;
  readonly abort: () => void;
}

export interface UnitMutationEvidenceSink {
  readonly beginUnitMutationEvidence: (
    binding: UnitMutationEvidenceBinding,
  ) => UnitMutationEvidenceTransaction;
  readonly readUnitMutationEvidenceClosure: (
    binding: UnitMutationEvidenceBinding,
  ) => ReleaseUnitMutationEvidenceClosure;
  readonly readUnitMutationEvidenceReceipt: (input: {
    readonly evidence_sink_id: string;
    readonly receipt_digest_sha256: string;
  }) => UnitMutationEvidenceReceipt;
  readonly readUnitMutationEvidenceBlob: (input: {
    readonly binding: UnitMutationEvidenceBinding;
    readonly identity: UnitMutationEvidenceObject;
  }) => Buffer;
}

const fail = (): never => {
  throw new Error(ERROR);
};
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const order = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

function closed(value: unknown, fields: readonly string[]): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    !([Object.prototype, null] as unknown[]).includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== fields.length
  )
    fail();
  for (const key of fields) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property?.enumerable || !('value' in property)) fail();
  }
}

function list(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 100_000 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  for (let index = 0; index < value.length; index += 1) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property?.enumerable || !('value' in property)) fail();
  }
  return value;
}

function name(value: unknown, maximum = 200): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.normalize('NFC') ||
    /\p{Cc}|\p{Cs}/u.test(value)
  )
    fail();
}

function path(value: unknown): void {
  name(value, 4096);
  if (
    value.includes('\\') ||
    value.includes(':') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    fail();
}

function boundary<T>(fn: () => T): T {
  try {
    return fn();
  } catch {
    return fail();
  }
}

/** Pure identity validation; this grants no sink or producer authority. */
export function captureUnitMutationEvidenceBinding(
  value: UnitMutationEvidenceBinding,
): UnitMutationEvidenceBinding {
  return boundary(() => {
    closed(value, [
      'repository_id',
      'candidate_commit',
      'candidate_tree',
      'release_unit',
      'release_plan_receipt_digest_sha256',
      'release_profile_digest_sha256',
      'mutation_policy_digest_sha256',
      'task_policy_digests_sha256',
    ]);
    name(value.repository_id);
    name(value.release_unit);
    for (const id of [value.candidate_commit, value.candidate_tree])
      if (typeof id !== 'string' || !GIT.test(id)) fail();
    if (value.candidate_commit.length !== value.candidate_tree.length) fail();
    const tasks = list(value.task_policy_digests_sha256);
    if (tasks.length === 0) fail();
    for (const digest of [
      value.release_plan_receipt_digest_sha256,
      value.release_profile_digest_sha256,
      value.mutation_policy_digest_sha256,
      ...tasks,
    ])
      if (typeof digest !== 'string' || !SHA.test(digest)) fail();
    const sorted = [...value.task_policy_digests_sha256].sort(order);
    if (new Set(sorted).size !== sorted.length || !same(sorted, tasks)) fail();
    return JSON.parse(canonicalJson(value)) as UnitMutationEvidenceBinding;
  });
}

function objectIdentity(value: UnitMutationEvidenceObject, member: boolean): void {
  closed(value, [
    'path',
    'sha256',
    'size_bytes',
    'evidence_sink_id',
    'opaque_handle',
    ...(member ? ['document_kind', 'package_name'] : []),
  ]);
  path(value.path);
  if (
    typeof value.sha256 !== 'string' ||
    !SHA.test(value.sha256) ||
    !Number.isSafeInteger(value.size_bytes) ||
    value.size_bytes < 1 ||
    typeof value.evidence_sink_id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value.evidence_sink_id) ||
    value.opaque_handle !== `sha256:${value.sha256}`
  )
    fail();
}

/** The protected sink calls this only after verifying the retained canonical documents. */
export function finalizeUnitMutationEvidenceClosure(
  binding: UnitMutationEvidenceBinding,
  projection: UnitMutationEvidenceProjection,
): ReleaseUnitMutationEvidenceClosure {
  return boundary(() => {
    const identity = captureUnitMutationEvidenceBinding(binding);
    closed(projection, ['summary_path', 'semantic_receipt_path', 'output_contract', 'members']);
    path(projection.summary_path);
    path(projection.semantic_receipt_path);
    objectIdentity(projection.output_contract, false);
    list(projection.members);
    const paths = new Set([projection.output_contract.path]);
    let previous: string | undefined;
    const packages = new Map<string, Set<string>>();
    let summaryCount = 0;
    let semanticCount = 0;
    for (const member of projection.members) {
      objectIdentity(member, true);
      if (
        !KINDS.includes(member.document_kind) ||
        member.evidence_sink_id !== projection.output_contract.evidence_sink_id ||
        paths.has(member.path) ||
        (previous !== undefined && order(previous, member.path) >= 0)
      )
        fail();
      previous = member.path;
      paths.add(member.path);
      if (member.document_kind === KINDS[0] || member.document_kind === KINDS[1]) {
        name(member.package_name);
        const kinds = packages.get(member.package_name) ?? new Set<string>();
        if (kinds.has(member.document_kind)) fail();
        kinds.add(member.document_kind);
        packages.set(member.package_name, kinds);
      } else {
        if (member.package_name !== null) fail();
        if (member.document_kind === KINDS[2]) {
          summaryCount += 1;
          if (member.path !== projection.summary_path) fail();
        } else {
          semanticCount += 1;
          if (member.path !== projection.semantic_receipt_path) fail();
        }
      }
    }
    if (
      summaryCount !== 1 ||
      semanticCount !== 1 ||
      [...packages.values()].some((kinds) => kinds.size !== 2)
    )
      fail();
    const draft = {
      kind: 'release-unit-mutation-evidence-receipt-v1' as const,
      canonicalization: 'utf-8-rfc8785-jcs-sha256' as const,
      referent: {
        ...identity,
        member_projection_digest_sha256: canonicalSha256(projection.members),
        output_contract_digest_sha256: projection.output_contract.sha256,
      },
    };
    return JSON.parse(
      canonicalJson({
        schemaVersion: '1.0.0',
        kind: 'release-unit-mutation-evidence-closure-v1',
        release_unit: identity.release_unit,
        member_order: ORDER,
        ...projection,
        receipt: { ...draft, receipt_digest_sha256: canonicalSha256(draft) },
      }),
    ) as ReleaseUnitMutationEvidenceClosure;
  });
}

/** Checks the complete closed projection, not just a caller-supplied receipt digest. */
export function verifyUnitMutationEvidenceClosure(
  value: ReleaseUnitMutationEvidenceClosure,
  expected: UnitMutationEvidenceBinding,
): void {
  boundary(() => {
    closed(value, [
      'schemaVersion',
      'kind',
      'release_unit',
      'member_order',
      'summary_path',
      'semantic_receipt_path',
      'output_contract',
      'members',
      'receipt',
    ]);
    const rebuilt = finalizeUnitMutationEvidenceClosure(expected, {
      summary_path: value.summary_path,
      semantic_receipt_path: value.semantic_receipt_path,
      output_contract: value.output_contract,
      members: value.members,
    });
    // Validate receipt data descriptors before canonicalization can observe them.
    closed(value.receipt, ['kind', 'canonicalization', 'referent', 'receipt_digest_sha256']);
    closed(value.receipt.referent, Object.keys(rebuilt.receipt.referent));
    const { member_projection_digest_sha256, output_contract_digest_sha256, ...binding } =
      value.receipt.referent;
    captureUnitMutationEvidenceBinding(binding);
    if (
      typeof member_projection_digest_sha256 !== 'string' ||
      !SHA.test(member_projection_digest_sha256) ||
      typeof output_contract_digest_sha256 !== 'string' ||
      !SHA.test(output_contract_digest_sha256) ||
      typeof value.receipt.kind !== 'string' ||
      typeof value.receipt.canonicalization !== 'string' ||
      typeof value.receipt.receipt_digest_sha256 !== 'string'
    )
      fail();
    if (!same(value, rebuilt)) fail();
  });
}

/** Pure bounded reread/semantic check shared by retention and bundle-backed offline readers. */
export async function verifyUnitMutationEvidenceDocuments(input: {
  readonly closure: ReleaseUnitMutationEvidenceClosure;
  readonly expected: UnitMutationEvidenceBinding;
  readonly maximum_bytes: number;
  readonly read: (identity: UnitMutationEvidenceObject) => Uint8Array | Promise<Uint8Array>;
}): Promise<void> {
  try {
    closed(input, ['closure', 'expected', 'maximum_bytes', 'read']);
    if (
      !Number.isSafeInteger(input.maximum_bytes) ||
      input.maximum_bytes < 1 ||
      typeof input.read !== 'function'
    )
      fail();
    verifyUnitMutationEvidenceClosure(input.closure, input.expected);
    // Capture before awaiting a reader; it cannot mutate the identity being verified.
    const closure = JSON.parse(canonicalJson(input.closure)) as ReleaseUnitMutationEvidenceClosure;
    const expected = captureUnitMutationEvidenceBinding(input.expected);
    const read = input.read;
    const limit = input.maximum_bytes;
    const documents = new Map<string, { bytes: Buffer; value: Json }>();
    let total = 0;
    for (const identity of [closure.output_contract, ...closure.members]) {
      total += identity.size_bytes;
      if (!Number.isSafeInteger(total) || total > limit) fail();
      const raw = await read({
        path: identity.path,
        sha256: identity.sha256,
        size_bytes: identity.size_bytes,
        evidence_sink_id: identity.evidence_sink_id,
        opaque_handle: identity.opaque_handle,
      });
      if (!(raw instanceof Uint8Array) || raw.byteLength !== identity.size_bytes) fail();
      const bytes = Buffer.from(raw);
      if (createHash('sha256').update(bytes).digest('hex') !== identity.sha256) fail();
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Json;
      if (
        !bytes.equals(Buffer.from(canonicalJson(value))) ||
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value)
      )
        fail();
      documents.set(identity.path, { bytes, value });
    }
    const contract = documents.get(closure.output_contract.path)?.value ?? fail();
    if (
      contract['summaryPath'] !== closure.summary_path ||
      contract['semanticReceiptPath'] !== closure.semantic_receipt_path ||
      contract['releasePlanReceiptDigest'] !== expected.release_plan_receipt_digest_sha256 ||
      contract['releaseProfileDigest'] !== expected.release_profile_digest_sha256 ||
      contract['policyDigest'] !== expected.mutation_policy_digest_sha256 ||
      !same(
        [...(contract['paths'] as string[])].sort(order),
        closure.members.map((member) => member.path),
      )
    )
      fail();
    for (const member of closure.members) {
      const document = documents.get(member.path)?.value;
      if (
        !document ||
        document['kind'] !== member.document_kind ||
        (member.document_kind === KINDS[1] && document['packageName'] !== member.package_name)
      )
        fail();
    }
    const required = list(contract['packages']).filter(
      (entry) => (entry as Json)['requirement'] === 'required',
    ) as readonly Json[];
    if (closure.members.length !== 2 * required.length + 2) fail();
    for (const entry of required) {
      for (const [field, kind] of [
        ['reportPath', KINDS[0]],
        ['resultPath', KINDS[1]],
      ] as const) {
        const member = closure.members.find((item) => item.path === entry[field]);
        if (member?.document_kind !== kind || member.package_name !== entry['packageName']) fail();
      }
    }
    const result = await verifyMutationEvidenceV21(
      contract,
      (path) => documents.get(path)?.bytes ?? fail(),
      {
        releaseUnit: expected.release_unit,
        candidateCommit: expected.candidate_commit,
        candidateTree: expected.candidate_tree,
        mutationVerificationMode: 'offline',
      },
    );
    if (result['passed'] !== true) fail();
  } catch {
    fail();
  }
}
