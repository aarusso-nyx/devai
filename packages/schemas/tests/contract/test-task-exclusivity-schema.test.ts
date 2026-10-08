// ADR-CHK-0007 rule 5: parallel scheduling declarations live in test-task-exclusivity.json,
// validated by a closed schema, and never in test-tasks.json. The descriptor schema is closed
// too, so a misspelled property or an exclusivity block placed in the descriptor (which the
// package-owned evidence verifier would refuse under ADR-CHK-0006) fails validation instead of
// being silently ignored.
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getValidator, ROSTER } from '../../src/index.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as Record<string, unknown>;
}

const validateExclusivity = getValidator('test-task-exclusivity.schema.json');
const admitsExclusivity = (value: unknown): boolean => validateExclusivity(value) === true;
const declaring = (nodes: Record<string, unknown>) => ({ schemaVersion: '1.0.0', nodes });

// The descriptor schema is source-only (not in the runtime roster), so it is compiled from law.
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(readJson('law/schemas/preflight-probe.schema.json'));
const validateDescriptor = ajv.compile(readJson('law/schemas/test-task-descriptor.schema.json'));
const admitsDescriptor = (value: unknown): boolean => validateDescriptor(value) === true;

const COMMITTED_DESCRIPTORS = [
  'test-tasks.json',
  'tests/fixtures/export-intent/test-tasks.json',
  'packages/cli/tests/fixtures/mutation-toolchain/test-tasks.json',
] as const;

/** The repository descriptor with its first task replaced by `edit(first)`. */
function withFirstTask(
  edit: (task: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const document = readJson('test-tasks.json');
  const [first, ...rest] = document['tasks'] as Record<string, unknown>[];
  if (first === undefined) throw new Error('fixture: test-tasks.json declares no task');
  return { ...document, tasks: [edit(first), ...rest] };
}

describe('test-task-exclusivity.schema.json', () => {
  it('is a versioned runtime roster schema whose own examples validate', () => {
    expect(ROSTER).toContain('test-task-exclusivity.schema.json');
    const schema = readJson('law/schemas/test-task-exclusivity.schema.json');
    expect(schema['schema_version']).toBe('1.0.0');
    const examples = schema['examples'] as unknown[];
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(admitsExclusivity(example), JSON.stringify(validateExclusivity.errors)).toBe(true);
    }
  });

  it.each([
    ['an empty node map', declaring({})],
    ['an empty declaration', declaring({ marker: {} })],
    ['empty key lists', declaring({ marker: { exclusive: [], shared: [] } })],
    [
      'a writer and a reader',
      declaring({ build: { exclusive: ['dist'] }, test: { shared: ['dist'] } }),
    ],
    ['both lists on one node', declaring({ build: { exclusive: ['dist'], shared: ['sources'] } })],
  ])('admits %s', (_label, document) => {
    expect(admitsExclusivity(document), JSON.stringify(validateExclusivity.errors)).toBe(true);
  });

  it.each([
    ['a missing nodes map', { schemaVersion: '1.0.0' }],
    ['a missing schemaVersion', { nodes: {} }],
    ['another schemaVersion', { schemaVersion: '1.1.0', nodes: {} }],
    ['nodes as an array', { schemaVersion: '1.0.0', nodes: [] }],
    ['a declaration that is not an object', declaring({ build: ['dist'] })],
    ['a null declaration', declaring({ build: null })],
  ])('refuses %s', (_label, document) => {
    expect(admitsExclusivity(document)).toBe(false);
  });

  it.each([
    ['a misspelled top-level nodes', { schemaVersion: '1.0.0', node: {} }],
    ['an extra top-level property beside nodes', { schemaVersion: '1.0.0', nodes: {}, workers: 4 }],
    ['a misspelled exclusive', declaring({ build: { exlusive: ['dist'] } })],
    ['a misspelled shared', declaring({ build: { shard: ['dist'] } })],
    [
      'a misspelled list beside the correct one',
      declaring({ build: { exclusive: ['dist'], exclusives: ['sources'] } }),
    ],
    [
      'a scheduling field other than the two lists',
      declaring({ build: { exclusive: ['dist'], priority: 1 } }),
    ],
  ])('refuses %s: the file and every declaration are closed objects', (_label, document) => {
    expect(admitsExclusivity(document)).toBe(false);
  });

  it.each([
    ['uppercase', 'Dist'],
    ['a colon', 'db:main'],
    ['a slash', 'packages/cli'],
    ['a space', 'two words'],
    ['a leading dot', '.dist'],
    ['a leading dash', '-dist'],
    ['a leading underscore', '_dist'],
    ['the empty string', ''],
  ])('refuses a key with %s in either list', (_label, key) => {
    expect(admitsExclusivity(declaring({ build: { exclusive: [key] } }))).toBe(false);
    expect(admitsExclusivity(declaring({ build: { shared: [key] } }))).toBe(false);
  });

  it.each(['dist', 'db', 'sources', '0cache', 'scratch.typecheck', 'out_dir', 'a-b', 'v1.2-x_y'])(
    'admits the key %s under ^[a-z0-9][a-z0-9._-]*$',
    (key) => {
      expect(admitsExclusivity(declaring({ build: { exclusive: [key], shared: [key] } }))).toBe(
        true,
      );
    },
  );

  it('refuses a key that is not a string, a list that is not an array, and a repeated key', () => {
    expect(admitsExclusivity(declaring({ build: { exclusive: [1] } }))).toBe(false);
    expect(admitsExclusivity(declaring({ build: { exclusive: 'dist' } }))).toBe(false);
    expect(admitsExclusivity(declaring({ build: { shared: ['dist', 'dist'] } }))).toBe(false);
    expect(admitsExclusivity(declaring({ build: { exclusive: ['dist', 'dist'] } }))).toBe(false);
  });

  it('refuses an empty node id, but leaves unknown-node refusal to the runner', () => {
    expect(admitsExclusivity(declaring({ '': {} }))).toBe(false);
    // The schema cannot see the descriptor: a node id the descriptor does not declare is
    // schema-valid here and is refused by the runner before any node starts (ADR-CHK-0007
    // rule 5, IA-008), so the schema must not be read as that check.
    expect(admitsExclusivity(declaring({ 'no-such-node': { exclusive: ['dist'] } }))).toBe(true);
  });
});

describe('test-task-descriptor.schema.json is closed', () => {
  it.each(COMMITTED_DESCRIPTORS)('still admits the committed descriptor %s', (path) => {
    expect(admitsDescriptor(readJson(path)), JSON.stringify(validateDescriptor.errors)).toBe(true);
  });

  it.each([
    ['dependencies', 'dependancies'],
    ['allowlistedEnv', 'allowListedEnv'],
    ['inputSelectors', 'inputSelector'],
    ['outputContract', 'outputContracts'],
  ])('refuses a task carrying %s and a misspelled copy %s', (correct, misspelled) => {
    // The correct property stays present, so only the closed-object rule can refuse.
    const unchanged = withFirstTask((task) => task);
    const doubled = withFirstTask((task) => {
      expect(task).toHaveProperty(correct);
      return { ...task, [misspelled]: task[correct] };
    });
    expect(admitsDescriptor(unchanged), JSON.stringify(validateDescriptor.errors)).toBe(true);
    expect(admitsDescriptor(doubled)).toBe(false);
  });

  it('refuses a misspelled top-level property beside the correct one', () => {
    const document = readJson('test-tasks.json');
    expect(admitsDescriptor({ ...document, fallbackNodeID: document['fallbackNodeId'] })).toBe(
      false,
    );
  });

  it.each([
    ['an exclusivity block', { exclusivity: { exclusive: ['sources'], shared: ['dist'] } }],
    ['an exclusive list', { exclusive: ['sources'] }],
    ['a shared list', { shared: ['dist'] }],
    ['the superseded exclusivityKeys field', { exclusivityKeys: ['sources'] }],
  ])('refuses %s placed on a task instead of in test-task-exclusivity.json', (_label, extra) => {
    expect(admitsDescriptor(withFirstTask((task) => ({ ...task, ...extra })))).toBe(false);
  });

  it('refuses a whole exclusivity document embedded at the top level', () => {
    const document = readJson('test-tasks.json');
    const embedded = { ...document, exclusivity: declaring({ build: { exclusive: ['dist'] } }) };
    expect(admitsDescriptor(embedded)).toBe(false);
  });
});
