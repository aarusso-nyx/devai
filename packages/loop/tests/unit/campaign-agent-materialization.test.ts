// ADR-MDL-0009 IA-004..IA-005: campaign materialize emits an agent executor only for a task
// that declares a valid agent executor contract; human executors stay the default.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  campaignAgentExecutorRefusal,
  materializeCampaignRound,
  type CampaignAgentBinding,
} from '../../src/campaign/index.js';
import { loadTask, type TaskRecord } from '../../src/loop/tasks.js';

const ROUND = 'R-0801';
const DIRECTORY = 'product/campaigns/CMP-0801-agents';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MODELS = {
  'claude-cli': ['haiku', 'sonnet', 'opus', 'fable'],
  'codex-cli': ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra'],
};

/** A binding whose composition id is derived from the record, as the CLI's is. */
const composed: TaskRecord[] = [];
const BINDING: CampaignAgentBinding = {
  models: MODELS,
  promptCompositionId: (record) => {
    composed.push(record);
    return `PC-${record.id.slice(-4).padStart(16, 'a')}`;
  },
};

const AGENT = {
  kind: 'agent',
  runtime: 'claude-cli',
  model: 'sonnet',
  effort: 'high',
  recipe_name: 'devai-fix',
} as const;

function task(id: string, discipline: string, upstream: string | null, executor?: object) {
  return {
    id,
    title: `${discipline} task ${id}`,
    discipline,
    coupled_pipeline_position: discipline,
    upstream_task_id: upstream,
    status: 'ready',
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
    execution: { tier: 'worker', effort: 'medium', time_budget_minutes: 30 },
    ...(executor !== undefined && { executor }),
  };
}

function repository(executors: { inspector?: object; engineer?: object; architect?: object }) {
  const root = mkdtempSync(join(tmpdir(), 'devai-campaign-agents-'));
  roots.push(root);
  const schema = JSON.parse(
    readFileSync(
      join(import.meta.dirname, '..', '..', '..', '..', 'law/schemas/campaign.schema.json'),
      'utf8',
    ),
  ) as { examples: Record<string, unknown>[] };
  const example = structuredClone(schema.examples[0]) as Record<string, unknown>;
  const exampleRound = (example['rounds'] as Record<string, unknown>[])[0] ?? {};
  const exampleWave = (exampleRound['waves'] as Record<string, unknown>[])[0] ?? {};
  const campaign = {
    ...example,
    id: 'CMP-0801',
    title: 'Agent campaign',
    status: 'active',
    date: '2026-10-05',
    rounds: [
      {
        ...exampleRound,
        id: ROUND,
        status: 'open',
        depends_on: [],
        waves: [
          {
            ...exampleWave,
            id: 'CTG-0801',
            type: 'coupled-triplet',
            depends_on: [],
            tasks: [
              task('TASK-8011', 'architect', null, executors.architect),
              task('TASK-8012', 'inspector', 'TASK-8011', executors.inspector),
              task('TASK-8013', 'engineer', 'TASK-8012', executors.engineer),
            ],
          },
        ],
      },
    ],
  };
  mkdirSync(join(root, DIRECTORY, 'prompts'), { recursive: true });
  writeFileSync(join(root, DIRECTORY, 'campaign.json'), JSON.stringify(campaign));
  writeFileSync(join(root, DIRECTORY, 'prompts/preamble.md'), '# Preamble\n');
  for (const id of ['TASK-8011', 'TASK-8012', 'TASK-8013']) {
    writeFileSync(join(root, DIRECTORY, 'prompts', `${id}.md`), `# ${id}\n`);
  }
  mkdirSync(join(root, 'work/rounds', ROUND), { recursive: true });
  writeFileSync(join(root, 'work/rounds', ROUND, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  return root;
}

describe('campaign agent materialization (IA-004)', () => {
  it('emits an exact-selection agent executor bound to the composed prompt', async () => {
    composed.length = 0;
    const root = repository({
      engineer: AGENT,
      inspector: {
        ...AGENT,
        runtime: 'codex-cli',
        model: 'gpt-6-sol',
        effort: 'xhigh',
        recipe_name: 'devai-verify',
        max_iterations: 2,
        capabilities: ['repository-context'],
      },
    });
    const result = await withAuthorityHostTestScope(async () =>
      materializeCampaignRound({
        repoRoot: root,
        campaignId: 'CMP-0801',
        roundId: ROUND,
        agent: BINDING,
      }),
    );
    expect(result.materialized).toEqual(['TASK-8011', 'TASK-8012', 'TASK-8013']);
    // Human executors stay the default.
    expect(loadTask(root, 'TASK-8011').executor).toMatchObject({ kind: 'human' });
    expect(loadTask(root, 'TASK-8013').executor).toEqual({
      kind: 'agent',
      runtime: 'claude-cli',
      model: 'sonnet',
      effort: 'high',
      selection: { mode: 'exact', registry_id: 'claude-cli' },
      recipe_name: 'devai-fix',
      instructions_ref: `${DIRECTORY}/prompts/TASK-8013.md`,
      prompt_composition_id: 'PC-aaaaaaaaaaaa8013',
      max_iterations: 4,
      capabilities: [],
      timeout_ms: 1_800_000,
    });
    expect(loadTask(root, 'TASK-8012').executor).toMatchObject({
      kind: 'agent',
      runtime: 'codex-cli',
      model: 'gpt-6-sol',
      effort: 'xhigh',
      selection: { mode: 'exact', registry_id: 'codex-cli' },
      max_iterations: 2,
      capabilities: ['repository-context'],
    });
    // The binding composes the record it is about to bind, never a human one.
    expect(composed.map((record) => record.id)).toEqual(['TASK-8012', 'TASK-8013']);
    expect(composed.every((record) => record.executor.kind === 'agent')).toBe(true);
  });

  it('is idempotent for an identical agent record', async () => {
    const root = repository({ engineer: AGENT });
    await withAuthorityHostTestScope(async () => {
      const options = { repoRoot: root, campaignId: 'CMP-0801', roundId: ROUND, agent: BINDING };
      materializeCampaignRound(options);
      expect(materializeCampaignRound(options)).toMatchObject({
        materialized: [],
        existing: ['TASK-8011', 'TASK-8012', 'TASK-8013'],
      });
    });
  });
});

describe('campaign agent contract validation (IA-005)', () => {
  it.each([
    ['architect', AGENT, 'CAMPAIGN_AGENT_DISCIPLINE_UNSUPPORTED'],
    ['engineer', { ...AGENT, runtime: 'anthropic-api' }, 'CAMPAIGN_AGENT_RUNTIME_UNSUPPORTED'],
    ['engineer', { ...AGENT, effort: 'ultra' }, 'CAMPAIGN_AGENT_EFFORT_UNSUPPORTED'],
    ['engineer', { ...AGENT, model: 'gpt-6-sol' }, 'CAMPAIGN_AGENT_MODEL_UNSUPPORTED'],
  ])('refuses a %s contract with %o as %s', (discipline, executor, code) => {
    expect(
      campaignAgentExecutorRefusal(
        { discipline: discipline as 'engineer', executor: executor as typeof AGENT },
        MODELS,
      ),
    ).toBe(code);
  });

  it('refuses an invalid contract before any queue write', async () => {
    const root = repository({ engineer: AGENT, architect: AGENT });
    await withAuthorityHostTestScope(async () => {
      expect(() =>
        materializeCampaignRound({
          repoRoot: root,
          campaignId: 'CMP-0801',
          roundId: ROUND,
          agent: BINDING,
        }),
      ).toThrow('CAMPAIGN_AGENT_DISCIPLINE_UNSUPPORTED');
    });
    expect(existsSync(join(root, '.devai/state'))).toBe(false);
  });

  it('refuses an agent contract without a binding', async () => {
    const root = repository({ engineer: AGENT });
    await withAuthorityHostTestScope(async () => {
      expect(() =>
        materializeCampaignRound({ repoRoot: root, campaignId: 'CMP-0801', roundId: ROUND }),
      ).toThrow('CAMPAIGN_AGENT_BINDING_REQUIRED');
    });
    expect(existsSync(join(root, '.devai/state'))).toBe(false);
  });

  it('rejects a contract the campaign schema does not admit', () => {
    const root = repository({ engineer: { ...AGENT, recipe_name: 'devai-unknown' } });
    expect(() =>
      materializeCampaignRound({
        repoRoot: root,
        campaignId: 'CMP-0801',
        roundId: ROUND,
        agent: BINDING,
      }),
    ).toThrow('CAMPAIGN_INVALID');
  });
});
