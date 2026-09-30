// ADR-CHK-0003, Inspector Adversarial Acceptance IA-001, IA-002, and IA-005
// (plan side), and ADR-CHK-0006 IA-003: the check runner selects the planning
// lane from the change taxonomy, never from a workflow path filter, and never
// from a class selector in the descriptor.
//
// Each case builds a fixture repository that carries the framework's own
// taxonomy files, commits a candidate diff, and plans the repository's real
// test-tasks.json with the affected target through buildTaskPlan. The planned
// descriptor holds no class selector: any class selector the committed
// descriptor still carries is replaced in place by its change-taxonomy binding
// expansion, which is the committed shape ADR-CHK-0006 requires.
//
// - A diff whose paths all classify as plan (product/, record/, work/) plans
//   exactly the planning lane: the preflight nodes, plan:validate with its
//   campaign and scorecard-page members, format, and the schema members, and
//   no node that is or depends on generate or build.
// - A diff that also touches a path of another class, or that renames or
//   deletes a plan-class path, plans the affected profile, whatever the
//   candidate does to the workflow path filter or to the taxonomy binding.
//
// Red until TASK-03113: policy-descriptor.ts loads the taxonomy classifier only
// when the descriptor holds a class selector, so a descriptor without one never
// selects the planning lane (the three planning-lane cases), and the committed
// plan:validate still selects by class.
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTaskPlan, parseTaskDescriptor } from '../../src/services/check-runner/policy.js';
import type { TaskDescriptor } from '../../src/services/check-runner/types.js';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../../..');
const COPIED_FILES = [
  'law/policy/change-taxonomy.json',
  'law/policy/adopter-defaults/change-taxonomy-binding.json',
  '.devai/config/change-taxonomy.json',
  '.devai/config/change-taxonomy-binding.json',
  '.github/workflows/pull-request-checks.yml',
] as const;
const BINDING_PATH = '.devai/config/change-taxonomy-binding.json';
const WORKFLOW_PATH = '.github/workflows/pull-request-checks.yml';
const LEDGER_PATH = 'product/campaigns/CMP-9999-fixture/campaign.json';
const PROMPT_PATH = 'product/campaigns/CMP-9999-fixture/prompts/TASK-9991.md';
const SCORECARD_PATH = 'record/proofs/compliance/scorecards/SC-99990101T000000-001.json';
const ROUND_PATH = 'work/rounds/R-9999/round.json';
const PACKAGE_SOURCE_PATH = 'packages/cli/src/services/fixture.ts';
const EXCLUDED_NODES = ['generate', 'build'] as const;
const PREFLIGHT_RUNNER = 'preflight-v1';

type Selector = Readonly<{ kind: string; pattern: string }>;
type Binding = Readonly<{ bindings: readonly Readonly<{ selector: Selector; class: string }>[] }>;

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function readRepositoryJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(REPOSITORY_ROOT, path), 'utf8')) as T;
}

/** The binding entries of one class, as selectors, in the binding's order. */
function classExpansion(changeClass: string): readonly Selector[] {
  return readRepositoryJson<Binding>(BINDING_PATH)
    .bindings.filter((entry) => entry.class === changeClass)
    .map((entry) => ({ kind: entry.selector.kind, pattern: entry.selector.pattern }));
}

type RawDescriptor = Readonly<{
  dynamicFallbackSelectors: readonly Selector[];
  tasks: readonly Readonly<{ nodeId: string; inputSelectors: readonly Selector[] }>[];
}>;

function withoutClassSelectors(raw: RawDescriptor): RawDescriptor {
  const expand = (selectors: readonly Selector[]): readonly Selector[] =>
    selectors.flatMap((selector) =>
      selector.kind === 'class' ? classExpansion(selector.pattern) : [selector],
    );
  return {
    ...raw,
    dynamicFallbackSelectors: expand(raw.dynamicFallbackSelectors),
    tasks: raw.tasks.map((task) => ({ ...task, inputSelectors: expand(task.inputSelectors) })),
  };
}

function classSelectorsOf(raw: RawDescriptor): readonly string[] {
  return [...raw.dynamicFallbackSelectors, ...raw.tasks.flatMap((task) => task.inputSelectors)]
    .filter((selector) => selector.kind === 'class')
    .map((selector) => selector.pattern);
}

let plannedDescriptor: TaskDescriptor | undefined;
/** The committed descriptor with no class selector (ADR-CHK-0006). */
function descriptor(): TaskDescriptor {
  plannedDescriptor ??= parseTaskDescriptor(
    withoutClassSelectors(readRepositoryJson<RawDescriptor>('test-tasks.json')),
  );
  return plannedDescriptor;
}

let invocationOrdinal = 0;
function withRunnerScope<T>(callback: () => T): T {
  invocationOrdinal += 1;
  const invocationId = `check-runner-planning-lane-test-${String(invocationOrdinal)}`;
  let receiptOrdinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'check-runner-planning-lane-test',
    issuer_version: '1.0.0',
    invocation_id: invocationId,
    canonicalSha256: () => 'c'.repeat(64),
    randomId: () => `${invocationId}-${String(++receiptOrdinal)}`,
    now: () => '2026-09-28T00:00:00.000Z',
    receipt_ttl_ms: 30_000,
  });
  const scope: AuthorityHostEffectScope = {
    action_id: 'check',
    invocation_id: invocationId,
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
  };
  try {
    return runWithAuthorityHostEffects(scope, callback);
  } finally {
    issuer.dispose();
  }
}

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, 'utf8');
}

function initRepo(): Readonly<{ root: string; base: string }> {
  const root = mkdtempSync(join(tmpdir(), 'devai-planning-lane-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  for (const path of COPIED_FILES) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(REPOSITORY_ROOT, path), join(root, path));
  }
  put(root, '.gitignore', '.devai/state/\n');
  put(root, LEDGER_PATH, '{"id":"CMP-9999"}\n');
  put(root, PROMPT_PATH, '# TASK-9991\n');
  put(root, SCORECARD_PATH, '{"id":"SC-99990101T000000-001"}\n');
  put(root, ROUND_PATH, '{"id":"R-9999"}\n');
  put(root, PACKAGE_SOURCE_PATH, 'export const value = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  return { root, base: git(root, ['rev-parse', 'HEAD']) };
}

function commit(root: string, edits: Readonly<Record<string, string | null>>): void {
  for (const [path, content] of Object.entries(edits)) {
    if (content === null) unlinkSync(join(root, path));
    else put(root, path, content);
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'candidate']);
}

function plannedNodes(root: string, base: string): readonly string[] {
  const tasks = descriptor().tasks;
  const toolchain = Object.fromEntries(
    [...new Set(tasks.flatMap((task) => task.toolchainKeys))].map((key) => [key, 'v-test']),
  );
  const plan = withRunnerScope(() =>
    buildTaskPlan({
      repoRoot: root,
      descriptor: descriptor(),
      target: 'affected',
      baseCommit: base,
      toolchain,
      environment: {},
      resolveExecutable: () => ({ path: process.execPath, sha256: 'a'.repeat(64) }),
      cacheState: () => ({ cacheState: 'execute' as const, reason: 'fixture' }),
    }),
  );
  return plan.tasks.map((task) => task.nodeId);
}

function taskById(nodeId: string) {
  const task = descriptor().tasks.find((entry) => entry.nodeId === nodeId);
  if (task === undefined) throw new Error(`PLANNING_LANE_TEST: unknown node ${nodeId}`);
  return task;
}

function argvText(nodeId: string): string {
  return taskById(nodeId).argv.join(' ');
}

const RUNS_CAMPAIGN_CHECK = /scripts\/check-campaign\.mjs/u;
const RUNS_SCORECARD_PAGE_CHECK =
  /scripts\/generate-scorecard-page\.mjs\b.*--check|scorecard-page:check/u;

/**
 * A node the planning lane admits: a preflight node, plan:validate or one of
 * its members (journeys, the campaign check, the scorecard-page check), format,
 * or a schema member. Anything else is outside the lane.
 */
function isPlanningLaneNode(nodeId: string): boolean {
  const task = taskById(nodeId);
  const text = argvText(nodeId);
  return (
    task.runner === PREFLIGHT_RUNNER ||
    nodeId === 'plan:validate' ||
    nodeId === 'format' ||
    RUNS_CAMPAIGN_CHECK.test(text) ||
    RUNS_SCORECARD_PAGE_CHECK.test(text) ||
    /--only\s+journeys\b/u.test(text) ||
    /schema/u.test(nodeId) ||
    /--only\s+schemas\b/u.test(text)
  );
}

/** Every node the selected node transitively depends on, itself included. */
function closure(nodeId: string): ReadonlySet<string> {
  const seen = new Set<string>();
  const pending = [nodeId];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    pending.push(...taskById(next).dependencies);
  }
  return seen;
}

function expectPlanningLane(nodes: readonly string[], label: string): void {
  const outside = nodes.filter((nodeId) => !isPlanningLaneNode(nodeId));
  expect(outside, `${label}: planned nodes outside the planning lane`).toEqual([]);
  for (const excluded of EXCLUDED_NODES) {
    expect(nodes, `${label}: the planning lane plans no ${excluded} node`).not.toContain(excluded);
  }
  const dependingOnBuild = nodes.filter((nodeId) =>
    EXCLUDED_NODES.some((excluded) => nodeId !== excluded && closure(nodeId).has(excluded)),
  );
  expect(dependingOnBuild, `${label}: planned nodes depending on generate or build`).toEqual([]);
  expect(nodes, `${label}: plan:validate is planned`).toContain('plan:validate');
  expect(nodes, `${label}: format is planned`).toContain('format');
  for (const task of descriptor().tasks.filter((entry) => entry.runner === PREFLIGHT_RUNNER)) {
    expect(nodes, `${label}: preflight node ${task.nodeId} is planned`).toContain(task.nodeId);
  }
  expect(
    nodes.filter((nodeId) => RUNS_CAMPAIGN_CHECK.test(argvText(nodeId))),
    `${label}: a planned node runs scripts/check-campaign.mjs`,
  ).not.toEqual([]);
  expect(
    nodes.filter((nodeId) => RUNS_SCORECARD_PAGE_CHECK.test(argvText(nodeId))),
    `${label}: a planned node runs scripts/generate-scorecard-page.mjs --check`,
  ).not.toEqual([]);
}

function expectAffectedProfile(nodes: readonly string[], label: string): void {
  const profile = descriptor().profiles.find((entry) => entry.profileId === 'affected');
  expect(profile, 'test-tasks.json declares the affected profile').toBeDefined();
  for (const nodeId of profile?.requiredNodes ?? []) {
    expect(nodes, `${label}: the affected profile plans ${nodeId}`).toContain(nodeId);
  }
  expect(nodes, `${label}: the affected profile plans build`).toContain('build');
}

describe('check-runner planning lane (ADR-CHK-0003)', () => {
  it('plans a descriptor that holds no class selector (ADR-CHK-0006 IA-003)', () => {
    expect(classSelectorsOf(descriptor() as unknown as RawDescriptor)).toEqual([]);
  });

  it('binds committed plan:validate to the plan expansion, not a class selector', () => {
    const committed = readRepositoryJson<RawDescriptor>('test-tasks.json');
    const planValidate = committed.tasks.find((task) => task.nodeId === 'plan:validate');
    expect(planValidate?.inputSelectors).toEqual(classExpansion('plan'));
  });

  it('plans exactly the planning lane for a diff of one prompt and the ledger (IA-001)', () => {
    const { root, base } = initRepo();
    commit(root, {
      [PROMPT_PATH]: '# TASK-9991\n\nRole: Inspector.\n',
      [LEDGER_PATH]: '{"id":"CMP-9999","status":"active"}\n',
    });
    expectPlanningLane(plannedNodes(root, base), 'prompt and ledger');
  });

  it('plans the planning lane, without generate or build, for a scorecard record (IA-005)', () => {
    const { root, base } = initRepo();
    commit(root, { [SCORECARD_PATH]: '{"id":"SC-99990101T000000-001","stale":true}\n' });
    expectPlanningLane(plannedNodes(root, base), 'scorecard record');
  });

  it('plans the planning lane for a work/ path, which the plan class now binds', () => {
    const { root, base } = initRepo();
    commit(root, { [ROUND_PATH]: '{"id":"R-9999","status":"open"}\n' });
    expectPlanningLane(plannedNodes(root, base), 'work/ round');
  });

  it('plans the affected profile for a prompt plus a package source (IA-002)', () => {
    const { root, base } = initRepo();
    commit(root, {
      [PROMPT_PATH]: '# TASK-9991\n\nchanged\n',
      [PACKAGE_SOURCE_PATH]: 'export const value = 2;\n',
    });
    expectAffectedProfile(plannedNodes(root, base), 'prompt and package source');
  });

  it('plans the affected profile for a renamed plan-class path (IA-002)', () => {
    const { root, base } = initRepo();
    git(root, ['mv', PROMPT_PATH, 'product/campaigns/CMP-9999-fixture/prompts/TASK-9992.md']);
    git(root, ['commit', '-qm', 'rename prompt']);
    expectAffectedProfile(plannedNodes(root, base), 'renamed prompt');
  });

  it('plans the affected profile for a deleted plan-class path (IA-002)', () => {
    const { root, base } = initRepo();
    commit(root, { [PROMPT_PATH]: null });
    expectAffectedProfile(plannedNodes(root, base), 'deleted prompt');
  });

  it('ignores a workflow path filter the candidate adds beside a prompt (IA-002)', () => {
    const { root, base } = initRepo();
    const workflow = readFileSync(join(root, WORKFLOW_PATH), 'utf8').replace(
      /^ {4}types: \[[^\]]*\]$/mu,
      (line) => `${line}\n    paths-ignore: ['packages/**', '.github/**']`,
    );
    expect(workflow, 'the fixture edits the path filter').toContain('paths-ignore');
    commit(root, {
      [PROMPT_PATH]: '# TASK-9991\n\nchanged\n',
      [WORKFLOW_PATH]: workflow,
    });
    expectAffectedProfile(plannedNodes(root, base), 'prompt and workflow path filter');
  });

  it('ignores a candidate that rebinds package sources to the plan class', () => {
    const { root, base } = initRepo();
    const binding = JSON.parse(readFileSync(join(root, BINDING_PATH), 'utf8')) as {
      bindings: { selector: { kind: string; pattern: string }; class: string }[];
    };
    for (const entry of binding.bindings) {
      if (entry.selector.pattern.startsWith('packages/')) entry.class = 'plan';
    }
    commit(root, {
      [BINDING_PATH]: `${JSON.stringify(binding, null, 2)}\n`,
      [PACKAGE_SOURCE_PATH]: 'export const value = 3;\n',
    });
    expectAffectedProfile(plannedNodes(root, base), 'rebound taxonomy and package source');
  });
});
