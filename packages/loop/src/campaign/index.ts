/**
 * Campaign projection and materialization (ADR-GOV-0025, S4a and S4b). A campaign is a
 * plan and a ledger (law/schemas/campaign.schema.json); these functions read it against
 * canonical runtime task records and, for one open round, materialize its tasks through
 * the single round task queue exactly as law/policy/campaign-execution.json declares.
 */
import { existsSync, readFileSync, readdirSync } from '@devai-nyx/authority';
import { parsers } from '@devai-nyx/schemas';
import { join } from 'node:path';
import { requestedTaskFields } from '../loop/round-task-admission.js';
import type { TaskRecord } from '../loop/task-contract.js';
import { fail, materializeRoundQueueTask } from '../loop/task-queue-services.js';
import { listTaskRecords } from '../loop/tasks.js';

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
  readonly tasks: readonly CampaignTask[];
}

interface CampaignRound {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly waves: readonly CampaignWave[];
}

export interface CampaignPlan {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly date: string;
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

/**
 * S4a: the read-only projection of a campaign onto runtime state. Every round, wave and
 * task appears with its plan status beside its runtime status, and every disagreement is
 * named as drift. Nothing is written.
 */
export function campaignStatus(repoRoot: string, campaignId: string) {
  const { plan, directory } = loadCampaign(repoRoot, campaignId);
  const runtime = runtimeTasks(repoRoot);
  const drift: CampaignDrift[] = [];
  const planned = new Set<string>();
  const rounds = plan.rounds.map((round) => ({
    id: round.id,
    title: round.title,
    status: round.status,
    waves: round.waves.map((wave) => ({
      id: wave.id,
      title: wave.title,
      tasks: wave.tasks.map((task) => {
        planned.add(task.id);
        const record = runtime.get(task.id);
        const active = ['open', 'closing'].includes(round.status);
        if (record === undefined && active && !['planned', 'cancelled'].includes(task.status)) {
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
    if (roundIds.has(record.round_id) && !planned.has(record.id)) {
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

/**
 * S4b: materialize one open campaign round through the round task queue. A task whose
 * runtime record already carries the identical request is reported as existing; any
 * difference refuses with TASK_RECORD_CONFLICT before anything is written.
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
  const runtime = runtimeTasks(options.repoRoot);
  const records = round.waves.flatMap((wave) =>
    wave.tasks
      .filter((task) => task.status !== 'cancelled')
      .map((task) => campaignTaskRecord(campaign, round, wave, task)),
  );
  // Check every record before writing any, so a conflict leaves the queue untouched.
  const existing: string[] = [];
  for (const record of records) {
    const current = runtime.get(record.id);
    if (current === undefined) continue;
    const same =
      JSON.stringify(requestedTaskFields({ ...current, status: 'queued' })) ===
      JSON.stringify(requestedTaskFields(record));
    if (!same) fail('TASK_RECORD_CONFLICT');
    existing.push(record.id);
  }
  const materialized: string[] = [];
  for (const record of records) {
    if (existing.includes(record.id)) continue;
    materializeRoundQueueTask({ repoRoot: options.repoRoot, round: round.id, task: record });
    materialized.push(record.id);
  }
  return {
    campaign_id: campaign.plan.id,
    round_id: round.id,
    materialized,
    existing,
  };
}
