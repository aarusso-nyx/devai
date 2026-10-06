// ADR-MDL-0009 IA-006: a campaign task with an agent executor contract materializes through
// the CLI binding into an agent task that round dispatch --experimental admits and runs to
// human review, against a scripted fake provider. No live provider.
import { runWithAuthorityHostEffects, type AuthorityHostEffectScope } from '@devai-nyx/authority';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createIssuer,
  runtimeApi,
} from '../../../authority/tests/unit/authority-runtime-testkit.js';
import {
  loadTask,
  materializeCampaignRound,
  runRoundTasks,
  saveTask,
  type ExperimentalActivation,
} from '@devai-nyx/loop';
import { composeAgentPrompt } from '@devai-nyx/skills';
import { campaignAgentBinding } from '../../src/commands/campaign/index.js';
import {
  dispatchExperimentalTask,
  experimentalTaskRefusal,
  withinDeclaredBoundary,
  type ExperimentalBudget,
} from '../../src/services/experimental-dispatch/index.js';

const FAKE = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'skills',
  'tests',
  'fixtures',
  'fake-agent-cli.mjs',
);
const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const ROUND = 'R-0901';
const DIRECTORY = 'product/campaigns/CMP-0009-agents';
for (const name of Object.keys(process.env)) {
  if (name.startsWith('GIT_')) Reflect.deleteProperty(process.env, name);
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-campaign-agent-dispatch-'));
  roots.push(root);
  const schema = JSON.parse(
    readFileSync(join(ROOT, 'law/schemas/campaign.schema.json'), 'utf8'),
  ) as {
    examples: Record<string, unknown>[];
  };
  const example = structuredClone(schema.examples[0]) as Record<string, unknown>;
  const exampleRound = (example['rounds'] as Record<string, unknown>[])[0] ?? {};
  const exampleWave = (exampleRound['waves'] as Record<string, unknown>[])[0] ?? {};
  const campaign = {
    ...example,
    id: 'CMP-0009',
    title: 'Agent dispatch campaign',
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
            id: 'CTG-0901',
            type: 'single-role',
            depends_on: [],
            tasks: [
              {
                id: 'TASK-0901',
                title: 'Implement the feature',
                discipline: 'engineer',
                coupled_pipeline_position: 'engineer',
                upstream_task_id: null,
                status: 'ready',
                target_substrates: ['F2'],
                boundary: { paths: ['packages/app/src/feature.ts'] },
                deliverables: ['the feature'],
                acceptance_commands: [['pnpm', 'test']],
                commit_types: ['feat'],
                prompt: { path: 'prompts/TASK-0901.md' },
                pull_request: null,
                merged_as: null,
                execution: { tier: 'worker', effort: 'high' },
                executor: {
                  kind: 'agent',
                  runtime: 'claude-cli',
                  model: 'sonnet',
                  effort: 'high',
                  recipe_name: 'devai-fix',
                  capabilities: ['repository-context'],
                },
              },
            ],
          },
        ],
      },
    ],
  };
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'user.name', 'fixture');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, '.gitignore'), '.devai/\n');
  writeFileSync(join(root, 'AGENTS.md'), '# Fixture adopter\n');
  mkdirSync(join(root, 'packages/app/src'), { recursive: true });
  writeFileSync(join(root, 'packages/app/src/index.ts'), 'export const x = 1;\n');
  mkdirSync(join(root, DIRECTORY, 'prompts'), { recursive: true });
  writeFileSync(join(root, DIRECTORY, 'campaign.json'), JSON.stringify(campaign));
  writeFileSync(join(root, DIRECTORY, 'prompts/preamble.md'), '# Preamble\n');
  writeFileSync(join(root, DIRECTORY, 'prompts/TASK-0901.md'), '# TASK-0901\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'fixture');
  mkdirSync(join(root, 'work/rounds', ROUND), { recursive: true });
  writeFileSync(join(root, 'work/rounds', ROUND, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  return root;
}

const ACTIVATION: ExperimentalActivation = {
  schemaVersion: '1.0.0',
  id: 'experimental-activation',
  authority: 'Owner',
  issued_at: '2026-10-04T00:00:00.000Z',
  expires_at: '2026-10-18T00:00:00.000Z',
  runtimes: [{ runtime: 'claude-cli', models: ['sonnet', 'opus'], efforts: ['high'] }],
  disciplines: ['engineer', 'inspector'],
  budgets: {
    attempts_per_task: 4,
    attempts_per_invocation: 8,
    attempt_wall_clock_minutes: 1,
    tokens_per_invocation: 1_000_000,
  },
};

async function permissive<T>(run: () => Promise<T>): Promise<T> {
  const issuer = createIssuer(await runtimeApi(), { invocation_id: 'campaign-agent-dispatch' });
  const scope: AuthorityHostEffectScope = {
    action_id: 'round dispatch',
    invocation_id: 'campaign-agent-dispatch',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
  };
  try {
    return await runWithAuthorityHostEffects(scope, run);
  } finally {
    issuer.dispose();
  }
}

async function materialize(root: string): Promise<void> {
  await permissive(async () => {
    materializeCampaignRound({
      repoRoot: root,
      campaignId: 'CMP-0009',
      roundId: ROUND,
      agent: campaignAgentBinding(root),
    });
    // The readying step a human takes before dispatch; status is not part of the request.
    saveTask(root, { ...loadTask(root, 'TASK-0901'), status: 'ready' });
  });
}

async function dispatch(root: string, writes: string) {
  const budget: ExperimentalBudget = { attempts: 0, tokens: 0, unverifiable: false };
  return permissive(() =>
    runRoundTasks({
      repoRoot: root,
      round: ROUND,
      dispatch: (running) =>
        dispatchExperimentalTask(
          {
            repoRoot: root,
            roundId: ROUND,
            activation: ACTIVATION,
            budget,
            env: { ...process.env, FAKE_AGENT_WRITE_PATH: writes },
            invocation: (selection) => ({
              runtime: selection.runtime,
              command: process.execPath,
              args: [FAKE, 'claude-writes'],
            }),
          },
          running,
        ),
    }),
  );
}

describe('campaign-to-agent materialization (IA-006)', () => {
  it('materializes an agent task that round dispatch admits and runs to human review', async () => {
    const root = repository();
    await materialize(root);
    const task = loadTask(root, 'TASK-0901');
    const composed = composeAgentPrompt({ repoRoot: root, task });
    expect(task.executor).toMatchObject({
      kind: 'agent',
      selection: { mode: 'exact', registry_id: 'claude-cli' },
      instructions_ref: `${DIRECTORY}/prompts/TASK-0901.md`,
      prompt_composition_id: composed.composition.id,
    });
    // The campaign prompt is a hashed component handed to the provider.
    expect(composed.composition.components.map((component) => component.name)).toContain(
      'task.instructions',
    );
    expect(composed.prompt).toContain('# TASK-0901');
    expect(experimentalTaskRefusal(task, ACTIVATION)).toBeUndefined();
    const result = await dispatch(root, 'packages/app/src/feature.ts');
    expect(result.results).toMatchObject([{ task_id: 'TASK-0901', ok: true }]);
    expect(loadTask(root, 'TASK-0901').status).toBe('awaiting_human_review');
  });

  it('fails an attempt that writes inside the role paths but outside the task boundary', async () => {
    const root = repository();
    await materialize(root);
    const result = await dispatch(root, 'packages/app/src/other.ts');
    expect(result.results).toMatchObject([
      { task_id: 'TASK-0901', ok: false, code: 'EXPERIMENTAL_BOUNDARY_VIOLATION' },
    ]);
    expect(loadTask(root, 'TASK-0901').status).toBe('experimental_blocked');
  });

  it('refuses dispatch after the campaign prompt changes until the task is re-bound', async () => {
    const root = repository();
    await materialize(root);
    writeFileSync(join(root, DIRECTORY, 'prompts/TASK-0901.md'), '# TASK-0901\nEdited.\n');
    const result = await dispatch(root, 'packages/app/src/feature.ts');
    expect(result.results).toMatchObject([
      { task_id: 'TASK-0901', ok: false, code: 'TASK_PROMPT_COMPOSITION_DRIFT' },
    ]);
  });
});

describe('declared task boundary', () => {
  it('admits exact paths and paths under a directory entry only', () => {
    const boundary = ['packages/app/src/feature.ts', 'docs/notes/'];
    expect(withinDeclaredBoundary('packages/app/src/feature.ts', boundary)).toBe(true);
    expect(withinDeclaredBoundary('docs/notes/a.md', boundary)).toBe(true);
    expect(withinDeclaredBoundary('packages/app/src/feature.tsx', boundary)).toBe(false);
    expect(withinDeclaredBoundary('docs/notes.md', boundary)).toBe(false);
  });
});
