// ADR-GOV-0025 IA-001..IA-003: campaign projection, materialization through the single queue,
// and human ratification separate from merge.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  campaignStatus,
  campaignTaskRecord,
  loadCampaign,
  materializeCampaignRound,
} from '../../src/campaign/index.js';
import { ratifyRoundTask } from '../../src/loop/ratification.js';
import { loadTask, saveTask, type TaskRecord } from '../../src/loop/tasks.js';

const ROUND = 'R-0701';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function task(id: string, discipline: string, upstream: string | null, status = 'planned') {
  return {
    id,
    title: `${discipline} task ${id}`,
    discipline,
    coupled_pipeline_position: discipline,
    upstream_task_id: upstream,
    status,
    target_substrates: [
      discipline === 'inspector' ? 'F3' : discipline === 'architect' ? 'F1' : 'F2',
    ],
    boundary: { paths: [`packages/app/${id}.ts`] },
    deliverables: [`deliver ${id}`],
    acceptance_commands: [['pnpm', 'test']],
    commit_types: ['feat'],
    prompt: { path: `prompts/${id}.md` },
    pull_request: null,
    merged_as: null,
    execution: { tier: 'worker', effort: 'medium', time_budget_minutes: 60 },
  };
}

function repository(roundStatus = 'open', taskStatus = 'ready'): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-campaign-controller-'));
  roots.push(root);
  const repo = JSON.parse(
    readFileSync(
      join(import.meta.dirname, '..', '..', '..', '..', 'law/schemas/campaign.schema.json'),
      'utf8',
    ),
  ) as {
    examples: unknown[];
  };
  const example = structuredClone(repo.examples[0]) as Record<string, unknown>;
  const campaign = {
    ...example,
    id: 'CMP-0701',
    title: 'Fixture campaign',
    status: 'active',
    date: '2026-10-04',
    rounds: [
      {
        ...(example['rounds'] as Record<string, unknown>[])[0],
        id: ROUND,
        status: roundStatus,
        depends_on: [],
        waves: [
          {
            ...(
              (example['rounds'] as Record<string, unknown>[])[0]?.['waves'] as Record<
                string,
                unknown
              >[]
            )[0],
            id: 'CTG-0701',
            type: 'coupled-triplet',
            depends_on: [],
            tasks: [
              task('TASK-7011', 'architect', null, taskStatus),
              task('TASK-7012', 'inspector', 'TASK-7011', taskStatus),
              task('TASK-7013', 'engineer', 'TASK-7012', taskStatus),
            ],
          },
        ],
      },
    ],
  };
  mkdirSync(join(root, 'product/campaigns/CMP-0701-fixture'), { recursive: true });
  writeFileSync(
    join(root, 'product/campaigns/CMP-0701-fixture/campaign.json'),
    JSON.stringify(campaign),
  );
  mkdirSync(join(root, 'work/rounds', ROUND), { recursive: true });
  writeFileSync(join(root, 'work/rounds', ROUND, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  return root;
}

describe('campaign status (S4a, IA-001)', () => {
  it('projects plan beside runtime and names drift without writing', async () => {
    const root = repository();
    const loaded = loadCampaign(root, 'CMP-0701');
    expect(loaded.directory).toBe('product/campaigns/CMP-0701-fixture');
    const before = campaignStatus(root, 'CMP-0701');
    expect(before.drift.map((item) => [item.task_id, item.kind])).toEqual([
      ['TASK-7011', 'missing-runtime-record'],
      ['TASK-7012', 'missing-runtime-record'],
      ['TASK-7013', 'missing-runtime-record'],
    ]);
    await withAuthorityHostTestScope(async () => {
      materializeCampaignRound({ repoRoot: root, campaignId: 'CMP-0701', roundId: ROUND });
      saveTask(root, { ...loadTask(root, 'TASK-7011'), status: 'completed' });
      saveTask(root, {
        ...(loadTask(root, 'TASK-7013') as TaskRecord),
        id: 'TASK-7019',
      } as TaskRecord);
    });
    const after = campaignStatus(root, 'CMP-0701');
    expect(after.drift.map((item) => [item.task_id, item.kind])).toEqual([
      ['TASK-7011', 'runtime-ahead-of-plan'],
      ['TASK-7019', 'unplanned-runtime-task'],
    ]);
    expect(after.rounds[0]?.waves[0]?.tasks[1]).toMatchObject({
      id: 'TASK-7012',
      plan_status: 'ready',
      runtime_status: 'queued',
    });
  });

  it('refuses an unknown or malformed campaign', () => {
    const root = repository();
    expect(() => campaignStatus(root, 'CMP-0799')).toThrow('CAMPAIGN_NOT_FOUND');
    expect(() => campaignStatus(root, 'nope')).toThrow('CAMPAIGN_ID_INVALID');
    writeFileSync(join(root, 'product/campaigns/CMP-0701-fixture/campaign.json'), '{}');
    expect(() => campaignStatus(root, 'CMP-0701')).toThrow('CAMPAIGN_INVALID');
  });
});

describe('campaign materialize (S4b, IA-002)', () => {
  it('maps each task exactly as campaign-execution.json declares and writes only through the queue', async () => {
    const root = repository();
    const result = await withAuthorityHostTestScope(async () =>
      materializeCampaignRound({ repoRoot: root, campaignId: 'CMP-0701', roundId: ROUND }),
    );
    expect(result).toEqual({
      campaign_id: 'CMP-0701',
      round_id: ROUND,
      materialized: ['TASK-7011', 'TASK-7012', 'TASK-7013'],
      existing: [],
    });
    expect(loadTask(root, 'TASK-7012')).toMatchObject({
      status: 'queued',
      round_id: ROUND,
      discipline: 'inspector',
      coupled_task_group: 'CTG-0701',
      coupled_pipeline_position: 'inspector',
      upstream_task_id: 'TASK-7011',
      intent_diff: {
        planned_files: ['packages/app/TASK-7012.ts'],
        planned_steps: ['deliver TASK-7012'],
      },
      executor: {
        kind: 'human',
        role: 'inspector',
        instructions_ref: 'product/campaigns/CMP-0701-fixture/prompts/TASK-7012.md',
        timeout_ms: 3_600_000,
        timeout_behavior: 'escalate',
      },
    });
    expect(readFileSync(join(root, '.devai/state/backlog.jsonl'), 'utf8')).toContain('TASK-7013');
  });

  it('is idempotent for identical records and refuses a differing one before writing', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      materializeCampaignRound({ repoRoot: root, campaignId: 'CMP-0701', roundId: ROUND });
      saveTask(root, { ...loadTask(root, 'TASK-7011'), status: 'ready' });
      expect(
        materializeCampaignRound({ repoRoot: root, campaignId: 'CMP-0701', roundId: ROUND }),
      ).toMatchObject({ materialized: [], existing: ['TASK-7011', 'TASK-7012', 'TASK-7013'] });
      saveTask(root, { ...loadTask(root, 'TASK-7012'), title: 'changed by hand' });
      expect(() =>
        materializeCampaignRound({ repoRoot: root, campaignId: 'CMP-0701', roundId: ROUND }),
      ).toThrow('TASK_RECORD_CONFLICT');
      expect(loadTask(root, 'TASK-7012').title).toBe('changed by hand');
    });
  });

  it('materializes only an open round with an active authorization', async () => {
    const closed = repository('planned');
    await withAuthorityHostTestScope(async () => {
      expect(() =>
        materializeCampaignRound({ repoRoot: closed, campaignId: 'CMP-0701', roundId: ROUND }),
      ).toThrow('CAMPAIGN_ROUND_NOT_OPEN');
      const open = repository();
      rmSync(join(open, 'work/rounds', ROUND, 'AUTHORIZATION.md'));
      expect(() =>
        materializeCampaignRound({ repoRoot: open, campaignId: 'CMP-0701', roundId: ROUND }),
      ).toThrow();
      expect(existsSync(join(open, '.devai/state/tasks'))).toBe(false);
    });
  });

  it('builds the human executor from the campaign prompt', () => {
    const root = repository();
    const loaded = loadCampaign(root, 'CMP-0701');
    const round = loaded.plan.rounds[0]!;
    const wave = round.waves[0]!;
    const record = campaignTaskRecord(loaded, round, wave, wave.tasks[0]!);
    expect(record.executor).toMatchObject({ kind: 'human', role: 'architect' });
    expect(record.created_at).toBe('2026-10-04T00:00:00.000Z');
  });
});

describe('round ratify (S4c, IA-003)', () => {
  async function awaiting(root: string): Promise<void> {
    await withAuthorityHostTestScope(async () => {
      materializeCampaignRound({ repoRoot: root, campaignId: 'CMP-0701', roundId: ROUND });
      saveTask(root, {
        ...loadTask(root, 'TASK-7013'),
        status: 'awaiting_human_review',
        branch: 'experimental/TASK-7013/attempt-1',
      });
    });
  }

  it('accepts into pre_merge and records the human decision once', async () => {
    const root = repository();
    await awaiting(root);
    await withAuthorityHostTestScope(async () => {
      const record = ratifyRoundTask({
        repoRoot: root,
        round: ROUND,
        taskId: 'TASK-7013',
        decision: 'accept',
        role: 'owner',
        note: 'reviewed',
      });
      expect(record).toMatchObject({
        decision: 'accept',
        role: 'owner',
        resulting_status: 'pre_merge',
        branch: 'experimental/TASK-7013/attempt-1',
      });
      expect(loadTask(root, 'TASK-7013').status).toBe('pre_merge');
      expect(() =>
        ratifyRoundTask({
          repoRoot: root,
          round: ROUND,
          taskId: 'TASK-7013',
          decision: 'accept',
          role: 'owner',
        }),
      ).toThrow('RATIFICATION_TASK_NOT_AWAITING_REVIEW');
    });
  });

  it('escalates a rejection and refuses other roles, decisions and states', async () => {
    const root = repository();
    await awaiting(root);
    await withAuthorityHostTestScope(async () => {
      const base = { repoRoot: root, round: ROUND, taskId: 'TASK-7013' } as const;
      expect(() => ratifyRoundTask({ ...base, decision: 'accept', role: 'engineer' })).toThrow(
        'RATIFICATION_ROLE_DENIED',
      );
      expect(() =>
        ratifyRoundTask({ ...base, decision: 'merge' as 'accept', role: 'owner' }),
      ).toThrow('RATIFICATION_DECISION_INVALID');
      expect(() =>
        ratifyRoundTask({ ...base, taskId: 'TASK-7011', decision: 'accept', role: 'owner' }),
      ).toThrow('RATIFICATION_TASK_NOT_AWAITING_REVIEW');
      expect(ratifyRoundTask({ ...base, decision: 'reject', role: 'architect' })).toMatchObject({
        resulting_status: 'escalated',
      });
      expect(loadTask(root, 'TASK-7013').status).toBe('escalated');
    });
  });
});
