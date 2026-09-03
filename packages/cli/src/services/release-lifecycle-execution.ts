import {
  closeSync,
  closeReadOnlySync,
  existsSync,
  fileOpenConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  openReadOnlyNoFollowSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from '@devai-nyx/authority';
import { parsers } from '@devai-nyx/schemas';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { verifyReleasePlanReceipt } from './release-lifecycle.js';

export const RELEASE_ACTIONS = [
  'release plan',
  'release preflight',
  'release certify',
  'release prepare',
  'release export',
  'release offline-verify',
  'release evidence-publish',
  'release publish',
  'release resume',
] as const;

export type ReleaseAction = (typeof RELEASE_ACTIONS)[number];
export type PersistedReleaseAction = Exclude<
  ReleaseAction,
  'release plan' | 'release offline-verify' | 'release resume'
>;
export type PersistedReleaseState =
  | 'preflight_passed'
  | 'certified'
  | 'prepared'
  | 'exported'
  | 'evidence_published'
  | 'publication_dispatched';

export interface ArtifactIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

export interface TrustIdentity {
  readonly trust_root_id: string;
  readonly trust_store_digest_sha256: string;
  readonly key_id: string;
  readonly signature_algorithm: 'ed25519' | 'ecdsa-p256-sha256' | 'rsa-pss-sha256';
}

export interface ReleaseLifecycleRequest extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '1.0.0';
  readonly request_kind: 'release-lifecycle-request';
  readonly action_id: ReleaseAction;
  readonly repository_locator: {
    readonly id: string;
    readonly commit: string;
    readonly tree: string;
  };
  readonly candidate_locator: {
    readonly commit: string;
    readonly tree: string;
    readonly release_units: readonly {
      readonly release_unit: string;
      readonly version: string;
      readonly package_roster: readonly {
        readonly package_id: string;
        readonly manifest_path: string;
        readonly manifest_digest_sha256: string;
      }[];
    }[];
  };
  readonly receipt_locators?: readonly {
    readonly kind: 'release-plan-receipt' | 'release-offline-verification-receipt';
    readonly receipt_id: string;
    readonly receipt_digest_sha256: string;
    readonly path: string;
  }[];
  readonly provider?: { readonly kind: string; readonly provider_id: string };
  readonly destination?: {
    readonly kind: string;
    readonly exact_identifier: string;
    readonly trust?: TrustIdentity;
  };
}

export interface PackageEvidence {
  readonly package_id: string;
  readonly manifest: ArtifactIdentity | null;
  readonly tarball: ArtifactIdentity | null;
  readonly sbom: ArtifactIdentity | null;
  readonly evidence_manifest: ArtifactIdentity | null;
  readonly provider_result: ArtifactIdentity | null;
  readonly trust: TrustIdentity | null;
}

export interface ReleaseUnitEvidence {
  readonly release_unit: string;
  readonly version: string;
  readonly packages: readonly PackageEvidence[];
}

export interface ReleaseStateMaterial {
  readonly release_units: readonly ReleaseUnitEvidence[];
  readonly inputs: readonly {
    readonly kind: string;
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly evidence: {
    readonly manifest_digest_sha256: string;
    readonly receipt_digests: readonly string[];
    readonly independently_checkable: true;
  };
  readonly artifacts: readonly {
    readonly kind: string;
    readonly path: string;
    readonly sha256: string;
    readonly size_bytes: number;
  }[];
}

export interface TrustedReleaseAuthority {
  readonly actor: {
    readonly kind: 'human';
    readonly role: 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
    readonly declaration_source: 'cli-flag' | 'session-state';
  };
  readonly consent: {
    readonly write: true;
    readonly allow_publish: boolean;
    readonly experimental: false;
  };
}

export interface PublicationControls {
  readonly destination: {
    readonly system_id: string;
    readonly exact_identifier: string;
    readonly operation: 'publish';
  };
  readonly workflow: {
    readonly repository: string;
    readonly workflow_path: string;
    readonly workflow_sha: string;
    readonly protected_environment: string;
    readonly protected: true;
  };
  readonly trust: TrustIdentity;
}

export interface ReleaseLifecycleStateV2 extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '2.0.0';
  readonly state_id: string;
  readonly state: PersistedReleaseState;
  readonly action_id: PersistedReleaseAction;
  readonly repository: ReleaseLifecycleRequest['repository_locator'];
  readonly candidate: {
    readonly release_unit: string;
    readonly version: string;
    readonly commit: string;
    readonly tree: string;
  };
  readonly release_units: readonly ReleaseUnitEvidence[];
  readonly prior_state: StateReference | null;
  readonly storage: { readonly generation: number; readonly head_before: StateStorageHead | null };
  readonly record_digest_sha256: string;
}

export interface StateReference {
  readonly state: PersistedReleaseState;
  readonly state_id: string;
  readonly record_digest_sha256: string;
}

export interface StateStorageHead {
  readonly generation: number;
  readonly record_digest_sha256: string;
}

export interface StoreHead extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '2.0.0';
  readonly canonicalization: Readonly<Record<string, unknown>>;
  readonly repository: ReleaseLifecycleRequest['repository_locator'];
  readonly candidate: { readonly commit: string; readonly tree: string };
  readonly generation: number;
  readonly state_id: string;
  readonly state_digest_sha256: string;
  readonly completion_record: StoreRecordReference & { readonly attempt_id: string };
  readonly head_digest_sha256: string;
}

export interface StoreRecord extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '1.0.0';
  readonly record_kind: 'attempt' | 'completion' | 'failure' | 'unknown-provider-result';
  readonly record_id: string;
  readonly record_digest_sha256: string;
  readonly sequence: number;
  readonly predecessor_record: StoreRecordReference | null;
  readonly observed_head_before: StoreHead | null;
  readonly attempt_id: string;
  readonly action_id: PersistedReleaseAction;
  readonly request_digest_sha256: string;
  readonly authorization_event_id: string | null;
  readonly provider_handle: string | null;
  readonly provider_dispatch: {
    readonly status: 'not-dispatched' | 'failed-before-dispatch' | 'dispatched' | 'unknown';
    readonly handle_observed: boolean;
  };
  readonly completion: {
    readonly state_id: string;
    readonly state_digest_sha256: string;
    readonly state: PersistedReleaseState;
  } | null;
  readonly failure: { readonly code: string; readonly retryable: false } | null;
  readonly unknown: {
    readonly code: 'release-provider-result-unknown';
    readonly redispatch_permitted: false;
  } | null;
}

interface StoreRecordReference {
  readonly sequence: number;
  readonly record_id: string;
  readonly record_digest_sha256: string;
}

export interface ReleaseProviderResult {
  readonly outcome: 'success' | 'failure' | 'unknown';
  readonly dispatch_status?: 'failed-before-dispatch' | 'dispatched' | 'unknown';
  readonly provider_handle?: string;
  readonly material?: ReleaseStateMaterial;
  readonly code?: string;
}

export type ReleaseProvider = (
  request: ReleaseLifecycleRequest,
) => ReleaseProviderResult | Promise<ReleaseProviderResult>;

export type OfflineVerificationProvider = (
  request: ReleaseLifecycleRequest,
  exportedState: ReleaseLifecycleStateV2,
) => unknown | Promise<unknown>;

export type ReleasePlanInputResolver = (input: Readonly<Record<string, unknown>>) => unknown;

export interface TrustedOfflineReceiptVerifier {
  readonly verify: (input: {
    readonly repository: ReleaseLifecycleRequest['repository_locator'];
    readonly candidate_locator: ReleaseLifecycleRequest['candidate_locator'];
    readonly exported_state: ReleaseLifecycleStateV2;
    readonly receipt: Readonly<Record<string, unknown>>;
  }) => unknown | Promise<unknown>;
}

interface AuthorizationLedgerHead {
  readonly ledger_id: string;
  readonly sequence: number;
  readonly event_id: string;
  readonly event_digest_sha256: string;
}

export type AuthorizationResolution =
  | {
      readonly ok: true;
      readonly ledger: unknown;
      readonly events: readonly unknown[];
    }
  | { readonly ok: false; readonly code: string };

export interface AuthorizationConsumptionProof {
  readonly durable: true;
  readonly ledger: unknown;
  readonly events: readonly unknown[];
}

export interface AuthorizationBridge {
  readonly resolve: (
    binding: AuthorizationAttemptBinding,
  ) => AuthorizationResolution | Promise<AuthorizationResolution>;
  readonly consume: (
    binding: AuthorizationAttemptBinding & { readonly grant_event_id: string },
  ) => AuthorizationConsumptionProof | Promise<AuthorizationConsumptionProof>;
}

export interface AuthorizationAttemptBinding {
  readonly attempt_id: string;
  readonly action_id: PersistedReleaseAction;
  readonly request_digest_sha256: string;
  readonly repository: ReleaseLifecycleRequest['repository_locator'];
  readonly candidate: ReleaseLifecycleStateV2['candidate'];
  readonly destination: {
    readonly system_id: string;
    readonly exact_identifier: string;
    readonly operation: 'create' | 'publish';
  };
}

export type ReceiptResolver = (
  locator: NonNullable<ReleaseLifecycleRequest['receipt_locators']>[number],
) => unknown;

const FORBIDDEN_REQUEST_KEYS = new Set([
  'state_id',
  'generation',
  'head',
  'digest',
  'record_digest_sha256',
  'actor',
  'role',
  'authority',
  'authorization',
  'consent',
  'effective_authorities',
  'provider_result',
  'provider_handle',
]);

const STATE_BY_ACTION: Readonly<Record<PersistedReleaseAction, PersistedReleaseState>> = {
  'release preflight': 'preflight_passed',
  'release certify': 'certified',
  'release prepare': 'prepared',
  'release export': 'exported',
  'release evidence-publish': 'evidence_published',
  'release publish': 'publication_dispatched',
};

const PRIOR_BY_STATE: Readonly<Record<PersistedReleaseState, PersistedReleaseState | null>> = {
  preflight_passed: null,
  certified: 'preflight_passed',
  prepared: 'certified',
  exported: 'prepared',
  evidence_published: 'exported',
  publication_dispatched: 'evidence_published',
};

const EFFECT_BY_ACTION = {
  'release preflight': 'harness-write',
  'release certify': 'harness-write',
  'release prepare': 'local-write',
  'release export': 'local-write',
  'release evidence-publish': 'remote-write',
  'release publish': 'remote-write',
} as const;

const ROLES_BY_ACTION: Readonly<Record<PersistedReleaseAction, readonly string[]>> = {
  'release preflight': ['inspector'],
  'release certify': ['inspector'],
  'release prepare': ['architect'],
  'release export': ['architect'],
  'release evidence-publish': ['owner'],
  'release publish': ['owner'],
};

const STATE_CANONICALIZATION = {
  kernel_id: 'devai.kernel.release-lifecycle-state.v2',
  encoding: 'utf-8',
  json_form: 'rfc8785-jcs',
  digest_algorithm: 'sha256',
  projection_excludes: ['state_id', 'record_digest_sha256'],
  id_derivation: 'RLS-hyphen-plus-first-16-lowercase-hex-of-record_digest_sha256',
} as const;

const STORE_CANONICALIZATION = {
  json_form: 'rfc8785-jcs',
  encoding: 'utf-8',
  digest_algorithm: 'sha256',
  projection_excludes: ['record_id', 'record_digest_sha256'],
  id_derivation: 'RLE-hyphen-plus-first-16-lowercase-hex-of-record_digest_sha256',
} as const;

const HEAD_CANONICALIZATION = {
  kernel_id: 'devai.kernel.release-lifecycle-store-head.v2',
  encoding: 'utf-8',
  json_form: 'rfc8785-jcs',
  digest_algorithm: 'sha256',
  projection_excludes: ['head_digest_sha256'],
} as const;

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('release-request-projection-invalid');
  }
  return value as Readonly<Record<string, unknown>>;
}

function rejectForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectForbiddenKeys(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Readonly<Record<string, unknown>>)) {
    if (FORBIDDEN_REQUEST_KEYS.has(key))
      throw new Error(`release-request-projection-invalid:${key}`);
    rejectForbiddenKeys(child);
  }
}

function assertSortedUnique(values: readonly string[], code: string): void {
  const sorted = [...values].sort();
  if (
    new Set(values).size !== values.length ||
    values.some((value, index) => value !== sorted[index])
  ) {
    throw new Error(code);
  }
}

export function validateReleaseLifecycleRequest(
  value: unknown,
  expectedAction?: ReleaseAction,
): ReleaseLifecycleRequest {
  rejectForbiddenKeys(value);
  const parsed = parsers.releaseLifecycleRequest.safeParse<ReleaseLifecycleRequest>(value);
  if (!parsed.ok) throw new Error('release-request-projection-invalid');
  const request = parsed.value;
  if (expectedAction !== undefined && request.action_id !== expectedAction) {
    throw new Error('release-request-action-mismatch');
  }
  if (
    request.repository_locator.commit !== request.candidate_locator.commit ||
    request.repository_locator.tree !== request.candidate_locator.tree
  ) {
    throw new Error('release-request-identity-mismatch');
  }
  assertSortedUnique(
    request.candidate_locator.release_units.map((unit) => `${unit.release_unit}\0${unit.version}`),
    'release-release-unit-bijection-invalid',
  );
  for (const unit of request.candidate_locator.release_units) {
    assertSortedUnique(
      unit.package_roster.map((pkg) => pkg.package_id),
      'release-release-unit-bijection-invalid',
    );
  }
  if (request.receipt_locators !== undefined) {
    assertSortedUnique(
      request.receipt_locators.map((receipt) => `${receipt.kind}\0${receipt.receipt_id}`),
      'release-request-receipt-order-invalid',
    );
  }
  const receiptKinds = request.receipt_locators?.map((receipt) => receipt.kind) ?? [];
  if (
    request.action_id !== 'release plan' &&
    request.action_id !== 'release evidence-publish' &&
    request.action_id !== 'release resume' &&
    (receiptKinds.length !== request.candidate_locator.release_units.length ||
      receiptKinds.some((kind) => kind !== 'release-plan-receipt'))
  ) {
    throw new Error('release-receipt-identity-mismatch');
  }
  if (
    request.action_id === 'release evidence-publish' &&
    (receiptKinds.length !== 1 || receiptKinds[0] !== 'release-offline-verification-receipt')
  ) {
    throw new Error('release-receipt-identity-mismatch');
  }
  return request;
}

export function computeReleaseRequestDigest(request: ReleaseLifecycleRequest): string {
  return canonicalSha256(request);
}

function without(value: Readonly<Record<string, unknown>>, keys: readonly string[]) {
  const excluded = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key)));
}

interface VerifiedReceipt {
  readonly kind: 'release-plan-receipt' | 'release-offline-verification-receipt';
  readonly value: Readonly<Record<string, unknown>>;
}

function verifyPlanReceiptSemantics(
  receipt: Readonly<Record<string, unknown>>,
  resolveInput: ReleasePlanInputResolver | undefined,
): void {
  if (resolveInput === undefined) throw new Error('rpl-semantic-verification-not-performed');
  const inputs = receipt['inputs'];
  if (!Array.isArray(inputs)) throw new Error('rpl-input-set-mismatch');
  const byKind = new Map(
    inputs.map((input) => {
      const value = object(input);
      return [String(value['kind']), value] as const;
    }),
  );
  const intent = byKind.get('release-intent');
  const profile = byKind.get('release-verification-profile');
  const lifecycle = byKind.get('release-lifecycle-policy');
  const actions = byKind.get('action-registry-policy');
  const repository = object(receipt['repository']);
  if (
    intent === undefined ||
    profile === undefined ||
    lifecycle === undefined ||
    actions === undefined ||
    typeof repository['id'] !== 'string' ||
    typeof intent['path'] !== 'string' ||
    !verifyReleasePlanReceipt({
      receipt,
      repository_id: repository['id'],
      intent_path: intent['path'],
      intent: resolveInput(intent),
      release_verification_profile: resolveInput(profile),
      release_lifecycle_policy: resolveInput(lifecycle),
      action_registry: resolveInput(actions),
    })
  ) {
    throw new Error('rpl-semantic-verification-not-performed');
  }
}

function verifyReceiptDocument(
  valueInput: unknown,
  resolvePlanInput?: ReleasePlanInputResolver,
): VerifiedReceipt {
  const value = object(valueInput);
  const kind = value['receipt_kind'];
  if (kind !== 'release-plan-receipt' && kind !== 'release-offline-verification-receipt') {
    throw new Error('release-receipt-identity-mismatch');
  }
  const parsed =
    kind === 'release-plan-receipt'
      ? parsers.releasePlanReceipt.safeParse<Readonly<Record<string, unknown>>>(value)
      : parsers.releaseOfflineVerificationReceipt.safeParse<Readonly<Record<string, unknown>>>(
          value,
        );
  if (!parsed.ok) throw new Error('release-receipt-identity-mismatch');
  const receipt = parsed.value;
  const digest = canonicalSha256(without(receipt, ['receipt_id', 'receipt_digest_sha256']));
  const prefix = kind === 'release-plan-receipt' ? 'RPL' : 'ROV';
  if (
    receipt['receipt_digest_sha256'] !== digest ||
    receipt['receipt_id'] !== `${prefix}-${digest.slice(0, 16)}` ||
    receipt['verdict'] !== 'pass'
  ) {
    throw new Error(
      receipt['verdict'] === 'pass'
        ? 'release-receipt-identity-mismatch'
        : 'release-receipt-verdict-invalid',
    );
  }
  if (kind === 'release-plan-receipt') verifyPlanReceiptSemantics(receipt, resolvePlanInput);
  return { kind, value: receipt };
}

function verifyBoundReceipts(
  request: ReleaseLifecycleRequest,
  resolver?: ReceiptResolver,
  resolvePlanInput?: ReleasePlanInputResolver,
): readonly VerifiedReceipt[] {
  const locators = request.receipt_locators ?? [];
  if (locators.length === 0) return [];
  if (resolver === undefined) throw new Error('release-receipt-provider-unavailable');
  const verified: VerifiedReceipt[] = [];
  for (const locator of locators) {
    const receipt = verifyReceiptDocument(resolver(locator), resolvePlanInput);
    const value = receipt.value;
    if (
      receipt.kind !== locator.kind ||
      value['receipt_id'] !== locator.receipt_id ||
      value['receipt_digest_sha256'] !== locator.receipt_digest_sha256
    ) {
      throw new Error('release-receipt-identity-mismatch');
    }
    const repository = object(value['repository']);
    const candidate = object(value['candidate']);
    const candidateMatch = request.candidate_locator.release_units.some(
      (unit) =>
        candidate['release_unit'] === unit.release_unit && candidate['version'] === unit.version,
    );
    if (
      !same(repository, request.repository_locator) ||
      candidate['commit'] !== request.candidate_locator.commit ||
      candidate['tree'] !== request.candidate_locator.tree ||
      !candidateMatch
    ) {
      throw new Error('release-receipt-identity-mismatch');
    }
    verified.push(receipt);
  }
  const planCandidates = verified
    .filter((receipt) => receipt.kind === 'release-plan-receipt')
    .map((receipt) => receipt.value['candidate'])
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), 'en'));
  if (
    planCandidates.length > 0 &&
    !same(
      planCandidates,
      request.candidate_locator.release_units
        .map((unit) => ({
          release_unit: unit.release_unit,
          version: unit.version,
          commit: request.candidate_locator.commit,
          tree: request.candidate_locator.tree,
        }))
        .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), 'en')),
    )
  ) {
    throw new Error('release-receipt-identity-mismatch');
  }
  return verified;
}

export function finalizeReleaseStateV2(
  draft: Omit<ReleaseLifecycleStateV2, 'state_id' | 'record_digest_sha256'>,
): ReleaseLifecycleStateV2 {
  const digest = canonicalSha256(draft);
  const state = {
    ...draft,
    state_id: `RLS-${digest.slice(0, 16)}`,
    record_digest_sha256: digest,
  };
  return parsers.releaseLifecycleState.parse<ReleaseLifecycleStateV2>(state);
}

export function verifyReleaseStateIdentity(value: unknown, write = false): ReleaseLifecycleStateV2 {
  const parsed = parsers.releaseLifecycleState.safeParse<ReleaseLifecycleStateV2>(value);
  if (!parsed.ok) throw new Error('release-state-schema-invalid');
  const state = parsed.value;
  if (write && state.schemaVersion !== '2.0.0') throw new Error('release-state-v1-write-refused');
  const projection = without(
    state,
    state.schemaVersion === '2.0.0'
      ? ['state_id', 'record_digest_sha256']
      : ['record_digest_sha256'],
  );
  const digest = canonicalSha256(projection);
  if (state.record_digest_sha256 !== digest) {
    throw new Error('release-state-id-or-digest-mismatch');
  }
  if (state.schemaVersion === '2.0.0' && state.state_id !== `RLS-${digest.slice(0, 16)}`) {
    throw new Error('release-state-id-or-digest-mismatch');
  }
  return state;
}

function storeRecordReference(record: StoreRecord): StoreRecordReference {
  return {
    sequence: record.sequence,
    record_id: record.record_id,
    record_digest_sha256: record.record_digest_sha256,
  };
}

export function finalizeStoreRecord(
  draft: Omit<StoreRecord, 'record_id' | 'record_digest_sha256'>,
): StoreRecord {
  const digest = canonicalSha256(draft);
  const record = {
    ...draft,
    record_id: `RLE-${digest.slice(0, 16)}`,
    record_digest_sha256: digest,
  };
  return parsers.releaseLifecycleStoreRecord.parse<StoreRecord>(record);
}

export function verifyStoreRecordIdentity(value: unknown): StoreRecord {
  const parsed = parsers.releaseLifecycleStoreRecord.safeParse<StoreRecord>(value);
  if (!parsed.ok) throw new Error('release-state-store-record-invalid');
  const record = parsed.value;
  const digest = canonicalSha256(without(record, ['record_id', 'record_digest_sha256']));
  if (record.record_digest_sha256 !== digest || record.record_id !== `RLE-${digest.slice(0, 16)}`) {
    throw new Error('release-state-store-record-identity-invalid');
  }
  return record;
}

export interface StoreReduction {
  readonly ok: boolean;
  readonly records: readonly StoreRecord[];
  readonly last: StoreRecord | null;
  readonly errors: readonly string[];
  readonly ambiguous: boolean;
  readonly failed: boolean;
  readonly completed_head: StoreHead | null;
}

export function reduceStoreRecords(values: readonly unknown[]): StoreReduction {
  const records: StoreRecord[] = [];
  const errors = new Set<string>();
  let prior: StoreRecord | null = null;
  let repositoryDigest: string | undefined;
  let candidateDigest: string | undefined;
  let completedHead: StoreHead | null = null;
  let completedState: PersistedReleaseState | null = null;
  let terminalUnknown = false;
  for (const value of values) {
    let record: StoreRecord;
    try {
      record = verifyStoreRecordIdentity(value);
    } catch (error) {
      errors.add(error instanceof Error ? error.message : 'release-state-store-record-invalid');
      continue;
    }
    records.push(record);
    if (record.sequence !== records.length - 1) errors.add('release-state-store-sequence-invalid');
    const expectedPrior = prior === null ? null : storeRecordReference(prior);
    if (canonicalSha256(record.predecessor_record) !== canonicalSha256(expectedPrior)) {
      errors.add('release-state-store-broken-chain');
    }
    if (!same(record.observed_head_before, completedHead)) {
      errors.add('release-state-head-mismatch');
    }
    if (terminalUnknown) errors.add('release-provider-result-unknown');
    repositoryDigest ??= canonicalSha256(record['repository']);
    candidateDigest ??= canonicalSha256(record['candidate']);
    if (repositoryDigest !== canonicalSha256(record['repository']))
      errors.add('release-state-store-repository-mismatch');
    if (candidateDigest !== canonicalSha256(record['candidate']))
      errors.add('release-state-store-candidate-mismatch');

    const remote = EFFECT_BY_ACTION[record.action_id] === 'remote-write';
    if (record.record_kind === 'attempt') {
      if (prior === null) {
        if (record.predecessor_record !== null) errors.add('release-store-opening-attempt-invalid');
      } else if (
        prior.record_kind === 'attempt' ||
        prior.record_kind === 'unknown-provider-result'
      ) {
        errors.add('release-store-attempt-predecessor-invalid');
      }
      if (
        prior?.record_kind === 'failure' &&
        remote &&
        record.authorization_event_id === prior.authorization_event_id
      ) {
        errors.add('fresh-exact-authorization-required');
      }
      const expectedAttempt = deriveAttemptId({
        request_digest_sha256: record.request_digest_sha256,
        action_id: record.action_id,
        sequence: record.sequence,
        predecessor_record: record.predecessor_record,
      });
      if (record.attempt_id !== expectedAttempt)
        errors.add('release-store-opening-attempt-invalid');
      if (
        record.provider_handle !== null ||
        record.provider_dispatch.status !== 'not-dispatched' ||
        record.provider_dispatch.handle_observed
      ) {
        errors.add('release-provider-handle-observation-invalid');
      }
      if (PRIOR_BY_STATE[STATE_BY_ACTION[record.action_id]] !== completedState) {
        errors.add('release-state-transition-invalid');
      }
      if (remote !== (record.authorization_event_id !== null)) {
        errors.add('release-authorization-attempt-binding-invalid');
      }
    } else {
      if (
        prior === null ||
        prior.record_kind !== 'attempt' ||
        record.predecessor_record === null ||
        !same(record.predecessor_record, storeRecordReference(prior)) ||
        record.attempt_id !== prior.attempt_id ||
        record.action_id !== prior.action_id ||
        record.request_digest_sha256 !== prior.request_digest_sha256 ||
        record.authorization_event_id !== prior.authorization_event_id ||
        !same(record.repository, prior.repository) ||
        !same(record.candidate, prior.candidate)
      ) {
        errors.add('release-store-terminal-attempt-link-invalid');
      }
      if (!same(record.observed_head_before, prior?.observed_head_before ?? null)) {
        errors.add('release-state-head-mismatch');
      }
      if (
        record.record_kind === 'completion' &&
        (record.completion?.state !== STATE_BY_ACTION[record.action_id] ||
          (remote &&
            (record.provider_dispatch.status !== 'dispatched' ||
              !record.provider_dispatch.handle_observed ||
              record.provider_handle === null)))
      ) {
        errors.add('release-store-terminal-attempt-link-invalid');
      }
      if (
        record.record_kind === 'failure' &&
        remote &&
        record.provider_dispatch.status !== 'failed-before-dispatch'
      ) {
        errors.add('release-store-terminal-attempt-link-invalid');
      }
      if (
        record.record_kind === 'unknown-provider-result' &&
        record.provider_dispatch.status !== 'unknown'
      ) {
        errors.add('release-store-completion-unknown-conflict');
      }
      if (record.record_kind === 'completion' && record.completion !== null) {
        const generation = (record.observed_head_before?.generation ?? -1) + 1;
        completedHead = finalizeStoreHead({
          schemaVersion: '2.0.0',
          canonicalization: HEAD_CANONICALIZATION,
          repository: record['repository'] as ReleaseLifecycleRequest['repository_locator'],
          candidate: {
            commit: String(object(record['candidate'])['commit']),
            tree: String(object(record['candidate'])['tree']),
          },
          generation,
          state_id: record.completion.state_id,
          state_digest_sha256: record.completion.state_digest_sha256,
          completion_record: { ...storeRecordReference(record), attempt_id: record.attempt_id },
        });
        completedState = record.completion.state;
      }
      if (record.record_kind === 'unknown-provider-result') terminalUnknown = true;
    }
    prior = record;
  }
  const pending = prior?.record_kind === 'attempt';
  const unknown = records.some((record) => record.record_kind === 'unknown-provider-result');
  return {
    ok: errors.size === 0,
    records,
    last: prior,
    errors: [...errors],
    ambiguous: pending || unknown,
    failed: prior?.record_kind === 'failure',
    completed_head: completedHead,
  };
}

function sameFileIdentity(
  left: ReturnType<typeof lstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return (
    left !== undefined &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink
  );
}

function noFollowFlags(base: number, directory = false): number {
  return (
    base |
    (fileOpenConstants.O_NOFOLLOW ?? 0) |
    (directory ? (fileOpenConstants.O_DIRECTORY ?? 0) : 0)
  );
}

function safeExistingDirectory(path: string, requirePrivate = false): void {
  const stat = lstatSync(path);
  const currentUid = typeof process.geteuid === 'function' ? process.geteuid() : undefined;
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (requirePrivate &&
      ((stat.mode & 0o077) !== 0 || (currentUid !== undefined && stat.uid !== currentUid)))
  ) {
    throw new Error('release-state-store-unsafe');
  }
  const descriptor = openReadOnlyNoFollowSync(path, true);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory() || !sameFileIdentity(stat, opened)) {
      throw new Error('release-state-store-unsafe');
    }
  } finally {
    closeReadOnlySync(descriptor);
  }
}

function ensurePrivateDirectory(path: string, requireExistingPrivate = true): void {
  const absolute = resolve(path);
  if (existsSync(absolute)) {
    safeExistingDirectory(absolute, requireExistingPrivate);
    return;
  }
  const parent = dirname(absolute);
  if (parent === absolute) throw new Error('release-state-store-unsafe');
  ensurePrivateDirectory(parent, false);
  try {
    mkdirSync(absolute, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  safeExistingDirectory(absolute, true);
}

function fsyncDirectory(path: string): void {
  const before = lstatSync(path);
  const descriptor = openSync(path, noFollowFlags(fileOpenConstants.O_RDONLY, true));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory() || !sameFileIdentity(before, opened)) {
      throw new Error('release-state-store-unsafe');
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function exclusiveWrite(path: string, value: unknown): void {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o077) !== 0) {
      throw new Error('release-state-store-unsafe');
    }
    writeSync(descriptor, `${canonicalJson(value)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

function readRegularJson(path: string): unknown {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error('release-state-store-unsafe');
  const descriptor = openReadOnlyNoFollowSync(path);
  try {
    const openedBefore = fstatSync(descriptor);
    if (
      !openedBefore.isFile() ||
      openedBefore.nlink !== 1 ||
      !sameFileIdentity(before, openedBefore)
    ) {
      throw new Error('release-state-store-unsafe');
    }
    const body = readFileSync(descriptor, 'utf8');
    const openedAfter = fstatSync(descriptor);
    if (
      !sameFileIdentity(before, openedAfter) ||
      openedBefore.size !== openedAfter.size ||
      openedBefore.mtimeMs !== openedAfter.mtimeMs ||
      openedBefore.ctimeMs !== openedAfter.ctimeMs
    ) {
      throw new Error('release-state-store-unsafe');
    }
    return JSON.parse(body) as unknown;
  } finally {
    closeReadOnlySync(descriptor);
  }
}

function same(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalSha256(left) === canonicalSha256(right);
}

function primaryCandidate(request: ReleaseLifecycleRequest): ReleaseLifecycleStateV2['candidate'] {
  const unit = request.candidate_locator.release_units[0];
  if (unit === undefined) throw new Error('release-release-unit-bijection-invalid');
  return {
    release_unit: unit.release_unit,
    version: unit.version,
    commit: request.candidate_locator.commit,
    tree: request.candidate_locator.tree,
  };
}

function authorizationDestination(
  request: ReleaseLifecycleRequest & { readonly action_id: PersistedReleaseAction },
): AuthorizationAttemptBinding['destination'] {
  if (request.destination === undefined) throw new Error('release-request-projection-invalid');
  return {
    system_id: request.destination.kind,
    exact_identifier: request.destination.exact_identifier,
    operation: request.action_id === 'release evidence-publish' ? 'create' : 'publish',
  };
}

function assertTrustedAuthority(
  action: PersistedReleaseAction,
  authority: TrustedReleaseAuthority | undefined,
): TrustedReleaseAuthority {
  if (
    authority === undefined ||
    authority.actor.kind !== 'human' ||
    !ROLES_BY_ACTION[action].includes(authority.actor.role) ||
    !['cli-flag', 'session-state'].includes(authority.actor.declaration_source) ||
    authority.consent.write !== true ||
    authority.consent.experimental !== false ||
    authority.consent.allow_publish !== (EFFECT_BY_ACTION[action] === 'remote-write')
  ) {
    throw new Error('release-authority-context-invalid');
  }
  return authority;
}

function assertPublicationControls(
  request: ReleaseLifecycleRequest & { readonly action_id: PersistedReleaseAction },
  controls: PublicationControls | undefined,
): asserts controls is PublicationControls {
  const destination = request.destination;
  const workflowPath = controls?.workflow.workflow_path ?? '';
  if (
    controls === undefined ||
    destination === undefined ||
    destination.trust === undefined ||
    controls.destination.system_id !== destination.kind ||
    controls.destination.exact_identifier !== destination.exact_identifier ||
    controls.destination.operation !== 'publish' ||
    controls.workflow.repository !== request.repository_locator.id ||
    workflowPath.startsWith('/') ||
    workflowPath.split('/').includes('..') ||
    workflowPath.includes('\\') ||
    workflowPath.includes('\0') ||
    workflowPath.length === 0 ||
    !/^[a-f0-9]{40}$/u.test(controls.workflow.workflow_sha) ||
    controls.workflow.protected_environment.length === 0 ||
    controls.workflow.protected !== true ||
    !same(controls.trust, destination.trust)
  ) {
    throw new Error('rpd-workflow-expectation-invalid');
  }
}

function eventIdentity(value: unknown): Readonly<Record<string, unknown>> {
  const parsed =
    parsers.effectAuthorizationEvent.safeParse<Readonly<Record<string, unknown>>>(value);
  if (!parsed.ok) throw new Error('release-authorization-attempt-binding-invalid');
  const event = parsed.value;
  const payloadDigest = canonicalSha256(without(event, ['event_id', 'payload_digest_sha256']));
  if (
    event['payload_digest_sha256'] !== payloadDigest ||
    event['event_id'] !== `EA-${payloadDigest.slice(0, 16)}`
  ) {
    throw new Error('release-authorization-attempt-binding-invalid');
  }
  return event;
}

function assertLedgerHead(value: AuthorizationLedgerHead): void {
  if (
    typeof value.ledger_id !== 'string' ||
    !Number.isInteger(value.sequence) ||
    value.sequence < 1 ||
    !/^EA-[a-f0-9]{16}$/u.test(value.event_id) ||
    !/^[a-f0-9]{64}$/u.test(value.event_digest_sha256)
  ) {
    throw new Error('release-authorization-attempt-binding-invalid');
  }
}

interface VerifiedAuthorizationLedger {
  readonly ledger: Readonly<Record<string, unknown>>;
  readonly head: AuthorizationLedgerHead;
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly by_id: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

function verifyAuthorizationLedgerProof(
  ledgerInput: unknown,
  eventInputs: readonly unknown[],
): VerifiedAuthorizationLedger {
  const parsed =
    parsers.effectAuthorizationLedger.safeParse<Readonly<Record<string, unknown>>>(ledgerInput);
  if (!parsed.ok) throw new Error('release-authorization-attempt-binding-invalid');
  const ledger = parsed.value;
  const entries = ledger['entries'];
  if (!Array.isArray(entries) || entries.length !== eventInputs.length || entries.length === 0) {
    throw new Error('release-authorization-attempt-binding-invalid');
  }
  const events = eventInputs.map(eventIdentity);
  const byId = new Map<string, Readonly<Record<string, unknown>>>();
  const terminalByGrant = new Set<string>();
  let priorDigest: string | null = null;
  for (const [index, event] of events.entries()) {
    const entry = object(entries[index]);
    const eventId = String(event['event_id']);
    const digest = canonicalSha256(event);
    const expectedSequence = index + 1;
    if (
      byId.has(eventId) ||
      event['ledger_id'] !== ledger['ledger_id'] ||
      event['sequence'] !== expectedSequence ||
      entry['sequence'] !== expectedSequence ||
      entry['event_id'] !== eventId ||
      entry['event_digest_sha256'] !== digest ||
      entry['previous_event_digest_sha256'] !== priorDigest ||
      entry['kind'] !== event['kind'] ||
      entry['references_event_id'] !== event['grant_event_id'] ||
      event['previous_event_digest_sha256'] !== priorDigest
    ) {
      throw new Error('release-authorization-attempt-binding-invalid');
    }
    if (event['kind'] !== 'granted') {
      const grantId = event['grant_event_id'];
      const grant = typeof grantId === 'string' ? byId.get(grantId) : undefined;
      if (
        grant === undefined ||
        terminalByGrant.has(String(grantId)) ||
        event['action_id'] !== grant['action_id'] ||
        event['effect'] !== grant['effect'] ||
        !same(event['resource'], grant['resource']) ||
        !same(event['repository'], grant['repository']) ||
        !same(event['candidate'], grant['candidate']) ||
        !same(event['grantor'], grant['grantor']) ||
        event['subject_role'] !== grant['subject_role'] ||
        !same(event['consent'], grant['consent'])
      ) {
        throw new Error('release-authorization-attempt-binding-invalid');
      }
      terminalByGrant.add(String(grantId));
      if (event['kind'] === 'consumed') {
        const consumedAt = Date.parse(String(event['recorded_at']));
        const notBefore = Date.parse(String(grant['not_before']));
        const expiresAt = Date.parse(String(grant['expires_at']));
        if (
          !Number.isFinite(consumedAt) ||
          !Number.isFinite(notBefore) ||
          !Number.isFinite(expiresAt) ||
          consumedAt < notBefore ||
          consumedAt >= expiresAt
        ) {
          throw new Error('release-authorization-attempt-binding-invalid');
        }
      }
    } else {
      const notBefore = Date.parse(String(event['not_before']));
      const expiresAt = Date.parse(String(event['expires_at']));
      if (!Number.isFinite(notBefore) || !Number.isFinite(expiresAt) || notBefore >= expiresAt) {
        throw new Error('release-authorization-attempt-binding-invalid');
      }
    }
    byId.set(eventId, event);
    priorDigest = digest;
  }
  const rawHead = object(ledger['head']);
  const head: AuthorizationLedgerHead = {
    ledger_id: String(ledger['ledger_id']),
    sequence: Number(rawHead['sequence']),
    event_id: String(rawHead['event_id']),
    event_digest_sha256: String(rawHead['event_digest_sha256']),
  };
  assertLedgerHead(head);
  const finalEvent = events.at(-1);
  if (
    finalEvent === undefined ||
    head.sequence !== events.length ||
    head.event_id !== finalEvent['event_id'] ||
    head.event_digest_sha256 !== canonicalSha256(finalEvent)
  ) {
    throw new Error('release-authorization-attempt-binding-invalid');
  }
  return { ledger, head, events, by_id: byId };
}

function grantResource(binding: AuthorizationAttemptBinding) {
  return {
    kind: 'remote',
    system_id: binding.destination.system_id,
    exact_identifier: binding.destination.exact_identifier,
    operations: [binding.destination.operation],
  } as const;
}

function verifyGrantResolution(
  resolution: AuthorizationResolution,
  binding: AuthorizationAttemptBinding,
  trustedAuthority: TrustedReleaseAuthority,
  observedAt: string,
): {
  readonly grant: Readonly<Record<string, unknown>>;
  readonly grant_event_id: string;
  readonly ledger_head: AuthorizationLedgerHead;
  readonly ledger: Readonly<Record<string, unknown>>;
  readonly events: readonly Readonly<Record<string, unknown>>[];
} {
  if (!resolution.ok) throw new Error(resolution.code);
  const verified = verifyAuthorizationLedgerProof(resolution.ledger, resolution.events);
  const grant = verified.events.at(-1);
  if (grant === undefined) throw new Error('release-authorization-attempt-binding-invalid');
  const candidate = primaryCandidateFromBinding(binding);
  const observedInstant = Date.parse(observedAt);
  const notBefore = Date.parse(String(grant['not_before']));
  const expiresAt = Date.parse(String(grant['expires_at']));
  if (
    grant['schemaVersion'] !== '1.0.0' ||
    grant['kind'] !== 'granted' ||
    grant['grant_event_id'] !== null ||
    grant['event_id'] !== verified.head.event_id ||
    canonicalSha256(grant) !== verified.head.event_digest_sha256 ||
    grant['ledger_id'] !== verified.head.ledger_id ||
    grant['action_id'] !== binding.action_id ||
    grant['effect'] !== 'remote-write' ||
    !same(grant['resource'], grantResource(binding)) ||
    !same(grant['repository'], binding.repository) ||
    !same(grant['candidate'], candidate) ||
    grant['subject_role'] !== trustedAuthority.actor.role ||
    !same(grant['grantor'], trustedAuthority.actor) ||
    !same(grant['consent'], trustedAuthority.consent) ||
    grant['one_time'] !== true ||
    grant['uses_permitted'] !== 1 ||
    grant['bearer_transferable'] !== false ||
    grant['delegable'] !== false ||
    !Number.isFinite(observedInstant) ||
    observedInstant < notBefore ||
    observedInstant >= expiresAt
  ) {
    throw new Error('release-authorization-attempt-binding-invalid');
  }
  return {
    grant,
    grant_event_id: String(grant['event_id']),
    ledger_head: verified.head,
    ledger: verified.ledger,
    events: verified.events,
  };
}

function primaryCandidateFromBinding(
  binding: AuthorizationAttemptBinding,
): ReleaseLifecycleStateV2['candidate'] {
  return binding.candidate;
}

function verifyConsumptionProof(
  proof: AuthorizationConsumptionProof,
  binding: AuthorizationAttemptBinding,
  grant: Readonly<Record<string, unknown>>,
  grantEventId: string,
  predecessor: AuthorizationLedgerHead,
  priorLedger: Readonly<Record<string, unknown>>,
  priorEvents: readonly Readonly<Record<string, unknown>>[],
): string {
  if (proof.durable !== true) throw new Error('release-authorization-consumption-not-durable');
  const verified = verifyAuthorizationLedgerProof(proof.ledger, proof.events);
  const event = verified.events.at(-1);
  if (event === undefined) throw new Error('release-authorization-consumption-not-durable');
  const eventDigest = canonicalSha256(event);
  const expectedConsumptionBinding = {
    ...binding,
    grant_event_id: grantEventId,
    ledger_predecessor_digest_sha256: predecessor.event_digest_sha256,
  };
  if (
    event['schemaVersion'] !== '2.0.0' ||
    event['kind'] !== 'consumed' ||
    event['consumed_by_state_id'] !== null ||
    event['grant_event_id'] !== grantEventId ||
    event['ledger_id'] !== predecessor.ledger_id ||
    event['sequence'] !== predecessor.sequence + 1 ||
    event['previous_event_digest_sha256'] !== predecessor.event_digest_sha256 ||
    event['action_id'] !== binding.action_id ||
    event['effect'] !== 'remote-write' ||
    !same(event['resource'], grant['resource']) ||
    !same(event['repository'], grant['repository']) ||
    !same(event['candidate'], grant['candidate']) ||
    !same(event['grantor'], grant['grantor']) ||
    event['subject_role'] !== grant['subject_role'] ||
    !same(event['consent'], grant['consent']) ||
    !same(event['consumption_binding'], expectedConsumptionBinding) ||
    verified.head.ledger_id !== predecessor.ledger_id ||
    verified.head.sequence !== event['sequence'] ||
    verified.head.event_id !== event['event_id'] ||
    verified.head.event_digest_sha256 !== eventDigest ||
    !same(
      (verified.ledger['entries'] as readonly unknown[]).slice(0, -1),
      priorLedger['entries'],
    ) ||
    !same(
      without(verified.ledger, ['head', 'entries']),
      without(priorLedger, ['head', 'entries']),
    ) ||
    !same(verified.events.slice(0, -1), priorEvents)
  ) {
    throw new Error('release-authorization-consumption-not-durable');
  }
  return String(event['event_id']);
}

export function finalizeStoreHead(draft: Omit<StoreHead, 'head_digest_sha256'>): StoreHead {
  const head = { ...draft, head_digest_sha256: canonicalSha256(draft) };
  return parsers.releaseLifecycleStoreHead.parse<StoreHead>(head);
}

export function verifyStoreHeadIdentity(value: unknown): StoreHead {
  const parsed = parsers.releaseLifecycleStoreHead.safeParse<StoreHead>(value);
  if (!parsed.ok) throw new Error('release-state-head-invalid');
  const head = parsed.value;
  if (head.head_digest_sha256 !== canonicalSha256(without(head, ['head_digest_sha256']))) {
    throw new Error('release-state-head-invalid');
  }
  return head;
}

function headForCompletion(state: ReleaseLifecycleStateV2, completion: StoreRecord): StoreHead {
  if (
    completion.record_kind !== 'completion' ||
    completion.attempt_id === '' ||
    completion.completion?.state_id !== state.state_id ||
    completion.completion.state_digest_sha256 !== state.record_digest_sha256
  ) {
    throw new Error('release-store-head-completion-mismatch');
  }
  return finalizeStoreHead({
    schemaVersion: '2.0.0',
    canonicalization: HEAD_CANONICALIZATION,
    repository: state.repository,
    candidate: { commit: state.candidate.commit, tree: state.candidate.tree },
    generation: state.storage.generation,
    state_id: state.state_id,
    state_digest_sha256: state.record_digest_sha256,
    completion_record: {
      ...storeRecordReference(completion),
      attempt_id: completion.attempt_id,
    },
  });
}

export class ReleaseLifecycleFileStore {
  readonly campaignDirectory: string;
  private executionLocked = false;

  constructor(root: string, request: ReleaseLifecycleRequest) {
    const absoluteRoot = resolve(root);
    const repositoryKey = canonicalSha256(request.repository_locator.id);
    this.campaignDirectory = join(absoluteRoot, repositoryKey, request.candidate_locator.commit);
    const escaped = relative(absoluteRoot, this.campaignDirectory);
    if (escaped.startsWith(`..${sep}`) || isAbsolute(escaped))
      throw new Error('release-state-store-unsafe');
  }

  initialize(): void {
    ensurePrivateDirectory(this.campaignDirectory);
    for (const directory of ['records', 'attempts', 'completions', 'failures', 'unknown']) {
      ensurePrivateDirectory(join(this.campaignDirectory, directory));
    }
  }

  async withExecutionLock<T>(operation: () => T | Promise<T>): Promise<T> {
    this.initialize();
    const path = join(this.campaignDirectory, '.EXECUTION.lock');
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, 'wx', 0o600);
      writeSync(descriptor, 'release-lifecycle-v2\n');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      fsyncDirectory(this.campaignDirectory);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      throw new Error(
        (error as NodeJS.ErrnoException).code === 'EEXIST'
          ? 'release-state-store-concurrent-writer'
          : 'release-state-store-unsafe',
      );
    }
    this.executionLocked = true;
    try {
      return await operation();
    } finally {
      this.executionLocked = false;
      unlinkSync(path);
      fsyncDirectory(this.campaignDirectory);
    }
  }

  readHead(): StoreHead | null {
    const path = join(this.campaignDirectory, 'HEAD.json');
    if (!existsSync(path)) return null;
    return verifyStoreHeadIdentity(readRegularJson(path));
  }

  readStateRecords(): ReleaseLifecycleStateV2[] {
    const directory = join(this.campaignDirectory, 'records');
    if (!existsSync(directory)) return [];
    safeExistingDirectory(directory);
    return readdirSync(directory)
      .map((name) => {
        if (!/^[0-9]{8}-[a-f0-9]{64}\.json$/u.test(name)) {
          throw new Error('release-state-store-unsafe');
        }
        return name;
      })
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((name) => {
        const state = verifyReleaseStateIdentity(readRegularJson(join(directory, name)), true);
        if (!name.endsWith(`-${state.record_digest_sha256}.json`)) {
          throw new Error('release-state-store-unsafe');
        }
        return state;
      });
  }

  readStoreRecords(): StoreRecord[] {
    const all: StoreRecord[] = [];
    if (existsSync(this.campaignDirectory)) {
      safeExistingDirectory(this.campaignDirectory);
      const allowed = new Set([
        'HEAD.json',
        'records',
        'attempts',
        'completions',
        'failures',
        'unknown',
        ...(this.executionLocked ? ['.EXECUTION.lock'] : []),
      ]);
      if (readdirSync(this.campaignDirectory).some((entry) => !allowed.has(entry))) {
        throw new Error('release-state-store-unsafe');
      }
    }
    for (const directoryName of ['attempts', 'completions', 'failures', 'unknown']) {
      const directory = join(this.campaignDirectory, directoryName);
      if (!existsSync(directory)) continue;
      safeExistingDirectory(directory);
      for (const name of readdirSync(directory)) {
        if (!/^[0-9]{8}-[a-f0-9]{64}\.json$/u.test(name)) {
          throw new Error('release-state-store-unsafe');
        }
        const record = verifyStoreRecordIdentity(readRegularJson(join(directory, name)));
        if (!name.endsWith(`-${record.record_digest_sha256}.json`)) {
          throw new Error('release-state-store-unsafe');
        }
        all.push(record);
      }
    }
    return all.sort(
      (left, right) =>
        left.sequence - right.sequence || left.record_id.localeCompare(right.record_id, 'en'),
    );
  }

  appendStoreRecord(record: StoreRecord): void {
    if (!this.executionLocked) throw new Error('release-state-store-lock-required');
    verifyStoreRecordIdentity(record);
    this.initialize();
    const directoryName =
      record.record_kind === 'attempt'
        ? 'attempts'
        : record.record_kind === 'completion'
          ? 'completions'
          : record.record_kind === 'failure'
            ? 'failures'
            : 'unknown';
    exclusiveWrite(
      join(
        this.campaignDirectory,
        directoryName,
        `${String(record.sequence).padStart(8, '0')}-${record.record_digest_sha256}.json`,
      ),
      record,
    );
  }

  appendStateAndAdvanceHead(
    state: ReleaseLifecycleStateV2,
    completion: StoreRecord,
    expected: StoreHead | null,
  ): void {
    if (!this.executionLocked) throw new Error('release-state-store-lock-required');
    verifyReleaseStateIdentity(state, true);
    this.initialize();
    const statePath = join(
      this.campaignDirectory,
      'records',
      `${String(state.storage.generation).padStart(8, '0')}-${state.record_digest_sha256}.json`,
    );
    exclusiveWrite(statePath, state);
    const observed = this.readHead();
    if (!same(observed, expected)) throw new Error('release-state-cas-stale-head');
    const next = headForCompletion(state, completion);
    const headPath = join(this.campaignDirectory, 'HEAD.json');
    const temporary = join(this.campaignDirectory, `.HEAD-${state.state_id}.tmp`);
    try {
      exclusiveWrite(temporary, next);
      if (!same(this.readHead(), expected)) throw new Error('release-state-cas-stale-head');
      renameSync(temporary, headPath);
      fsyncDirectory(this.campaignDirectory);
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
  }
}

function requestStoreCandidate(
  request: ReleaseLifecycleRequest,
): Readonly<Record<string, unknown>> {
  return {
    commit: request.candidate_locator.commit,
    tree: request.candidate_locator.tree,
    release_units: request.candidate_locator.release_units.map((unit) => ({
      release_unit: unit.release_unit,
      version: unit.version,
      packages: unit.package_roster.map((pkg) => ({ package_id: pkg.package_id })),
    })),
  };
}

function deriveAttemptId(input: {
  readonly request_digest_sha256: string;
  readonly action_id: PersistedReleaseAction;
  readonly sequence: number;
  readonly predecessor_record: StoreRecordReference | null;
}): string {
  return `RLA-${canonicalSha256(input).slice(0, 16)}`;
}

function buildStoreRecord(
  request: ReleaseLifecycleRequest & { readonly action_id: PersistedReleaseAction },
  prior: StoreRecord | null,
  observedHeadBefore: StoreHead | null,
  attemptId: string,
  kind: StoreRecord['record_kind'],
  authorizationEventId: string | null,
  result?: ReleaseProviderResult,
  state?: ReleaseLifecycleStateV2,
): StoreRecord {
  const sequence = prior === null ? 0 : prior.sequence + 1;
  const handle = result?.provider_handle ?? null;
  const remote = EFFECT_BY_ACTION[request.action_id] === 'remote-write';
  return finalizeStoreRecord({
    schemaVersion: '1.0.0',
    record_kind: kind,
    canonicalization: STORE_CANONICALIZATION,
    sequence,
    repository: request.repository_locator,
    candidate: requestStoreCandidate(request),
    predecessor_record: prior === null ? null : storeRecordReference(prior),
    observed_head_before: observedHeadBefore,
    attempt_id: attemptId,
    action_id: request.action_id,
    request_digest_sha256: computeReleaseRequestDigest(request),
    authorization_event_id: authorizationEventId,
    provider_handle: handle,
    provider_dispatch:
      kind === 'attempt'
        ? { status: 'not-dispatched', handle_observed: false }
        : kind === 'unknown-provider-result'
          ? { status: 'unknown', handle_observed: handle !== null }
          : remote
            ? {
                status: result?.dispatch_status ?? 'dispatched',
                handle_observed: handle !== null,
              }
            : { status: 'not-dispatched', handle_observed: false },
    completion:
      kind === 'completion' && state !== undefined
        ? {
            state_id: state.state_id,
            state_digest_sha256: state.record_digest_sha256,
            state: state.state,
          }
        : null,
    failure:
      kind === 'failure'
        ? { code: result?.code ?? 'release-provider-failed', retryable: false }
        : null,
    unknown:
      kind === 'unknown-provider-result'
        ? { code: 'release-provider-result-unknown', redispatch_permitted: false }
        : null,
  } as never);
}

function stateReference(state: ReleaseLifecycleStateV2): StateReference {
  return {
    state: state.state,
    state_id: state.state_id,
    record_digest_sha256: state.record_digest_sha256,
  };
}

function assertMaterialBijection(
  request: ReleaseLifecycleRequest,
  action: PersistedReleaseAction,
  material: ReleaseStateMaterial,
): void {
  const requested = request.candidate_locator.release_units.map((unit) => ({
    release_unit: unit.release_unit,
    version: unit.version,
    packages: unit.package_roster.map((pkg) => pkg.package_id),
  }));
  const produced = material.release_units.map((unit) => ({
    release_unit: unit.release_unit,
    version: unit.version,
    packages: unit.packages.map((pkg) => pkg.package_id),
  }));
  if (!same(requested, produced)) throw new Error('release-release-unit-bijection-invalid');
  for (const [unitIndex, unit] of material.release_units.entries()) {
    const requestUnit = request.candidate_locator.release_units[unitIndex];
    if (requestUnit === undefined) throw new Error('release-release-unit-bijection-invalid');
    for (const [packageIndex, pkg] of unit.packages.entries()) {
      const requestPackage = requestUnit.package_roster[packageIndex];
      if (
        requestPackage === undefined ||
        pkg.manifest === null ||
        pkg.manifest.path !== requestPackage.manifest_path ||
        pkg.manifest.sha256 !== requestPackage.manifest_digest_sha256
      ) {
        throw new Error('release-release-unit-bijection-invalid');
      }
      if (
        (action === 'release prepare' ||
          action === 'release export' ||
          action === 'release evidence-publish' ||
          action === 'release publish') &&
        (pkg.tarball === null || pkg.sbom === null)
      ) {
        throw new Error('release-release-unit-bijection-invalid');
      }
      if (
        (action === 'release export' ||
          action === 'release evidence-publish' ||
          action === 'release publish') &&
        (pkg.evidence_manifest === null || pkg.provider_result === null || pkg.trust === null)
      ) {
        throw new Error('release-release-unit-bijection-invalid');
      }
    }
  }
  if (action === 'release preflight' || action === 'release certify') return;
  const topByKey = new Map<string, Readonly<Record<string, unknown>>>();
  for (const artifact of material.artifacts) {
    const key = `${artifact.kind}\0${artifact.path}`;
    if (topByKey.has(key)) throw new Error('release-release-unit-bijection-invalid');
    topByKey.set(key, artifact);
  }
  const requiredTop: Readonly<Record<string, unknown>>[] = [];
  for (const unit of material.release_units) {
    for (const pkg of unit.packages) {
      if (pkg.manifest !== null) requiredTop.push({ kind: 'manifest', ...pkg.manifest });
      if (pkg.tarball !== null) requiredTop.push({ kind: 'package-tarball', ...pkg.tarball });
      if (pkg.sbom !== null) requiredTop.push({ kind: 'sbom', ...pkg.sbom });
      if (pkg.evidence_manifest !== null)
        requiredTop.push({ kind: 'manifest', ...pkg.evidence_manifest });
      if (pkg.provider_result !== null)
        requiredTop.push({ kind: 'provider-result', ...pkg.provider_result });
    }
  }
  for (const artifact of requiredTop) {
    const key = `${String(artifact['kind'])}\0${String(artifact['path'])}`;
    if (!same(topByKey.get(key), artifact)) {
      throw new Error('release-release-unit-bijection-invalid');
    }
  }
}

function assertStateMatchesRequest(
  request: ReleaseLifecycleRequest,
  state: ReleaseLifecycleStateV2,
): void {
  const requested = request.candidate_locator.release_units.map((unit) => ({
    release_unit: unit.release_unit,
    version: unit.version,
    packages: unit.package_roster.map((pkg) => ({
      package_id: pkg.package_id,
      manifest_path: pkg.manifest_path,
      manifest_digest_sha256: pkg.manifest_digest_sha256,
    })),
  }));
  const observed = state.release_units.map((unit) => ({
    release_unit: unit.release_unit,
    version: unit.version,
    packages: unit.packages.map((pkg) => ({
      package_id: pkg.package_id,
      manifest_path: pkg.manifest?.path,
      manifest_digest_sha256: pkg.manifest?.sha256,
    })),
  }));
  if (
    !same(state.repository, request.repository_locator) ||
    !same(state.candidate, primaryCandidate(request)) ||
    !same(requested, observed)
  ) {
    throw new Error('release-state-identity-mismatch');
  }
}

function sortedArtifacts(values: readonly unknown[]): readonly unknown[] {
  return [...values].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right), 'en'),
  );
}

function offlineArtifactProjection(state: ReleaseLifecycleStateV2): readonly unknown[] {
  const allowed = new Set(['package-tarball', 'evidence-bundle', 'manifest', 'attestation']);
  const artifacts: unknown[] = (state['artifacts'] as readonly Readonly<Record<string, unknown>>[])
    .filter((artifact) => allowed.has(String(artifact['kind'])))
    .map((artifact) => artifact);
  for (const unit of state.release_units) {
    for (const pkg of unit.packages) {
      if (pkg.manifest !== null) artifacts.push({ kind: 'manifest', ...pkg.manifest });
      if (pkg.tarball !== null) artifacts.push({ kind: 'package-tarball', ...pkg.tarball });
      if (pkg.evidence_manifest !== null)
        artifacts.push({ kind: 'manifest', ...pkg.evidence_manifest });
    }
  }
  const unique = new Map(artifacts.map((artifact) => [canonicalJson(artifact), artifact]));
  return sortedArtifacts([...unique.values()]);
}

function assertPriorMaterialContinuity(
  action: PersistedReleaseAction,
  material: ReleaseStateMaterial,
  prior: ReleaseLifecycleStateV2 | null,
): void {
  if (prior === null) return;
  if (action === 'release evidence-publish' || action === 'release publish') {
    if (
      !same(material.release_units, prior.release_units) ||
      !same(material.inputs, prior['inputs']) ||
      !same(material.evidence, prior['evidence']) ||
      !same(material.artifacts, prior['artifacts'])
    ) {
      throw new Error('release-evidence-binding-invalid');
    }
    return;
  }
  for (const [unitIndex, priorUnit] of prior.release_units.entries()) {
    const nextUnit = material.release_units[unitIndex];
    if (nextUnit === undefined) throw new Error('release-evidence-binding-invalid');
    for (const [packageIndex, priorPackage] of priorUnit.packages.entries()) {
      const nextPackage = nextUnit.packages[packageIndex];
      if (nextPackage === undefined) throw new Error('release-evidence-binding-invalid');
      for (const key of [
        'manifest',
        'tarball',
        'sbom',
        'evidence_manifest',
        'provider_result',
        'trust',
      ] as const) {
        if (priorPackage[key] !== null && !same(priorPackage[key], nextPackage[key])) {
          throw new Error('release-evidence-binding-invalid');
        }
      }
    }
  }
  const nextArtifacts = new Set(material.artifacts.map((artifact) => canonicalJson(artifact)));
  if (
    (prior['artifacts'] as readonly unknown[]).some(
      (artifact) => !nextArtifacts.has(canonicalJson(artifact)),
    )
  ) {
    throw new Error('release-evidence-binding-invalid');
  }
}

function assertReceiptContinuity(
  request: ReleaseLifecycleRequest,
  receipts: readonly VerifiedReceipt[],
  prior: ReleaseLifecycleStateV2 | null,
): void {
  const offline = receipts.filter(
    (receipt) => receipt.kind === 'release-offline-verification-receipt',
  );
  if (request.action_id !== 'release evidence-publish') return;
  if (prior === null || prior.state !== 'exported' || offline.length !== 1) {
    throw new Error('release-offline-receipt-binding-invalid');
  }
  const receipt = offline[0]?.value;
  if (
    receipt === undefined ||
    receipt['schemaVersion'] !== '2.0.0' ||
    !same(receipt['verified_state'], stateReference(prior)) ||
    !same(receipt['release_units'], prior.release_units) ||
    !same(
      sortedArtifacts(receipt['artifacts'] as readonly unknown[]),
      offlineArtifactProjection(prior),
    ) ||
    !Array.isArray(receipt['release_units']) ||
    !(receipt['release_units'] as readonly unknown[]).every((unit, unitIndex) => {
      const packages = object(unit)['packages'];
      const priorPackages = prior.release_units[unitIndex]?.packages;
      return (
        Array.isArray(packages) &&
        priorPackages !== undefined &&
        packages.every((pkg, packageIndex) => {
          const expectedTrust = priorPackages[packageIndex]?.trust;
          return (
            expectedTrust !== null &&
            expectedTrust !== undefined &&
            same(object(pkg)['trust'], expectedTrust) &&
            same(object(pkg)['trust'], request.destination?.trust)
          );
        })
      );
    })
  ) {
    throw new Error('release-offline-receipt-binding-invalid');
  }
}

function buildState(
  request: ReleaseLifecycleRequest & { readonly action_id: PersistedReleaseAction },
  material: ReleaseStateMaterial,
  prior: ReleaseLifecycleStateV2 | null,
  authorizationEventId: string | null,
  authority: TrustedReleaseAuthority,
  publicationControls: PublicationControls | undefined,
  recordedAt: string,
): ReleaseLifecycleStateV2 {
  assertMaterialBijection(request, request.action_id, material);
  assertPriorMaterialContinuity(request.action_id, material, prior);
  const primary = request.candidate_locator.release_units[0];
  if (primary === undefined) throw new Error('release-release-unit-bijection-invalid');
  const state = STATE_BY_ACTION[request.action_id];
  if (PRIOR_BY_STATE[state] !== (prior?.state ?? null))
    throw new Error('release-state-predecessor-mismatch');
  const generation = prior === null ? 0 : prior.storage.generation + 1;
  const headBefore =
    prior === null
      ? null
      : { generation: prior.storage.generation, record_digest_sha256: prior.record_digest_sha256 };
  const boundReceipts = (request.receipt_locators ?? []).map((receipt) => ({
    kind: receipt.kind,
    receipt_id: receipt.receipt_id,
    receipt_digest_sha256: receipt.receipt_digest_sha256,
    verdict: 'pass' as const,
  }));
  return finalizeReleaseStateV2({
    schemaVersion: '2.0.0',
    canonicalization: STATE_CANONICALIZATION,
    state,
    action_id: request.action_id,
    effect: EFFECT_BY_ACTION[request.action_id],
    prior_state: prior === null ? null : stateReference(prior),
    bound_receipts: boundReceipts,
    repository: request.repository_locator,
    candidate: {
      release_unit: primary.release_unit,
      version: primary.version,
      commit: request.candidate_locator.commit,
      tree: request.candidate_locator.tree,
    },
    release_units: material.release_units,
    inputs: material.inputs,
    evidence: material.evidence,
    artifacts: material.artifacts,
    actor: authority.actor,
    consent: authority.consent,
    authorization_event_id: authorizationEventId,
    publication_expectation:
      request.action_id === 'release publish' && publicationControls !== undefined
        ? { authorization_event_id: authorizationEventId, ...publicationControls }
        : null,
    storage: { generation, head_before: headBefore },
    recorded_at: recordedAt,
  } as never);
}

export type ExecuteReleaseResult =
  | { readonly ok: true; readonly state: ReleaseLifecycleStateV2; readonly completion: StoreRecord }
  | {
      readonly ok: false;
      readonly phase: string;
      readonly code: string;
      readonly record?: StoreRecord;
    };

/**
 * Execute exactly one persisted lifecycle action. All authority and producer
 * effects are injected. The core owns identities, append ordering, and state.
 */
export async function executeReleaseLifecycleAction(input: {
  readonly request: unknown;
  readonly action: PersistedReleaseAction;
  readonly store: ReleaseLifecycleFileStore;
  readonly provider?: ReleaseProvider;
  readonly authorization?: AuthorizationBridge;
  readonly authority?: TrustedReleaseAuthority;
  readonly publication_controls?: PublicationControls;
  readonly resolveReceipt?: ReceiptResolver;
  readonly resolvePlanInput?: ReleasePlanInputResolver;
  readonly offlineReceiptVerifier?: TrustedOfflineReceiptVerifier;
  readonly recorded_at: string;
}): Promise<ExecuteReleaseResult> {
  let request: ReleaseLifecycleRequest & { readonly action_id: PersistedReleaseAction };
  let authority: TrustedReleaseAuthority;
  let receipts: readonly VerifiedReceipt[];
  try {
    request = validateReleaseLifecycleRequest(
      input.request,
      input.action,
    ) as ReleaseLifecycleRequest & {
      readonly action_id: PersistedReleaseAction;
    };
  } catch (error) {
    return {
      ok: false,
      phase: 'validation',
      code: error instanceof Error ? error.message : 'release-request-projection-invalid',
    };
  }
  try {
    authority = assertTrustedAuthority(request.action_id, input.authority);
    receipts = verifyBoundReceipts(request, input.resolveReceipt, input.resolvePlanInput);
  } catch (error) {
    return {
      ok: false,
      phase: 'validation',
      code: error instanceof Error ? error.message : 'release-receipt-identity-mismatch',
    };
  }
  const remote = EFFECT_BY_ACTION[request.action_id] === 'remote-write';
  if (!remote && input.provider === undefined) {
    return { ok: false, phase: 'provider', code: 'release-provider-unavailable' };
  }
  if (remote && input.authorization === undefined) {
    return {
      ok: false,
      phase: 'authorization',
      code: 'release-authorization-provider-unavailable',
    };
  }
  if (
    request.action_id === 'release evidence-publish' &&
    input.offlineReceiptVerifier === undefined
  ) {
    return {
      ok: false,
      phase: 'validation',
      code: 'release-offline-verifier-provider-unavailable',
    };
  }
  if (request.action_id === 'release publish') {
    try {
      assertPublicationControls(request, input.publication_controls);
    } catch (error) {
      return {
        ok: false,
        phase: 'validation',
        code: error instanceof Error ? error.message : 'rpd-workflow-expectation-invalid',
      };
    }
  }
  try {
    return await input.store.withExecutionLock(async () => {
      let storeRecords: StoreRecord[];
      let states: ReleaseLifecycleStateV2[];
      let head: StoreHead | null;
      try {
        storeRecords = input.store.readStoreRecords();
        states = input.store.readStateRecords();
        head = input.store.readHead();
        const reduced = reduceStoreRecords(storeRecords);
        if (!reduced.ok || reduced.ambiguous) {
          return {
            ok: false,
            phase: 'reconciliation',
            code: reduced.ambiguous
              ? 'release-provider-result-unknown'
              : (reduced.errors[0] ?? 'release-state-store-unsafe'),
          };
        }
        const stateReduction = reduceReleaseStates(states);
        if (!stateReduction.ok) {
          return {
            ok: false,
            phase: 'reconciliation',
            code: stateReduction.errors[0] ?? 'release-state-store-unsafe',
          };
        }
        const stateHead = stateReduction.head;
        if (stateHead !== null) assertStateMatchesRequest(request, stateHead);
        const completions = storeRecords.filter((record) => record.record_kind === 'completion');
        if (
          completions.length !== states.length ||
          completions.some((record, index) => {
            const state = states[index];
            return (
              state === undefined ||
              record.completion?.state_id !== state.state_id ||
              record.completion.state_digest_sha256 !== state.record_digest_sha256
            );
          })
        ) {
          return { ok: false, phase: 'reconciliation', code: 'release-state-store-orphan-record' };
        }
        const expectedHead =
          stateHead === null
            ? null
            : headForCompletion(stateHead, completions[completions.length - 1] as StoreRecord);
        if (!same(head, expectedHead))
          return { ok: false, phase: 'reconciliation', code: 'release-state-head-mismatch' };
        if (!same(reduced.completed_head, head)) {
          return { ok: false, phase: 'reconciliation', code: 'release-state-head-mismatch' };
        }
        const expectedPrior = PRIOR_BY_STATE[STATE_BY_ACTION[request.action_id]];
        if (expectedPrior !== (stateHead?.state ?? null)) {
          return { ok: false, phase: 'validation', code: 'release-state-transition-invalid' };
        }
        assertReceiptContinuity(request, receipts, stateHead);
        if (request.action_id === 'release evidence-publish') {
          const offline = receipts.find(
            (receipt) => receipt.kind === 'release-offline-verification-receipt',
          );
          if (stateHead === null || offline === undefined) {
            throw new Error('release-offline-receipt-binding-invalid');
          }
          const verifiedDocument = await input.offlineReceiptVerifier?.verify({
            repository: request.repository_locator,
            candidate_locator: request.candidate_locator,
            exported_state: stateHead,
            receipt: offline.value,
          });
          if (
            verifiedDocument === undefined ||
            !same(verifyReceiptDocument(verifiedDocument).value, offline.value)
          ) {
            throw new Error('rov-semantic-verification-not-performed');
          }
        }
      } catch (error) {
        return {
          ok: false,
          phase: 'reconciliation',
          code: error instanceof Error ? error.message : 'release-state-store-unsafe',
        };
      }

      const priorRecord = storeRecords.at(-1) ?? null;
      const nextSequence = priorRecord === null ? 0 : priorRecord.sequence + 1;
      const requestDigest = computeReleaseRequestDigest(request);
      const attemptId = deriveAttemptId({
        request_digest_sha256: requestDigest,
        action_id: request.action_id,
        sequence: nextSequence,
        predecessor_record: priorRecord === null ? null : storeRecordReference(priorRecord),
      });
      let authorizationEventId: string | null = null;
      let binding: AuthorizationAttemptBinding | undefined;
      let grantProof:
        | {
            readonly grant: Readonly<Record<string, unknown>>;
            readonly grant_event_id: string;
            readonly ledger_head: AuthorizationLedgerHead;
            readonly ledger: Readonly<Record<string, unknown>>;
            readonly events: readonly Readonly<Record<string, unknown>>[];
          }
        | undefined;
      if (remote) {
        binding = {
          attempt_id: attemptId,
          action_id: request.action_id,
          request_digest_sha256: requestDigest,
          repository: request.repository_locator,
          candidate: primaryCandidate(request),
          destination: authorizationDestination(request),
        };
        try {
          const resolution = await input.authorization?.resolve(binding);
          if (resolution === undefined)
            throw new Error('release-authorization-provider-unavailable');
          grantProof = verifyGrantResolution(resolution, binding, authority, input.recorded_at);
          authorizationEventId = grantProof.grant_event_id;
          if (
            priorRecord?.record_kind === 'failure' &&
            priorRecord.authorization_event_id === authorizationEventId
          ) {
            throw new Error('fresh-exact-authorization-required');
          }
        } catch (error) {
          return {
            ok: false,
            phase: 'authorization',
            code:
              error instanceof Error
                ? error.message
                : 'release-authorization-attempt-binding-invalid',
          };
        }
      }
      if (input.provider === undefined) {
        return { ok: false, phase: 'provider', code: 'release-provider-unavailable' };
      }
      const provider = input.provider;
      const attempt = buildStoreRecord(
        request,
        priorRecord,
        head,
        attemptId,
        'attempt',
        authorizationEventId,
      );
      try {
        input.store.appendStoreRecord(attempt);
      } catch (error) {
        return {
          ok: false,
          phase: 'append',
          code: error instanceof Error ? error.message : 'release-state-store-unsafe',
        };
      }

      if (remote && binding !== undefined && authorizationEventId !== null) {
        try {
          const refreshed = await input.authorization?.resolve(binding);
          if (refreshed === undefined || grantProof === undefined)
            throw new Error('release-authorization-consumption-not-durable');
          const refreshedProof = verifyGrantResolution(
            refreshed,
            binding,
            authority,
            input.recorded_at,
          );
          if (
            refreshedProof.grant_event_id !== grantProof.grant_event_id ||
            !same(refreshedProof.ledger_head, grantProof.ledger_head) ||
            !same(refreshedProof.grant, grantProof.grant)
          ) {
            throw new Error('release-authorization-attempt-binding-invalid');
          }
          const consumption = await input.authorization?.consume({
            ...binding,
            grant_event_id: authorizationEventId,
          });
          if (consumption === undefined)
            throw new Error('release-authorization-consumption-not-durable');
          verifyConsumptionProof(
            consumption,
            binding,
            grantProof.grant,
            authorizationEventId,
            grantProof.ledger_head,
            grantProof.ledger,
            grantProof.events,
          );
        } catch (error) {
          const failure = buildStoreRecord(
            request,
            attempt,
            head,
            attemptId,
            'failure',
            authorizationEventId,
            {
              outcome: 'failure',
              dispatch_status: 'failed-before-dispatch',
              code: 'release-authorization-consumption-failed',
            },
          );
          input.store.appendStoreRecord(failure);
          return {
            ok: false,
            phase: 'authorization',
            code:
              error instanceof Error
                ? error.message
                : 'release-authorization-consumption-not-durable',
            record: failure,
          };
        }
      }

      let result: ReleaseProviderResult;
      try {
        result = await provider(request);
      } catch {
        result = remote
          ? { outcome: 'unknown', code: 'release-provider-result-unknown' }
          : { outcome: 'failure', code: 'release-provider-failed' };
      }
      if (result.outcome !== 'success') {
        const unsafeRemoteFailure =
          remote &&
          result.outcome === 'failure' &&
          (result.provider_handle !== undefined ||
            result.dispatch_status !== 'failed-before-dispatch');
        const terminalResult = unsafeRemoteFailure
          ? ({ ...result, outcome: 'unknown', code: 'release-provider-result-unknown' } as const)
          : result;
        const kind = terminalResult.outcome === 'unknown' ? 'unknown-provider-result' : 'failure';
        const terminal = buildStoreRecord(
          request,
          attempt,
          head,
          attemptId,
          kind,
          authorizationEventId,
          terminalResult,
        );
        input.store.appendStoreRecord(terminal);
        return {
          ok: false,
          phase: terminalResult.outcome === 'unknown' ? 'ambiguous' : 'provider',
          code:
            terminalResult.outcome === 'unknown'
              ? 'release-provider-result-unknown'
              : (terminalResult.code ?? 'release-provider-failed'),
          record: terminal,
        };
      }
      if (remote && result.provider_handle === undefined) {
        const unknown = buildStoreRecord(
          request,
          attempt,
          head,
          attemptId,
          'unknown-provider-result',
          authorizationEventId,
          { outcome: 'unknown', code: 'release-provider-result-unknown' },
        );
        input.store.appendStoreRecord(unknown);
        return {
          ok: false,
          phase: 'ambiguous',
          code: 'release-provider-handle-observation-invalid',
          record: unknown,
        };
      }
      if (result.material === undefined) {
        const terminal = buildStoreRecord(
          request,
          attempt,
          head,
          attemptId,
          remote ? 'unknown-provider-result' : 'failure',
          authorizationEventId,
          remote
            ? { ...result, outcome: 'unknown', code: 'release-provider-result-unknown' }
            : { ...result, outcome: 'failure', code: 'release-adapter-output-invalid' },
        );
        input.store.appendStoreRecord(terminal);
        return {
          ok: false,
          phase: remote ? 'ambiguous' : 'validation',
          code: remote ? 'release-provider-result-unknown' : 'release-adapter-output-invalid',
          record: terminal,
        };
      }

      let state: ReleaseLifecycleStateV2;
      try {
        state = buildState(
          request,
          result.material,
          states.at(-1) ?? null,
          authorizationEventId,
          authority,
          input.publication_controls,
          input.recorded_at,
        );
      } catch (error) {
        const terminal = buildStoreRecord(
          request,
          attempt,
          head,
          attemptId,
          remote ? 'unknown-provider-result' : 'failure',
          authorizationEventId,
          remote
            ? { ...result, outcome: 'unknown', code: 'release-provider-result-unknown' }
            : { ...result, outcome: 'failure', code: 'release-adapter-output-invalid' },
        );
        input.store.appendStoreRecord(terminal);
        return {
          ok: false,
          phase: remote ? 'ambiguous' : 'validation',
          code: remote
            ? 'release-provider-result-unknown'
            : error instanceof Error
              ? error.message
              : 'release-adapter-output-invalid',
          record: terminal,
        };
      }
      const completion = buildStoreRecord(
        request,
        attempt,
        head,
        attemptId,
        'completion',
        authorizationEventId,
        result,
        state,
      );
      try {
        input.store.appendStoreRecord(completion);
        input.store.appendStateAndAdvanceHead(state, completion, head);
      } catch (error) {
        return {
          ok: false,
          phase: 'append',
          code: error instanceof Error ? error.message : 'release-state-store-unsafe',
          record: completion,
        };
      }
      return { ok: true, state, completion };
    });
  } catch (error) {
    return {
      ok: false,
      phase: 'reconciliation',
      code: error instanceof Error ? error.message : 'release-state-store-unsafe',
    };
  }
}

export type OfflineVerificationResult =
  | { readonly ok: true; readonly receipt: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly phase: 'validation' | 'provider'; readonly code: string };

/** Pure offline verification boundary. It emits a receipt and never opens a store. */
export async function executeOfflineVerification(input: {
  readonly request: unknown;
  readonly exported_state: unknown;
  readonly provider?: OfflineVerificationProvider;
}): Promise<OfflineVerificationResult> {
  let request: ReleaseLifecycleRequest;
  let state: ReleaseLifecycleStateV2;
  try {
    request = validateReleaseLifecycleRequest(input.request, 'release offline-verify');
    state = verifyReleaseStateIdentity(input.exported_state);
    if (state.state !== 'exported') throw new Error('release-offline-state-mismatch');
    if (
      !same(state.repository, request.repository_locator) ||
      state.candidate.commit !== request.candidate_locator.commit ||
      state.candidate.tree !== request.candidate_locator.tree
    ) {
      throw new Error('release-request-identity-mismatch');
    }
    assertMaterialBijection(request, 'release export', {
      release_units: state.release_units,
      inputs: [],
      evidence: {
        manifest_digest_sha256: '0'.repeat(64),
        receipt_digests: [],
        independently_checkable: true,
      },
      artifacts: state['artifacts'] as ReleaseStateMaterial['artifacts'],
    });
  } catch (error) {
    return {
      ok: false,
      phase: 'validation',
      code: error instanceof Error ? error.message : 'release-offline-input-invalid',
    };
  }
  if (input.provider === undefined) {
    return { ok: false, phase: 'provider', code: 'release-offline-verifier-provider-unavailable' };
  }
  let raw: unknown;
  try {
    raw = await input.provider(request, state);
  } catch {
    return { ok: false, phase: 'provider', code: 'release-offline-verifier-failed' };
  }
  const parsed =
    parsers.releaseOfflineVerificationReceipt.safeParse<Readonly<Record<string, unknown>>>(raw);
  if (!parsed.ok)
    return { ok: false, phase: 'validation', code: 'release-offline-receipt-invalid' };
  const receipt = parsed.value;
  const digest = canonicalSha256(without(receipt, ['receipt_id', 'receipt_digest_sha256']));
  const expectedState = stateReference(state);
  const trust = request.destination?.trust;
  const releaseUnits = receipt['release_units'];
  const trustMatches =
    trust !== undefined &&
    Array.isArray(releaseUnits) &&
    releaseUnits.every((unit) => {
      const packages = object(unit)['packages'];
      return Array.isArray(packages) && packages.every((pkg) => same(object(pkg)['trust'], trust));
    });
  if (
    receipt['schemaVersion'] !== '2.0.0' ||
    receipt['receipt_digest_sha256'] !== digest ||
    receipt['receipt_id'] !== `ROV-${digest.slice(0, 16)}` ||
    receipt['verdict'] !== 'pass' ||
    receipt['state_observed'] !== 'offline_verified' ||
    !same(receipt['repository'], state.repository) ||
    !same(receipt['candidate'], state.candidate) ||
    !same(receipt['verified_state'], expectedState) ||
    !same(releaseUnits, state.release_units) ||
    !same(
      sortedArtifacts(receipt['artifacts'] as readonly unknown[]),
      offlineArtifactProjection(state),
    ) ||
    !trustMatches
  ) {
    return { ok: false, phase: 'validation', code: 'release-offline-receipt-binding-invalid' };
  }
  return { ok: true, receipt };
}

export interface StateReduction {
  readonly ok: boolean;
  readonly head: ReleaseLifecycleStateV2 | null;
  readonly errors: readonly string[];
}

export function reduceReleaseStates(values: readonly unknown[]): StateReduction {
  const errors = new Set<string>();
  let prior: ReleaseLifecycleStateV2 | null = null;
  for (const [index, value] of values.entries()) {
    let state: ReleaseLifecycleStateV2;
    try {
      state = verifyReleaseStateIdentity(value);
    } catch (error) {
      errors.add(error instanceof Error ? error.message : 'release-state-schema-invalid');
      continue;
    }
    if (prior !== null) {
      if (!same(state.repository, prior.repository) || !same(state.candidate, prior.candidate)) {
        errors.add('release-state-identity-mismatch');
      }
      if (!same(state.prior_state, stateReference(prior)))
        errors.add('release-state-predecessor-mismatch');
      const stateGeneration = state.schemaVersion === '2.0.0' ? state.storage.generation : index;
      const priorGeneration =
        prior.schemaVersion === '2.0.0' ? prior.storage.generation : index - 1;
      if (
        stateGeneration !== priorGeneration + 1 ||
        (state.schemaVersion === '2.0.0' &&
          !same(state.storage.head_before, {
            generation: priorGeneration,
            record_digest_sha256: prior.record_digest_sha256,
          }))
      ) {
        errors.add('release-state-head-mismatch');
      }
    } else if (state.state !== 'preflight_passed') {
      errors.add('release-state-transition-invalid');
    }
    if (PRIOR_BY_STATE[state.state] !== (prior?.state ?? null))
      errors.add('release-state-transition-invalid');
    prior = state;
  }
  return { ok: errors.size === 0, head: prior, errors: [...errors] };
}

function observationIdentity(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const digest = canonicalSha256(value);
  return {
    ...value,
    observation_id: `RLO-${digest.slice(0, 16)}`,
    observation_digest_sha256: digest,
  };
}

export type PublicationSignatureVerifier = (input: {
  readonly signed_payload_digest_sha256: string;
  readonly signature: string;
  readonly trust: TrustIdentity;
}) => boolean | Promise<boolean>;

async function verifyPublicationReceipt(
  receiptInput: unknown,
  state: ReleaseLifecycleStateV2,
  verifySignature: PublicationSignatureVerifier,
): Promise<Readonly<Record<string, unknown>> | null> {
  const parsed =
    parsers.releasePublicationReceipt.safeParse<Readonly<Record<string, unknown>>>(receiptInput);
  if (!parsed.ok || state.state !== 'publication_dispatched') return null;
  const receipt = parsed.value;
  const trustWithSignature = object(receipt['trust']);
  const trust: TrustIdentity = {
    trust_root_id: String(trustWithSignature['trust_root_id']),
    trust_store_digest_sha256: String(trustWithSignature['trust_store_digest_sha256']),
    key_id: String(trustWithSignature['key_id']),
    signature_algorithm: trustWithSignature[
      'signature_algorithm'
    ] as TrustIdentity['signature_algorithm'],
  };
  const receiptProjection = without(receipt, ['receipt_id', 'receipt_digest_sha256']);
  const signedTrust = without(object(receiptProjection['trust']), [
    'signature',
    'signed_payload_digest_sha256',
  ]);
  const signedDigest = canonicalSha256({ ...receiptProjection, trust: signedTrust });
  const wholeDigest = canonicalSha256(without(receipt, ['receipt_digest_sha256']));
  const expectation = object(state['publication_expectation']);
  const expectedWorkflow = object(expectation['workflow']);
  const receiptWorkflow = object(receipt['workflow']);
  const workflowProjection = {
    repository: receiptWorkflow['repository'],
    workflow_path: receiptWorkflow['workflow_path'],
    workflow_sha: receiptWorkflow['workflow_sha'],
    protected_environment: receiptWorkflow['protected_environment'],
    protected: receiptWorkflow['protected'],
  };
  if (
    receipt['outcome'] !== 'published' ||
    receipt['attests_state'] !== 'published' ||
    receipt['receipt_id'] !== `RPU-${signedDigest.slice(0, 16)}` ||
    receipt['receipt_digest_sha256'] !== wholeDigest ||
    trustWithSignature['signed_payload_digest_sha256'] !== signedDigest ||
    !same(receipt['repository'], state.repository) ||
    !same(receipt['candidate'], state.candidate) ||
    !same(receipt['dispatched_state'], stateReference(state)) ||
    !same(receipt['artifacts'], state['artifacts']) ||
    !same(receipt['publication'], expectation['destination']) ||
    !same(workflowProjection, expectedWorkflow) ||
    !same(trust, expectation['trust']) ||
    typeof trustWithSignature['signature'] !== 'string' ||
    !(await verifySignature({
      signed_payload_digest_sha256: signedDigest,
      signature: trustWithSignature['signature'],
      trust,
    }))
  ) {
    return null;
  }
  return {
    observed: true,
    receipt: {
      kind: 'release-publication-receipt',
      receipt_id: receipt['receipt_id'],
      receipt_digest_sha256: receipt['receipt_digest_sha256'],
      ...trust,
      signature_verified: true,
    },
    verified_against: {
      ...stateReference(state),
      candidate_identity_verified: true,
      artifact_identity_verified: true,
      destination_identity_verified: true,
      workflow_identity_verified: true,
      trust_identity_verified: true,
    },
  };
}

export async function resumeReleaseLifecycleExecution(input: {
  readonly states: readonly unknown[];
  readonly store_records?: readonly unknown[];
  readonly store_head?: unknown;
  readonly repository: ReleaseLifecycleRequest['repository_locator'];
  readonly candidate: ReleaseLifecycleStateV2['candidate'];
  readonly candidate_locator?: ReleaseLifecycleRequest['candidate_locator'];
  readonly receipt_documents?: readonly unknown[];
  readonly receipt_locators?: NonNullable<ReleaseLifecycleRequest['receipt_locators']>;
  readonly resolve_receipt?: ReceiptResolver;
  readonly resolve_plan_input?: ReleasePlanInputResolver;
  readonly offline_receipt_verifier?: TrustedOfflineReceiptVerifier;
  readonly publication_receipt?: unknown;
  readonly verify_signature?: PublicationSignatureVerifier;
}): Promise<Readonly<Record<string, unknown>>> {
  const stateReduction = reduceReleaseStates(input.states);
  const storeReduction = reduceStoreRecords(input.store_records ?? []);
  const head = stateReduction.head;
  const completions = storeReduction.records.filter(
    (record) => record.record_kind === 'completion',
  );
  const completionMismatch =
    storeReduction.records.length > 0 &&
    (completions.length !== input.states.length ||
      completions.some((record, index) => {
        const state = input.states[index];
        if (state === undefined) return true;
        try {
          const verified = verifyReleaseStateIdentity(state);
          return (
            record.completion?.state_id !== verified.state_id ||
            record.completion.state_digest_sha256 !== verified.record_digest_sha256
          );
        } catch {
          return true;
        }
      }));
  const lastStore = storeReduction.last;
  const storeIdentityMismatch =
    lastStore !== null &&
    (!same(lastStore['repository'], input.repository) ||
      object(lastStore['candidate'])['commit'] !== input.candidate.commit ||
      object(lastStore['candidate'])['tree'] !== input.candidate.tree);
  const identityMismatch =
    head !== null &&
    (!same(head.repository, input.repository) || !same(head.candidate, input.candidate));
  const locatorMismatch =
    input.candidate_locator !== undefined &&
    (input.candidate_locator.commit !== input.candidate.commit ||
      input.candidate_locator.tree !== input.candidate.tree ||
      input.candidate_locator.release_units[0]?.release_unit !== input.candidate.release_unit ||
      input.candidate_locator.release_units[0]?.version !== input.candidate.version);
  let headMismatch = false;
  const storeHeadProvided = Object.prototype.hasOwnProperty.call(input, 'store_head');
  if (storeReduction.records.length > 0 && !storeHeadProvided) headMismatch = true;
  if (storeHeadProvided) {
    try {
      const lastCompletion = completions.at(-1);
      if (input.store_head === null) {
        headMismatch = head !== null || lastCompletion !== undefined;
      } else {
        const observedHead = verifyStoreHeadIdentity(input.store_head);
        headMismatch =
          head === null ||
          lastCompletion === undefined ||
          !same(observedHead, headForCompletion(head, lastCompletion));
      }
    } catch {
      headMismatch = true;
    }
  }
  const verifiedReceipts: VerifiedReceipt[] = [];
  let receiptInvalid = false;
  try {
    for (const document of input.receipt_documents ?? []) {
      verifiedReceipts.push(verifyReceiptDocument(document, input.resolve_plan_input));
    }
    for (const locator of input.receipt_locators ?? []) {
      if (input.resolve_receipt === undefined)
        throw new Error('release-receipt-provider-unavailable');
      const receipt = verifyReceiptDocument(
        input.resolve_receipt(locator),
        input.resolve_plan_input,
      );
      if (
        receipt.kind !== locator.kind ||
        receipt.value['receipt_id'] !== locator.receipt_id ||
        receipt.value['receipt_digest_sha256'] !== locator.receipt_digest_sha256
      ) {
        throw new Error('release-receipt-identity-mismatch');
      }
      verifiedReceipts.push(receipt);
    }
  } catch {
    receiptInvalid = true;
  }
  const blocked =
    !stateReduction.ok ||
    !storeReduction.ok ||
    completionMismatch ||
    headMismatch ||
    storeIdentityMismatch ||
    identityMismatch ||
    locatorMismatch ||
    receiptInvalid;
  const ambiguous = !blocked && storeReduction.ambiguous;
  const remoteFailure =
    !blocked &&
    !ambiguous &&
    storeReduction.failed &&
    lastStore !== null &&
    EFFECT_BY_ACTION[lastStore.action_id] === 'remote-write';
  let published: Readonly<Record<string, unknown>> = {
    observed: false,
    receipt: null,
    verified_against: null,
  };
  const derived: Readonly<Record<string, unknown>>[] = [];
  const seenReceiptIds = new Set<string>();
  const expectedPlanCandidates = (
    input.candidate_locator?.release_units.map((unit) => ({
      release_unit: unit.release_unit,
      version: unit.version,
      commit: input.candidate_locator?.commit,
      tree: input.candidate_locator?.tree,
    })) ?? [input.candidate]
  ).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), 'en'));
  const observedPlanCandidates: unknown[] = [];
  for (const verified of verifiedReceipts) {
    const receipt = verified.value;
    const receiptId = String(receipt['receipt_id']);
    if (seenReceiptIds.has(receiptId)) {
      receiptInvalid = true;
      continue;
    }
    seenReceiptIds.add(receiptId);
    const repositoryMatches = same(receipt['repository'], input.repository);
    const candidateMatches = expectedPlanCandidates.some((candidate) =>
      same(receipt['candidate'], candidate),
    );
    if (verified.kind === 'release-plan-receipt' && repositoryMatches && candidateMatches) {
      observedPlanCandidates.push(receipt['candidate']);
      derived.push({
        state: 'planned',
        receipt_kind: verified.kind,
        receipt_id: receipt['receipt_id'],
        receipt_digest_sha256: receipt['receipt_digest_sha256'],
        verified: true,
      });
    } else if (verified.kind === 'release-plan-receipt') {
      receiptInvalid = true;
    }
    if (verified.kind === 'release-offline-verification-receipt' && repositoryMatches) {
      const exported = stateReduction.ok
        ? input.states
            .map((state) => {
              try {
                return verifyReleaseStateIdentity(state);
              } catch {
                return null;
              }
            })
            .find(
              (state) =>
                state?.state === 'exported' &&
                same(stateReference(state), receipt['verified_state']),
            )
        : undefined;
      if (
        exported !== undefined &&
        exported !== null &&
        same(receipt['candidate'], exported.candidate) &&
        same(receipt['release_units'], exported.release_units) &&
        same(
          sortedArtifacts(receipt['artifacts'] as readonly unknown[]),
          offlineArtifactProjection(exported),
        ) &&
        input.offline_receipt_verifier !== undefined &&
        same(
          verifyReceiptDocument(
            await input.offline_receipt_verifier.verify({
              repository: input.repository,
              candidate_locator: input.candidate_locator ?? {
                commit: input.candidate.commit,
                tree: input.candidate.tree,
                release_units: [
                  {
                    release_unit: input.candidate.release_unit,
                    version: input.candidate.version,
                    package_roster:
                      exported.release_units[0]?.packages.map((pkg) => ({
                        package_id: pkg.package_id,
                        manifest_path: pkg.manifest?.path ?? 'package.json',
                        manifest_digest_sha256: pkg.manifest?.sha256 ?? '0'.repeat(64),
                      })) ?? [],
                  },
                ],
              },
              exported_state: exported,
              receipt,
            }),
          ).value,
          receipt,
        )
      ) {
        derived.push({
          state: 'offline_verified',
          receipt_kind: verified.kind,
          receipt_id: receipt['receipt_id'],
          receipt_digest_sha256: receipt['receipt_digest_sha256'],
          verified: true,
        });
      } else {
        receiptInvalid = true;
      }
    } else if (verified.kind === 'release-offline-verification-receipt') {
      receiptInvalid = true;
    }
  }
  if (
    observedPlanCandidates.length > 0 &&
    !same(
      observedPlanCandidates.sort((left, right) =>
        canonicalJson(left).localeCompare(canonicalJson(right), 'en'),
      ),
      expectedPlanCandidates,
    )
  ) {
    receiptInvalid = true;
  }
  if (
    !blocked &&
    !receiptInvalid &&
    head !== null &&
    input.publication_receipt !== undefined &&
    input.verify_signature !== undefined
  ) {
    published =
      (await verifyPublicationReceipt(input.publication_receipt, head, input.verify_signature)) ??
      published;
  }
  const publishedObserved = published['observed'] === true;
  if (publishedObserved) {
    const receipt = object(published['receipt']);
    derived.push({
      state: 'published',
      receipt_kind: 'release-publication-receipt',
      receipt_id: receipt['receipt_id'],
      receipt_digest_sha256: receipt['receipt_digest_sha256'],
      verified: true,
    });
  }
  if (blocked || receiptInvalid) derived.length = 0;
  const hasPlan = derived.some((entry) => entry['state'] === 'planned');
  const hasOffline = derived.some((entry) => entry['state'] === 'offline_verified');
  let nextAction: ReleaseAction | null;
  let nextOutcome: 'ready' | 'awaiting-external-receipt' | 'complete' | 'blocked' | 'ambiguous';
  let blockedReason:
    | 'broken-chain'
    | 'stale-head'
    | 'orphan-record'
    | 'unterminated-attempt'
    | 'unknown-provider-result'
    | 'authorization-consumed'
    | 'fresh-exact-authorization-required'
    | 'candidate-identity-mismatch'
    | 'receipt-identity-mismatch'
    | null = null;
  let blockedRequirements: readonly 'fresh_exact_owner_authorization_required'[] = [];
  if (blocked || receiptInvalid) {
    nextAction = null;
    nextOutcome = 'blocked';
    blockedReason = receiptInvalid
      ? 'receipt-identity-mismatch'
      : storeIdentityMismatch || identityMismatch || locatorMismatch
        ? 'candidate-identity-mismatch'
        : completionMismatch
          ? 'orphan-record'
          : headMismatch
            ? 'stale-head'
            : !storeReduction.ok || !stateReduction.ok
              ? 'broken-chain'
              : 'receipt-identity-mismatch';
  } else if (ambiguous) {
    nextAction = null;
    nextOutcome = 'ambiguous';
  } else if (remoteFailure) {
    nextAction = lastStore.action_id;
    nextOutcome = 'blocked';
    blockedReason = 'fresh-exact-authorization-required';
    blockedRequirements = ['fresh_exact_owner_authorization_required'];
  } else if (publishedObserved) {
    nextAction = null;
    nextOutcome = 'complete';
  } else if (head === null) {
    nextAction = hasPlan ? 'release preflight' : 'release plan';
    nextOutcome = 'ready';
  } else if (head.state === 'preflight_passed') {
    nextAction = 'release certify';
    nextOutcome = 'ready';
  } else if (head.state === 'certified') {
    nextAction = 'release prepare';
    nextOutcome = 'ready';
  } else if (head.state === 'prepared') {
    nextAction = 'release export';
    nextOutcome = 'ready';
  } else if (head.state === 'exported') {
    nextAction = hasOffline ? 'release evidence-publish' : 'release offline-verify';
    nextOutcome = 'ready';
  } else if (head.state === 'evidence_published') {
    nextAction = 'release publish';
    nextOutcome = 'ready';
  } else {
    nextAction = 'release resume';
    nextOutcome = 'awaiting-external-receipt';
  }
  const draft = {
    schemaVersion: '1.0.0',
    observation_kind: 'release-lifecycle-observation',
    repository: input.repository,
    candidate: input.candidate,
    verification_kernel: {
      kernel_id: 'devai.kernel.release-lifecycle-observation.v1',
      policy_source: 'law/policy/release-lifecycle.json#/observation_kernel',
      schema_validation_alone_derives_published: false,
    },
    head: head === null ? null : stateReference(head),
    derived_states: derived,
    published,
    next_action: nextAction,
    next_outcome: nextOutcome,
    ...(nextOutcome === 'blocked'
      ? {
          blocked_reason: blockedReason,
          blocked_requirements: blockedRequirements,
        }
      : {}),
    emitted_by: {
      action_id: 'release resume',
      effect: 'read',
      output_channel: 'stdout',
      persists_repository_state: false,
      appends_state_record: false,
      writes_receipt_file: false,
    },
    grants: {
      authority: false,
      publication_authority: false,
      lifecycle_transition: false,
      appends_published_state: false,
    },
    determinism: {
      deterministic: true,
      derived_from_bound_inputs_only: true,
      contains_wall_clock_time: false,
    },
  };
  const observation = observationIdentity(draft);
  return parsers.releaseLifecycleObservation.parse(observation);
}
