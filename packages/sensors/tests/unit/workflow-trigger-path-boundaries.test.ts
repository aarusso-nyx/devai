import { describe, expect, it } from 'vitest';
import { parseWorkflow } from '../../src/harness/workflow-parser.js';

const repoRoot = '/repo';
const file = '/repo/.github/workflows/paths.yml';

describe('workflow trigger path boundaries', () => {
  it('keeps paths and paths-ignore populations separate across sibling trigger keys', () => {
    const ast = parseWorkflow(
      file,
      `name: paths
on:
  push:
    paths:
      - "src/**"
      - ''
    branches: [main]
    paths-ignore:
      - 'docs/**'
  pull_request:
    paths:
      - packages/**
    paths-ignore:
      - "generated/**"
jobs:
  check:
    steps:
      - run: echo check
permissions:
  contents: read
`,
      repoRoot,
    );

    expect(ast.onPaths).toEqual(['src/**', 'packages/**']);
    expect(ast.onPathsIgnore).toEqual(['docs/**', 'generated/**']);
    expect(ast.jobs).toEqual([
      { name: 'check', stepCount: 1, matrixDimensions: 0, matrixCombinations: 0 },
    ]);
  });

  it('accepts whitespace before the path-key colon and preserves embedded apostrophes', () => {
    const ast = parseWorkflow(
      file,
      `on:
  push:
    paths :
      - "src/o'brien/**"
jobs:
  check:
    steps:
      - run: echo check
`,
      repoRoot,
    );
    expect(ast.onPaths).toEqual(["src/o'brien/**"]);
  });

  it('ends a path list at the parent indentation before later workflow declarations', () => {
    const ast = parseWorkflow(
      file,
      `on:
  push:
    paths:
      - src/**
      - test/**
jobs:
  build:
    steps:
      - run: echo build
permissions:
  contents: read
concurrency:
  group: build
`,
      repoRoot,
    );

    expect(ast.onPaths).toEqual(['src/**', 'test/**']);
    expect(ast.onPathsIgnore).toEqual([]);
    expect(ast.jobs).toEqual([
      { name: 'build', stepCount: 1, matrixDimensions: 0, matrixCombinations: 0 },
    ]);
    expect(ast.hasPermissionsBlock).toBe(true);
    expect(ast.hasConcurrencyBlock).toBe(true);
  });
});
