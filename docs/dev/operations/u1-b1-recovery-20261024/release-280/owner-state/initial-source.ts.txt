import { createHash } from 'node:crypto';
import { types } from 'node:util';
import {
  decodeReconciliationOwnerRecord,
  encodeReconciliationOwnerRecord,
  verifyReconciliationOwnerRecord,
  type ReconciliationOwnerRecord,
} from './reconciliation-owner-record.js';
import {
  validateReconciliationClockObservation,
  type ReconciliationClockObservation,
} from './reconciliation-clock.js';

type Phase = '01' | '02' | '03' | '04';
type Approval = Extract<ReconciliationOwnerRecord, { kind: 'approval' }>;
type Grant = Extract<ReconciliationOwnerRecord, { kind: 'approval' | 'renewal' | 'revocation' }>;
type Intent = Extract<ReconciliationOwnerRecord, { kind: 'phase-intent' }>;
type Completion = Extract<ReconciliationOwnerRecord, { kind: 'phase-completion' }>;
type Lease = Extract<ReconciliationOwnerRecord, { kind: 'lease' }>;
type OperationRecord = Exclude<ReconciliationOwnerRecord, { kind: 'issuer' }>;
type Node<R extends OperationRecord = OperationRecord> = Readonly<{ sha: string; record: R }>;
const PHASES = Object.freeze(['01', '02', '03', '04'] as const);
const NS_PER_MS = 1000000n;
const MAX_BYTES = 33554432;
const byteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength',
)?.get;

/** Safe verified data. This object never grants host, action or effect authority. */
export interface ReconciliationOwnerState {
  readonly kind: 'reconciliation-owner-state';
  readonly repository_id: string;
  readonly worktree_id: string;
  readonly host_identity_sha256: string;
  readonly binding_sha256: string;
  readonly plan_sha256: string;
  readonly source_manifest_sha256: string;
  readonly approval_id: string;
  readonly issuer_sha256: string;
  readonly approval_sha256: string;
  readonly scope_sha256: string;
  readonly grant_sha256: string;
  readonly grant_sequence: number;
  readonly grant_kind: Grant['kind'];
  readonly lease_sha256: string | null;
  readonly phases: readonly Readonly<{
    phase: Phase;
    intent_sha256: string | null;
    completion_sha256: string | null;
  }>[];
  readonly grants_authority: false;
}
export interface ReconciliationOwnerPhaseAssessment {
  readonly phase: Phase;
  readonly grant_status: 'live' | 'expired' | 'revoked';
  readonly disposition: 'start' | 'resume' | 'settle' | 'completed' | 'held';
  readonly intent_sha256: string | null;
  readonly completion_sha256: string | null;
  readonly grants_authority: false;
}
export class ReconciliationOwnerStateError extends Error {
  readonly code = 'RECONCILIATION_OWNER_STATE_INVALID';
  constructor() {
    super('RECONCILIATION_OWNER_STATE_INVALID');
    this.name = 'ReconciliationOwnerStateError';
  }
}
interface PrivateState {
  readonly approval: Node<Approval>;
  readonly current: Node<Grant>;
  readonly intents: ReadonlyMap<Phase, Node<Intent>>;
  readonly completions: ReadonlyMap<Phase, Node<Completion>>;
  readonly history: readonly Node[];
}
const states = new WeakMap<object, PrivateState>();
function invalid(): never {
  throw new ReconciliationOwnerStateError();
}
function guarded<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    return invalid();
  }
}
function fields(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || types.isProxy(input)) invalid();
  const proto: unknown = Object.getPrototypeOf(input);
  if (proto !== null && proto !== Object.prototype) invalid();
  const expected = [
    'issuer_bytes',
    'approval_bytes',
    'grant_bytes',
    'intent_bytes',
    'completion_bytes',
    'lease_bytes',
  ];
  const keys = Reflect.ownKeys(input);
  if (keys.length !== expected.length) invalid();
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string' || !expected.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    copy[key] = descriptor.value;
  }
  return copy;
}
function array(input: unknown, limit: number): readonly unknown[] {
  if (types.isProxy(input) || !Array.isArray(input)) invalid();
  const proto: unknown = Object.getPrototypeOf(input);
  if (proto !== null && proto !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(input, 'length')?.value as unknown;
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > limit)
    invalid();
  if (Reflect.ownKeys(input).length !== length + 1) invalid();
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    copy.push(descriptor.value);
  }
  return copy;
}
function size(input: unknown): number {
  if (types.isProxy(input) || !types.isUint8Array(input) || byteLength === undefined) invalid();
  const count: unknown = Reflect.apply(byteLength, input, []);
  if (typeof count !== 'number' || count < 1 || count > 1048576) invalid();
  return count;
}
function sha(record: ReconciliationOwnerRecord): string {
  return createHash('sha256').update(encodeReconciliationOwnerRecord(record)).digest('hex');
}
/** Check chronology without imposing an expiry on immutable history. */
function ordered(
  earlier: ReconciliationClockObservation,
  later: ReconciliationClockObservation,
): void {
  if (earlier.boot_id !== later.boot_id || earlier.clock_source !== later.clock_source) invalid();
  const wall = later.wall_ms - earlier.wall_ms;
  const ns = BigInt(later.monotonic_ns) - BigInt(earlier.monotonic_ns);
  if (wall < 0 || ns < 0n) invalid();
  const difference = BigInt(wall) * NS_PER_MS - ns;
  if (difference < -2000n * NS_PER_MS || difference > 2000n * NS_PER_MS) invalid();
}
function grantAllows(grant: Grant, phase: Phase, clock: ReconciliationClockObservation): void {
  if (grant.kind === 'revocation') invalid();
  ordered(grant.clock, clock);
  const allowed = grant.kind === 'approval' ? grant.scope.allowed_phases : grant.remaining_phases;
  if (
    !allowed.includes(phase) ||
    clock.wall_ms >= grant.expires_wall_ms ||
    BigInt(clock.monotonic_ns) >= BigInt(grant.expires_monotonic_ns)
  )
    invalid();
}

/** Authenticate and reduce an immutable record graph; no filesystem or trusted clock observation. */
export function readReconciliationOwnerState(input: unknown): ReconciliationOwnerState {
  return guarded(() => {
    const data = fields(input);
    const rawGrants = array(data['grant_bytes'], 4096);
    const rawIntents = array(data['intent_bytes'], 4);
    const rawCompletions = array(data['completion_bytes'], 4);
    const allBytes = [
      data['issuer_bytes'],
      data['approval_bytes'],
      ...rawGrants,
      ...rawIntents,
      ...rawCompletions,
      ...(data['lease_bytes'] === null ? [] : [data['lease_bytes']]),
    ];
    let total = 0;
    for (const bytes of allBytes) {
      total += size(bytes);
      if (total > MAX_BYTES) invalid();
    }
    const issuer = decodeReconciliationOwnerRecord(data['issuer_bytes'] as Uint8Array);
    if (issuer.kind !== 'issuer') invalid();
    verifyReconciliationOwnerRecord(issuer, issuer.private_key_base64);
    const issuerSha = sha(issuer);
    const decode = (bytes: unknown): OperationRecord => {
      const record = verifyReconciliationOwnerRecord(
        decodeReconciliationOwnerRecord(bytes as Uint8Array),
        issuer.private_key_base64,
      );
      if (record.kind === 'issuer') invalid();
      return record;
    };
    const approvalRecord = decode(data['approval_bytes']);
    if (
      approvalRecord.kind !== 'approval' ||
      approvalRecord.repository_id !== issuer.repository_id ||
      approvalRecord.worktree_id !== issuer.worktree_id ||
      approvalRecord.issuer_sha256 !== issuerSha ||
      approvalRecord.scope.host_identity_sha256 !== issuer.host_identity_sha256
    )
      invalid();
    const approval: Node<Approval> = { sha: sha(approvalRecord), record: approvalRecord };
    const nodes = new Map<string, Node>();
    const adjacency = new Map<string, Set<string>>();
    const indegrees = new Map<string, number>();
    const add = <R extends OperationRecord>(record: R): Node<R> => {
      const digest = sha(record);
      if (nodes.has(digest)) invalid();
      const node = { sha: digest, record };
      nodes.set(digest, node);
      adjacency.set(digest, new Set());
      indegrees.set(digest, 0);
      return node;
    };
    add(approvalRecord);
    const edge = (before: Node, after: Node): void => {
      if (before.sha === after.sha) invalid();
      ordered(before.record.clock, after.record.clock);
      const outgoing = adjacency.get(before.sha);
      if (outgoing === undefined) invalid();
      if (!outgoing.has(after.sha)) {
        outgoing.add(after.sha);
        indegrees.set(after.sha, (indegrees.get(after.sha) ?? invalid()) + 1);
      }
    };
    const linked = (record: OperationRecord): void => {
      if (
        record.repository_id !== approvalRecord.repository_id ||
        record.worktree_id !== approvalRecord.worktree_id ||
        record.approval_id !== approvalRecord.approval_id ||
        record.issuer_sha256 !== issuerSha ||
        record.scope_sha256 !== approvalRecord.scope_sha256 ||
        (record.kind !== 'approval' && record.approval_sha256 !== approval.sha)
      )
        invalid();
      ordered(approvalRecord.clock, record.clock);
    };
    const grants: Node<Grant>[] = [approval];
    for (const bytes of rawGrants) {
      const record = decode(bytes);
      if (record.kind !== 'renewal' && record.kind !== 'revocation') invalid();
      linked(record);
      const previous = grants[grants.length - 1] ?? invalid();
      if (
        previous.record.kind === 'revocation' ||
        record.sequence !== previous.record.sequence + 1 ||
        record.previous_grant_sha256 !== previous.sha
      )
        invalid();
      const node = add(record);
      edge(previous, node);
      grants.push(node);
    }
    const grantBySha = new Map(grants.map((node) => [node.sha, node]));
    const nextGrant = new Map(
      grants.slice(0, -1).map((node, index) => [node.sha, grants[index + 1]]),
    );
    const fence = (node: Node, digest: string): Node<Grant> => {
      const grant = grantBySha.get(digest) ?? invalid();
      edge(grant, node);
      const successor = nextGrant.get(grant.sha);
      if (successor) edge(node, successor);
      return grant;
    };
    const intents = new Map<Phase, Node<Intent>>();
    for (const bytes of rawIntents) {
      const record = decode(bytes);
      if (record.kind !== 'phase-intent' || intents.has(record.phase)) invalid();
      linked(record);
      const expectedAction =
        record.phase === '04'
          ? 'sense bootstrap-inventory'
          : record.phase === '03'
            ? 'evidence reconcile stage-proof'
            : 'evidence reconcile materialize';
      if (
        record.action_id !== expectedAction ||
        record.initiator !== (record.phase === '04' ? 'architect' : 'inspector')
      )
        invalid();
      const node = add(record);
      const grant = fence(node, record.grant_sha256);
      grantAllows(grant.record, record.phase, record.clock);
      intents.set(record.phase, node);
    }
    const completions = new Map<Phase, Node<Completion>>();
    for (const bytes of rawCompletions) {
      const record = decode(bytes);
      if (record.kind !== 'phase-completion' || completions.has(record.phase)) invalid();
      linked(record);
      const intent = intents.get(record.phase) ?? invalid();
      if (record.intent_sha256 !== intent.sha) invalid();
      const node = add(record);
      fence(node, record.observed_grant_sha256);
      edge(intent, node);
      completions.set(record.phase, node);
    }
    let uncompleted = 0;
    for (const [index, phase] of PHASES.entries()) {
      const intent = intents.get(phase);
      const completion = completions.get(phase);
      if (intent === undefined) continue;
      if (completion === undefined) uncompleted += 1;
      const priorPhase = PHASES[index - 1];
      const predecessor = priorPhase === undefined ? undefined : completions.get(priorPhase);
      if (index > 0 && predecessor === undefined) invalid();
      const expected = predecessor?.sha ?? null;
      if (
        intent.record.predecessor_completion_sha256 !== expected ||
        (completion && completion.record.predecessor_completion_sha256 !== expected)
      )
        invalid();
      if (predecessor) edge(predecessor, intent);
    }
    if (uncompleted > 1) invalid();
    for (const grant of grants) {
      if (grant.record.kind !== 'renewal') continue;
      const remaining = grant.record.remaining_phases;
      const first = PHASES.findIndex((phase) => remaining.includes(phase));
      const suffix: readonly Phase[] = first < 0 ? [] : PHASES.slice(first);
      if (
        suffix.length !== remaining.length ||
        suffix.some((phase, index) => phase !== remaining[index])
      )
        invalid();
      const resume = grant.record.resumable_intent_sha256;
      let foundResume = resume === null;
      for (const phase of PHASES) {
        const intent = intents.get(phase);
        const completion = completions.get(phase);
        if (!remaining.includes(phase)) {
          if (completion === undefined) invalid();
          edge(completion, grant);
        } else {
          if (completion) edge(grant, completion);
          if (intent) {
            if (intent.sha === resume) {
              edge(intent, grant);
              foundResume = true;
            } else edge(grant, intent);
          }
        }
      }
      if (!foundResume) invalid();
    }
    let lease: Node<Lease> | undefined;
    if (data['lease_bytes'] !== null) {
      const record = decode(data['lease_bytes']);
      if (record.kind !== 'lease') invalid();
      linked(record);
      const intent = intents.get(record.phase) ?? invalid();
      if (
        record.original_intent_sha256 !== intent.sha ||
        record.action_id !== intent.record.action_id ||
        record.initiator !== intent.record.initiator ||
        record.host_identity_sha256 !== approvalRecord.scope.host_identity_sha256
      )
        invalid();
      lease = add(record);
      const grant = fence(lease, record.grant_sha256);
      grantAllows(grant.record, record.phase, record.clock);
      if (
        grant.sha !== intent.record.grant_sha256 &&
        (grant.record.kind !== 'renewal' || grant.record.resumable_intent_sha256 !== intent.sha)
      )
        invalid();
      edge(intent, lease);
      const completion = completions.get(record.phase);
      if (completion) edge(lease, completion);
    }
    const queue = [...nodes.keys()].filter((digest) => indegrees.get(digest) === 0);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const digest = queue[cursor] ?? invalid();
      for (const child of adjacency.get(digest) ?? invalid()) {
        const count = (indegrees.get(child) ?? invalid()) - 1;
        indegrees.set(child, count);
        if (count === 0) queue.push(child);
      }
    }
    if (queue.length !== nodes.size) invalid();
    const current = grants[grants.length - 1] ?? invalid();
    const state: ReconciliationOwnerState = Object.freeze({
      kind: 'reconciliation-owner-state',
      repository_id: approvalRecord.repository_id,
      worktree_id: approvalRecord.worktree_id,
      host_identity_sha256: approvalRecord.scope.host_identity_sha256,
      binding_sha256: approvalRecord.scope.binding_sha256,
      plan_sha256: approvalRecord.scope.plan_sha256,
      source_manifest_sha256: approvalRecord.scope.source_manifest_sha256,
      approval_id: approvalRecord.approval_id,
      issuer_sha256: issuerSha,
      approval_sha256: approval.sha,
      scope_sha256: approvalRecord.scope_sha256,
      grant_sha256: current.sha,
      grant_sequence: current.record.sequence,
      grant_kind: current.record.kind,
      lease_sha256: lease?.sha ?? null,
      phases: Object.freeze(
        PHASES.map((phase) =>
          Object.freeze({
            phase,
            intent_sha256: intents.get(phase)?.sha ?? null,
            completion_sha256: completions.get(phase)?.sha ?? null,
          }),
        ),
      ),
      grants_authority: false,
    });
    // No issuer, key or supplied byte view survives in this data-only brand.
    states.set(state, { approval, current, intents, completions, history: [...nodes.values()] });
    return state;
  });
}

/** Pure eligibility only; actual host origin, output verification and authority remain separate. */
export function assessReconciliationOwnerPhase(
  state: unknown,
  phase: unknown,
  observedClock: unknown,
  outputs: unknown,
): ReconciliationOwnerPhaseAssessment {
  return guarded(() => {
    if (state === null || typeof state !== 'object' || types.isProxy(state)) invalid();
    const data = states.get(state) ?? invalid();
    if (
      typeof phase !== 'string' ||
      !PHASES.includes(phase as Phase) ||
      (outputs !== 'absent' &&
        outputs !== 'partial-known' &&
        outputs !== 'complete' &&
        outputs !== 'unknown')
    )
      invalid();
    const selected = phase as Phase;
    const observed = validateReconciliationClockObservation(observedClock);
    for (const node of data.history) ordered(node.record.clock, observed);
    const grant = data.current.record;
    const grantStatus =
      grant.kind === 'revocation'
        ? 'revoked'
        : observed.wall_ms >= grant.expires_wall_ms ||
            BigInt(observed.monotonic_ns) >= BigInt(grant.expires_monotonic_ns)
          ? 'expired'
          : 'live';
    const intent = data.intents.get(selected);
    const completion = data.completions.get(selected);
    let disposition: ReconciliationOwnerPhaseAssessment['disposition'] = 'held';
    if (outputs !== 'unknown') {
      if (completion) {
        if (outputs === 'complete') disposition = 'completed';
      } else {
        const index = PHASES.indexOf(selected);
        const prior = PHASES[index - 1];
        const predecessorComplete = prior === undefined || data.completions.has(prior);
        if (predecessorComplete) {
          if (intent && outputs === 'complete') disposition = 'settle';
          else if (grantStatus === 'live' && grant.kind !== 'revocation') {
            const allowed =
              grant.kind === 'approval' ? grant.scope.allowed_phases : grant.remaining_phases;
            if (allowed.includes(selected)) {
              if (!intent && outputs === 'absent') disposition = 'start';
              else if (
                intent &&
                (data.current.sha === intent.record.grant_sha256 ||
                  (grant.kind === 'renewal' && grant.resumable_intent_sha256 === intent.sha))
              )
                disposition = 'resume';
            }
          }
        }
      }
    }
    return Object.freeze({
      phase: selected,
      grant_status: grantStatus,
      disposition,
      intent_sha256: intent?.sha ?? null,
      completion_sha256: completion?.sha ?? null,
      grants_authority: false,
    });
  });
}
