import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { getValidator } from '@devai-nyx/schemas';
import { canonicalSha256, nextCounterId } from '@devai-nyx/utils';
import {
  trackingFail,
  type GovernanceEvent,
  type GovernanceSessionSource,
} from '../tracking/events.js';
import {
  PublicationIndeterminate,
  fsyncDirectorySync,
  publishCreateOnlyDurableSync,
  replaceDurableSync,
} from '../loop/durable-files.js';
import { readRoundTrackingActivation } from '../tracking/projection.js';
import {
  readGovernanceEvents,
  recordGovernanceEvent,
  trackingStateDir,
} from '../tracking/store.js';

/**
 * Repository backlog store (ADR-GOV-0019).
 *
 * Items live at `.devai/state/backlog/BL-NNNN.json` and are committed with the
 * repository, so a later session in a fresh clone sees them. Ids come from the
 * `BL` key of `.devai/state/counters.json`, and an id already present on disk
 * is never reused even when the (uncommitted) counters file is absent. Every
 * record is validated against `backlog-item.schema.json` before it is written.
 *
 * A backlog item is not a round gap: this module never reads or writes
 * `.devai/state/rgr/`, and a round is recorded only when the caller passes one.
 *
 * Durability and recovery guarantees:
 * - An item is published atomically and create-only (staged, fsynced, linked
 *   into place), so a reader never sees a partial record and a concurrent add
 *   can never overwrite another item.
 * - An add that passes a `requestId` is idempotent by that identity: the id is
 *   recorded on the item, and a retry returns the recorded item instead of
 *   allocating another. The same id with different content is refused. An add
 *   without a request id is always new.
 * - Projection of one item onto its round chain is serialized by a per-round
 *   lock held across the existence check and the append, and an item is
 *   projected at most once. The lock is a create-only record owned by a token;
 *   it is released only by its owner. A lock that is held is waited for
 *   briefly and then refused; a lock older than its TTL is refused with a
 *   repair code and is never taken over automatically.
 */

export type BacklogKind = 'finding' | 'proposition' | 'note' | 'flaky-test';
export type BacklogRole = 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
export type BacklogClass =
  'law' | 'spec' | 'plan' | 'code' | 'tests' | 'docs' | 'ci' | 'toolchain' | 'generated';
export type BacklogStatus = 'open' | 'resolved';

export interface BacklogOrigin {
  readonly session: string;
  readonly role: BacklogRole;
  readonly commit: string;
}

export interface BacklogItem {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly request_id?: string;
  readonly kind: BacklogKind;
  readonly class?: BacklogClass;
  readonly title: string;
  readonly body: string;
  readonly origin: BacklogOrigin;
  readonly round_id?: string;
  readonly status: BacklogStatus;
  readonly resolution?: string;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

export class BacklogStoreError extends Error {
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'BacklogStoreError';
  }
}

export const BACKLOG_STATE_DIR_REL = '.devai/state/backlog';
export const BACKLOG_ID_PATTERN = /^BL-[0-9]{4,}$/u;
export const BACKLOG_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
export const BACKLOG_LOCK_TTL_MS = 10 * 60 * 1000;
const BACKLOG_LOCK_WAIT_MS = 2000;

export interface BacklogLockOptions {
  /** How long to wait for a held lock before refusing; defaults to two seconds. */
  readonly waitMs?: number;
  /** Age after which a held lock is reported stale for repair; defaults to ten minutes. */
  readonly ttlMs?: number;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLockToken(path: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const token = (parsed as { token?: unknown } | null)?.token;
    return typeof token === 'string' ? token : undefined;
  } catch {
    return undefined;
  }
}

function lockAgeMs(path: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const at = Date.parse(String((parsed as { acquired_at?: unknown } | null)?.acquired_at));
    return Number.isNaN(at) ? undefined : Date.now() - at;
  } catch {
    return undefined;
  }
}

/**
 * Hold a create-only lock record across `run`. The record carries an owner
 * token and is removed only while it still carries that token.
 */
function withLock<T>(path: string, options: BacklogLockOptions | undefined, run: () => T): T {
  const token = randomUUID();
  const record = `${JSON.stringify({ token, pid: process.pid, acquired_at: new Date().toISOString() })}\n`;
  const deadline = Date.now() + (options?.waitMs ?? BACKLOG_LOCK_WAIT_MS);
  for (;;) {
    let acquired: boolean;
    try {
      acquired = publishCreateOnlyDurableSync(path, record);
    } catch (error) {
      // An indeterminate publication may have landed: it is ours only if it carries our token.
      if (!(error instanceof PublicationIndeterminate) || readLockToken(path) !== token) {
        throw error;
      }
      acquired = true;
    }
    if (acquired) break;
    const age = lockAgeMs(path);
    if (age === undefined || age > (options?.ttlMs ?? BACKLOG_LOCK_TTL_MS)) {
      throw new BacklogStoreError('BACKLOG_LOCK_STALE', path);
    }
    if (Date.now() >= deadline) throw new BacklogStoreError('BACKLOG_LOCK_HELD', path);
    sleepSync(25);
  }
  try {
    return run();
  } finally {
    if (readLockToken(path) === token) {
      unlinkSync(path);
      fsyncDirectorySync(dirname(path));
    }
  }
}

function requestLockPath(repoRoot: string, requestId: string): string {
  return join(backlogDir(repoRoot), '.locks', `request-${canonicalSha256(requestId)}.lock`);
}

function projectionLockPath(repoRoot: string, round: string): string {
  return join(trackingStateDir(repoRoot, round), 'projection.lock');
}

const validateItem = getValidator('backlog-item.schema.json');

function backlogDir(repoRoot: string): string {
  return join(repoRoot, BACKLOG_STATE_DIR_REL);
}

function assertId(id: string): void {
  if (!BACKLOG_ID_PATTERN.test(id)) throw new BacklogStoreError('BACKLOG_ITEM_ID_INVALID', id);
}

function assertValid(item: unknown): asserts item is BacklogItem {
  if (!validateItem(item)) {
    throw new BacklogStoreError('BACKLOG_ITEM_SCHEMA_INVALID', JSON.stringify(validateItem.errors));
  }
}

function serialize(item: BacklogItem): string {
  return `${JSON.stringify(item, null, 2)}\n`;
}

/** Atomically replace an existing record: a staged, fsynced file renamed into place. */
function write(repoRoot: string, item: BacklogItem): void {
  replaceDurableSync(join(backlogDir(repoRoot), `${item.id}.json`), serialize(item));
}

/** Publish a new record only when its id is free; false means another add holds the id. */
function publishNew(repoRoot: string, item: BacklogItem): boolean {
  return publishCreateOnlyDurableSync(
    join(backlogDir(repoRoot), `${item.id}.json`),
    serialize(item),
  );
}

function storedIds(repoRoot: string): readonly string[] {
  const dir = backlogDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^BL-[0-9]{4,}\.json$/u.test(name))
    .map((name) => name.slice(0, -'.json'.length))
    .sort(compareIds);
}

function compareIds(left: string, right: string): number {
  return Number(left.slice(3)) - Number(right.slice(3)) || left.localeCompare(right);
}

/**
 * Allocate from the shared counter, skipping any id a committed item already
 * holds: a fresh clone carries items but not the ignored counters file.
 */
function allocateId(repoRoot: string): string {
  const taken = new Set(storedIds(repoRoot));
  for (;;) {
    const id = nextCounterId({
      repoRoot,
      key: 'BL',
      prefix: 'BL',
      effects: { mkdirSync, writeFileSync },
    });
    if (!taken.has(id)) return id;
  }
}

export interface AddBacklogItemOptions {
  readonly repoRoot: string;
  readonly kind: BacklogKind;
  readonly title: string;
  readonly body: string;
  readonly class?: BacklogClass;
  readonly roundId?: string;
  /** Durable request identity; a retry with the same id recovers the recorded item. */
  readonly requestId?: string;
  readonly lock?: BacklogLockOptions;
  readonly origin: BacklogOrigin;
  readonly createdAt?: string;
}

export function addBacklogItem(options: AddBacklogItemOptions): BacklogItem {
  const draft = (id: string): BacklogItem => ({
    schemaVersion: '1.0.0',
    id,
    ...(options.requestId === undefined ? {} : { request_id: options.requestId }),
    kind: options.kind,
    ...(options.class === undefined ? {} : { class: options.class }),
    title: options.title,
    body: options.body,
    origin: {
      session: options.origin.session,
      role: options.origin.role,
      commit: options.origin.commit,
    },
    ...(options.roundId === undefined ? {} : { round_id: options.roundId }),
    status: 'open',
    created_at: options.createdAt ?? new Date().toISOString(),
    resolved_at: null,
  });
  // Validate before allocating so a refused item never consumes an id.
  assertValid(draft('BL-0001'));
  const create = (): BacklogItem => {
    for (;;) {
      const item = draft(allocateId(options.repoRoot));
      assertValid(item);
      if (publishNew(options.repoRoot, item)) return item;
    }
  };
  const requestId = options.requestId;
  if (requestId === undefined) return create();
  return withLock(requestLockPath(options.repoRoot, requestId), options.lock, () => {
    const recorded = findByRequestId(options.repoRoot, requestId);
    if (recorded === undefined) return create();
    if (
      recorded.kind !== options.kind ||
      recorded.title !== options.title ||
      recorded.body !== options.body ||
      recorded.class !== options.class ||
      recorded.round_id !== options.roundId ||
      recorded.origin.role !== options.origin.role
    ) {
      throw new BacklogStoreError('BACKLOG_REQUEST_ID_CONFLICT', requestId);
    }
    return recorded;
  });
}

/**
 * The item recorded under a request id. An unreadable record could be the one
 * being recovered, so it refuses with a repair code naming it rather than
 * guessing; adds without a request id never scan and are not affected.
 */
function findByRequestId(repoRoot: string, requestId: string): BacklogItem | undefined {
  for (const id of storedIds(repoRoot)) {
    let item: BacklogItem;
    try {
      item = showBacklogItem({ repoRoot, id });
    } catch {
      throw new BacklogStoreError('BACKLOG_ITEM_UNREADABLE', id);
    }
    if (item.request_id === requestId) return item;
  }
  return undefined;
}

export function listBacklogItems(options: {
  readonly repoRoot: string;
  readonly status?: BacklogStatus | 'all';
  readonly roundId?: string;
}): readonly BacklogItem[] {
  const status = options.status ?? 'open';
  return storedIds(options.repoRoot)
    .map((id) => showBacklogItem({ repoRoot: options.repoRoot, id }))
    .filter((item) => status === 'all' || item.status === status)
    .filter((item) => options.roundId === undefined || item.round_id === options.roundId);
}

export function showBacklogItem(options: {
  readonly repoRoot: string;
  readonly id: string;
}): BacklogItem {
  assertId(options.id);
  const path = join(backlogDir(options.repoRoot), `${options.id}.json`);
  if (!existsSync(path)) throw new BacklogStoreError('BACKLOG_ITEM_NOT_FOUND', options.id);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assertValid(parsed);
  if (parsed.id !== options.id) throw new BacklogStoreError('BACKLOG_ITEM_ID_MISMATCH', options.id);
  return parsed;
}

export function resolveBacklogItem(options: {
  readonly repoRoot: string;
  readonly id: string;
  readonly resolution: string;
  readonly resolvedAt?: string;
}): BacklogItem {
  const current = showBacklogItem({ repoRoot: options.repoRoot, id: options.id });
  if (current.status === 'resolved') {
    throw new BacklogStoreError('BACKLOG_ITEM_ALREADY_RESOLVED', options.id);
  }
  if (options.resolution.trim().length === 0) {
    throw new BacklogStoreError('BACKLOG_RESOLUTION_REQUIRED', options.id);
  }
  const next: BacklogItem = {
    ...current,
    status: 'resolved',
    resolution: options.resolution,
    resolved_at: options.resolvedAt ?? new Date().toISOString(),
  };
  assertValid(next);
  write(options.repoRoot, next);
  return next;
}

function isProjectionOf(event: GovernanceEvent, id: string): boolean {
  return event.kind === 'backlog_item_projected' && event.evidence_refs.includes(id);
}

function sourceOf(identity: string): GovernanceSessionSource {
  return identity.startsWith('AUTH-SESSION-') ? 'session-state' : 'direct-cli';
}

/**
 * Project one backlog item onto its explicitly attributed round's governance
 * chain as a `backlog_item_projected` event. It reuses the round's Owner
 * activation and the public-safe disclosure profile: the summary names only
 * the id and kind, and the title and body travel as the payload digest.
 * A round is never inferred, and an absent or disabled activation refuses.
 * Projecting an already projected item returns its recorded event.
 */
export function projectBacklogItem(options: {
  readonly repoRoot: string;
  readonly id: string;
  readonly lock?: BacklogLockOptions;
}): GovernanceEvent {
  const item = showBacklogItem(options);
  const round = item.round_id;
  if (round === undefined) trackingFail('BACKLOG_PROJECTION_ROUND_REQUIRED');
  const notActivated = (): boolean => {
    const activation = readRoundTrackingActivation({ repoRoot: options.repoRoot, round });
    return activation === undefined || activation.state === 'disabled';
  };
  if (notActivated()) trackingFail('BACKLOG_PROJECTION_NOT_ACTIVATED');
  // The existence check and the append are one critical section per round, so two
  // processes can neither both append nor interleave on the governance chain.
  return withLock(projectionLockPath(options.repoRoot, round), options.lock, () => {
    // The activation is read again under the lock: it may have been disabled meanwhile.
    const activation = readRoundTrackingActivation({ repoRoot: options.repoRoot, round });
    if (activation === undefined || activation.state === 'disabled') {
      trackingFail('BACKLOG_PROJECTION_NOT_ACTIVATED');
    }
    // Idempotent: an item already on the chain is reported, never appended twice.
    const existing = readGovernanceEvents({ repoRoot: options.repoRoot, round }).find((event) =>
      isProjectionOf(event, item.id),
    );
    if (existing !== undefined) return existing;
    const identity = activation.authorization.authority_session_id;
    return recordGovernanceEvent({
      repoRoot: options.repoRoot,
      repositoryId: activation.repository_id,
      draft: {
        round_id: round,
        task_id: null,
        authority_session_id: identity,
        session_source: sourceOf(identity),
        role: item.origin.role,
        kind: 'backlog_item_projected',
        commit_binding: null,
        coverage: { mediated: true, adapter_id: null },
        summary: `Backlog item ${item.id} (${item.kind}) is ${item.status}.`,
        evidence_refs: [item.id],
        payload: item,
      },
    });
  });
}
