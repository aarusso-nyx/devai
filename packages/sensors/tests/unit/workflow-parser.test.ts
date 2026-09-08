import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseWorkflow } from '../../src/harness/workflow-parser.js';

function parse(line: string) {
  return parseWorkflow(
    '/repo/.github/workflows/check.yml',
    `jobs:\n  check:\n    steps:\n      - uses: ${line}\n`,
    '/repo',
  );
}

describe('workflow action reference extraction', () => {
  it.each(['actions/checkout@v4', '"actions/checkout@v4"', "'actions/checkout@v4'"])(
    'extracts the same action identity from supported YAML scalar %s',
    (scalar) => {
      expect(parse(scalar).actionUses).toEqual([
        { owner: 'actions', repo: 'checkout', ref: 'v4', line: 4 },
      ]);
    },
  );

  it('retains complete pinned refs and nested action paths', () => {
    const sha = 'abcdef0123456789abcdef0123456789abcdef0123';
    expect(parse(`"owner/repo/path/to/action@${sha}" # reviewed pin`).actionUses).toEqual([
      { owner: 'owner', repo: 'repo/path/to/action', ref: sha, line: 4 },
    ]);
  });

  it.each(['"./.github/actions/check"', "'./.github/actions/check'"])(
    'recognizes quoted local composite reference %s',
    (scalar) => {
      const ast = parse(scalar);
      expect(ast.actionUses).toEqual([
        { owner: '', repo: './.github/actions/check', ref: '', line: 4 },
      ]);
      expect(ast.compositeActionUses).toEqual(['./.github/actions/check']);
    },
  );

  it('recognizes a quoted reusable workflow and cache action', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  reusable:
    uses: "owner/repo/.github/workflows/check.yaml@main"
  checks:
    steps:
      - uses: 'actions/cache@v4'
`,
      '/repo',
    );
    expect(ast.reusableWorkflowUses).toEqual(['repo/.github/workflows/check.yaml']);
    expect(ast.hasCache).toBe(true);
    expect(ast.actionUses).toEqual([
      { owner: 'owner', repo: 'repo/.github/workflows/check.yaml', ref: 'main', line: 3 },
      { owner: 'actions', repo: 'cache', ref: 'v4', line: 6 },
    ]);
  });

  it.each(['"actions/checkout@v4', "'actions/checkout@v4", '"actions/checkout@v4\''])(
    'does not turn an unterminated or mismatched quoted reference into an action: %s',
    (scalar) => {
      expect(parse(scalar).actionUses).toEqual([]);
    },
  );

  it('ignores a uses: scalar that names no owner/repository pair', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  check:
    steps:
      - uses: docker
      - uses: actions/checkout@v4
      - uses: ./.github/actions/local
`,
      '/repo',
    );
    expect(ast.actionUses).toEqual([
      { owner: 'actions', repo: 'checkout', ref: 'v4', line: 5 },
      { owner: '', repo: './.github/actions/local', ref: '', line: 6 },
    ]);
    expect(ast.compositeActionUses).toEqual(['./.github/actions/local']);
  });

  it('does not mistake a run script line for a declared action', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  check:
    steps:
      - run: |
          uses: actions/cache@v4
`,
      '/repo',
    );
    expect(ast.actionUses).toEqual([]);
    expect(ast.hasCache).toBe(false);
  });
});

describe('workflow job and matrix accounting', () => {
  it('keeps a reusable workflow job separate from the following step-based job', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  delegated:
    uses: owner/repo/.github/workflows/reusable.yml@main
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`,
      '/repo',
    );
    expect(ast.jobs).toEqual([
      { name: 'delegated', stepCount: 0, matrixDimensions: 0, matrixCombinations: 0 },
      { name: 'build', stepCount: 1, matrixDimensions: 0, matrixCombinations: 0 },
    ]);
  });

  it('flushes a matrix at the next job even when the first job has no steps', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  delegated:
    strategy:
      matrix:
        os: [linux, macos]
        node:
          - 22
          - 24
    uses: owner/repo/.github/workflows/reusable.yml@main
  second:
    strategy:
      matrix:
        platform: [linux, macos, windows]
    steps:
      - run: echo test
`,
      '/repo',
    );
    expect(ast.jobs).toEqual([
      { name: 'delegated', stepCount: 0, matrixDimensions: 2, matrixCombinations: 4 },
      { name: 'second', stepCount: 1, matrixDimensions: 1, matrixCombinations: 3 },
    ]);
  });

  it('counts one step per list entry, not per property, and separates consecutive ordinary jobs', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  first:
    steps:
      - name: Build
        run: echo build
      - uses: actions/checkout@v4
  second:
    steps:
      - name: Test
        run: echo test
`,
      '/repo',
    );
    expect(ast.jobs.map(({ name, stepCount }) => ({ name, stepCount }))).toEqual([
      { name: 'first', stepCount: 2 },
      { name: 'second', stepCount: 1 },
    ]);
    expect(ast.runScripts).toEqual(['echo build', 'echo test']);
    expect(ast.runStepCount).toBe(2);
  });

  it('counts an inline matrix list only for the values it actually declares', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  build:
    strategy:
      matrix:
        empty: []
        os: [linux, macos, ]
        node:
          - 22
          - 24
    steps:
      - run: echo build
`,
      '/repo',
    );
    expect(ast.jobs).toEqual([
      { name: 'build', stepCount: 1, matrixDimensions: 2, matrixCombinations: 4 },
    ]);
  });

  it('keeps top-level flags and trigger path filters separate from nested job properties', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `on:
  pull_request:
    paths:
      - "src/**"
      - 'docs/#examples/**'
      - "gen/#out/**" # generated sources
  push:
    paths:
      - 'src/**'
    paths-ignore:
      - 'scratch/**'
permissions:
  contents: read
concurrency:
  group: checks
jobs:
  build:
    steps:
      - run: echo build
`,
      '/repo',
    );
    expect(ast.onPaths).toEqual(['src/**', 'docs/#examples/**', 'gen/#out/**']);
    expect(ast.onPathsIgnore).toEqual(['scratch/**']);
    expect(ast.hasPermissionsBlock).toBe(true);
    expect(ast.hasConcurrencyBlock).toBe(true);
    expect(ast.relativeFile).toBe('.github/workflows/check.yml');
    const nested = parseWorkflow(
      'external.yml',
      `jobs:
  build:
    permissions:
      contents: read
    concurrency:
      group: build
`,
      '/repo',
    );
    expect(nested.hasPermissionsBlock).toBe(false);
    expect(nested.hasConcurrencyBlock).toBe(false);
    expect(nested.relativeFile).toBe('external.yml');
  });
});

describe('run script capture', () => {
  it('captures every block-scalar indicator and dedents the body against the run: key', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  build:
    steps:
      - name: literal
        run: |
          echo literal
            indented
      - name: strip
        run: |-
          echo strip
      - name: folded
        run: >
          echo folded
      - name: folded-strip
        run: >-
          echo folded-strip
      - name: bare
        run:
          echo bare
      - run: echo inline
`,
      '/repo',
    );
    expect(ast.runScripts).toEqual([
      'echo literal\n  indented',
      'echo strip',
      'echo folded',
      'echo folded-strip',
      'echo bare',
      'echo inline',
    ]);
    expect(ast.runStepCount).toBe(6);
    expect(ast.jobs.map((job) => job.stepCount)).toEqual([6]);
  });

  it('keeps a blank line inside a literal block from truncating the commands after it', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  build:
    steps:
      - run: |
          set -euo pipefail
          echo one

          devai check --only dependencies
      - run: echo after
`,
      '/repo',
    );
    expect(ast.runScripts).toEqual([
      '  set -euo pipefail\n  echo one\n\n  devai check --only dependencies',
      'echo after',
    ]);
    expect(ast.runStepCount).toBe(2);
  });

  it('does not let a commented-out block-scalar body swallow the next step', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  build:
    steps:
      - run: |
          # devai check --only dependencies
      - run: echo after
`,
      '/repo',
    );
    expect(ast.runScripts).toEqual(['echo after']);
    expect(ast.runStepCount).toBe(1);
    expect(ast.jobs.map((job) => job.stepCount)).toEqual([2]);
  });

  it('ends a block-scalar body at a dedented sibling step key, blank line or not', () => {
    const separators = ['\n\n', '\n'];
    for (const separator of separators) {
      const ast = parseWorkflow(
        '/repo/.github/workflows/check.yml',
        `jobs:
  build:
    steps:
      - run: |
          echo one${separator}        env:
          MODE: strict
      - run: echo after
`,
        '/repo',
      );
      // The dash column is the recorded run indent, so the best-effort dedent
      // leaves the two columns the `- ` marker occupies.
      expect(ast.runScripts).toEqual(['  echo one', 'echo after']);
      expect(ast.runStepCount).toBe(2);
    }
  });
});

describe('plain scalar hashes and quote escape parity', () => {
  it('preserves embedded hashes in path filters and commands, removing only comments', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/ci.yml',
      `on:
  push:
    paths:
      - gen#out/**
      - src/** # only sources
    paths-ignore:
      - docs/#drafts/**
jobs:
  check:
    steps:
      - run: devai check --only dependencies --out dist/report#1.json || true # note
`,
      '/repo',
    );
    expect(ast.onPaths).toEqual(['gen#out/**', 'src/**']);
    expect(ast.onPathsIgnore).toEqual(['docs/#drafts/**']);
    expect(ast.runScripts).toEqual([
      'devai check --only dependencies --out dist/report#1.json || true',
    ]);
  });

  it.each([2, 4])('strips a trailing comment after %i backslashes and a closing quote', (count) => {
    const command = `devai check --only dependencies --root "C:${'\\'.repeat(count)}"`;
    const ast = parseWorkflow(
      '/repo/.github/workflows/ci.yml',
      `jobs:
  check:
    steps:
      - run: ${command} # explanatory || true text
`,
      '/repo',
    );
    expect(ast.runScripts).toEqual([command]);
  });
});

describe('folded scalar line boundaries', () => {
  it.each([
    ['devai check --only dependencies', '|| true'],
    ['devai check', '--only dependencies'],
    ['echo one', '', 'echo two'],
    ['echo one', '', '', 'echo two'],
    ['echo one', '  indented text', 'echo two'],
    ['echo one', '', '  indented text', '', 'echo two'],
    ['', 'echo one', 'echo two'],
  ])('agrees with YAML folding for %j', (...body) => {
    const content = `jobs:\n  check:\n    steps:\n      - run: >-\n${body.map((line) => `          ${line}`).join('\n')}\n`;
    const reference = parseYaml(content) as { jobs: { check: { steps: { run: string }[] } } };
    const ast = parseWorkflow('/repo/.github/workflows/ci.yml', content, '/repo');
    expect(ast.runScripts).toEqual([reference.jobs.check.steps[0]?.run]);
  });
});
