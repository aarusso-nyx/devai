import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadWorkflows, parseWorkflow } from '../../src/harness/workflow-parser.js';

const file = '/repo/.github/workflows/ci.yml';

describe('wave3 workflow parser scalar and cache boundaries', () => {
  it('preserves # preceded by whitespace inside a single-quoted path scalar', () => {
    const ast = parseWorkflow(
      file,
      `on:
  push:
    paths:
      - 'docs/ #draft' # trailing note
jobs:
  check:
    steps:
      - run: echo ok
`,
      '/repo',
    );

    expect(ast.onPaths).toEqual(['docs/ #draft']);
  });

  it('includes the tenth lookahead line when setup-node declares cache', () => {
    const ast = parseWorkflow(
      file,
      `jobs:
  build:
    steps:
      - uses: actions/setup-node@v4
        note1: x
        note2: x
        note3: x
        note4: x
        note5: x
        note6: x
        note7: x
        note8: x
        note9: x
        cache: pnpm
`,
      '/repo',
    );

    expect(ast.hasCache).toBe(true);
  });

  it('does not treat cache text in a step name as setup cache', () => {
    const ast = parseWorkflow(
      file,
      `jobs:
  build:
    steps:
      - uses: actions/setup-node@v4
        name: "cache: pnpm"
`,
      '/repo',
    );

    expect(ast.hasCache).toBe(false);
  });

  it('keeps a setup step open across a name containing a dash before with.cache', () => {
    const ast = parseWorkflow(
      file,
      `jobs:
  build:
    steps:
      - uses: actions/setup-node@v4
        name: setup - node
        with:
          cache: pnpm
`,
      '/repo',
    );

    expect(ast.hasCache).toBe(true);
  });
});

describe('wave3 composite cache propagation', () => {
  it('does not promote cache when a loaded composite has no cache action', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-wave3-parser-'));
    try {
      mkdirSync(join(root, '.github/workflows'), { recursive: true });
      mkdirSync(join(root, '.github/actions/check'), { recursive: true });
      writeFileSync(
        join(root, '.github/workflows/ci.yml'),
        `jobs:
  check:
    steps:
      - uses: ./.github/actions/check
`,
      );
      writeFileSync(
        join(root, '.github/actions/check/action.yml'),
        `runs:
  using: composite
  steps:
    - run: echo child
`,
      );

      const workflow = loadWorkflows(root)[0];
      expect(workflow).toMatchObject({
        hasCache: false,
        runScripts: ['echo child'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
