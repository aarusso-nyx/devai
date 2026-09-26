import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';

interface CampaignCheck {
  readonly ok: boolean;
  readonly id?: string;
  readonly problems: readonly string[];
}
interface Wave {
  records: string[];
  tasks: unknown[];
}
interface Round {
  depends_on: string[];
  records: string[];
  waves: Wave[];
}
interface Plan {
  status: string;
  records: string[];
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

function copyCampaign(): string {
  const dir = mkdtempSync(join(tmpdir(), 'devai-campaign-'));
  temporary.push(dir);
  cpSync(campaignDir, dir, { recursive: true });
  return dir;
}

function mutatePlan(dir: string, mutate: (plan: Plan) => void): void {
  const path = join(dir, 'campaign.json');
  const plan = JSON.parse(readFileSync(path, 'utf8')) as Plan;
  mutate(plan);
  writeFileSync(path, JSON.stringify(plan));
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
      [tasks[0], tasks[1]] = [tasks[1], tasks[0]];
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
});
