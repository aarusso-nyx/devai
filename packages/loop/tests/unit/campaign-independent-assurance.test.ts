// ADR-GOV-0026 IA-003 (issue #412): a campaign round or task designated independent-assurance
// withholds the Engineer's focused-regression verb. The designation reaches dispatch through the
// materialized task record, which carries `independent_assurance: true` when the round or the
// task sets it, and carries no such field otherwise, so undesignated records are unchanged.
import { describe, expect, it } from 'vitest';
import { campaignTaskRecord, type LoadedCampaign } from '../../src/campaign/index.js';

type Round = Parameters<typeof campaignTaskRecord>[1];
type Wave = Parameters<typeof campaignTaskRecord>[2];
type Task = Parameters<typeof campaignTaskRecord>[3];

function fixture(designation: { readonly round?: boolean; readonly task?: boolean }) {
  const task = {
    id: 'TASK-0412',
    title: 'Repair the parser',
    discipline: 'engineer',
    coupled_pipeline_position: 'engineer',
    upstream_task_id: null,
    status: 'planned',
    target_substrates: ['F2'],
    boundary: { paths: ['packages/x/'] },
    deliverables: ['the repair'],
    acceptance_commands: [],
    prompt: { path: 'prompts/TASK-0412.md' },
    execution: {},
    ...(designation.task !== undefined && { independent_assurance: designation.task }),
  } as unknown as Task;
  const wave = { id: 'CTG-0412', title: 'Wave', tasks: [task] } as unknown as Wave;
  const round = {
    id: 'R-0412',
    title: 'Round',
    status: 'planned',
    waves: [wave],
    ...(designation.round !== undefined && { independent_assurance: designation.round }),
  } as unknown as Round;
  const campaign = {
    plan: {
      id: 'CMP-0412',
      title: 'Campaign',
      status: 'active',
      date: '2026-10-22',
      rounds: [round],
    },
    directory: 'product/campaigns/CMP-0412-fixture',
  } as unknown as LoadedCampaign;
  return campaignTaskRecord(campaign, round, wave, task) as unknown as Record<string, unknown>;
}

describe('campaign materialization of the independent-assurance designation', () => {
  it('marks the task record when the round is designated', () => {
    expect(fixture({ round: true })['independent_assurance']).toBe(true);
  });

  it('marks the task record when the task is designated', () => {
    expect(fixture({ task: true })['independent_assurance']).toBe(true);
  });

  it.each([
    ['nothing is designated', {}],
    ['the designation is false', { round: false, task: false }],
  ])('writes no designation field when %s', (_label, designation) => {
    expect(fixture(designation)).not.toHaveProperty('independent_assurance');
  });
});
