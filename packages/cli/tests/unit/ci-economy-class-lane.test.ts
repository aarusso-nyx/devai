// ADR-CHK-0003, second Inspector iteration of TASK-0312: the advisory
// ci-economy.path-filters rule is not raised for a pull-request workflow whose
// lane is selected from the change taxonomy, because test-tasks.json carries
// `kind: class` selectors. A path filter there would duplicate the lane
// selection and let a candidate edit the filter to suppress checks (IA-002),
// so the advisory would only make every pull request that runs ci-economy
// exit on a warning. Without class selectors the advisory stands.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/commands/check/ci-local-only.js', () => ({
  inspectRemoteLocalOnlyNodes: () => ({
    enabled: false,
    errors: [],
    violations: [],
    forbiddenScripts: [],
  }),
}));

import { checkCiEconomy } from '../../src/commands/check/ci-economy.js';

const PATH_FILTERS = 'ci-economy.path-filters';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-ci-economy-class-lane-'));
  roots.push(root);
  return root;
}

function workflow(root: string, name: string, text: string): void {
  const directory = join(root, '.github/workflows');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), text);
}

function descriptor(
  root: string,
  selectors: readonly Readonly<{ kind: string; pattern: string }>[],
): void {
  writeFileSync(
    join(root, 'test-tasks.json'),
    `${JSON.stringify(
      {
        schemaVersion: '1.0.0',
        fallbackNodeId: 'test:local-full',
        dynamicFallbackSelectors: [],
        tasks: [
          {
            nodeId: 'docs:validate',
            dependencies: [],
            argv: ['node', 'bin.js', 'check', '--only', 'docs-governance'],
            cwd: '.',
            runner: 'pnpm-script-v1',
            inputSelectors: selectors,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function pullRequestWorkflow(trigger: 'pull_request' | 'pull_request_target'): string {
  return `name: pull request checks
on:
  ${trigger}:
    types: [opened, synchronize, reopened]
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: node .devai/state/pr-bootstrap/cli/bin.js check --affected --run
`;
}

const BRANCH_PUSH_WORKFLOW = `name: main verification
on:
  push:
    branches: [main]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test
`;

const CLASS_SELECTORS = [
  { kind: 'class', pattern: 'docs' },
  { kind: 'prefix', pattern: 'docs/' },
] as const;

function pathFilters(root: string) {
  return checkCiEconomy({ repoRoot: root }).findings.find((entry) => entry.ruleId === PATH_FILTERS);
}

describe('ci-economy.path-filters on a class-selected pull-request lane (ADR-CHK-0003)', () => {
  it.each(['pull_request', 'pull_request_target'] as const)(
    'is not raised for an unfiltered %s workflow when test-tasks.json carries class selectors',
    (trigger) => {
      const root = temporary();
      workflow(root, 'pull-request-checks.yml', pullRequestWorkflow(trigger));
      descriptor(root, CLASS_SELECTORS);
      expect(pathFilters(root), 'no path-filters advisory for a taxonomy-selected lane').toBe(
        undefined,
      );
    },
  );

  it('still raises the advisory for the same workflow without a test-tasks.json', () => {
    const root = temporary();
    workflow(root, 'pull-request-checks.yml', pullRequestWorkflow('pull_request'));
    expect(pathFilters(root)).toMatchObject({
      severity: 'warn',
      locations: ['pull-request-checks.yml'],
    });
  });

  it('still raises the advisory when test-tasks.json declares no class selector', () => {
    const root = temporary();
    workflow(root, 'pull-request-checks.yml', pullRequestWorkflow('pull_request'));
    descriptor(root, [
      { kind: 'prefix', pattern: 'docs/' },
      { kind: 'glob', pattern: 'packages/*/src/**' },
    ]);
    expect(pathFilters(root)).toMatchObject({
      severity: 'warn',
      locations: ['pull-request-checks.yml'],
    });
  });

  it('still raises the advisory when test-tasks.json cannot be read as a descriptor', () => {
    const root = temporary();
    workflow(root, 'pull-request-checks.yml', pullRequestWorkflow('pull_request'));
    writeFileSync(join(root, 'test-tasks.json'), '{ "tasks": [ { "inputSelectors": [ {');
    expect(pathFilters(root)).toMatchObject({
      severity: 'warn',
      locations: ['pull-request-checks.yml'],
    });
  });

  it('keeps the advisory for an unfiltered branch-push workflow beside a class-selected lane', () => {
    const root = temporary();
    workflow(root, 'pull-request-checks.yml', pullRequestWorkflow('pull_request'));
    workflow(root, 'main-verification.yml', BRANCH_PUSH_WORKFLOW);
    descriptor(root, CLASS_SELECTORS);
    expect(pathFilters(root)).toMatchObject({
      severity: 'warn',
      locations: ['main-verification.yml'],
    });
  });
});
