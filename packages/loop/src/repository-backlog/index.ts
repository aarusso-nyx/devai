import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { join } from 'node:path';
import { getValidator } from '@devai-nyx/schemas';
import { nextCounterId } from '@devai-nyx/utils';
import {
  trackingFail,
  type GovernanceEvent,
  type GovernanceSessionSource,
} from '../tracking/events.js';
import { readRoundTrackingActivation } from '../tracking/projection.js';
import { recordGovernanceEvent } from '../tracking/store.js';

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

function write(repoRoot: string, item: BacklogItem): void {
  const dir = backlogDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`);
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
  readonly origin: BacklogOrigin;
  readonly createdAt?: string;
}

export function addBacklogItem(options: AddBacklogItemOptions): BacklogItem {
  const draft = (id: string): BacklogItem => ({
    schemaVersion: '1.0.0',
    id,
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
  const item = draft(allocateId(options.repoRoot));
  assertValid(item);
  write(options.repoRoot, item);
  return item;
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

function sourceOf(identity: string): GovernanceSessionSource {
  return identity.startsWith('AUTH-SESSION-') ? 'session-state' : 'direct-cli';
}

/**
 * Project one backlog item onto its explicitly attributed round's governance
 * chain as a `backlog_item_projected` event. It reuses the round's Owner
 * activation and the public-safe disclosure profile: the summary names only
 * the id and kind, and the title and body travel as the payload digest.
 * A round is never inferred, and an absent or disabled activation refuses.
 */
export function projectBacklogItem(options: {
  readonly repoRoot: string;
  readonly id: string;
}): GovernanceEvent {
  const item = showBacklogItem(options);
  const round = item.round_id;
  if (round === undefined) trackingFail('BACKLOG_PROJECTION_ROUND_REQUIRED');
  const activation = readRoundTrackingActivation({ repoRoot: options.repoRoot, round });
  if (activation === undefined || activation.state === 'disabled') {
    trackingFail('BACKLOG_PROJECTION_NOT_ACTIVATED');
  }
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
}
