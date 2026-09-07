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

  it('keeps top-level flags and trigger path filters separate from nested job properties', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `on:
  pull_request:
    paths:
      - "src/**"
      - 'docs/#examples/**'
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
    expect(ast.onPaths).toEqual(['src/**', 'docs/#examples/**']);
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
