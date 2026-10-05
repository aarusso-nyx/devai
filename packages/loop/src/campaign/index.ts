/**
 * Campaign projection and materialization (ADR-GOV-0025, S4a and S4b). A campaign is a
 * plan and a ledger (law/schemas/campaign.schema.json); these functions read it against
 * canonical runtime task records and, for one open round, materialize its tasks through
 * the single round task queue exactly as law/policy/campaign-execution.json declares.
 */
import { existsSync, readFileSync, readdirSync } from '@devai-nyx/authority';
import { parsers } from '@devai-nyx/schemas';
import { join } from 'node:path';
import { readBacklog, type BacklogEntry } from '../loop/backlog.js';
import { requestedTaskFields } from '../loop/round-task-admission.js';
import type { TaskRecord } from '../loop/task-contract.js';
import {
  fail,
  materializeRoundQueueTask,
  requireActiveTaskRound,
} from '../loop/task-queue-services.js';
import { listTaskRecords, saveTask, validateTaskRecord } from '../loop/tasks.js';

interface CampaignTask {
  readonly id: string;
  readonly title: string;
  readonly discipline: 'architect' | 'inspector' | 'engineer';
  readonly coupled_pipeline_position: 'architect' | 'inspector' | 'engineer';
  readonly upstream_task_id: string | null;
  readonly status: string;
  readonly target_substrates: readonly string[];
  readonly boundary: { readonly paths: readonly string[] };
  readonly deliverables: readonly string[];
  readonly acceptance_commands: readonly (readonly string[])[];
  readonly prompt: { readonly path: string };
  readonly execution: { readonly time_budget_minutes?: number };
}

interface CampaignWave {
  readonly id: string;
  readonly title: string;
  readonly type?: string;
  readonly depends_on?: readonly string[];
  readonly tasks: readonly CampaignTask[];
}

interface CampaignRound {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly depends_on?: readonly string[];
  readonly waves: readonly CampaignWave[];
}

export interface CampaignPlan {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly date: string;
  readonly prompts?: { readonly preamble: string };
  readonly rounds: readonly CampaignRound[];
}

export interface LoadedCampaign {
  readonly plan: CampaignPlan;
  /** Repository-relative campaign directory, e.g. product/campaigns/CMP-0006-open-issue-closure. */
  readonly directory: string;
}

export type CampaignDriftKind =
  | 'missing-runtime-record'
  | 'runtime-ahead-of-plan'
  | 'plan-ahead-of-runtime'
  | 'unplanned-runtime-task';

export interface CampaignDrift {
  readonly round_id: string;
  readonly task_id: string;
  readonly kind: CampaignDriftKind;
}

const CAMPAIGNS_DIR = 'product/campaigns';
const DEFAULT_HUMAN_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

/** Load and schema-validate one campaign by its CMP- identity. */
export function loadCampaign(repoRoot: string, campaignId: string): LoadedCampaign {
  if (!/^CMP-[0-9]{4}$/u.test(campaignId)) fail('CAMPAIGN_ID_INVALID');
  const root = join(repoRoot, CAMPAIGNS_DIR);
  const matches = existsSync(root)
    ? readdirSync(root).filter((name) => name === campaignId || name.startsWith(`${campaignId}-`))
    : [];
  if (matches.length !== 1)
    fail(matches.length === 0 ? 'CAMPAIGN_NOT_FOUND' : 'CAMPAIGN_AMBIGUOUS');
  const directory = `${CAMPAIGNS_DIR}/${matches[0] as string}`;
  const path = join(repoRoot, directory, 'campaign.json');
  if (!existsSync(path)) fail('CAMPAIGN_NOT_FOUND');
  const parsed = parsers.campaign.safeParseJson<CampaignPlan>(readFileSync(path, 'utf8'));
  if (!parsed.ok) fail('CAMPAIGN_INVALID');
  if (parsed.value.id !== campaignId) fail('CAMPAIGN_ID_MISMATCH');
  return { plan: parsed.value, directory };
}

function runtimeTasks(repoRoot: string): ReadonlyMap<string, TaskRecord> {
  return new Map(
    listTaskRecords(repoRoot).flatMap((entry) =>
      entry.kind === 'current' ? [[entry.record.id, entry.record] as const] : [],
    ),
  );
}

const POSITIONS = ['architect', 'inspector', 'engineer'] as const;

/**
 * The structural rules of the campaign checker (scripts/check-campaign.mjs) that a
 * materialization depends on: unique round, wave and task ids; resolvable, acyclic round
 * and wave dependencies; each wave's discipline order and upstream chain; and present
 * prompts that name their task. An empty list means the plan may be materialized.
 */
export function campaignSemanticProblems(repoRoot: string, campaign: LoadedCampaign): string[] {
  const { plan, directory } = campaign;
  const problems: string[] = [];
  const seen = new Set<string>();
  const declare = (id: string): void => {
    if (seen.has(id)) problems.push(`duplicate id ${id}`);
    seen.add(id);
  };
  const preamble = plan.prompts?.preamble;
  if (preamble === undefined || !existsSync(join(repoRoot, directory, preamble))) {
    problems.push('preamble missing');
  }
  const roundIds = new Set(plan.rounds.map((round) => round.id));
  for (const round of plan.rounds) {
    declare(round.id);
    for (const dependency of round.depends_on ?? []) {
      if (!roundIds.has(dependency) || dependency === round.id) {
        problems.push(`${round.id} depends on ${dependency}`);
      }
    }
    const waveIds = new Set(round.waves.map((wave) => wave.id));
    for (const wave of round.waves) {
      declare(wave.id);
      for (const dependency of wave.depends_on ?? []) {
        if (!waveIds.has(dependency) || dependency === wave.id) {
          problems.push(`${wave.id} depends on ${dependency}`);
        }
      }
      if (
        wave.type === 'coupled-triplet' &&
        wave.tasks.map((task) => task.discipline).join() !== POSITIONS.join()
      ) {
        problems.push(`${wave.id} triplet must be architect, inspector, engineer`);
      }
      if (wave.type === 'single-role' && wave.tasks.length !== 1) {
        problems.push(`${wave.id} single-role wave must hold one task`);
      }
      let upstream: string | null = null;
      for (const task of wave.tasks) {
        declare(task.id);
        if (task.discipline !== task.coupled_pipeline_position) {
          problems.push(`${task.id} discipline differs from position`);
        }
        if (task.upstream_task_id !== upstream) {
          problems.push(`${task.id} upstream must be ${String(upstream)}`);
        }
        upstream = task.id;
        const prompt = join(repoRoot, directory, task.prompt.path);
        if (!existsSync(prompt)) problems.push(`${task.id} prompt missing ${task.prompt.path}`);
        else if (!readFileSync(prompt, 'utf8').includes(task.id)) {
          problems.push(`${task.id} prompt does not name the task`);
        }
      }
    }
  }
  const byId = new Map(plan.rounds.map((round) => [round.id, round]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      problems.push(`round dependency cycle at ${id}`);
      return;
    }
    visiting.add(id);
    for (const dependency of byId.get(id)?.depends_on ?? []) visit(dependency);
    visiting.delete(id);
    done.add(id);
  };
  for (const round of plan.rounds) visit(round.id);
  return problems;
}

/**
 * S4a: the read-only projection of a campaign onto runtime state. Every round, wave and
 * task appears with its plan status beside its runtime status, and every disagreement is
 * named as drift. Nothing is written.
 */
export function campaignStatus(repoRoot: string, campaignId: string) {
  const { plan, directory } = loadCampaign(repoRoot, campaignId);
  const runtime = runtimeTasks(repoRoot);
  const drift: CampaignDrift[] = [];
  // A runtime record matches a plan task only by task id and round id together.
  const planned = new Set<string>();
  const rounds = plan.rounds.map((round) => ({
    id: round.id,
    title: round.title,
    status: round.status,
    waves: round.waves.map((wave) => ({
      id: wave.id,
      title: wave.title,
      tasks: wave.tasks.map((task) => {
        planned.add(`${round.id}/${task.id}`);
        const candidate = runtime.get(task.id);
        const record = candidate?.round_id === round.id ? candidate : undefined;
        const active = ['open', 'closing'].includes(round.status);
        // ADR-GOV-0025: once the round is open every plan task needs a runtime record,
        // a planned one included; only a cancelled task needs none.
        if (record === undefined && active && task.status !== 'cancelled') {
          drift.push({ round_id: round.id, task_id: task.id, kind: 'missing-runtime-record' });
        }
        if (record?.status === 'completed' && task.status !== 'merged') {
          drift.push({ round_id: round.id, task_id: task.id, kind: 'runtime-ahead-of-plan' });
        }
        if (record !== undefined && task.status === 'merged' && record.status !== 'completed') {
          drift.push({ round_id: round.id, task_id: task.id, kind: 'plan-ahead-of-runtime' });
        }
        return {
          id: task.id,
          discipline: task.discipline,
          plan_status: task.status,
          runtime_status: record?.status ?? null,
        };
      }),
    })),
  }));
  const roundIds = new Set(plan.rounds.map((round) => round.id));
  for (const record of runtime.values()) {
    if (roundIds.has(record.round_id) && !planned.has(`${record.round_id}/${record.id}`)) {
      drift.push({ round_id: record.round_id, task_id: record.id, kind: 'unplanned-runtime-task' });
    }
  }
  return {
    campaign_id: plan.id,
    title: plan.title,
    status: plan.status,
    directory,
    rounds,
    drift,
    ok: drift.length === 0,
  };
}

/**
 * The queued task record of campaign-execution.json materialization.governed_task_record:
 * the task fields, the wave as coupled group, and a human executor whose role is the
 * discipline and whose instructions are the campaign prompt.
 */
export function campaignTaskRecord(
  campaign: LoadedCampaign,
  round: CampaignRound,
  wave: CampaignWave,
  task: CampaignTask,
): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id: task.id,
    round_id: round.id,
    status: 'queued',
    discipline: task.discipline,
    title: task.title,
    target_modules: [],
    target_substrates: task.target_substrates,
    created_at: `${campaign.plan.date}T00:00:00.000Z`,
    db_isolation: 'database',
    iteration_count: 0,
    coupled_task_group: wave.id,
    coupled_pipeline_position: task.coupled_pipeline_position,
    upstream_task_id: task.upstream_task_id,
    acceptance_commands: task.acceptance_commands,
    intent_diff: { planned_files: task.boundary.paths, planned_steps: task.deliverables },
    executor: {
      kind: 'human',
      role: task.discipline,
      instructions_ref: `${campaign.directory}/${task.prompt.path}`,
      completion_evidence: ['pull-request-merged'],
      timeout_ms:
        task.execution.time_budget_minutes === undefined
          ? DEFAULT_HUMAN_TIMEOUT_MS
          : task.execution.time_budget_minutes * 60_000,
      timeout_behavior: 'escalate',
    },
  } as unknown as TaskRecord;
}

/** Whether a backlog entry carries exactly the queue fields the task record would write. */
function sameQueueEntry(entry: BacklogEntry, record: TaskRecord): boolean {
  return (
    entry.round_id === record.round_id &&
    entry.title === record.title &&
    entry.priority === (record.priority ?? 50) &&
    entry.description === record.description &&
    entry.created_at === record.created_at
  );
}

/** The queue fields the canonical materializer writes beside the entry's identity. */
const QUEUE_FIELDS = [
  'discipline',
  'target_modules',
  'target_substrates',
  'db_isolation',
  'lifecycle',
  'acceptance_commands',
] as const;

/** Whether the entry carries any queue field with a value other than the record's. */
function queueFieldConflict(entry: BacklogEntry, record: TaskRecord): boolean {
  return QUEUE_FIELDS.some(
    (field) =>
      entry[field] !== undefined && JSON.stringify(entry[field]) !== JSON.stringify(record[field]),
  );
}

/** A queued entry carrying every field the canonical materializer would write for the record. */
function completeQueueEntry(entry: BacklogEntry, record: TaskRecord): boolean {
  return (
    entry.status === 'queued' &&
    entry.discipline === record.discipline &&
    JSON.stringify(entry.target_modules) === JSON.stringify(record.target_modules) &&
    JSON.stringify(entry.target_substrates) === JSON.stringify(record.target_substrates) &&
    entry.db_isolation === record.db_isolation &&
    entry.lifecycle === record.lifecycle &&
    JSON.stringify(entry.acceptance_commands) === JSON.stringify(record.acceptance_commands)
  );
}

/**
 * S4b: materialize one open campaign round through the round task queue. The plan must
 * pass the campaign checker's structural rules, and every record is validated and
 * checked against both stores — the task records and the backlog queue — before anything
 * is written, so a conflict on any task leaves the queue untouched. A task whose runtime
 * record already carries the identical request is reported as existing. The batch is
 * recoverable: a task whose complete queue entry was written before an interruption has
 * only its record completed, never a second entry; a compatible but partial queued entry
 * has only its absent fields added, through the canonical queue materializer; and an entry
 * the queue no longer holds as queued (for example completed), or one with a field whose
 * value differs from the record, refuses.
 */
export function materializeCampaignRound(options: {
  readonly repoRoot: string;
  readonly campaignId: string;
  readonly roundId: string;
}) {
  const campaign = loadCampaign(options.repoRoot, options.campaignId);
  const round = campaign.plan.rounds.find((candidate) => candidate.id === options.roundId);
  if (round === undefined) fail('CAMPAIGN_ROUND_NOT_FOUND');
  if (round.status !== 'open') fail('CAMPAIGN_ROUND_NOT_OPEN');
  if (campaignSemanticProblems(options.repoRoot, campaign).length > 0) {
    fail('CAMPAIGN_SEMANTICS_INVALID');
  }
  const runtime = runtimeTasks(options.repoRoot);
  const queue = new Map(readBacklog(options.repoRoot).map((entry) => [entry.id, entry]));
  const records = round.waves.flatMap((wave) =>
    wave.tasks
      .filter((task) => task.status !== 'cancelled')
      .map((task) => campaignTaskRecord(campaign, round, wave, task)),
  );
  // Check every record against both stores before writing any.
  const existing: string[] = [];
  const queued: string[] = [];
  for (const record of records) {
    try {
      validateTaskRecord(record);
    } catch {
      fail('TASK_RECORD_INVALID');
    }
    const entry = queue.get(record.id);
    if (entry !== undefined && !sameQueueEntry(entry, record)) {
      fail('TASK_QUEUE_MATERIALIZATION_CONFLICT');
    }
    const current = runtime.get(record.id);
    if (current === undefined) {
      if (entry === undefined) continue;
      // Entries older than the status field are queued, as in the global picker.
      if (entry.status !== undefined && entry.status !== 'queued') {
        fail('TASK_QUEUE_MATERIALIZATION_CONFLICT');
      }
      // Enrichment adds absent fields only; it never replaces a value the queue holds.
      if (queueFieldConflict(entry, record)) fail('TASK_QUEUE_MATERIALIZATION_CONFLICT');
      if (completeQueueEntry(entry, record)) queued.push(record.id);
      continue;
    }
    const same =
      JSON.stringify(requestedTaskFields({ ...current, status: 'queued' })) ===
      JSON.stringify(requestedTaskFields(record));
    if (!same) fail('TASK_RECORD_CONFLICT');
    existing.push(record.id);
  }
  requireActiveTaskRound({ repoRoot: options.repoRoot, round: round.id });
  const materialized: string[] = [];
  for (const record of records) {
    if (existing.includes(record.id)) continue;
    if (queued.includes(record.id)) {
      // An interrupted batch already wrote this task's complete entry: add its record only.
      saveTask(options.repoRoot, record);
    } else {
      // A new task, or a compatible partial entry the canonical materializer enriches.
      materializeRoundQueueTask({ repoRoot: options.repoRoot, round: round.id, task: record });
    }
    materialized.push(record.id);
  }
  return {
    campaign_id: campaign.plan.id,
    round_id: round.id,
    materialized,
    existing,
  };
}
