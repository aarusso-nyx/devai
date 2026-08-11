import {
  execFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { join } from 'node:path';
import { getValidator } from '@devai-nyx/schemas';

const validatePhaseClosure = getValidator('phase-closure.schema.json');

/**
 * Phase/round closure ledger (D-110; governance-roadmap item 4).
 *
 * One PhaseClosure record per closed phase/round under
 * record/proofs/compliance/closures/PC-NNNN.json. Records are append-only:
 * `closePhase` never overwrites, and corrections append a new record
 * carrying `supersedes`. Derived properties (the consecutive
 * no-deletion streak, batch counts, gate history) are computed from
 * the records by `computeLedger` — they are never stored, so they can
 * never drift the way hand-narrated counters did (D-108).
 */

export type ClosureRole = 'Owner' | 'Architect' | 'Inspector' | 'Engineer' | 'Auditor' | 'Machine';

export interface ClosureBatch {
  readonly id: string;
  readonly roles: readonly ClosureRole[];
  readonly commit?: string;
  readonly headline: string;
}

export interface ClosureGateResult {
  readonly status: 'pass' | 'fail' | 'skipped';
  readonly detail?: string;
}

export interface ClosureCriterion {
  readonly criterion: string;
  readonly verdict: 'pass' | 'fail' | 'n/a';
  readonly evidence?: string;
}

export interface PhaseClosureDraft {
  readonly round_id: string;
  readonly title?: string;
  readonly declaring_decision: string;
  readonly closing_decision: string;
  readonly batches: readonly ClosureBatch[];
  readonly gates: Readonly<Record<string, ClosureGateResult>>;
  readonly source_repo_deleted: boolean;
  readonly validation_criteria: readonly ClosureCriterion[];
  readonly closed_at?: string;
  readonly supersedes?: string;
  // Shipped-state fields stay optional for immutable records; current closure
  // writes require both fields.
  readonly merged_as?: string;
  readonly release_disposition?: 'published' | 'changeset-pending' | 'none-needed' | 'missing';
  readonly notes?: string;
}

export interface PhaseClosureRecord extends PhaseClosureDraft {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly closed_at: string;
}

const CLOSURES_DIR = 'record/proofs/compliance/closures';

function closuresDir(repoRoot: string): string {
  return join(repoRoot, CLOSURES_DIR);
}

export function readClosures(repoRoot: string): PhaseClosureRecord[] {
  const dir = closuresDir(repoRoot);
  if (!existsSync(dir)) return [];
  const records: PhaseClosureRecord[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!/^PC-[0-9]{4}\.json$/.test(name)) continue;
    let record: PhaseClosureRecord;
    try {
      record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as PhaseClosureRecord;
    } catch (error) {
      throw new Error(
        `phase closure ${name} is malformed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (record.id !== name.slice(0, -'.json'.length)) {
      throw new Error(`phase closure ${name} declares mismatched id '${String(record.id)}'`);
    }
    if (!validatePhaseClosure(record)) {
      const errors = (validatePhaseClosure.errors ?? [])
        .map((error) => `${error.instancePath || '/'} ${error.message ?? ''}`)
        .join('; ');
      throw new Error(
        `phase closure ${name} does not validate against phase-closure.schema.json: ${errors}`,
      );
    }
    records.push(record);
  }
  return records.sort((a, b) => a.id.localeCompare(b.id));
}

function nextClosureId(existing: readonly PhaseClosureRecord[]): string {
  let max = 0;
  for (const r of existing) {
    const n = Number(r.id.slice(3));
    if (n > max) max = n;
  }
  return `PC-${String(max + 1).padStart(4, '0')}`;
}

interface ParsedDecisionId {
  readonly namespace: 'D' | 'DII';
  readonly number: number;
}

function parseDecisionId(value: string): ParsedDecisionId {
  const match = /^(D|DII)-([0-9]+)$/.exec(value);
  if (match === null) throw new Error(`phase close: malformed decision id '${value}'`);
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`phase close: malformed decision id '${value}'`);
  }
  return { namespace: match[1] as ParsedDecisionId['namespace'], number };
}

export interface ClosePhaseResult {
  readonly record: PhaseClosureRecord;
  readonly path: string;
}

function mentionsExactGateIdentity(text: string, gate: string): boolean {
  const escaped = gate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'u').test(text);
}

function requireGitCommit(repoRoot: string, identity: string, label: string): void {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${identity}^{commit}`], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    throw new Error(`phase close: ${label} '${identity}' does not resolve to a Git commit`);
  }
}

/**
 * Validate a draft, assign the next sequential id, and write the
 * record. Throws on schema violation, on closing-decision number
 * lower than the declaring one, on duplicate round_id (unless the new
 * record supersedes), and on any failing gate without an explicit
 * failing validation criterion acknowledging it.
 */
export function closePhase(repoRoot: string, draft: PhaseClosureDraft): ClosePhaseResult {
  if (Object.prototype.hasOwnProperty.call(draft, 'id')) {
    throw new Error(
      'phase close: caller-supplied id is forbidden; the closure verb assigns the next PC identity',
    );
  }
  const preflightRecord = {
    ...draft,
    schemaVersion: '1.0.0',
    id: 'PC-0000',
    closed_at: draft.closed_at ?? new Date().toISOString(),
  };
  const validateDraft = (): void => {
    if (validatePhaseClosure(preflightRecord)) return;
    const errors = (validatePhaseClosure.errors ?? [])
      .map((error) => `${error.instancePath || '/'} ${error.message ?? ''}`)
      .join('; ');
    throw new Error(
      `phase close: draft does not validate against phase-closure.schema.json: ${errors}`,
    );
  };
  validateDraft();
  const fullGitObject = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
  for (const batch of draft.batches) {
    if (
      batch.roles.includes('Machine') &&
      (batch.commit === undefined || !fullGitObject.test(batch.commit))
    ) {
      throw new Error(
        `phase close: Machine-attributed batch '${batch.id}' requires a full 40- or 64-character commit identity`,
      );
    }
  }
  for (const batch of draft.batches) {
    if (batch.commit === undefined) continue;
    requireGitCommit(repoRoot, batch.commit, `batch '${batch.id}' commit`);
  }
  const existing = readClosures(repoRoot);
  const record: PhaseClosureRecord = {
    ...draft,
    schemaVersion: '1.0.0',
    id: nextClosureId(existing),
    closed_at: draft.closed_at ?? new Date().toISOString(),
  } as PhaseClosureRecord;

  if (!validatePhaseClosure(record)) {
    const errors = (validatePhaseClosure.errors ?? [])
      .map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`)
      .join('; ');
    throw new Error(
      `phase close: draft does not validate against phase-closure.schema.json: ${errors}`,
    );
  }
  const unacknowledgedFailedGates = Object.entries(record.gates)
    .filter(([, result]) => result.status === 'fail')
    .map(([gate]) => gate)
    .filter(
      (gate) =>
        !record.validation_criteria.some(
          (criterion) =>
            criterion.verdict === 'fail' &&
            mentionsExactGateIdentity(`${criterion.criterion}\n${criterion.evidence ?? ''}`, gate),
        ),
    );
  if (unacknowledgedFailedGates.length > 0) {
    throw new Error(
      `phase close: failed gates require explicit failing validation criteria naming each gate: ${unacknowledgedFailedGates.join(', ')}`,
    );
  }
  const declaring = parseDecisionId(record.declaring_decision);
  const closing = parseDecisionId(record.closing_decision);
  if (declaring.namespace !== closing.namespace) {
    throw new Error(
      `phase close: declaring decision ${record.declaring_decision} and closing decision ${record.closing_decision} use different namespaces`,
    );
  }
  if (closing.number <= declaring.number) {
    throw new Error(
      `phase close: closing decision ${record.closing_decision} must strictly follow declaring decision ${record.declaring_decision}`,
    );
  }
  const dup = existing.find((r) => r.round_id === record.round_id);
  if (dup !== undefined && record.supersedes !== dup.id) {
    throw new Error(
      `phase close: round_id '${record.round_id}' already closed as ${dup.id}; pass supersedes: '${dup.id}' to correct it`,
    );
  }
  if (record.supersedes !== undefined && !existing.some((r) => r.id === record.supersedes)) {
    throw new Error(`phase close: supersedes ${record.supersedes} does not exist`);
  }
  // Every emitted closure must bind the merge that contains it.
  if (record.merged_as === undefined) {
    throw new Error(
      'phase close: merged_as is required — close only at or after the merge that ships the round',
    );
  }
  if (record.release_disposition === undefined) {
    throw new Error(
      'phase close: release_disposition is required (published | changeset-pending | none-needed | missing)',
    );
  }
  requireGitCommit(repoRoot, record.merged_as, 'merged_as');

  const dir = closuresDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record.id}.json`);
  if (existsSync(path)) {
    throw new Error(`phase close: ${path} already exists (closures are append-only)`);
  }
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n');
  return { record, path };
}

export interface LedgerRound {
  readonly id: string;
  readonly round_id: string;
  readonly title?: string;
  readonly closed_at: string;
  readonly declaring_decision: string;
  readonly closing_decision: string;
  readonly batch_count: number;
  readonly roles: readonly ClosureRole[];
  readonly gates_failed: readonly string[];
  readonly source_repo_deleted: boolean;
  readonly superseded_by?: string;
}

export interface ClosureLedger {
  readonly count: number;
  /** Consecutive no-deletion closures counting back from the latest effective record. */
  readonly no_deletion_streak: number;
  readonly streak_basis: string;
  readonly rounds: readonly LedgerRound[];
}

/** Latest-wins view: records superseded by a later record are annotated, not dropped. */
export function computeLedger(records: readonly PhaseClosureRecord[]): ClosureLedger {
  const supersededBy = new Map<string, string>();
  for (const r of records) {
    if (r.supersedes !== undefined) supersededBy.set(r.supersedes, r.id);
  }
  const rounds: LedgerRound[] = records.map((r) => ({
    id: r.id,
    round_id: r.round_id,
    ...(r.title !== undefined && { title: r.title }),
    closed_at: r.closed_at,
    declaring_decision: r.declaring_decision,
    closing_decision: r.closing_decision,
    batch_count: r.batches.length,
    roles: [...new Set(r.batches.flatMap((b) => b.roles))],
    gates_failed: Object.entries(r.gates)
      .filter(([, g]) => g.status === 'fail')
      .map(([name]) => name),
    source_repo_deleted: r.source_repo_deleted,
    ...(supersededBy.has(r.id) && { superseded_by: supersededBy.get(r.id) }),
  }));

  const effective = rounds.filter((r) => r.superseded_by === undefined);
  let streak = 0;
  for (let i = effective.length - 1; i >= 0; i -= 1) {
    if (effective[i]?.source_repo_deleted === true) break;
    streak += 1;
  }
  return {
    count: effective.length,
    no_deletion_streak: streak,
    streak_basis:
      effective.length > 0
        ? `since records began (${effective[0]?.id ?? '?'})`
        : 'no closure records yet',
    rounds,
  };
}
