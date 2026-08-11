import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createOperationHost, listOperations, runOperation } from '../../src/operations/index.js';
import { loadRecipe } from '../../src/recipes/index.js';
import { withAuthorityHostTestScope } from '../unit/authority-host-test-scope.js';

describe('deterministic operation catalog', () => {
  it('contains exactly the 20 manifest-referenced operations', () => {
    expect(listOperations()).toHaveLength(20);
    expect(new Set(listOperations().map((operation) => operation.id)).size).toBe(20);
  });

  it('passes the exact variant contract to the host', async () => {
    const execute = vi.fn(() => ({ operation: 'check.lint' as const, status: 'pass' as const }));
    await runOperation(
      {
        recipe: 'devai-fix',
        variant: 'lint',
        operation: 'check.lint',
        repo_root: '/repo',
        write_paths: ['packages/cli/src/bin.ts'],
      },
      { execute },
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].variant_contract.write_policy).toEqual({
      mode: 'explicit-files',
      scopes: ['packages/**/*.{ts,tsx,js,jsx,json}'],
    });
  });

  it('rejects scope escape and permission union attempts before host execution', async () => {
    const execute = vi.fn();
    await expect(
      runOperation(
        {
          recipe: 'devai-fix',
          variant: 'lint',
          operation: 'check.lint',
          repo_root: '/repo',
          write_paths: ['law/policy/action-registry.json'],
        },
        { execute },
      ),
    ).rejects.toThrow('OPERATION_WRITE_PATH_OUT_OF_SCOPE');
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes a check/plan operation through the exact deterministic command', async () => {
    const run = vi.fn(() => ({ operation: 'check.inspect' as const, status: 'pass' as const }));
    const result = await runOperation(
      {
        recipe: 'devai-plan',
        variant: 'change',
        operation: 'check.inspect',
        repo_root: '/repo',
      },
      createOperationHost({ run }),
    );
    expect(result.status).toBe('pass');
    expect(run).toHaveBeenCalledWith({
      argv: ['devai', 'check', '--suite', 'quick'],
      cwd: '/repo',
      effect: 'read',
      write_paths: [],
    });
  });

  it('supplies required deterministic arguments to current read operations', async () => {
    const run = vi.fn((request: { operation?: string }) => ({
      operation: (request.operation ?? 'sense.inventory') as 'sense.inventory',
      status: 'pass' as const,
    }));
    const host = createOperationHost({ run });
    await runOperation(
      {
        recipe: 'devai-assess',
        variant: 'inventory',
        operation: 'sense.inventory',
        repo_root: '/repo',
      },
      host,
    );
    await runOperation(
      {
        recipe: 'devai-assess',
        variant: 'round',
        operation: 'round.assess',
        repo_root: '/repo',
        inputs: { round: 'R-0007' },
      },
      host,
    );
    await runOperation(
      {
        recipe: 'devai-verify',
        variant: 'rc',
        operation: 'evidence.verify',
        repo_root: '/repo',
      },
      host,
    );
    expect(run.mock.calls.map(([request]) => request.argv)).toEqual([
      ['devai', 'sense', 'inventory', '--slice', 'all'],
      ['devai', 'round', 'assess', '--round', 'R-0007'],
      ['devai', 'evidence', 'verify', '--scope', 'local'],
    ]);
  });

  it('materializes reviewed test candidates exactly and refuses drift', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-tests-from-docs-'));
    const path = 'packages/demo/tests/from-docs.test.ts';
    const invocation = {
      recipe: 'devai-scaffold' as const,
      variant: 'tests-from-docs',
      operation: 'scaffold.tests-from-docs' as const,
      repo_root: root,
      write_paths: [path],
      inputs: {
        files: [
          {
            path,
            content: 'test("documented", () => {});\n',
            source_documents: ['docs/API Map.md'],
          },
        ],
      },
    };
    const first = await withAuthorityHostTestScope(() =>
      runOperation(invocation, createOperationHost({ run: vi.fn() })),
    );
    expect(first.status).toBe('pass');
    expect(readFileSync(join(root, path), 'utf8')).toContain('documented');
    writeFileSync(join(root, path), 'local drift\n');
    const second = await withAuthorityHostTestScope(() =>
      runOperation(invocation, createOperationHost({ run: vi.fn() })),
    );
    expect(second.status).toBe('review');
    expect(readFileSync(join(root, path), 'utf8')).toBe('local drift\n');
  });

  it('records bounded preview phases and closes only complete verification', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-round-preview-'));
    const planPath = '.devai/state/round-runs/demo/plan.json';
    const result = await withAuthorityHostTestScope(() =>
      runOperation(
        {
          recipe: 'devai-round',
          variant: 'plan',
          operation: 'round.plan.preview',
          repo_root: root,
          write_paths: [planPath],
          inputs: { plan: { tasks: ['T-1'] } },
        },
        createOperationHost({ run: vi.fn() }),
      ),
    );
    expect(result.status).toBe('pass');
    expect(JSON.parse(readFileSync(join(root, planPath), 'utf8'))).toMatchObject({
      phase: 'plan',
      round_run_id: 'demo',
    });
    await expect(
      runOperation(
        {
          recipe: 'devai-round',
          variant: 'close',
          operation: 'round.close.preview',
          repo_root: root,
          write_paths: ['.devai/state/round-runs/demo/close.json'],
          inputs: { verification: { complete: false } },
        },
        createOperationHost({ run: vi.fn() }),
      ),
    ).rejects.toThrow('OPERATION_PREVIEW_CLOSE_INCOMPLETE');
  });

  it('renders deterministic documentation scaffolds only to the exact allowed paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-scaffold-operation-'));
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/blueprint.json');
    writeFileSync(join(root, 'blueprint.json'), readFileSync(fixture));
    const paths = ['domain/demo-bookmark/docs/README.md', 'domain/demo-bookmark/docs/ADR-0001.md'];
    const result = await withAuthorityHostTestScope(() =>
      runOperation(
        {
          recipe: 'devai-scaffold',
          variant: 'docs',
          operation: 'scaffold.docs',
          repo_root: root,
          write_paths: paths,
          inputs: { blueprint_path: 'blueprint.json' },
        },
        createOperationHost({ run: vi.fn() }),
      ),
    );
    expect(result.status).toBe('pass');
    const readme = paths[0];
    expect(readme).toBeDefined();
    expect(readFileSync(join(root, readme ?? ''), 'utf8')).toContain('BP-DEMO-BOOKMARK-001');
  });

  it('keeps each document recipe variant bound to one exact output', () => {
    const recipe = loadRecipe('devai-docs');
    for (const variant of Object.values(recipe.manifest.variants)) {
      expect(variant.effect).toBe('local-write');
      expect(variant.write_policy.mode).toBe('bounded-patterns');
      if (variant.write_policy.mode !== 'none') expect(variant.write_policy.scopes).toHaveLength(1);
    }
  });
});
