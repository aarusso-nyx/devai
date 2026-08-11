import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { join } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import { canonicalSha256, nextCounterId } from '@devai-nyx/utils';

/**
 * Reference Gap Report (RGR) persistence + CRUD.
 *
 * Per Phase 11.C / D-39: canonical DEVAI already had the
 * rgr.schema.json + the task pause-rgr / resume-rgr lifecycle
 * + an RGR template, but had no top-level CLI to
 * create / list / resolve RGRs and no persistence to a stable
 * .devai/state/rgr/ directory. This module fills that gap.
 *
 * Records live at .devai/state/rgr/RGR-NNNN.json. IDs come
 * from .devai/state/counters.json (RGR key). The RGR record's
 * shape is validated against rgr.schema.json on every write.
 */

export interface RgrProblem {
  readonly summary: string;
  readonly ambiguity: string;
  readonly invariants_impacted?: readonly string[];
  readonly journeys_impacted?: readonly string[];
  readonly surfaces?: readonly string[];
  readonly risk_class?:
    'security' | 'data_loss' | 'compliance' | 'ux' | 'correctness' | 'performance' | 'none';
}

export interface RgrQuestion {
  readonly qid: string;
  readonly question: string;
  readonly options?: readonly string[];
  readonly depends_on?: readonly string[];
}

export interface RgrRecord {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly emitting_task_id: string;
  readonly emitting_discipline: 'engineer' | 'inspector' | 'auditor';
  readonly created_at: string;
  readonly target_authority?: 'owner' | 'architect';
  readonly problem: RgrProblem;
  readonly questions: readonly RgrQuestion[];
  readonly evidence_refs: readonly string[];
  readonly proposed_resolution?: {
    readonly summary?: string;
    readonly rationale?: string;
  };
  readonly status: 'open' | 'in_review' | 'resolved' | 'rejected' | 'superseded';
  readonly resolution?: {
    readonly resolved_at?: string;
    readonly resolver?: string;
    readonly answers?: ReadonlyArray<{ readonly qid: string; readonly answer: string }>;
    readonly resulting_commits?: readonly string[];
    readonly resumed_task_id?: string | null;
  };
}

const STATE_DIR_REL = '.devai/state/rgr';

function stateDir(repoRoot: string): string {
  return join(repoRoot, STATE_DIR_REL);
}

export function nextRgrId(repoRoot: string): string {
  return nextCounterId({
    repoRoot,
    key: 'RGR',
    prefix: 'RGR',
    effects: { mkdirSync, writeFileSync },
  });
}

export interface EmitRgrOptions {
  readonly repoRoot: string;
  readonly emittingTaskId: string;
  readonly emittingDiscipline: 'engineer' | 'inspector' | 'auditor';
  readonly summary: string;
  readonly ambiguity: string;
  readonly evidenceRefs: readonly string[];
  readonly questions?: readonly RgrQuestion[];
  readonly invariantsImpacted?: readonly string[];
  readonly journeysImpacted?: readonly string[];
  readonly surfaces?: readonly string[];
  readonly riskClass?: RgrProblem['risk_class'];
  readonly targetAuthority?: 'owner' | 'architect';
  readonly proposedResolutionSummary?: string;
  readonly createdAt?: string;
}

/**
 * Build, validate, and persist a Reference Gap Report. Returns
 * the persisted record. Throws on schema-validation failure.
 */
export function emitRgr(opts: EmitRgrOptions): RgrRecord {
  const id = nextRgrId(opts.repoRoot);
  const questions: readonly RgrQuestion[] =
    opts.questions !== undefined && opts.questions.length > 0
      ? opts.questions
      : [{ qid: 'Q1', question: opts.ambiguity }];
  const problem: RgrProblem = {
    summary: opts.summary,
    ambiguity: opts.ambiguity,
    ...(opts.invariantsImpacted !== undefined && { invariants_impacted: opts.invariantsImpacted }),
    ...(opts.journeysImpacted !== undefined && { journeys_impacted: opts.journeysImpacted }),
    ...(opts.surfaces !== undefined && { surfaces: opts.surfaces }),
    ...(opts.riskClass !== undefined && { risk_class: opts.riskClass }),
  };
  const record: RgrRecord = {
    schemaVersion: '1.0.0',
    id,
    emitting_task_id: opts.emittingTaskId,
    emitting_discipline: opts.emittingDiscipline,
    created_at: opts.createdAt ?? new Date().toISOString(),
    ...(opts.targetAuthority !== undefined && { target_authority: opts.targetAuthority }),
    problem,
    questions,
    evidence_refs: opts.evidenceRefs,
    ...(opts.proposedResolutionSummary !== undefined && {
      proposed_resolution: { summary: opts.proposedResolutionSummary },
    }),
    status: 'open',
  };
  const ok = validators.rgr(record);
  if (!ok) {
    throw new Error(
      `emitRgr: produced record failed rgr.schema.json validation: ${JSON.stringify(validators.rgr.errors)}`,
    );
  }
  const dir = stateDir(opts.repoRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(record, null, 2) + '\n');
  return record;
}

export function readRgr(repoRoot: string, rgrId: string): RgrRecord | null {
  const path = join(stateDir(repoRoot), `${rgrId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RgrRecord;
  } catch {
    return null;
  }
}

export function listRgrs(repoRoot: string): readonly RgrRecord[] {
  const dir = stateDir(repoRoot);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => /^RGR-\d{4,}\.json$/.test(n))
      .sort();
  } catch {
    return [];
  }
  const out: RgrRecord[] = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, n), 'utf8')) as RgrRecord);
    } catch {
      // skip unparseable
    }
  }
  return out;
}

export interface ResolveRgrOptions {
  readonly repoRoot: string;
  readonly rgrId: string;
  readonly resolver: string;
  readonly answers?: ReadonlyArray<{ readonly qid: string; readonly answer: string }>;
  readonly resultingCommits?: readonly string[];
  readonly resumedTaskId?: string | null;
  readonly newStatus?: 'resolved' | 'rejected' | 'superseded';
  readonly resolvedAt?: string;
}

/**
 * Apply a resolution to an existing RGR. Validates the result
 * against rgr.schema.json. Throws if the RGR isn't found.
 */
export function resolveRgr(opts: ResolveRgrOptions): RgrRecord {
  const current = readRgr(opts.repoRoot, opts.rgrId);
  if (current === null) {
    throw new Error(`resolveRgr: ${opts.rgrId} not found at ${stateDir(opts.repoRoot)}`);
  }
  const next: RgrRecord = {
    ...current,
    status: opts.newStatus ?? 'resolved',
    resolution: {
      resolved_at: opts.resolvedAt ?? new Date().toISOString(),
      resolver: opts.resolver,
      ...(opts.answers !== undefined && { answers: opts.answers }),
      ...(opts.resultingCommits !== undefined && { resulting_commits: opts.resultingCommits }),
      ...(opts.resumedTaskId !== undefined && { resumed_task_id: opts.resumedTaskId }),
    },
  };
  const ok = validators.rgr(next);
  if (!ok) {
    throw new Error(
      `resolveRgr: result failed rgr.schema.json validation: ${JSON.stringify(validators.rgr.errors)}`,
    );
  }
  writeFileSync(
    join(stateDir(opts.repoRoot), `${opts.rgrId}.json`),
    JSON.stringify(next, null, 2) + '\n',
  );
  return next;
}

/**
 * Compute a deterministic content hash over an RGR record for
 * external log / audit-trail purposes. SHA-256 over the
 * current canonical-JSON form.
 *
 * **Not persisted on the rgr.schema.json record itself.** Unlike
 * `agent-run` / `rtd-manifest`, rgr records carry no stored
 * `manifest_hash` field. Callers compute the hash on demand and
 * MUST treat each call as authoritative for the live record at
 * call time.
 */
export function rgrContentHash(record: RgrRecord): string {
  return canonicalSha256(record);
}

export function getRgrDir(repoRoot: string): string {
  return stateDir(repoRoot);
}
