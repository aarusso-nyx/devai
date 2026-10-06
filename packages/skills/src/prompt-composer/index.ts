import { existsSync, readFileSync } from '@devai-nyx/authority';
import { requestedTaskFields, type TaskRecord } from '@devai-nyx/loop';
import { canonicalJson } from '@devai-nyx/utils';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One hashed layer of a composed prompt (law/schemas/prompt-composition.schema.json). */
export interface PromptComponent {
  readonly layer: 'global' | 'role' | 'task' | 'payload';
  readonly name: string;
  readonly source: string;
  readonly body_sha256: string;
  readonly body_length: number;
}

/** The composition record of Constitution Article 37. */
export interface PromptCompositionRecord {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly generated_at: string;
  readonly task_id: string;
  readonly model_target?: {
    readonly family: 'claude' | 'codex' | 'other';
    readonly model: string;
    readonly tier: 'default' | 'bumped';
  };
  readonly components: readonly PromptComponent[];
  readonly stack_sha256: string;
}

export interface ComposedPrompt {
  readonly composition: PromptCompositionRecord;
  /** The exact bytes handed to the provider. */
  readonly prompt: string;
  readonly prompt_sha256: string;
}

export interface ComposeAgentPromptOptions {
  readonly repoRoot: string;
  readonly task: TaskRecord;
  readonly generatedAt?: string;
  readonly modelTarget?: PromptCompositionRecord['model_target'];
  /** Packaged resources root; tests may point it at a fixture. */
  readonly resourcesRoot?: string;
}

const DEFAULT_RESOURCES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../resources');
const ROLE_DISCIPLINES = new Set(['engineer', 'inspector']);
/** A packaged recipe directory name; nothing that could leave `resources/recipes/`. */
const RECIPE_NAME = /^[a-z][a-z0-9-]*$/u;

export class PromptCompositionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PromptCompositionError';
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Line endings are the only canonicalization; every other byte is part of the hash. */
function canonicalBody(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

function readComponent(path: string): string {
  if (!existsSync(path)) throw new PromptCompositionError('PROMPT_COMPONENT_MISSING');
  const body = canonicalBody(readFileSync(path, 'utf8'));
  if (body.trim().length === 0) throw new PromptCompositionError('PROMPT_COMPONENT_EMPTY');
  return body;
}

/**
 * The task layer: the bound request (admission's requested fields) without its
 * own `prompt_composition_id`, which is derived from this composition and so
 * cannot be part of it.
 */
function taskBody(task: TaskRecord): string {
  const requested = { ...requestedTaskFields(task) } as Record<string, unknown>;
  const executor = requested['executor'];
  if (executor !== null && typeof executor === 'object' && !Array.isArray(executor)) {
    const { prompt_composition_id: _bound, ...rest } = executor as Record<string, unknown>;
    void _bound;
    requested['executor'] = rest;
  }
  return `${canonicalJson(requested)}\n`;
}

/**
 * The task's declared instructions (`executor.instructions_ref`, ADR-MDL-0009), such as a
 * campaign task prompt, as a second task-layer component; none when the task declares none.
 * The reference must stay inside the repository, and a missing or empty file refuses.
 */
function taskInstructions(
  repoRoot: string,
  task: TaskRecord,
): { layer: PromptComponent['layer']; name: string; source: string; body: string }[] {
  const ref = (task.executor as { readonly instructions_ref?: unknown }).instructions_ref;
  if (ref === undefined) return [];
  const root = resolve(repoRoot);
  const path = typeof ref === 'string' ? resolve(root, ref) : '';
  if (typeof ref !== 'string' || ref.length === 0 || !path.startsWith(`${root}${sep}`)) {
    throw new PromptCompositionError('PROMPT_INSTRUCTIONS_INVALID');
  }
  return [{ layer: 'task', name: 'task.instructions', source: ref, body: readComponent(path) }];
}

/** SHA-256 over each component's layer, name and body hash, in composition order. */
export function promptStackSha256(components: readonly PromptComponent[]): string {
  return sha256(
    components
      .map((component) => `${component.layer}\u0000${component.name}\u0000${component.body_sha256}`)
      .join('\n'),
  );
}

/**
 * Compose an experimental agent prompt deterministically (Article 37, ADR-MDL-0005
 * D-8) from four layers, in order: the adopter's `AGENTS.md`, the packaged role
 * charter for the task's discipline, the bound task request (followed by the task's
 * declared instructions file when it names one, ADR-MDL-0009), and the declared
 * recipe as the payload. The same inputs give the same stack hash; a change to one
 * input changes exactly that component's hash. A missing or empty component refuses,
 * including the payload of a task that declares no recipe; nothing is silently skipped.
 */
export function composeAgentPrompt(options: ComposeAgentPromptOptions): ComposedPrompt {
  const { task } = options;
  if (task.executor.kind !== 'agent')
    throw new PromptCompositionError('PROMPT_AGENT_TASK_REQUIRED');
  if (!ROLE_DISCIPLINES.has(task.discipline)) {
    throw new PromptCompositionError('PROMPT_DISCIPLINE_UNSUPPORTED');
  }
  // D-8 layer 4: the payload is the task's recipe. Without one the stack would have
  // three layers, so the composition refuses rather than skipping the payload.
  const recipe = (task.executor as { readonly recipe_name?: unknown }).recipe_name;
  if (recipe === undefined) throw new PromptCompositionError('PROMPT_RECIPE_REQUIRED');
  if (typeof recipe !== 'string' || !RECIPE_NAME.test(recipe)) {
    throw new PromptCompositionError('PROMPT_RECIPE_INVALID');
  }
  const resources = options.resourcesRoot ?? DEFAULT_RESOURCES_ROOT;
  const bodies: { layer: PromptComponent['layer']; name: string; source: string; body: string }[] =
    [
      {
        layer: 'global',
        name: 'repository.agents',
        source: 'AGENTS.md',
        body: readComponent(join(options.repoRoot, 'AGENTS.md')),
      },
      {
        layer: 'role',
        name: `${task.discipline}.role`,
        source: `resources/roles/${task.discipline}.md`,
        body: readComponent(join(resources, 'roles', `${task.discipline}.md`)),
      },
      {
        layer: 'task',
        name: `task.${task.id}`,
        source: `.devai/state/tasks/${task.id}.json`,
        body: taskBody(task),
      },
      ...taskInstructions(options.repoRoot, task),
      {
        layer: 'payload',
        name: `recipe.${recipe}`,
        source: `resources/recipes/${recipe}/SKILL.md`,
        body: readComponent(join(resources, 'recipes', recipe, 'SKILL.md')),
      },
    ];
  const components: PromptComponent[] = bodies.map((entry) => ({
    layer: entry.layer,
    name: entry.name,
    source: entry.source,
    body_sha256: sha256(entry.body),
    body_length: Buffer.byteLength(entry.body, 'utf8'),
  }));
  const stack = promptStackSha256(components);
  const prompt = bodies
    .map((entry) => `<!-- devai:${entry.layer} ${entry.name} -->\n${entry.body.trimEnd()}\n`)
    .join('\n');
  return {
    composition: {
      schemaVersion: '1.0.0',
      id: `PC-${stack.slice(0, 16)}`,
      generated_at: options.generatedAt ?? new Date().toISOString(),
      task_id: task.id,
      ...(options.modelTarget !== undefined && { model_target: options.modelTarget }),
      components,
      stack_sha256: stack,
    },
    prompt,
    prompt_sha256: sha256(prompt),
  };
}
