// ADR-CHK-0006, Inspector Adversarial Acceptance IA-001 and IA-002: the
// committed test-tasks.json uses only the selector kinds the pinned trusted
// verifier admits, and the seven former class nodes carry exactly the
// change-taxonomy binding expansion of their class.
//
// - IA-001: every selector kind in the committed descriptor is in
//   descriptor.selector_kinds of law/policy/trusted-local-rc-verifier-package.json,
//   that set is the vendored verifier schema's kind enum, and the descriptor
//   check scripts/check-test-task-workspace-selectors.mjs, run in a temporary
//   repository, refuses a kind outside the set with
//   TEST_TASK_SELECTOR_KIND_UNADMITTED naming the node and the kind, in both
//   its --check and its writing mode, and leaves the descriptor bytes unchanged.
// - IA-002: each of plan:campaign, plan:scorecard-page, plan:validate,
//   docs:links, docs:governance, docs:ci-economy, and docs:validate carries the
//   binding entries of its class, as prefix and exact selectors in the binding's
//   order, in place of the class selector, followed by the node's other
//   selectors unchanged. A binding entry the node lacks, a selector the binding
//   does not derive, or a reordering each fail.
//
// Red until TASK-03113: the committed descriptor still holds seven `class`
// selectors (the live IA-001 and IA-002 cases), and the descriptor check does
// not read the declared set, so it accepts an unadmitted kind (the refusal
// cases). The drift cases over fixtures and the policy/schema agreement are
// green on the architect head.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve('.');
const DESCRIPTOR_PATH = 'test-tasks.json';
const VERIFIER_POLICY_PATH = 'law/policy/trusted-local-rc-verifier-package.json';
const BINDING_PATH = '.devai/config/change-taxonomy-binding.json';
const VENDORED_SCHEMA_PATH =
  'packages/cli/vendor/evidence-verification/schemas/task-descriptor.schema.json';
const DESCRIPTOR_CHECK = join(ROOT, 'scripts/check-test-task-workspace-selectors.mjs');
const UNADMITTED = 'TEST_TASK_SELECTOR_KIND_UNADMITTED';

type Selector = Readonly<{ kind: string; pattern: string }>;
type DescriptorNode = { nodeId: string; inputSelectors: Selector[] } & Record<string, unknown>;
type Descriptor = {
  dynamicFallbackSelectors: Selector[];
  tasks: DescriptorNode[];
} & Record<string, unknown>;
type Binding = Readonly<{ bindings: readonly Readonly<{ selector: Selector; class: string }>[] }>;

/**
 * The seven former class nodes: the class each selected, and the node's other
 * selectors, which follow the class selector and stay untouched.
 */
const FORMER_CLASS_NODES: Readonly<
  Record<string, Readonly<{ class: 'plan' | 'docs'; others: readonly Selector[] }>>
> = {
  'plan:campaign': {
    class: 'plan',
    others: [
      { kind: 'exact', pattern: 'scripts/check-campaign.mjs' },
      { kind: 'exact', pattern: 'law/schemas/campaign.schema.json' },
    ],
  },
  'plan:scorecard-page': {
    class: 'plan',
    others: [
      { kind: 'exact', pattern: 'scripts/generate-scorecard-page.mjs' },
      { kind: 'exact', pattern: 'docs/reference/scorecard.md' },
    ],
  },
  'plan:validate': { class: 'plan', others: [] },
  'docs:links': { class: 'docs', others: [] },
  'docs:governance': {
    class: 'docs',
    others: [{ kind: 'exact', pattern: '.devai/config/project.json' }],
  },
  'docs:ci-economy': { class: 'docs', others: [] },
  'docs:validate': { class: 'docs', others: [] },
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as T;
}

function committedDescriptor(): Descriptor {
  return readJson<Descriptor>(DESCRIPTOR_PATH);
}

function committedBinding(): Binding {
  return readJson<Binding>(BINDING_PATH);
}

function admittedKinds(): readonly string[] {
  return readJson<{ descriptor: { selector_kinds: readonly string[] } }>(VERIFIER_POLICY_PATH)
    .descriptor.selector_kinds;
}

/** The binding entries of one class, as selectors, in the binding's order. */
function expansion(binding: Binding, changeClass: string): readonly Selector[] {
  return binding.bindings
    .filter((entry) => entry.class === changeClass)
    .map((entry) => ({ kind: entry.selector.kind, pattern: entry.selector.pattern }));
}

function key(selector: Selector): string {
  return `${selector.kind}:${selector.pattern}`;
}

/**
 * Drift of one former class node against its binding expansion: the binding
 * entries the node lacks, the node selectors the binding (or the node's frozen
 * other selectors) does not derive, and whether the order differs.
 */
function expansionDrift(
  node: Readonly<{ inputSelectors: readonly Selector[] }>,
  binding: Binding,
  spec: Readonly<{ class: string; others: readonly Selector[] }>,
): Readonly<{ missing: readonly string[]; extra: readonly string[]; ordered: boolean }> {
  const expected = [...expansion(binding, spec.class), ...spec.others].map(key);
  const actual = node.inputSelectors.map(key);
  return {
    missing: expected.filter((entry) => !actual.includes(entry)),
    extra: actual.filter((entry) => !expected.includes(entry)),
    ordered: expected.length === actual.length && expected.every((entry, i) => entry === actual[i]),
  };
}

/** The descriptor with every class selector replaced in place by its binding expansion. */
function materialized(descriptor: Descriptor, binding: Binding): Descriptor {
  const expand = (selectors: readonly Selector[]): Selector[] =>
    selectors.flatMap((selector) =>
      selector.kind === 'class' ? expansion(binding, selector.pattern) : [selector],
    );
  return {
    ...descriptor,
    dynamicFallbackSelectors: expand(descriptor.dynamicFallbackSelectors),
    tasks: descriptor.tasks.map((task) => ({
      ...task,
      inputSelectors: expand(task.inputSelectors),
    })),
  };
}

function specOf(nodeId: string): Readonly<{ class: string; others: readonly Selector[] }> {
  const spec = FORMER_CLASS_NODES[nodeId];
  if (spec === undefined) throw new Error(`VERIFIER_COMPAT_TEST: no spec for ${nodeId}`);
  return spec;
}

function nodeOf(descriptor: Descriptor, nodeId: string): DescriptorNode {
  const node = descriptor.tasks.find((task) => task.nodeId === nodeId);
  if (node === undefined) throw new Error(`VERIFIER_COMPAT_TEST: unknown node ${nodeId}`);
  return node;
}

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, 'utf8');
}

/**
 * A temporary repository holding what the descriptor check reads: the root
 * manifest, every workspace manifest, the trusted-verifier policy, and the
 * fixture descriptor.
 */
function fixtureRepository(descriptor: Descriptor, policy?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-descriptor-kinds-'));
  roots.push(root);
  put(root, 'package.json', readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const entry of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let manifest: string;
    try {
      manifest = readFileSync(join(ROOT, 'packages', entry.name, 'package.json'), 'utf8');
    } catch {
      continue;
    }
    put(root, `packages/${entry.name}/package.json`, manifest);
  }
  put(
    root,
    VERIFIER_POLICY_PATH,
    policy === undefined
      ? readFileSync(join(ROOT, VERIFIER_POLICY_PATH), 'utf8')
      : `${JSON.stringify(policy, null, 2)}\n`,
  );
  put(root, DESCRIPTOR_PATH, `${JSON.stringify(descriptor, null, 2)}\n`);
  return root;
}

function runDescriptorCheck(root: string, mode: 'check' | 'write') {
  const result = spawnSync(
    process.execPath,
    [DESCRIPTOR_CHECK, ...(mode === 'check' ? ['--check'] : [])],
    { cwd: root, encoding: 'utf8' },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function withSelector(descriptor: Descriptor, nodeId: string, selector: Selector): Descriptor {
  return {
    ...descriptor,
    tasks: descriptor.tasks.map((task) =>
      task.nodeId === nodeId
        ? { ...task, inputSelectors: [...task.inputSelectors, selector] }
        : task,
    ),
  };
}

function expectRefused(
  root: string,
  mode: 'check' | 'write',
  nodeId: string,
  kind: string,
  before: string,
): void {
  const { status, output } = runDescriptorCheck(root, mode);
  expect(status, `${mode}: the descriptor check exits non-zero\n${output}`).not.toBe(0);
  const line = output.split('\n').find((entry) => entry.includes(UNADMITTED));
  expect(line, `${mode}: the check names ${UNADMITTED}\n${output}`).toBeDefined();
  expect(line, `${mode}: the refusal names the node`).toContain(nodeId);
  expect(line, `${mode}: the refusal names the kind`).toContain(kind);
  expect(
    readFileSync(join(root, DESCRIPTOR_PATH), 'utf8'),
    `${mode}: the check never rewrites the descriptor to pass`,
  ).toBe(before);
}

describe('committed descriptor selector kinds (ADR-CHK-0006 IA-001)', () => {
  it('declares the vendored verifier schema kind enum as the admitted set', () => {
    const schema = readJson<{
      $defs: { selector: { properties: { kind: { enum: string[] } } } };
      properties: {
        dynamicFallbackSelectors: { items: { $ref: string } };
        tasks: { items: { properties: { inputSelectors: { items: { $ref: string } } } } };
      };
    }>(VENDORED_SCHEMA_PATH);
    expect(schema.properties.dynamicFallbackSelectors.items.$ref).toBe('#/$defs/selector');
    expect(schema.properties.tasks.items.properties.inputSelectors.items.$ref).toBe(
      '#/$defs/selector',
    );
    expect([...admittedKinds()].sort()).toEqual(
      [...schema.$defs.selector.properties.kind.enum].sort(),
    );
  });

  it('uses only admitted kinds in every task and fallback selector', () => {
    const admitted = new Set(admittedKinds());
    const descriptor = committedDescriptor();
    const unadmitted = [
      ...descriptor.dynamicFallbackSelectors.map((selector) => `<fallback> ${selector.kind}`),
      ...descriptor.tasks.flatMap((task) =>
        task.inputSelectors.map((selector) => `${task.nodeId} ${selector.kind}`),
      ),
    ].filter((entry) => !admitted.has(entry.split(' ')[1] ?? ''));
    expect(unadmitted, 'selectors whose kind the pinned verifier does not admit').toEqual([]);
  });

  it('accepts a descriptor that uses only admitted kinds', () => {
    const descriptor = materialized(committedDescriptor(), committedBinding());
    const root = fixtureRepository(descriptor);
    const before = readFileSync(join(root, DESCRIPTOR_PATH), 'utf8');
    const { status, output } = runDescriptorCheck(root, 'check');
    expect(status, output).toBe(0);
    expect(output).not.toContain(UNADMITTED);
    expect(readFileSync(join(root, DESCRIPTOR_PATH), 'utf8')).toBe(before);
  });

  it.each([
    ['plan:validate', { kind: 'class', pattern: 'plan' }],
    ['docs:validate', { kind: 'regex', pattern: '^docs/.*$' }],
  ] as const)('refuses %s carrying the unadmitted kind %j', (nodeId, selector) => {
    const descriptor = withSelector(
      materialized(committedDescriptor(), committedBinding()),
      nodeId,
      selector,
    );
    for (const mode of ['check', 'write'] as const) {
      const root = fixtureRepository(descriptor);
      const before = readFileSync(join(root, DESCRIPTOR_PATH), 'utf8');
      expectRefused(root, mode, nodeId, selector.kind, before);
    }
  });

  it('reads the admitted set from the policy rather than a fixed list', () => {
    const policy = readJson<{ descriptor: { selector_kinds: string[] } }>(VERIFIER_POLICY_PATH);
    const narrowed = {
      ...policy,
      descriptor: {
        ...policy.descriptor,
        selector_kinds: policy.descriptor.selector_kinds.filter((kind) => kind !== 'glob'),
      },
    };
    const descriptor = materialized(committedDescriptor(), committedBinding());
    const globNode = descriptor.tasks.find((task) =>
      task.inputSelectors.some((selector) => selector.kind === 'glob'),
    );
    expect(globNode, 'the committed descriptor carries a glob selector').toBeDefined();
    const root = fixtureRepository(descriptor, narrowed);
    const before = readFileSync(join(root, DESCRIPTOR_PATH), 'utf8');
    expectRefused(root, 'check', globNode?.nodeId ?? '', 'glob', before);
  });
});

describe('former class nodes carry their binding expansion (ADR-CHK-0006 IA-002)', () => {
  it('expands plan to three selectors and docs to eight, forty-one across the seven nodes', () => {
    const binding = committedBinding();
    expect(expansion(binding, 'plan')).toEqual([
      { kind: 'prefix', pattern: 'product/' },
      { kind: 'prefix', pattern: 'record/' },
      { kind: 'prefix', pattern: 'work/' },
    ]);
    expect(expansion(binding, 'docs')).toEqual([
      { kind: 'prefix', pattern: 'docs/' },
      { kind: 'exact', pattern: 'README.md' },
      { kind: 'exact', pattern: 'CLAUDE.md' },
      { kind: 'exact', pattern: 'AGENTS.md' },
      { kind: 'exact', pattern: 'CHANGELOG.md' },
      { kind: 'exact', pattern: 'LICENSE' },
      { kind: 'exact', pattern: 'NOTICE' },
      { kind: 'exact', pattern: 'scratch/README.md' },
    ]);
    const total = Object.values(FORMER_CLASS_NODES).reduce(
      (sum, spec) => sum + expansion(binding, spec.class).length,
      0,
    );
    expect(total).toBe(41);
  });

  it.each(Object.keys(FORMER_CLASS_NODES))(
    '%s carries exactly its class expansion followed by its other selectors',
    (nodeId) => {
      const spec = specOf(nodeId);
      const node = nodeOf(committedDescriptor(), nodeId);
      expect(
        node.inputSelectors.filter((selector) => selector.kind === 'class'),
        `${nodeId} holds no class selector`,
      ).toEqual([]);
      expect(expansionDrift(node, committedBinding(), spec)).toEqual({
        missing: [],
        extra: [],
        ordered: true,
      });
    },
  );

  describe('drift in either direction fails', () => {
    const fixture = () => materialized(committedDescriptor(), committedBinding());

    it('accepts the exact materialization', () => {
      const descriptor = fixture();
      for (const [nodeId, spec] of Object.entries(FORMER_CLASS_NODES)) {
        expect(expansionDrift(nodeOf(descriptor, nodeId), committedBinding(), spec)).toEqual({
          missing: [],
          extra: [],
          ordered: true,
        });
      }
    });

    it('names a binding entry removed from docs:validate', () => {
      const node = nodeOf(fixture(), 'docs:validate');
      const trimmed = {
        inputSelectors: node.inputSelectors.filter((selector) => selector.pattern !== 'NOTICE'),
      };
      const drift = expansionDrift(trimmed, committedBinding(), specOf('docs:validate'));
      expect(drift.missing).toEqual(['exact:NOTICE']);
      expect(drift.ordered).toBe(false);
    });

    it('names a prefix added to plan:validate that the binding does not derive', () => {
      const node = nodeOf(fixture(), 'plan:validate');
      const widened = {
        inputSelectors: [...node.inputSelectors, { kind: 'prefix', pattern: 'packages/' }],
      };
      const drift = expansionDrift(widened, committedBinding(), specOf('plan:validate'));
      expect(drift.extra).toEqual(['prefix:packages/']);
      expect(drift.ordered).toBe(false);
    });

    it('names the missing expansion when the plan binding gains an entry', () => {
      const binding = committedBinding();
      const changed: Binding = {
        bindings: [
          ...binding.bindings,
          { selector: { kind: 'prefix', pattern: 'plans/' }, class: 'plan' },
        ],
      };
      const drift = expansionDrift(
        nodeOf(fixture(), 'plan:campaign'),
        changed,
        specOf('plan:campaign'),
      );
      expect(drift.missing).toEqual(['prefix:plans/']);
      expect(drift.ordered).toBe(false);
    });

    it('fails a reordered expansion', () => {
      const node = nodeOf(fixture(), 'docs:links');
      const reordered = { inputSelectors: [...node.inputSelectors].reverse() };
      const drift = expansionDrift(reordered, committedBinding(), specOf('docs:links'));
      expect(drift).toMatchObject({ missing: [], extra: [], ordered: false });
    });

    it('fails an untouched class selector left beside its expansion', () => {
      const node = nodeOf(fixture(), 'plan:validate');
      const doubled = {
        inputSelectors: [{ kind: 'class', pattern: 'plan' }, ...node.inputSelectors],
      };
      const drift = expansionDrift(doubled, committedBinding(), specOf('plan:validate'));
      expect(drift.extra).toEqual(['class:plan']);
    });
  });
});
