// ADR-GOV-0025 IA-001..IA-003: campaign projection, materialization through the single queue,
// and human ratification separate from merge.
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runWithAuthorityHostEffects, type AuthorityHostEffectScope } from '@devai-nyx/authority';
import {
  createIssuer,
  runtimeApi,
} from '../../../authority/tests/unit/authority-runtime-testkit.js';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  campaignSemanticProblems,
  campaignStatus,
  campaignTaskRecord,
  loadCampaign,
  materializeCampaignRound,
} from '../../src/campaign/index.js';
import { appendBacklog, readBacklog } from '../../src/loop/backlog.js';
import { ratifyRoundTask } from '../../src/loop/ratification.js';
import { escalateRoundTask } from '../../src/loop/task-services.js';
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
  mkdirSync(join(root, 'product/campaigns/CMP-0701-fixture/prompts'), { recursive: true });
  writeFileSync(
    join(root, 'product/campaigns/CMP-0701-fixture/campaign.json'),
    JSON.stringify(campaign),
  );
  writeFileSync(
    join(root, 'product/campaigns/CMP-0701-fixture/prompts/preamble.md'),
    '# Preamble\n',
  );
  for (const id of ['TASK-7011', 'TASK-7012', 'TASK-7013']) {
    writeFileSync(
      join(root, 'product/campaigns/CMP-0701-fixture/prompts', `${id}.md`),
      `# ${id}\n`,
    );
  }
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

  it('names a planned task with no runtime record once its round is open', () => {
    const root = repository('open', 'planned');
    expect(campaignStatus(root, 'CMP-0701').drift).toEqual([
      { round_id: ROUND, task_id: 'TASK-7011', kind: 'missing-runtime-record' },
      { round_id: ROUND, task_id: 'TASK-7012', kind: 'missing-runtime-record' },
      { round_id: ROUND, task_id: 'TASK-7013', kind: 'missing-runtime-record' },
    ]);
    expect(campaignStatus(repository('planned', 'planned'), 'CMP-0701').drift).toEqual([]);
  });

  it('matches runtime records by task id and round id together', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      materializeCampaignRound({ repoRoot: root, campaignId: 'CMP-0701', roundId: ROUND });
      saveTask(root, { ...loadTask(root, 'TASK-7012'), round_id: 'R-0702' });
    });
    const status = campaignStatus(root, 'CMP-0701');
    expect(status.drift).toEqual([
      { round_id: ROUND, task_id: 'TASK-7012', kind: 'missing-runtime-record' },
    ]);
    expect(status.rounds[0]?.waves[0]?.tasks[1]).toMatchObject({
      id: 'TASK-7012',
      runtime_status: null,
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

  it('preflights the backlog queue too, so a conflict on a later task writes nothing', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      appendBacklog(root, {
        id: 'TASK-7013',
        round_id: ROUND,
        title: 'a different queued title',
        priority: 50,
        created_at: '2026-10-04T00:00:00.000Z',
      });
      expect(() =>
        materializeCampaignRound({ repoRoot: root, campaignId: 'CMP-0701', roundId: ROUND }),
      ).toThrow('TASK_QUEUE_MATERIALIZATION_CONFLICT');
    });
    expect(existsSync(join(root, '.devai/state/tasks'))).toBe(false);
    expect(readBacklog(root).map((entry) => entry.id)).toEqual(['TASK-7013']);
  });

  it('completes an interrupted batch without a second queue entry', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      materializeCampaignRound({ repoRoot: root, campaignId: 'CMP-0701', roundId: ROUND });
    });
    // The state an interruption after a queue entry and before its record leaves behind.
    rmSync(join(root, '.devai/state/tasks/TASK-7013.json'));
    const lines = readFileSync(join(root, '.devai/state/backlog.jsonl'), 'utf8');
    await withAuthorityHostTestScope(async () => {
      expect(
        materializeCampaignRound({ repoRoot: root, campaignId: 'CMP-0701', roundId: ROUND }),
      ).toMatchObject({ materialized: ['TASK-7013'], existing: ['TASK-7011', 'TASK-7012'] });
    });
    expect(readFileSync(join(root, '.devai/state/backlog.jsonl'), 'utf8')).toBe(lines);
    expect(loadTask(root, 'TASK-7013').status).toBe('queued');
  });

  it('refuses a plan that fails the campaign checker rules before any write', async () => {
    const root = repository();
    rmSync(join(root, 'product/campaigns/CMP-0701-fixture/prompts/TASK-7012.md'));
    expect(campaignSemanticProblems(root, loadCampaign(root, 'CMP-0701'))).toEqual([
      'TASK-7012 prompt missing prompts/TASK-7012.md',
    ]);
    await withAuthorityHostTestScope(async () => {
      expect(() =>
        materializeCampaignRound({ repoRoot: root, campaignId: 'CMP-0701', roundId: ROUND }),
      ).toThrow('CAMPAIGN_SEMANTICS_INVALID');
    });
    expect(existsSync(join(root, '.devai/state'))).toBe(false);
    const path = join(root, 'product/campaigns/CMP-0701-fixture/campaign.json');
    const plan = JSON.parse(readFileSync(path, 'utf8')) as {
      rounds: {
        depends_on: string[];
        waves: { tasks: { id: string; upstream_task_id: string | null }[] }[];
      }[];
    };
    const [round] = plan.rounds;
    const tasks = round?.waves[0]?.tasks ?? [];
    if (round === undefined || tasks.length !== 3) throw new Error('fixture shape changed');
    writeFileSync(
      join(root, 'product/campaigns/CMP-0701-fixture/prompts/TASK-7012.md'),
      'TASK-7012\n',
    );
    round.depends_on = ['R-0799'];
    tasks[2] = { ...tasks[2], id: 'TASK-7011', upstream_task_id: 'TASK-7011' } as never;
    writeFileSync(path, JSON.stringify(plan));
    expect(campaignSemanticProblems(root, loadCampaign(root, 'CMP-0701'))).toEqual([
      `${ROUND} depends on R-0799`,
      'duplicate id TASK-7011',
      'TASK-7011 upstream must be TASK-7012',
      'TASK-7011 prompt does not name the task',
    ]);
  });

  it('refuses to recover beside a queue entry that is no longer queued', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      materializeCampaignRound({ repoRoot: root, campaignId: 'CMP-0701', roundId: ROUND });
    });
    rmSync(join(root, '.devai/state/tasks/TASK-7013.json'));
    const [entry] = readBacklog(root).filter((item) => item.id === 'TASK-7013');
    appendFileSync(
      join(root, '.devai/state/backlog.jsonl'),
      `${JSON.stringify({ ...entry, status: 'completed' })}\n`,
    );
    await withAuthorityHostTestScope(async () => {
      expect(() =>
        materializeCampaignRound({ repoRoot: root, campaignId: 'CMP-0701', roundId: ROUND }),
      ).toThrow('TASK_QUEUE_MATERIALIZATION_CONFLICT');
    });
    expect(existsSync(join(root, '.devai/state/tasks/TASK-7013.json'))).toBe(false);
  });

  it('enriches a compatible partial queue entry through the canonical materializer', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      appendBacklog(root, {
        id: 'TASK-7013',
        round_id: ROUND,
        title: 'engineer task TASK-7013',
        priority: 50,
        status: 'queued',
        created_at: '2026-10-04T00:00:00.000Z',
      });
      expect(
        materializeCampaignRound({ repoRoot: root, campaignId: 'CMP-0701', roundId: ROUND }),
      ).toMatchObject({ materialized: ['TASK-7011', 'TASK-7012', 'TASK-7013'], existing: [] });
    });
    const [entry] = readBacklog(root).filter((item) => item.id === 'TASK-7013');
    expect(entry).toMatchObject({
      status: 'queued',
      discipline: 'engineer',
      target_substrates: ['F2'],
      db_isolation: 'database',
    });
    expect(loadTask(root, 'TASK-7013').status).toBe('queued');
  });

  it('applies the one-task rule of a single-role wave before any write', async () => {
    const root = repository();
    const path = join(root, 'product/campaigns/CMP-0701-fixture/campaign.json');
    const plan = JSON.parse(readFileSync(path, 'utf8')) as {
      rounds: { waves: { type: string }[] }[];
    };
    const wave = plan.rounds[0]?.waves[0];
    if (wave === undefined) throw new Error('fixture shape changed');
    wave.type = 'single-role';
    writeFileSync(path, JSON.stringify(plan));
    expect(campaignSemanticProblems(root, loadCampaign(root, 'CMP-0701'))).toEqual([
      'CTG-0701 single-role wave must hold one task',
    ]);
    await withAuthorityHostTestScope(async () => {
      expect(() =>
        materializeCampaignRound({ repoRoot: root, campaignId: 'CMP-0701', roundId: ROUND }),
      ).toThrow('CAMPAIGN_SEMANTICS_INVALID');
    });
    expect(existsSync(join(root, '.devai/state'))).toBe(false);
  });

  it('builds the human executor from the campaign prompt', () => {
    const root = repository();
    const loaded = loadCampaign(root, 'CMP-0701');
    const [round] = loaded.plan.rounds;
    const [wave] = round?.waves ?? [];
    const [first] = wave?.tasks ?? [];
    if (round === undefined || wave === undefined || first === undefined) {
      throw new Error('fixture campaign must hold one round, wave and task');
    }
    const record = campaignTaskRecord(loaded, round, wave, first);
    expect(record.executor).toMatchObject({ kind: 'human', role: 'architect' });
    expect(record.created_at).toBe('2026-10-04T00:00:00.000Z');
  });
});

describe('round ratify (S4c, IA-003)', () => {
  const AGENT_EXECUTOR = {
    kind: 'agent',
    runtime: 'claude-cli',
    model: 'sonnet',
    effort: 'high',
    selection: { mode: 'exact', registry_id: 'claude-cli' },
    prompt_composition_id: 'PC-0000000000000000',
    max_iterations: 4,
    capabilities: ['repository-context'],
  };

  async function awaiting(root: string): Promise<void> {
    await withAuthorityHostTestScope(async () => {
      materializeCampaignRound({ repoRoot: root, campaignId: 'CMP-0701', roundId: ROUND });
      saveTask(root, {
        ...loadTask(root, 'TASK-7013'),
        status: 'awaiting_human_review',
        branch: 'experimental/TASK-7013/attempt-1',
        executor: AGENT_EXECUTOR,
      } as unknown as TaskRecord);
    });
  }

  const decisionPath = (root: string) =>
    join(root, '.devai/state/round-runs', ROUND, 'ratifications', 'TASK-7013.json');

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
      // Repeating the identical decision is idempotent; a different one is refused.
      expect(
        ratifyRoundTask({
          repoRoot: root,
          round: ROUND,
          taskId: 'TASK-7013',
          decision: 'accept',
          role: 'owner',
        }),
      ).toEqual(record);
      expect(() =>
        ratifyRoundTask({
          repoRoot: root,
          round: ROUND,
          taskId: 'TASK-7013',
          decision: 'reject',
          role: 'owner',
        }),
      ).toThrow('RATIFICATION_EXISTS');
    });
  });

  it('escalates a rejection and refuses other roles, decisions, executors and states', async () => {
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
      // A human executor completes through its own evidence contract, never ratify.
      saveTask(root, { ...loadTask(root, 'TASK-7012'), status: 'awaiting_human_review' });
      expect(() =>
        ratifyRoundTask({ ...base, taskId: 'TASK-7012', decision: 'accept', role: 'owner' }),
      ).toThrow('RATIFICATION_EXECUTOR_INELIGIBLE');
      expect(loadTask(root, 'TASK-7012').status).toBe('awaiting_human_review');
      saveTask(root, {
        ...loadTask(root, 'TASK-7011'),
        executor: AGENT_EXECUTOR,
      } as unknown as TaskRecord);
      expect(() =>
        ratifyRoundTask({ ...base, taskId: 'TASK-7011', decision: 'accept', role: 'owner' }),
      ).toThrow('RATIFICATION_TASK_NOT_AWAITING_REVIEW');
      expect(ratifyRoundTask({ ...base, decision: 'reject', role: 'architect' })).toMatchObject({
        resulting_status: 'escalated',
      });
      expect(loadTask(root, 'TASK-7013').status).toBe('escalated');
    });
  });

  it('completes an interrupted ratification on retry and quarantines a torn decision', async () => {
    const root = repository();
    await awaiting(root);
    await withAuthorityHostTestScope(async () => {
      const base = { repoRoot: root, round: ROUND, taskId: 'TASK-7013' } as const;
      const record = ratifyRoundTask({ ...base, decision: 'accept', role: 'owner' });
      // The state a crash between the decision and the transition leaves behind.
      saveTask(root, { ...loadTask(root, 'TASK-7013'), status: 'awaiting_human_review' });
      expect(() => ratifyRoundTask({ ...base, decision: 'reject', role: 'owner' })).toThrow(
        'RATIFICATION_EXISTS',
      );
      expect(ratifyRoundTask({ ...base, decision: 'accept', role: 'owner' })).toEqual(record);
      expect(loadTask(root, 'TASK-7013').status).toBe('pre_merge');
    });
    const torn = repository();
    await awaiting(torn);
    mkdirSync(join(torn, '.devai/state/round-runs', ROUND, 'ratifications'), { recursive: true });
    writeFileSync(decisionPath(torn), '{"schemaVersion":"1.0.0","round_id"');
    await withAuthorityHostTestScope(async () => {
      expect(
        ratifyRoundTask({
          repoRoot: torn,
          round: ROUND,
          taskId: 'TASK-7013',
          decision: 'reject',
          role: 'owner',
        }),
      ).toMatchObject({ decision: 'reject', resulting_status: 'escalated' });
    });
    expect(
      readdirSync(join(torn, '.devai/state/round-runs', ROUND, 'ratifications')).some((name) =>
        name.startsWith('TASK-7013.json.torn-'),
      ),
    ).toBe(true);
  });

  it('refuses a ratification whose task changed before its load', async () => {
    const root = repository();
    await awaiting(root);
    const issuer = createIssuer(await runtimeApi(), { invocation_id: 'ratify-changed' });
    const scope: AuthorityHostEffectScope = {
      action_id: 'round ratify',
      invocation_id: 'ratify-changed',
      effect: 'local-write',
      receipt_store: issuer,
      apply_effect: (request, apply) => {
        const applied = apply();
        // A writer that ignores the round controller lands right after the decision.
        if (request.symbol === 'renameSync' && request.arguments[1] === decisionPath(root)) {
          saveTask(root, { ...loadTask(root, 'TASK-7013'), status: 'escalated' });
        }
        return applied;
      },
    };
    try {
      await runWithAuthorityHostEffects(scope, async () => {
        expect(() =>
          ratifyRoundTask({
            repoRoot: root,
            round: ROUND,
            taskId: 'TASK-7013',
            decision: 'accept',
            role: 'owner',
          }),
        ).toThrow('RATIFICATION_TASK_CHANGED');
      });
    } finally {
      issuer.dispose();
    }
    expect(loadTask(root, 'TASK-7013').status).toBe('escalated');
  });

  it('serializes a concurrent escalation landing between the load and the save', async () => {
    const root = repository();
    await awaiting(root);
    const taskFile = join(root, '.devai/state/tasks/TASK-7013.json');
    let concurrent: unknown;
    const issuer = createIssuer(await runtimeApi(), { invocation_id: 'ratify-window' });
    const scope: AuthorityHostEffectScope = {
      action_id: 'round ratify',
      invocation_id: 'ratify-window',
      effect: 'local-write',
      receipt_store: issuer,
      apply_effect: (request, apply) => {
        if (
          concurrent === undefined &&
          request.symbol === 'writeFileSync' &&
          request.arguments[0] === taskFile &&
          String(request.arguments[1]).includes('"status": "pre_merge"')
        ) {
          // `task escalate` arrives after ratify loaded the task and before it saves it.
          concurrent = 'attempted';
          try {
            escalateRoundTask({
              repoRoot: root,
              round: ROUND,
              taskId: 'TASK-7013',
              acquireRoundController: true,
            });
            concurrent = 'escalated';
          } catch (error) {
            concurrent = (error as { code?: string }).code;
          }
        }
        return apply();
      },
    };
    try {
      await runWithAuthorityHostEffects(scope, async () => {
        expect(
          ratifyRoundTask({
            repoRoot: root,
            round: ROUND,
            taskId: 'TASK-7013',
            decision: 'accept',
            role: 'owner',
          }),
        ).toMatchObject({ resulting_status: 'pre_merge' });
      });
    } finally {
      issuer.dispose();
    }
    // The escalation could not enter the window, so no update was lost.
    expect(concurrent).toBe('TASK_ROUND_CONTROLLER_BUSY');
    expect(loadTask(root, 'TASK-7013').status).toBe('pre_merge');
    await withAuthorityHostTestScope(async () => {
      escalateRoundTask({
        repoRoot: root,
        round: ROUND,
        taskId: 'TASK-7013',
        acquireRoundController: true,
      });
    });
    expect(loadTask(root, 'TASK-7013').status).toBe('escalated');
  });
});
