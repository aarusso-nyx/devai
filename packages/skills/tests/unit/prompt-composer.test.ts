// ADR-MDL-0005 D-8 and IA-008: deterministic prompt composition with per-component and stack
// hashes (Constitution Article 37); a missing component refuses instead of being skipped.
import type { TaskRecord } from '@devai-nyx/loop';
import { getValidator } from '@devai-nyx/schemas';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeAgentPrompt, promptStackSha256 } from '../../src/prompt-composer/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(agents = '# Adopter rules\n\nKeep changes small.\n'): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-prompt-composer-'));
  roots.push(root);
  writeFileSync(join(root, 'AGENTS.md'), agents);
  return root;
}

function task(
  overrides: Partial<TaskRecord> = {},
  executor: Record<string, unknown> = {},
): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id: 'TASK-0040',
    round_id: 'R-0012',
    status: 'ready',
    discipline: 'inspector',
    title: 'Cover the ticket list endpoint',
    target_modules: ['MOD-tickets'],
    target_substrates: ['F3'],
    created_at: '2026-10-04T00:00:00.000Z',
    db_isolation: 'database',
    iteration_count: 0,
    executor: {
      kind: 'agent',
      runtime: 'claude-cli',
      model: 'claude-opus-5-5',
      effort: 'high',
      selection: { mode: 'exact' },
      prompt_composition_id: 'PC-0000000000000000',
      max_iterations: 4,
      capabilities: ['repository-context'],
      recipe_name: 'devai-verify',
      ...executor,
    },
    ...overrides,
  } as TaskRecord;
}

const AT = '2026-10-04T12:00:00.000Z';
const hashes = (root: string, value: TaskRecord) =>
  Object.fromEntries(
    composeAgentPrompt({ repoRoot: root, task: value, generatedAt: AT }).composition.components.map(
      (component) => [component.layer, component.body_sha256],
    ),
  );

describe('agent prompt composition (ADR-MDL-0005 D-8)', () => {
  it('is deterministic and records a schema-valid composition', () => {
    const root = repository();
    const first = composeAgentPrompt({ repoRoot: root, task: task(), generatedAt: AT });
    const second = composeAgentPrompt({ repoRoot: root, task: task(), generatedAt: AT });
    expect(second).toEqual(first);
    expect(first.composition.components.map((component) => component.layer)).toEqual([
      'global',
      'role',
      'task',
      'payload',
    ]);
    expect(first.composition.id).toBe(`PC-${first.composition.stack_sha256.slice(0, 16)}`);
    expect(first.composition.stack_sha256).toBe(promptStackSha256(first.composition.components));
    expect(first.prompt_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.prompt).toContain('Role: Inspector');
    expect(getValidator('prompt-composition.schema.json')(first.composition)).toBe(true);
  });

  it('attributes a change to exactly the component that changed (IA-008)', () => {
    const root = repository();
    const base = hashes(root, task());
    const retitled = hashes(root, task({ title: 'Cover the ticket detail endpoint' }));
    expect(retitled.global).toBe(base.global);
    expect(retitled.role).toBe(base.role);
    expect(retitled.task).not.toBe(base.task);
    expect(retitled.payload).toBe(base.payload);

    const changedRules = hashes(repository('# Adopter rules\n\nKeep changes tiny.\n'), task());
    expect(changedRules.global).not.toBe(base.global);
    expect(changedRules.role).toBe(base.role);
    expect(changedRules.task).toBe(base.task);
    expect(changedRules.payload).toBe(base.payload);
  });

  it('ignores lifecycle progress and its own bound composition id', () => {
    const root = repository();
    const base = hashes(root, task());
    expect(hashes(root, task({ status: 'in_progress', iteration_count: 2 }))).toEqual(base);
    expect(hashes(root, task({}, { prompt_composition_id: 'PC-ffffffffffffffff' }))).toEqual(base);
    expect(hashes(repository('# Adopter rules\r\n\r\nKeep changes small.\r\n'), task())).toEqual(
      base,
    );
  });

  it('adds the declared recipe as the payload layer from the packaged recipes', () => {
    const root = repository();
    const composed = composeAgentPrompt({
      repoRoot: root,
      task: task({}, { recipe_name: 'devai-fix' }),
      generatedAt: AT,
    });
    expect(composed.composition.components.at(-1)).toMatchObject({
      layer: 'payload',
      name: 'recipe.devai-fix',
      source: 'resources/recipes/devai-fix/SKILL.md',
    });
    expect(composed.prompt).toContain('<!-- devai:payload recipe.devai-fix -->');
  });

  it('refuses a task without a recipe instead of composing three layers (D-8)', () => {
    const root = repository();
    expect(() =>
      composeAgentPrompt({ repoRoot: root, task: task({}, { recipe_name: undefined }) }),
    ).toThrow('PROMPT_RECIPE_REQUIRED');
    for (const recipe_name of ['../roles', 'devai-fix/../../x', 'Devai-Fix', '', 7]) {
      expect(() => composeAgentPrompt({ repoRoot: root, task: task({}, { recipe_name }) })).toThrow(
        'PROMPT_RECIPE_INVALID',
      );
    }
    expect(() =>
      composeAgentPrompt({ repoRoot: root, task: task({}, { recipe_name: 'devai-absent' }) }),
    ).toThrow('PROMPT_COMPONENT_MISSING');
  });

  it('refuses a missing component, an unsupported discipline and a non-agent task', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-prompt-composer-bare-'));
    roots.push(root);
    expect(() => composeAgentPrompt({ repoRoot: root, task: task() })).toThrow(
      'PROMPT_COMPONENT_MISSING',
    );
    const withRules = repository();
    expect(() =>
      composeAgentPrompt({ repoRoot: withRules, task: task({ discipline: 'architect' }) }),
    ).toThrow('PROMPT_DISCIPLINE_UNSUPPORTED');
    expect(() =>
      composeAgentPrompt({
        repoRoot: withRules,
        task: task({ executor: { kind: 'routine' } as unknown as TaskRecord['executor'] }),
      }),
    ).toThrow('PROMPT_AGENT_TASK_REQUIRED');
    expect(() => composeAgentPrompt({ repoRoot: repository(' \n'), task: task() })).toThrow(
      'PROMPT_COMPONENT_EMPTY',
    );
  });

  it('ships a charter for every discipline experimental execution admits', () => {
    const root = repository();
    for (const discipline of ['engineer', 'inspector'] as const) {
      const composed = composeAgentPrompt({ repoRoot: root, task: task({ discipline }) });
      expect(composed.prompt).toMatch(/Constitution Article 6/u);
      expect(composed.prompt).toMatch(/Do not push, merge/u);
    }
  });
});
