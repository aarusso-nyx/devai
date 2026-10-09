// ADR-CHK-0003, second Inspector iteration of TASK-0312: the advisory
// ci-economy.path-filters rule is not raised for a pull-request workflow whose
// lane is selected from the change taxonomy, because test-tasks.json carries
// `kind: class` selectors. A path filter there would duplicate the lane
// selection and let a candidate edit the filter to suppress checks (IA-002),
// so the advisory would only make every pull request that runs ci-economy
// exit on a warning. Without class selectors the advisory stands.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
const CONCURRENCY_CANCEL = 'ci-economy.concurrency-cancel';
const ROOT = resolve(import.meta.dirname, '../../../..');
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
      # The lane checks out the candidate, so it consumes repository content and the
      # checkout-free exemption (ADR-CHK-0008 amendment) never applies to it.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
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
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
      - run: pnpm test
`;

/**
 * A branch-push workflow that checks out no source and only calls the GitHub API, like the
 * update-branch rebase (ADR-CHK-0008): a path filter could only make it skip updates.
 */
const API_ONLY_PUSH_WORKFLOW = `name: update pull request branches
on:
  push:
    branches: [main]
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - run: echo present=true >> "$GITHUB_OUTPUT"
  update-branches:
    runs-on: ubuntu-latest
    needs: probe
    steps:
      - uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1
        with:
          app-id: \${{ secrets.APP_ID }}
          private-key: \${{ secrets.APP_PRIVATE_KEY }}
      - run: gh api repos/example/devai/pulls
`;

/** The API-only push workflow with a checkout added to one of its jobs. */
function withCheckout(uses: string): string {
  return API_ONLY_PUSH_WORKFLOW.replace(
    '      - run: gh api repos/example/devai/pulls\n',
    `      - uses: ${uses}\n      - run: gh api repos/example/devai/pulls\n`,
  );
}

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

describe('ci-economy.path-filters on a branch push that checks out no source (ADR-CHK-0008)', () => {
  it('is not raised for a branch-push workflow with no actions/checkout step in any job', () => {
    const root = temporary();
    workflow(root, 'update-pull-request-branches.yml', API_ONLY_PUSH_WORKFLOW);
    expect(pathFilters(root)).toBe(undefined);
  });

  it.each([
    ['a sha-pinned checkout', 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'],
    ['a tag checkout', 'actions/checkout@v4'],
    ['a branch checkout', 'actions/checkout@main'],
  ])('still warns when any job uses %s', (_label, uses) => {
    const root = temporary();
    workflow(root, 'update-pull-request-branches.yml', withCheckout(uses));
    expect(pathFilters(root)).toMatchObject({
      severity: 'warn',
      locations: ['update-pull-request-branches.yml'],
    });
  });

  it('names only the push workflow that checks out source beside an exempt one', () => {
    const root = temporary();
    workflow(root, 'update-pull-request-branches.yml', API_ONLY_PUSH_WORKFLOW);
    workflow(root, 'main-verification.yml', BRANCH_PUSH_WORKFLOW);
    expect(pathFilters(root)).toMatchObject({
      severity: 'warn',
      locations: ['main-verification.yml'],
    });
  });

  // Re-pinned by the 2026-10-09 ADR-CHK-0008 amendment: a workflow whose jobs never check out
  // the repository consumes no repository content, so the advisory skips it on a branch push
  // and on either pull-request trigger (docs/adopters/ci-economy.md).
  it.each(['pull_request', 'pull_request_target'] as const)(
    'is not raised for an unfiltered checkout-free %s workflow without class selectors',
    (trigger) => {
      const root = temporary();
      workflow(
        root,
        'pull-request-checks.yml',
        API_ONLY_PUSH_WORKFLOW.replace(
          'on:\n  push:\n    branches: [main]\n',
          `on:\n  ${trigger}:\n    types: [opened, synchronize]\nconcurrency:\n  group: \${{ github.workflow }}-\${{ github.ref }}\n  cancel-in-progress: true\n`,
        ),
      );
      expect(pathFilters(root)).toBe(undefined);
    },
  );

  it.each(['pull_request', 'pull_request_target'] as const)(
    'still warns for an unfiltered %s lane without class selectors once a job checks out',
    (trigger) => {
      const root = temporary();
      workflow(
        root,
        'pull-request-checks.yml',
        withCheckout('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1').replace(
          'on:\n  push:\n    branches: [main]\n',
          `on:\n  ${trigger}:\n    types: [opened, synchronize]\n`,
        ),
      );
      expect(pathFilters(root)).toMatchObject({
        severity: 'warn',
        locations: ['pull-request-checks.yml'],
      });
    },
  );
});

/** The update workflow's shape after the amendment: push to main plus pull_request_target. */
const API_ONLY_PUSH_AND_TARGET_WORKFLOW = API_ONLY_PUSH_WORKFLOW.replace(
  'on:\n  push:\n    branches: [main]\n',
  [
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request_target:',
    '    types: [opened, reopened, ready_for_review]',
    '    branches: [main]',
    'concurrency:',
    "  group: ${{ github.workflow }}-${{ github.event_name == 'pull_request_target' && format('pr-{0}', github.event.pull_request.number) || github.ref }}",
    '  cancel-in-progress: true',
    '',
  ].join('\n'),
);

function rule(root: string, ruleId: string) {
  return checkCiEconomy({ repoRoot: root }).findings.find((entry) => entry.ruleId === ruleId);
}

describe('ci-economy on the update workflow with pull_request_target (ADR-CHK-0008 IA-010)', () => {
  it('raises no path-filters advisory and passes rule 1 for the checkout-free push and target shape', () => {
    const root = temporary();
    workflow(root, 'update-pull-request-branches.yml', API_ONLY_PUSH_AND_TARGET_WORKFLOW);
    expect(pathFilters(root)).toBe(undefined);
    expect(rule(root, CONCURRENCY_CANCEL)).toMatchObject({ severity: 'pass' });
  });

  it('fails rule 1 when that workflow stops cancelling superseded pull_request_target runs', () => {
    const root = temporary();
    workflow(
      root,
      'update-pull-request-branches.yml',
      API_ONLY_PUSH_AND_TARGET_WORKFLOW.replace('  cancel-in-progress: true\n', ''),
    );
    expect(rule(root, CONCURRENCY_CANCEL)).toMatchObject({
      severity: 'fail',
      locations: ['update-pull-request-branches.yml'],
    });
  });

  it('raises no path-filters advisory and passes rule 1 for the committed update workflow', () => {
    const root = temporary();
    const committed = readFileSync(
      join(ROOT, '.github/workflows/update-pull-request-branches.yml'),
      'utf8',
    );
    expect(committed).toMatch(/^\s*pull_request_target\s*:/mu);
    workflow(root, 'update-pull-request-branches.yml', committed);
    expect(pathFilters(root)).toBe(undefined);
    expect(rule(root, CONCURRENCY_CANCEL)).toMatchObject({ severity: 'pass' });
  });
});
