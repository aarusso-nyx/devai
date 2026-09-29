import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';

interface CampaignCheck {
  readonly ok: boolean;
  readonly id?: string;
  readonly problems: readonly string[];
}
interface Task {
  id: string;
  acceptance_commands: string[][];
}
interface Wave {
  records: string[];
  tasks: Task[];
}
interface Round {
  id: string;
  status: string;
  depends_on: string[];
  records: string[];
  owner_effects_required: string[];
  waves: Wave[];
}
interface OwnerEffect {
  id: string;
  required_before: string;
  performed_at?: string | null;
}
interface Plan {
  status: string;
  records: string[];
  owner_effects: OwnerEffect[];
  rounds: Round[];
}
const checker = (await import(
  pathToFileURL(join(process.cwd(), 'scripts/check-campaign.mjs')).href
)) as {
  readonly checkCampaign: (root: string, dir: string) => CampaignCheck;
  readonly checkCampaignTree: (root: string) => {
    readonly ok: boolean;
    readonly campaigns: readonly CampaignCheck[];
  };
};
const { checkCampaign, checkCampaignTree } = checker;

const root = resolve(import.meta.dirname, '../..');
const campaignDir = join(root, 'product/campaigns/CMP-0001-workflow-economy');
const temporary: string[] = [];

function copyCampaign(source = campaignDir): string {
  const dir = mkdtempSync(join(tmpdir(), 'devai-campaign-'));
  temporary.push(dir);
  cpSync(source, dir, { recursive: true });
  return dir;
}

function mutatePlan(dir: string, mutate: (plan: Plan) => void): void {
  const path = join(dir, 'campaign.json');
  const plan = JSON.parse(readFileSync(path, 'utf8')) as Plan;
  mutate(plan);
  writeFileSync(path, JSON.stringify(plan));
}

/**
 * A view of the repository in a temporary directory: every entry is a symlink
 * to the checkout except the files named in overrides, which are written with
 * the given content inside real directories, and scripts/, which is copied so
 * a script's main-module guard sees its own path.
 */
function mirrorRepository(overrides: Readonly<Record<string, string>>): string {
  const mirror = mkdtempSync(join(tmpdir(), 'devai-campaign-mirror-'));
  temporary.push(mirror);
  const paths = Object.keys(overrides);
  const build = (relative: string): void => {
    for (const name of readdirSync(join(root, relative))) {
      const path = relative === '' ? name : `${relative}/${name}`;
      if (path === 'scripts') {
        cpSync(join(root, path), join(mirror, path), { recursive: true });
      } else if (Object.hasOwn(overrides, path)) {
        writeFileSync(join(mirror, path), overrides[path] ?? '');
      } else if (paths.some((override) => override.startsWith(`${path}/`))) {
        mkdirSync(join(mirror, path));
        build(path);
      } else {
        symlinkSync(join(root, path), join(mirror, path));
      }
    }
  };
  build('');
  return mirror;
}

interface DescriptorTask {
  readonly nodeId: string;
  readonly dependencies: readonly string[];
  readonly argv: readonly string[];
  readonly inputSelectors: readonly Readonly<{ kind: string; pattern: string }>[];
}

function descriptorTasks(): readonly DescriptorTask[] {
  return (
    JSON.parse(readFileSync(join(root, 'test-tasks.json'), 'utf8')) as {
      tasks: readonly DescriptorTask[];
    }
  ).tasks;
}

const PLAN_CLASS_PREFIXES = ['product/', 'record/', 'work/'] as const;

/** Whether a descriptor node selects a path; the plan class is the ADR-CHK-0003 population. */
function selects(task: DescriptorTask, path: string): boolean {
  return task.inputSelectors.some((selector) => {
    if (selector.kind === 'exact') return path === selector.pattern;
    if (selector.kind === 'prefix') return path.startsWith(selector.pattern);
    if (selector.kind === 'class') {
      return (
        selector.pattern === 'plan' && PLAN_CLASS_PREFIXES.some((prefix) => path.startsWith(prefix))
      );
    }
    const expression = selector.pattern
      .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
      .replaceAll('**', '\u0000')
      .replaceAll('*', '[^/]*')
      .replaceAll('\u0000', '.*');
    return new RegExp(`^${expression}$`, 'u').test(path);
  });
}

function dependencyClosure(nodeId: string): ReadonlySet<string> {
  const byId = new Map(descriptorTasks().map((task) => [task.nodeId, task]));
  const seen = new Set<string>();
  const pending = [nodeId];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    pending.push(...(byId.get(next)?.dependencies ?? []));
  }
  return seen;
}

/** The plan:validate members that run a script and select the given plan-class path. */
function planValidateMembers(script: RegExp, path: string): readonly DescriptorTask[] {
  return descriptorTasks().filter(
    (task) => script.test(task.argv.join(' ')) && selects(task, path),
  );
}

function runMember(task: DescriptorTask, cwd: string) {
  const [command = '', ...args] = task.argv;
  const result = spawnSync(command === 'node' ? process.execPath : command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const SCORECARD_DIR = 'record/proofs/compliance/scorecards';
const SCORECARD_PAGE_CHECK =
  /scripts\/generate-scorecard-page\.mjs\b.*--check|scorecard-page:check/u;
const CAMPAIGN_CHECK = /scripts\/check-campaign\.mjs/u;
const DRIFTED_PROMPT = 'product/campaigns/CMP-0001-workflow-economy/prompts/TASK-0111.md';

function newestScorecardPath(): string {
  const id = readdirSync(join(root, SCORECARD_DIR))
    .map((name) => /^(SC-[0-9A-Z-]+)\.json$/u.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .sort()
    .at(-1);
  if (id === undefined) throw new Error('fixture scorecard record missing');
  return `${SCORECARD_DIR}/${id}.json`;
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('campaign plan contract', () => {
  it('accepts every committed campaign', () => {
    const result = checkCampaignTree(root);
    expect(result.campaigns.map((campaign) => campaign.problems)).toEqual(
      result.campaigns.map(() => []),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a schema violation before structural checks', () => {
    const dir = copyCampaign();
    mutatePlan(dir, (plan) => {
      plan.status = 'running';
    });
    const result = checkCampaign(root, dir);
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => problem.startsWith('schema /status'))).toBe(true);
  });

  it('rejects a triplet whose pipeline order is not architect, inspector, engineer', () => {
    const dir = copyCampaign();
    mutatePlan(dir, (plan) => {
      const tasks = plan.rounds[0]?.waves[0]?.tasks ?? [];
      [tasks[0], tasks[1]] = [tasks[1] as Task, tasks[0] as Task];
    });
    const result = checkCampaign(root, dir);
    expect(result.problems).toContain('CTG-0101 triplet must be architect, inspector, engineer');
  });

  it('rejects an unknown round dependency, a cycle, and an unaccepted record file', () => {
    const dir = copyCampaign();
    mutatePlan(dir, (plan) => {
      const first = plan.rounds[0];
      const last = plan.rounds[5];
      if (first === undefined || last === undefined) throw new Error('fixture rounds missing');
      first.depends_on = ['R-0106'];
      last.depends_on = ['R-0101'];
      plan.records.push('ADR-ZZZ-9999');
      first.records.push('ADR-ZZZ-9999');
      first.waves[0]?.records.push('ADR-ZZZ-9999');
    });
    const result = checkCampaign(root, dir);
    expect(result.problems).toContain('record ADR-ZZZ-9999 has no file under law/adr');
    expect(result.problems.some((problem) => problem.startsWith('round dependency cycle'))).toBe(
      true,
    );
  });

  it('rejects a prompt whose acceptance block drifts from the plan or hides a credential', () => {
    const dir = copyCampaign();
    const prompt = join(dir, 'prompts/TASK-0111.md');
    const body = readFileSync(prompt, 'utf8');
    writeFileSync(
      prompt,
      `${body.replace('node scripts/check-policy-materialization.mjs', 'pnpm test')}\nghp_${'a'.repeat(20)}\n`,
    );
    const result = checkCampaign(root, dir);
    expect(result.problems).toContain(
      'TASK-0111 prompt acceptance block differs from acceptance_commands',
    );
    expect(result.problems).toContain('TASK-0111 prompt contains a credential shape');
  });

  it('rejects an orphan prompt and a missing prompt', () => {
    const dir = copyCampaign();
    writeFileSync(join(dir, 'prompts/TASK-9999.md'), '# orphan\n');
    rmSync(join(dir, 'prompts/TASK-0112.md'));
    const result = checkCampaign(root, dir);
    expect(result.problems).toContain('orphan prompt prompts/TASK-9999.md');
    expect(result.problems).toContain('TASK-0112 prompt missing prompts/TASK-0112.md');
  });

  // ADR-CHK-0003, Inspector Adversarial Acceptance IA-004.
  it('refuses a closed round whose required Owner effect has no performed_at', () => {
    const dir = copyCampaign();
    mutatePlan(dir, (plan) => {
      const round = plan.rounds.find((candidate) => candidate.id === 'R-0103');
      const effect = plan.owner_effects.find((candidate) => candidate.id === 'OE-01');
      if (round === undefined || effect === undefined) throw new Error('fixture effect missing');
      expect(round.status).toBe('closed');
      expect(round.owner_effects_required).toContain('OE-01');
      expect(effect.required_before).toBe('R-0103');
      effect.performed_at = null;
    });
    const result = checkCampaign(root, dir);
    expect(result.ok).toBe(false);
    expect(
      result.problems.filter((problem) => problem.includes('OE-01') && problem.includes('R-0103')),
      `a problem names OE-01 and R-0103: ${JSON.stringify(result.problems)}`,
    ).not.toEqual([]);
  });

  it('refuses a ledger whose acceptance commands drift from the prompt', () => {
    const dir = copyCampaign(join(root, 'product/campaigns/CMP-0003-harness-convergence'));
    mutatePlan(dir, (plan) => {
      const task = plan.rounds
        .flatMap((round) => round.waves.flatMap((wave) => wave.tasks))
        .find((candidate) => candidate.id === 'TASK-0312');
      if (task === undefined) throw new Error('fixture task missing');
      task.acceptance_commands = [['pnpm', 'test']];
    });
    const result = checkCampaign(root, dir);
    expect(result.problems).toContain(
      'TASK-0312 prompt acceptance block differs from acceptance_commands',
    );
  });

  it('loads the campaign execution policy with status accepted (IA-004)', () => {
    const policy = JSON.parse(
      readFileSync(join(root, 'law/policy/campaign-execution.json'), 'utf8'),
    ) as { status?: string };
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(
      JSON.parse(
        readFileSync(join(root, 'law/schemas/campaign-execution-policy.schema.json'), 'utf8'),
      ) as object,
    );
    expect(validate(policy), JSON.stringify(validate.errors)).toBe(true);
    expect(policy.status).toBe('accepted');
  });

  // ADR-CHK-0003, Inspector Adversarial Acceptance IA-001: the campaign check reports.
  it('runs the campaign check as a plan:validate member that reports a drifted prompt', () => {
    const members = planValidateMembers(CAMPAIGN_CHECK, DRIFTED_PROMPT);
    expect(
      members.map((task) => task.nodeId),
      'a node running scripts/check-campaign.mjs selects campaign prompts',
    ).not.toEqual([]);
    const mirror = mirrorRepository({
      [DRIFTED_PROMPT]: readFileSync(join(root, DRIFTED_PROMPT), 'utf8').replace(
        'node scripts/check-policy-materialization.mjs',
        'pnpm test',
      ),
    });
    for (const task of members) {
      const { status, output } = runMember(task, mirror);
      expect(status, `${task.nodeId} fails on a drifted prompt`).not.toBe(0);
      expect(output).toContain(
        'TASK-0111 prompt acceptance block differs from acceptance_commands',
      );
    }
  });

  // ADR-CHK-0003, Inspector Adversarial Acceptance IA-005.
  it('fails plan:validate through the scorecard-page check without generate or build', () => {
    const record = newestScorecardPath();
    const members = planValidateMembers(SCORECARD_PAGE_CHECK, record);
    expect(
      members.map((task) => task.nodeId),
      'a node running generate-scorecard-page.mjs --check selects scorecard records',
    ).not.toEqual([]);
    for (const task of members) {
      const closure = dependencyClosure(task.nodeId);
      expect(closure.has('generate'), `${task.nodeId} depends on generate`).toBe(false);
      expect(closure.has('build'), `${task.nodeId} depends on build`).toBe(false);
      const fresh = runMember(task, root);
      expect(fresh.status, `${task.nodeId} passes on the checkout: ${fresh.output}`).toBe(0);
    }
    const scorecard = JSON.parse(readFileSync(join(root, record), 'utf8')) as Readonly<
      Record<string, unknown>
    >;
    const mirror = mirrorRepository({
      [record]: `${JSON.stringify({ ...scorecard, generated_at: '2000-01-01T00:00:00Z' }, null, 2)}\n`,
    });
    for (const task of members) {
      const stale = runMember(task, mirror);
      expect(stale.status, `${task.nodeId} fails on a stale page`).not.toBe(0);
      expect(stale.output).toContain('SCORECARD_PAGE_DRIFT');
    }
  });
});
