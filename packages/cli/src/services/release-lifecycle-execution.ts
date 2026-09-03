import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from '@devai-nyx/authority';
import { parsers } from '@devai-nyx/schemas';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
  readonly publication_expectation?: unknown;
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
  readonly storage: { readonly generation: number; readonly head_before: StoreHead | null };
  readonly record_digest_sha256: string;
}

export interface StateReference {
  readonly state: PersistedReleaseState;
  readonly state_id: string;
  readonly record_digest_sha256: string;
}

export interface StoreHead {
  readonly generation: number;
  readonly record_digest_sha256: string;
}

export interface StoreRecord extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '1.0.0';
  readonly record_kind: 'attempt' | 'completion' | 'failure' | 'unknown-provider-result';
  readonly record_id: string;
  readonly record_digest_sha256: string;
  readonly sequence: number;
  readonly predecessor_record: StoreRecordReference | null;
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

export interface AuthorizationResolution {
  readonly ok: boolean;
  readonly grant_event_id?: string;
  readonly code?: string;
}

export interface AuthorizationBridge {
  readonly resolve: (
    binding: AuthorizationAttemptBinding,
  ) => AuthorizationResolution | Promise<AuthorizationResolution>;
  readonly consume: (
    binding: AuthorizationAttemptBinding & { readonly grant_event_id: string },
  ) => void | Promise<void>;
}

export interface AuthorizationAttemptBinding {
  readonly attempt_id: string;
  readonly action_id: PersistedReleaseAction;
  readonly request_digest_sha256: string;
  readonly repository: ReleaseLifecycleRequest['repository_locator'];
  readonly candidate: ReleaseLifecycleRequest['candidate_locator'];
  readonly destination: NonNullable<ReleaseLifecycleRequest['destination']>;
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

const ROLE_BY_ACTION = {
  'release preflight': 'inspector',
  'release certify': 'inspector',
  'release prepare': 'architect',
  'release export': 'architect',
  'release evidence-publish': 'owner',
  'release publish': 'owner',
} as const;

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
  if (request.action_id === 'release preflight' && !same(receiptKinds, ['release-plan-receipt'])) {
    throw new Error('release-receipt-identity-mismatch');
  }
  if (
    request.action_id === 'release evidence-publish' &&
    !same(receiptKinds, ['release-offline-verification-receipt'])
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

function verifyBoundReceipts(request: ReleaseLifecycleRequest, resolver?: ReceiptResolver): void {
  const locators = request.receipt_locators ?? [];
  if (locators.length === 0) return;
  if (resolver === undefined) throw new Error('release-receipt-provider-unavailable');
  for (const locator of locators) {
    const value = object(resolver(locator));
    const parsed =
      locator.kind === 'release-plan-receipt'
        ? parsers.releasePlanReceipt.safeParse(value)
        : parsers.releaseOfflineVerificationReceipt.safeParse(value);
    if (!parsed.ok) throw new Error('release-receipt-identity-mismatch');
    const digest = canonicalSha256(without(value, ['receipt_id', 'receipt_digest_sha256']));
    if (
      value['receipt_id'] !== locator.receipt_id ||
      value['receipt_digest_sha256'] !== locator.receipt_digest_sha256 ||
      digest !== locator.receipt_digest_sha256
    ) {
      throw new Error('release-receipt-identity-mismatch');
    }
    const repository = object(value['repository']);
    const candidate = object(value['candidate']);
    const primary = request.candidate_locator.release_units[0];
    if (
      primary === undefined ||
      !same(repository, request.repository_locator) ||
      candidate['commit'] !== request.candidate_locator.commit ||
      candidate['tree'] !== request.candidate_locator.tree ||
      candidate['release_unit'] !== primary.release_unit ||
      candidate['version'] !== primary.version
    ) {
      throw new Error('release-receipt-identity-mismatch');
    }
    if (value['verdict'] !== 'pass') throw new Error('release-receipt-verdict-invalid');
  }
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
}

export function reduceStoreRecords(values: readonly unknown[]): StoreReduction {
  const records: StoreRecord[] = [];
  const errors = new Set<string>();
  const terminals = new Map<string, StoreRecord>();
  let prior: StoreRecord | null = null;
  let repositoryDigest: string | undefined;
  let candidateDigest: string | undefined;
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
    repositoryDigest ??= canonicalSha256(record['repository']);
    candidateDigest ??= canonicalSha256(record['candidate']);
    if (repositoryDigest !== canonicalSha256(record['repository']))
      errors.add('release-state-store-repository-mismatch');
    if (candidateDigest !== canonicalSha256(record['candidate']))
      errors.add('release-state-store-candidate-mismatch');
    if (record.record_kind !== 'attempt') {
      if (terminals.has(record.attempt_id)) errors.add('release-state-store-duplicate-terminal');
      terminals.set(record.attempt_id, record);
    }
    prior = record;
  }
  const attempts = records.filter((record) => record.record_kind === 'attempt');
  for (const terminal of terminals.values()) {
    if (!attempts.some((attempt) => attempt.attempt_id === terminal.attempt_id)) {
      errors.add('release-state-store-terminal-without-attempt');
    }
  }
  const pending = attempts.some((attempt) => !terminals.has(attempt.attempt_id));
  const unknown = [...terminals.values()].some(
    (record) => record.record_kind === 'unknown-provider-result',
  );
  return {
    ok: errors.size === 0,
    records,
    last: prior,
    errors: [...errors],
    ambiguous: pending || unknown,
    failed: prior?.record_kind === 'failure',
  };
}

function safeExistingDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('release-state-store-unsafe');
}

function ensurePrivateDirectory(path: string): void {
  const absolute = resolve(path);
  if (existsSync(absolute)) {
    safeExistingDirectory(absolute);
    return;
  }
  const parent = dirname(absolute);
  if (parent === absolute) throw new Error('release-state-store-unsafe');
  ensurePrivateDirectory(parent);
  try {
    mkdirSync(absolute, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  safeExistingDirectory(absolute);
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function exclusiveWrite(path: string, value: unknown): void {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeSync(descriptor, `${canonicalJson(value)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

function readRegularJson(path: string): unknown {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('release-state-store-unsafe');
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalSha256(left) === canonicalSha256(right);
}

export class ReleaseLifecycleFileStore {
  readonly campaignDirectory: string;

  constructor(root: string, request: ReleaseLifecycleRequest) {
    const absoluteRoot = resolve(root);
    const repositoryKey = canonicalSha256(request.repository_locator.id);
    this.campaignDirectory = join(absoluteRoot, repositoryKey, request.candidate_locator.commit);
    const escaped = relative(absoluteRoot, this.campaignDirectory);
    if (escaped.startsWith(`..${sep}`) || isAbsolute(escaped))
      throw new Error('release-state-store-unsafe');
  }

  initialize(): void {
    for (const directory of ['records', 'attempts', 'completions', 'failures', 'unknown']) {
      ensurePrivateDirectory(join(this.campaignDirectory, directory));
    }
  }

  readHead(): StoreHead | null {
    const path = join(this.campaignDirectory, 'HEAD.json');
    if (!existsSync(path)) return null;
    const value = object(readRegularJson(path));
    if (
      !Number.isInteger(value['generation']) ||
      typeof value['record_digest_sha256'] !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value['record_digest_sha256']) ||
      Object.keys(value).length !== 2
    ) {
      throw new Error('release-state-store-unsafe');
    }
    return value as unknown as StoreHead;
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

  appendStateAndAdvanceHead(state: ReleaseLifecycleStateV2, expected: StoreHead | null): void {
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
    const next = {
      generation: state.storage.generation,
      record_digest_sha256: state.record_digest_sha256,
    };
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
}

function buildState(
  request: ReleaseLifecycleRequest & { readonly action_id: PersistedReleaseAction },
  material: ReleaseStateMaterial,
  prior: ReleaseLifecycleStateV2 | null,
  authorizationEventId: string | null,
  recordedAt: string,
): ReleaseLifecycleStateV2 {
  assertMaterialBijection(request, request.action_id, material);
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
    actor: {
      kind: 'human',
      role: ROLE_BY_ACTION[request.action_id],
      declaration_source: 'cli-flag',
    },
    consent: {
      write: true,
      allow_publish: EFFECT_BY_ACTION[request.action_id] === 'remote-write',
      experimental: false,
    },
    authorization_event_id: authorizationEventId,
    publication_expectation: material.publication_expectation ?? null,
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
  readonly resolveReceipt?: ReceiptResolver;
  readonly recorded_at: string;
}): Promise<ExecuteReleaseResult> {
  let request: ReleaseLifecycleRequest & { readonly action_id: PersistedReleaseAction };
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
    verifyBoundReceipts(request, input.resolveReceipt);
  } catch (error) {
    return {
      ok: false,
      phase: 'validation',
      code: error instanceof Error ? error.message : 'release-receipt-identity-mismatch',
    };
  }
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
    const stateHead = states.at(-1) ?? null;
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
        : {
            generation: stateHead.storage.generation,
            record_digest_sha256: stateHead.record_digest_sha256,
          };
    if (!same(head, expectedHead))
      return { ok: false, phase: 'reconciliation', code: 'release-state-head-mismatch' };
    const expectedPrior = PRIOR_BY_STATE[STATE_BY_ACTION[request.action_id]];
    if (expectedPrior !== (stateHead?.state ?? null)) {
      return { ok: false, phase: 'validation', code: 'release-state-transition-invalid' };
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
  const remote = EFFECT_BY_ACTION[request.action_id] === 'remote-write';
  let authorizationEventId: string | null = null;
  let binding: AuthorizationAttemptBinding | undefined;
  if (remote) {
    if (request.destination === undefined)
      return { ok: false, phase: 'validation', code: 'release-request-projection-invalid' };
    binding = {
      attempt_id: attemptId,
      action_id: request.action_id,
      request_digest_sha256: requestDigest,
      repository: request.repository_locator,
      candidate: request.candidate_locator,
      destination: request.destination,
    };
    if (input.authorization === undefined) {
      return {
        ok: false,
        phase: 'authorization',
        code: 'release-authorization-provider-unavailable',
      };
    }
    const resolution = await input.authorization.resolve(binding);
    if (!resolution.ok || resolution.grant_event_id === undefined) {
      return {
        ok: false,
        phase: 'authorization',
        code: resolution.code ?? 'absent-effect-authorization',
      };
    }
    authorizationEventId = resolution.grant_event_id;
  }
  if (input.provider === undefined) {
    return { ok: false, phase: 'provider', code: 'release-provider-unavailable' };
  }

  const attempt = buildStoreRecord(
    request,
    priorRecord,
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
      await input.authorization?.consume({ ...binding, grant_event_id: authorizationEventId });
    } catch {
      const failure = buildStoreRecord(
        request,
        attempt,
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
        code: 'release-authorization-consumption-failed',
        record: failure,
      };
    }
  }

  let result: ReleaseProviderResult;
  try {
    result = await input.provider(request);
  } catch {
    result = remote
      ? { outcome: 'unknown', code: 'release-provider-result-unknown' }
      : { outcome: 'failure', code: 'release-provider-failed' };
  }
  if (result.outcome !== 'success') {
    const unsafeRemoteFailure =
      remote &&
      result.outcome === 'failure' &&
      result.provider_handle === undefined &&
      result.dispatch_status !== 'failed-before-dispatch';
    const terminalResult = unsafeRemoteFailure
      ? ({ outcome: 'unknown', code: 'release-provider-result-unknown' } as const)
      : result;
    const kind = terminalResult.outcome === 'unknown' ? 'unknown-provider-result' : 'failure';
    const terminal = buildStoreRecord(
      request,
      attempt,
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
    const failure = buildStoreRecord(request, attempt, attemptId, 'failure', authorizationEventId, {
      ...result,
      outcome: 'failure',
      code: 'release-adapter-output-invalid',
    });
    input.store.appendStoreRecord(failure);
    return {
      ok: false,
      phase: 'validation',
      code: 'release-adapter-output-invalid',
      record: failure,
    };
  }

  let state: ReleaseLifecycleStateV2;
  try {
    state = buildState(
      request,
      result.material,
      states.at(-1) ?? null,
      authorizationEventId,
      input.recorded_at,
    );
  } catch (error) {
    const failure = buildStoreRecord(request, attempt, attemptId, 'failure', authorizationEventId, {
      ...result,
      outcome: 'failure',
      code: 'release-adapter-output-invalid',
    });
    input.store.appendStoreRecord(failure);
    return {
      ok: false,
      phase: 'validation',
      code: error instanceof Error ? error.message : 'release-adapter-output-invalid',
      record: failure,
    };
  }
  const completion = buildStoreRecord(
    request,
    attempt,
    attemptId,
    'completion',
    authorizationEventId,
    result,
    state,
  );
  try {
    input.store.appendStoreRecord(completion);
    input.store.appendStateAndAdvanceHead(state, head);
  } catch (error) {
    return {
      ok: false,
      phase: 'append',
      code: error instanceof Error ? error.message : 'release-state-store-unsafe',
      record: completion,
    };
  }
  return { ok: true, state, completion };
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
      artifacts: [],
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
  readonly repository: ReleaseLifecycleRequest['repository_locator'];
  readonly candidate: ReleaseLifecycleStateV2['candidate'];
  readonly derived_states?: readonly Readonly<Record<string, unknown>>[];
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
  const blocked =
    !stateReduction.ok ||
    !storeReduction.ok ||
    storeReduction.failed ||
    completionMismatch ||
    storeIdentityMismatch ||
    identityMismatch;
  const ambiguous = !blocked && storeReduction.ambiguous;
  const published =
    head !== null && input.publication_receipt !== undefined && input.verify_signature !== undefined
      ? ((await verifyPublicationReceipt(
          input.publication_receipt,
          head,
          input.verify_signature,
        )) ?? { observed: false, receipt: null, verified_against: null })
      : { observed: false, receipt: null, verified_against: null };
  const publishedObserved = published['observed'] === true;
  const derived = [...(input.derived_states ?? [])];
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
  const hasPlan = derived.some((entry) => entry['state'] === 'planned');
  const hasOffline = derived.some((entry) => entry['state'] === 'offline_verified');
  let nextAction: ReleaseAction | null;
  let nextOutcome: 'ready' | 'awaiting-external-receipt' | 'complete' | 'blocked' | 'ambiguous';
  if (blocked) {
    nextAction = null;
    nextOutcome = 'blocked';
  } else if (ambiguous) {
    nextAction = null;
    nextOutcome = 'ambiguous';
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
