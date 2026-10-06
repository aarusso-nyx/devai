// ADR-MDL-0009: a task's declared instructions file is a hashed task-layer component of the
// composed prompt, so editing it changes the composition id; it must stay in the repository.
import type { TaskRecord } from '@devai-nyx/loop';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeAgentPrompt } from '../../src/prompt-composer/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-prompt-instructions-'));
  roots.push(root);
  writeFileSync(join(root, 'AGENTS.md'), '# Adopter rules\n');
  mkdirSync(join(root, 'prompts'), { recursive: true });
  writeFileSync(join(root, 'prompts/TASK-0041.md'), '# TASK-0041\nDo the thing.\n');
  return root;
}

function task(instructions?: string): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id: 'TASK-0041',
    round_id: 'R-0012',
    status: 'ready',
    discipline: 'engineer',
    title: 'Implement the thing',
    target_modules: [],
    target_substrates: ['F2'],
    created_at: '2026-10-05T00:00:00.000Z',
    db_isolation: 'database',
    iteration_count: 0,
    executor: {
      kind: 'agent',
      runtime: 'claude-cli',
      model: 'sonnet',
      effort: 'high',
      selection: { mode: 'exact', registry_id: 'claude-cli' },
      prompt_composition_id: 'PC-0000000000000000',
      max_iterations: 4,
      capabilities: [],
      recipe_name: 'devai-fix',
      ...(instructions !== undefined && { instructions_ref: instructions }),
    },
  } as TaskRecord;
}

const AT = '2026-10-05T12:00:00.000Z';

describe('task instructions in the composed prompt (ADR-MDL-0009)', () => {
  it('adds the instructions as a hashed task component handed to the provider', () => {
    const root = repository();
    const composed = composeAgentPrompt({
      repoRoot: root,
      task: task('prompts/TASK-0041.md'),
      generatedAt: AT,
    });
    expect(composed.composition.components.map((c) => c.name)).toEqual([
      'repository.agents',
      'engineer.role',
      'task.TASK-0041',
      'task.instructions',
      'recipe.devai-fix',
    ]);
    expect(composed.prompt).toContain('Do the thing.');
    writeFileSync(join(root, 'prompts/TASK-0041.md'), '# TASK-0041\nDo another thing.\n');
    const edited = composeAgentPrompt({
      repoRoot: root,
      task: task('prompts/TASK-0041.md'),
      generatedAt: AT,
    });
    expect(edited.composition.id).not.toBe(composed.composition.id);
  });

  it('keeps the four-layer prompt when no instructions are declared', () => {
    const root = repository();
    const composed = composeAgentPrompt({ repoRoot: root, task: task(), generatedAt: AT });
    expect(composed.composition.components).toHaveLength(4);
  });

  it('refuses instructions outside the repository or missing', () => {
    const root = repository();
    expect(() => composeAgentPrompt({ repoRoot: root, task: task('../escape.md') })).toThrow(
      'PROMPT_INSTRUCTIONS_INVALID',
    );
    expect(() => composeAgentPrompt({ repoRoot: root, task: task('prompts/none.md') })).toThrow(
      'PROMPT_COMPONENT_MISSING',
    );
  });
});
