import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listWorkflowFiles,
  loadWorkflows,
  parseWorkflow,
} from '../../src/harness/workflow-parser.js';

let root: string;
function write(path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-workflow-loader-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const workflow = 'jobs:\n  check:\n    steps:\n      - uses: ./.github/actions/check\n';

describe('workflow loading and composite evidence', () => {
  it('lists supported extensions in stable order and accepts explicit relative or absolute directories', () => {
    write('custom/z.yaml', 'name: z');
    write('custom/a.yml', 'name: a');
    write('custom/ignored.txt', 'name: ignored');
    write('custom/nested/hidden.yml', 'name: nested');
    expect(listWorkflowFiles(root, 'custom')).toEqual([
      join(root, 'custom/a.yml'),
      join(root, 'custom/z.yaml'),
    ]);
    expect(listWorkflowFiles(root, join(root, 'custom'))).toEqual(
      listWorkflowFiles(root, 'custom'),
    );
    expect(listWorkflowFiles(root)).toEqual([]);
    expect(listWorkflowFiles(root, 'custom/ignored.txt')).toEqual([]);
  });

  it.each(['action.yml', 'action.yaml'])(
    'incorporates action, script and cache observations from %s',
    (filename) => {
      write('.github/workflows/check.yml', workflow);
      write(
        `.github/actions/check/${filename}`,
        `runs:
  using: composite
  steps:
    - uses: actions/cache@v4
    - run: pnpm test
      shell: bash
`,
      );
      const records = loadWorkflows(root);
      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record?.hasCache).toBe(true);
      expect(record?.runScripts).toEqual(['pnpm test']);
      expect(record?.actionUses).toEqual([
        { owner: '', repo: './.github/actions/check', ref: '', line: 4 },
        { owner: 'actions', repo: 'cache', ref: 'v4', line: 4 },
      ]);
    },
  );

  it('prefers action.yml when both composite filenames exist', () => {
    write('.github/workflows/check.yml', workflow);
    write('.github/actions/check/action.yml', 'runs:\n  steps:\n    - run: echo primary\n');
    write('.github/actions/check/action.yaml', 'runs:\n  steps:\n    - run: echo alternate\n');
    expect(loadWorkflows(root)[0]?.runScripts).toEqual(['echo primary']);
  });

  it('retains the parent workflow when a referenced composite cannot be read', () => {
    write('.github/workflows/check.yml', workflow);
    const records = loadWorkflows(root);
    expect(records).toHaveLength(1);
    expect(records[0]?.compositeActionUses).toEqual(['./.github/actions/check']);
    expect(records[0]?.hasCache).toBe(false);
    expect(records[0]?.runScripts).toEqual([]);
  });

  it('skips unreadable workflow entries without discarding readable workflows', () => {
    mkdirSync(join(root, '.github/workflows/directory.yml'), { recursive: true });
    write('.github/workflows/good.yml', 'jobs:\n  check:\n    steps:\n      - run: echo ok\n');
    expect(loadWorkflows(root).map((record) => record.relativeFile)).toEqual([
      '.github/workflows/good.yml',
    ]);
  });
});

describe('setup action cache attribution', () => {
  it('recognizes cache configuration within the setup action step', () => {
    const ast = parseWorkflow(
      'check.yml',
      `jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
`,
      root,
    );
    expect(ast.hasCache).toBe(true);
  });

  it('does not borrow cache configuration from a later step', () => {
    const ast = parseWorkflow(
      'check.yml',
      `jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - uses: owner/unrelated@v1
        with:
          cache: pnpm
`,
      root,
    );
    expect(ast.hasCache).toBe(false);
  });

  it('does not treat a commented-out action as a cache', () => {
    expect(
      parseWorkflow(
        'check.yml',
        'jobs:\n  check:\n    steps:\n      # - uses: actions/cache@v4\n      - run: echo ok\n',
        root,
      ).hasCache,
    ).toBe(false);
  });
});
