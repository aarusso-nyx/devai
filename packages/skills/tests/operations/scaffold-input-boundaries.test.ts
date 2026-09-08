import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, expect, it, vi } from 'vitest';
import { runScaffolder } from '../../src/operations/scaffold/runner.js';
import { withAuthorityHostTestScope } from '../unit/authority-host-test-scope.js';

const roots: string[] = [];
aroundEach((runTest) => withAuthorityHostTestScope(runTest));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
  { label: 'missing', value: undefined },
  { label: 'null', value: null },
  { label: 'empty', value: '' },
  { label: 'zero', value: 0 },
  { label: 'nonzero number', value: 42 },
  { label: 'true', value: true },
  { label: 'false', value: false },
  { label: 'object', value: { path: 'blueprint.json' } },
  { label: 'empty array', value: [] },
  { label: 'path array', value: ['blueprint.json'] },
])(
  'refuses a $label blueprint input before resolving templates or producing output',
  ({ value }) => {
    const root = mkdtempSync(join(tmpdir(), 'devai-scaffold-input-'));
    roots.push(root);
    const deriveTasks = vi.fn(() => []);
    let result: ReturnType<typeof runScaffolder> | undefined;
    expect(() => {
      result = runScaffolder({
        spec: { operationId: 'fixture-scaffold', templateIds: ['fixture'], deriveTasks },
        ctx: { repoRoot: root, inputs: { blueprint_path: value }, allowedPaths: [] },
      });
    }).not.toThrow();
    expect(result).toEqual({
      operation_id: 'fixture-scaffold',
      status: 'fail',
      notes: ['inputs.blueprint_path: string is required (path to a module-blueprint JSON file)'],
    });
    expect(deriveTasks).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
  },
);
