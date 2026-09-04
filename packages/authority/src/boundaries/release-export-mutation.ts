import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { types } from 'node:util';

export interface ExportMutationObjectIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly evidence_sink_id: string;
  readonly opaque_handle: string;
}

export interface ExportMutationMemberIdentity extends ExportMutationObjectIdentity {
  readonly document_kind:
    | 'mutation-normalized-stryker-report-v2'
    | 'mutation-package-result-v2'
    | 'mutation-composed-report-set-v2'
    | 'mutation-semantic-verification-receipt-v2';
  readonly package_name: string | null;
}

export interface ExportMutationUnitProjection {
  readonly release_unit: string;
  readonly mutation_evidence: null | {
    readonly carrier_package_id: string;
    readonly binding: {
      readonly repository_id: string;
      readonly candidate_commit: string;
      readonly candidate_tree: string;
      readonly release_unit: string;
      readonly release_plan_receipt_digest_sha256: string;
      readonly release_profile_digest_sha256: string;
      readonly mutation_policy_digest_sha256: string;
      readonly task_policy_digests_sha256: readonly string[];
    };
    readonly closure: { readonly sha256: string; readonly size_bytes: number };
    readonly receipt: {
      readonly sha256: string;
      readonly size_bytes: number;
      readonly receipt_digest_sha256: string;
    };
    readonly output_contract: ExportMutationObjectIdentity;
    readonly members: readonly ExportMutationMemberIdentity[];
    readonly member_projection_digest_sha256: string;
  };
}

const SHA = /^[a-f0-9]{64}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const KINDS = [
  'mutation-normalized-stryker-report-v2',
  'mutation-package-result-v2',
  'mutation-composed-report-set-v2',
  'mutation-semantic-verification-receipt-v2',
];
function fail(): never {
  throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return fail();
  }
  return value as Record<string, unknown>;
}
function list(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  for (let i = 0; i < value.length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !('value' in descriptor)) return fail();
  }
  return value;
}
function text(value: unknown, maximum = 200): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.normalize('NFC') ||
    /[\p{Cc}\p{Cs}]/u.test(value)
  )
    return fail();
  return value;
}
function digest(value: unknown): void {
  if (typeof value !== 'string' || !SHA.test(value)) fail();
}
function identity(value: unknown, receipt = false): void {
  const item = record(value, [
    'sha256',
    'size_bytes',
    ...(receipt ? ['receipt_digest_sha256'] : []),
  ]);
  digest(item['sha256']);
  if (!Number.isSafeInteger(item['size_bytes']) || (item['size_bytes'] as number) < 1) fail();
  if (receipt) digest(item['receipt_digest_sha256']);
}
function objectIdentity(value: unknown, member: boolean): ExportMutationObjectIdentity {
  const item = record(value, [
    'path',
    'sha256',
    'size_bytes',
    'evidence_sink_id',
    'opaque_handle',
    ...(member ? ['document_kind', 'package_name'] : []),
  ]);
  const path = text(item['path'], 512);
  if (
    path.includes('\\') ||
    path.includes(':') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    fail();
  identity({ sha256: item['sha256'], size_bytes: item['size_bytes'] });
  if (
    !OPAQUE.test(text(item['evidence_sink_id'])) ||
    item['opaque_handle'] !== `sha256:${String(item['sha256'])}`
  )
    fail();
  return item as unknown as ExportMutationObjectIdentity;
}
function ordered(previous: string | undefined, next: string): void {
  if (previous !== undefined && Buffer.compare(Buffer.from(previous), Buffer.from(next)) >= 0)
    fail();
}

/** Data-only validation. Full profile requirements and evidence semantics are checked by the host. */
export function captureExportMutationUnitProjections(
  value: unknown,
  packages: readonly { readonly package_id: string; readonly release_unit: string }[],
  expected: {
    readonly repository: { readonly id: string; readonly commit: string; readonly tree: string };
    readonly plan_receipt_digest_sha256: string;
  },
  maximumPackages: number,
): readonly ExportMutationUnitProjection[] {
  try {
    if (!Number.isSafeInteger(maximumPackages) || maximumPackages < 1) fail();
    const roster = new Map<string, string[]>();
    const packageIds = new Set<string>();
    for (const raw of list(packages, maximumPackages)) {
      const row = record(raw, ['package_id', 'release_unit']);
      const packageId = text(row['package_id'], 214);
      if (!PACKAGE.test(packageId) || packageIds.has(packageId)) fail();
      packageIds.add(packageId);
      const unit = text(row['release_unit']);
      roster.set(unit, [...(roster.get(unit) ?? []), packageId]);
    }
    const units = list(value, maximumPackages);
    if (roster.size === 0 || units.length !== roster.size) fail();
    let previous: string | undefined;
    for (const raw of units) {
      const unit = record(raw, ['release_unit', 'mutation_evidence']);
      const unitId = text(unit['release_unit']);
      ordered(previous, unitId);
      previous = unitId;
      const unitPackages = roster.get(unitId);
      if (!unitPackages) fail();
      const rawEvidence = unit['mutation_evidence'];
      if (rawEvidence === null) continue;
      const evidence = record(rawEvidence, [
        'carrier_package_id',
        'binding',
        'closure',
        'receipt',
        'output_contract',
        'members',
        'member_projection_digest_sha256',
      ]);
      if (
        evidence['carrier_package_id'] !==
        [...unitPackages].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))[0]
      )
        fail();
      const binding = record(evidence['binding'], [
        'repository_id',
        'candidate_commit',
        'candidate_tree',
        'release_unit',
        'release_plan_receipt_digest_sha256',
        'release_profile_digest_sha256',
        'mutation_policy_digest_sha256',
        'task_policy_digests_sha256',
      ]);
      if (
        binding['repository_id'] !== expected.repository.id ||
        binding['candidate_commit'] !== expected.repository.commit ||
        binding['candidate_tree'] !== expected.repository.tree ||
        binding['release_unit'] !== unitId ||
        binding['release_plan_receipt_digest_sha256'] !== expected.plan_receipt_digest_sha256
      )
        fail();
      digest(binding['release_profile_digest_sha256']);
      digest(binding['mutation_policy_digest_sha256']);
      const tasks = list(binding['task_policy_digests_sha256'], 100_000);
      if (tasks.length === 0) fail();
      let previousTask: string | undefined;
      for (const task of tasks) {
        digest(task);
        ordered(previousTask, task as string);
        previousTask = task as string;
      }
      identity(evidence['closure']);
      identity(evidence['receipt'], true);
      const control = objectIdentity(evidence['output_contract'], false);
      const members = list(evidence['members'], 100_000);
      const paths = new Set([control.path]);
      const pairs = new Map<string, Set<string>>();
      let previousPath: string | undefined;
      let summaries = 0;
      let receipts = 0;
      for (const rawMember of members) {
        const member = objectIdentity(rawMember, true) as ExportMutationMemberIdentity;
        ordered(previousPath, member.path);
        previousPath = member.path;
        if (
          paths.has(member.path) ||
          member.evidence_sink_id !== control.evidence_sink_id ||
          !KINDS.includes(member.document_kind)
        )
          fail();
        paths.add(member.path);
        if (member.document_kind === KINDS[0] || member.document_kind === KINDS[1]) {
          const packageName = text(member.package_name, 214);
          if (!PACKAGE.test(packageName)) fail();
          const kinds = pairs.get(packageName) ?? new Set<string>();
          if (kinds.has(member.document_kind)) fail();
          kinds.add(member.document_kind);
          pairs.set(packageName, kinds);
        } else {
          if (member.package_name !== null) fail();
          if (member.document_kind === KINDS[2]) summaries += 1;
          else receipts += 1;
        }
      }
      if (
        summaries !== 1 ||
        receipts !== 1 ||
        [...pairs.values()].some((kinds) => kinds.size !== 2) ||
        members.length !== 2 * pairs.size + 2 ||
        evidence['member_projection_digest_sha256'] !== canonicalSha256(members)
      )
        fail();
    }
    return JSON.parse(canonicalJson(value)) as readonly ExportMutationUnitProjection[];
  } catch {
    return fail();
  }
}
