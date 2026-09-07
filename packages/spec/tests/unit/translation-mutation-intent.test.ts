import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { recordMutationCandidate } from '../../src/translation-validation/index.js';

type RecordValue = Record<string, unknown>;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function example(name: string): RecordValue {
  const schema = JSON.parse(
    readFileSync(join(process.cwd(), 'law/schemas', `${name}.schema.json`), 'utf8'),
  ) as { examples: RecordValue[] };
  if (!schema.examples[0]) throw new Error('missing schema fixture');
  return structuredClone(schema.examples[0]);
}
function put(root: string, path: string, value: unknown) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(value));
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai-mutation-intent-'));
  roots.push(root);
  const task = example('task');
  const invariant = example('invariant');
  const witness = example('translation-witness');
  const intent = example('mutation-intent');
  intent['task_id'] = task['id'];
  intent['strategy'] = 'regression';
  intent['red_green'] = witness['red_green'];
  const implementsEntries = structuredClone(witness['implements']) as RecordValue[];
  const firstEntry = implementsEntries[0];
  if (!firstEntry) throw new Error('schema fixture has no implementation claim');
  firstEntry['invariant_id'] = invariant['id'];
  intent['implements'] = implementsEntries;
  task['intent_diff'] = { planned_files: intent['declared_touched'] };
  expect(validators.task(task), JSON.stringify(validators.task.errors)).toBe(true);
  expect(validators.invariant(invariant), JSON.stringify(validators.invariant.errors)).toBe(true);
  expect(validators.mutationIntent(intent), JSON.stringify(validators.mutationIntent.errors)).toBe(
    true,
  );
  return { root, task, invariant, intent };
}
async function attempt(
  f: ReturnType<typeof fixture>,
  expected: string,
  task: RecordValue | null = f.task,
  invariant: RecordValue | null = f.invariant,
) {
  if (task !== null) put(f.root, `.devai/state/tasks/${String(f.intent['task_id'])}.json`, task);
  if (invariant !== null)
    put(f.root, `law/invariants/${String(f.invariant['id'])}.json`, invariant);
  const run = vi.fn(async () => undefined);
  await expect(
    withAuthorityHostTestScope(() =>
      recordMutationCandidate({
        repo_root: f.root,
        intent: f.intent,
        emitted_at: '2026-09-07T00:00:00.000Z',
        run,
      }),
    ),
  ).rejects.toThrow(expected);
  expect(run).not.toHaveBeenCalled();
}

it('accepts schema-valid linked intent before requiring a real Git candidate', async () => {
  // No Git repository exists: reaching this exact refusal proves linked schema,
  // scope, strategy and effect checks completed, without executing a mutation.
  await attempt(fixture(), 'MUTATION_HEAD_INVALID');
});

it.each([
  ['id', 'TASK-7002', 'MUTATION_TASK_AUTHORITY_MISMATCH'],
  ['discipline', 'architect', 'MUTATION_TASK_AUTHORITY_MISMATCH'],
  ['intent_diff', { planned_files: [] }, 'MUTATION_TASK_SCOPE_MISMATCH'],
  [
    'intent_diff',
    { planned_files: ['packages/other/src/example.ts'] },
    'MUTATION_TASK_SCOPE_MISMATCH',
  ],
] as const)(
  'refuses mismatched task %s before invoking the recipe',
  async (field, value, reason) => {
    const f = fixture();
    const task = { ...f.task, [field]: value };
    expect(validators.task(task)).toBe(true);
    await attempt(f, reason, task);
  },
);

it('refuses a malformed task before invoking the recipe', async () => {
  await attempt(fixture(), 'MUTATION_TASK_INVALID', {});
});
it('refuses a malformed invariant before invoking the recipe', async () => {
  const f = fixture();
  await attempt(f, 'MUTATION_INVARIANT_INVALID', f.task, {});
});

it.each([
  ['id', 'INV-AUTH-002'],
  ['status', 'draft'],
  ['lifecycle', 'experimental'],
] as const)('requires the active supported invariant identity: %s', async (field, value) => {
  const f = fixture();
  const invariant = { ...f.invariant, [field]: value };
  expect(validators.invariant(invariant)).toBe(true);
  await attempt(f, 'MUTATION_STRATEGY_MISMATCH', f.task, invariant);
});

it('does not accept an intent that permits a different effect than its declared path', async () => {
  const f = fixture();
  f.intent['effects_permitted'] = ['fs:architect-spec'];
  expect(validators.mutationIntent(f.intent)).toBe(true);
  await attempt(f, 'MUTATION_EFFECT_MISMATCH');
});

it('does not let an engineer declare an Architect-owned path even when the task names it', async () => {
  const f = fixture();
  f.intent['declared_touched'] = ['law/invariants/INV-AUTH-001.json'];
  f.intent['effects_permitted'] = ['fs:architect-spec'];
  f.task['intent_diff'] = { planned_files: f.intent['declared_touched'] };
  expect(validators.mutationIntent(f.intent)).toBe(true);
  expect(validators.task(f.task)).toBe(true);
  await attempt(f, 'MUTATION_AUTHORITY_MISMATCH');
});

it('requires the referenced task file', async () => {
  await attempt(fixture(), 'MUTATION_TASK_MISSING', null);
});
it('requires the referenced invariant file', async () => {
  const f = fixture();
  await attempt(f, 'MUTATION_INVARIANT_MISSING', f.task, null);
});
it('rejects malformed intent before inspecting or running the task', async () => {
  const f = fixture();
  f.intent['trust'] = 'trusted';
  await attempt(f, 'MUTATION_INTENT_INVALID');
});
it('requires the declared strategy to match the active invariant strategy', async () => {
  const f = fixture();
  const verification = f.invariant['verification'] as RecordValue;
  const strategy = verification['strategy'] as RecordValue;
  const invariant = {
    ...f.invariant,
    verification: { ...verification, strategy: { ...strategy, primary: 'structural' } },
  };
  expect(validators.invariant(invariant)).toBe(true);
  await attempt(f, 'MUTATION_STRATEGY_MISMATCH', f.task, invariant);
});
it('rejects a schema-valid demonstration of the wrong strategy kind', async () => {
  const f = fixture();
  f.intent['implements'] = [
    {
      invariant_id: f.invariant['id'],
      criteria: [
        {
          claim: 'A semantic review cannot stand in for regression tests.',
          demonstrated_by: [{ kind: 'semantic-review', rubric_ref: 'docs/review.md' }],
        },
      ],
    },
  ];
  expect(validators.mutationIntent(f.intent)).toBe(true);
  await attempt(f, 'MUTATION_DEMONSTRATION_MISMATCH');
});
