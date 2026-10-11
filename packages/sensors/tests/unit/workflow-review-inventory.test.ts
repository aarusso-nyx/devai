// ADR-SCR-0018; Constitution Articles 29, 39 and 41.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hash,
  populate,
  put,
  snapshot,
  workflow,
} from '../../../../tests/helpers/workflow-inventory-fixture.js';
import { workflowReviewInventory } from '../../src/harness/workflow-parser.js';

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai workflow ç '));
  roots.push(root);
  populate(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('read-only workflow review inventory', () => {
  it('returns complete raw workflow and executable/import digests without executing or writing', () => {
    const root = fixture();
    const before = snapshot(root);
    const result = workflowReviewInventory(root);
    expect(result).toEqual({
      schemaVersion: '1.0.0',
      status: 'complete',
      reason: null,
      workflows: [
        {
          path: '.github/workflows/check.yml',
          sha256: hash(readFileSync(join(root, '.github/workflows/check.yml'))),
          status: 'complete',
          reason: null,
          steps: [
            {
              job: 'verify',
              index: 0,
              occurrence: '.github/workflows/check.yml#verify[0]',
              name: 'Inspect',
              sha256: hash(JSON.stringify({ name: 'Inspect', run: 'node scripts/main.mjs' })),
              closure: {
                status: 'complete',
                reason: null,
                files: ['package.json', 'scripts/leaf.mjs', 'scripts/main.mjs'].map((path) => ({
                  path,
                  sha256: hash(readFileSync(join(root, path))),
                })),
              },
            },
          ],
        },
      ],
    });
    expect(workflowReviewInventory(root)).toEqual(result);
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(join(root, 'EXECUTED'))).toBe(false);
    expect(existsSync(join(root, '.devai'))).toBe(false);
    expect(existsSync(join(root, 'record'))).toBe(false);
  });

  it('keeps each duplicate occurrence and sorts workflow paths, independently of raw YAML formatting', () => {
    const root = fixture();
    put(root, '.github/workflows/z.yaml', workflow().replace('  verify:', '  zed:'));
    put(
      root,
      '.github/workflows/a.yml',
      `jobs:\n  first:\n    steps:\n      - run: node scripts/main.mjs\n        name: Inspect # canonical comment\n      - name: Inspect\n        run: node scripts/main.mjs\n  second:\n    steps:\n      - name: Inspect\n        run: node scripts/main.mjs\n`,
    );
    put(root, '.github/workflows/ignored.txt', 'not workflow YAML');
    const result = workflowReviewInventory(root);
    expect(result.status).toBe('complete');
    expect(result.workflows.map((row) => row.path)).toEqual([
      '.github/workflows/a.yml',
      '.github/workflows/check.yml',
      '.github/workflows/z.yaml',
    ]);
    const rows = result.workflows.flatMap((row) => row.steps);
    expect(rows.map((row) => row.occurrence)).toEqual([
      '.github/workflows/a.yml#first[0]',
      '.github/workflows/a.yml#first[1]',
      '.github/workflows/a.yml#second[0]',
      '.github/workflows/check.yml#verify[0]',
      '.github/workflows/z.yaml#zed[0]',
    ]);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.sha256)).size).toBe(1);
    expect(new Set(result.workflows.map((row) => row.sha256)).size).toBe(3);
  });

  it('follows package pre/post scripts and recomputes transitive bytes on each invocation', () => {
    const root = fixture();
    put(
      root,
      'package.json',
      JSON.stringify({
        scripts: {
          preaudit: 'node scripts/before.mjs',
          audit: 'node scripts/main.mjs',
          postaudit: 'node scripts/after.mjs',
        },
      }),
    );
    for (const name of ['before', 'after'])
      put(root, `scripts/${name}.mjs`, 'export const ready = true;\n');
    put(root, '.github/workflows/check.yml', workflow('pnpm run audit'));
    const first = workflowReviewInventory(root);
    expect(first.status).toBe('complete');
    expect(first.workflows[0]?.steps[0]?.closure.files?.map((row) => row.path)).toEqual([
      'package.json',
      'scripts/after.mjs',
      'scripts/before.mjs',
      'scripts/leaf.mjs',
      'scripts/main.mjs',
    ]);
    put(root, 'scripts/leaf.mjs', 'export const value = 2;\n');
    const next = workflowReviewInventory(root);
    expect(next.status).toBe('complete');
    expect(next.workflows[0]?.steps[0]?.sha256).toBe(first.workflows[0]?.steps[0]?.sha256);
    expect(next.workflows[0]?.steps[0]?.closure.files).not.toEqual(
      first.workflows[0]?.steps[0]?.closure.files,
    );
    expect(
      next.workflows[0]?.steps[0]?.closure.files?.find((row) => row.path === 'scripts/leaf.mjs')
        ?.sha256,
    ).toBe(hash('export const value = 2;\n'));
  });

  it.each([
    'node scripts/main.mjs && echo hidden',
    'bash scripts/main.mjs',
    'node --eval hidden',
    'node scripts/missing.mjs',
  ])('keeps unsupported or missing closure unknown: %s', (run) => {
    const root = fixture();
    put(root, '.github/workflows/check.yml', workflow(run));
    const result = workflowReviewInventory(root);
    expect(result).toMatchObject({ status: 'unknown', reason: 'WORKFLOW_INVENTORY_INCOMPLETE' });
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]?.steps).toHaveLength(1);
    expect(result.workflows[0]?.steps[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.workflows[0]?.steps[0]?.closure).toMatchObject({
      status: 'unknown',
      files: null,
    });
    expect(result.workflows[0]?.steps[0]?.closure.reason).toBeTypeOf('string');
  });

  it('does not infer a computed-import cover from a filename, variable or unbound authored registry', () => {
    const root = fixture();
    put(root, 'scripts/main.mjs', "const selected = './leaf.mjs'; await import(selected);\n");
    put(root, '.devai/config/reviewed-workflow-steps.json', '{"schemaVersion":"1.0.0","steps":[]}');
    const result = workflowReviewInventory(root);
    expect(result.status).toBe('unknown');
    expect(result.workflows[0]?.steps[0]?.closure).toMatchObject({
      status: 'unknown',
      files: null,
    });
  });

  it.each(['symlink-file', 'symlink-directory', 'escape', 'unreadable'] as const)(
    'never publishes a partial complete closure for %s',
    (variant) => {
      const root = fixture();
      const outside = fixture();
      if (variant === 'symlink-file') {
        rmSync(join(root, 'scripts/leaf.mjs'));
        symlinkSync(join(outside, 'scripts/leaf.mjs'), join(root, 'scripts/leaf.mjs'));
      } else if (variant === 'symlink-directory') {
        symlinkSync(join(outside, 'scripts'), join(root, 'linked'));
        put(root, 'scripts/main.mjs', "import '../linked/leaf.mjs';\n");
      } else if (variant === 'escape')
        put(root, 'scripts/main.mjs', "import '../../outside.mjs';\n");
      else chmodSync(join(root, 'scripts/leaf.mjs'), 0);
      try {
        const result = workflowReviewInventory(root);
        expect(result.status).toBe('unknown');
        expect(result.workflows[0]?.steps[0]?.closure).toMatchObject({
          status: 'unknown',
          files: null,
        });
      } finally {
        if (variant === 'unreadable') chmodSync(join(root, 'scripts/leaf.mjs'), 0o600);
      }
    },
  );

  it('retains unreadable or invalid selected workflow rows rather than reporting an empty success', () => {
    const root = fixture();
    put(root, '.github/workflows/broken.yml', 'jobs: [\n');
    const result = workflowReviewInventory(root);
    expect(result.status).toBe('unknown');
    expect(result.reason).toBe('WORKFLOW_INVENTORY_INCOMPLETE');
    expect(result.workflows.map((row) => row.path)).toEqual([
      '.github/workflows/broken.yml',
      '.github/workflows/check.yml',
    ]);
    expect(result.workflows[0]).toMatchObject({ status: 'unknown', steps: [] });
    expect(result.workflows[0]?.reason).toBeTypeOf('string');
    expect(result.workflows[1]?.status).toBe('complete');
  });

  it.each(['directory', 'file'] as const)(
    'refuses workflow %s symlinks before they can escape the source population',
    (kind) => {
      const root = fixture();
      const outside = fixture();
      const path = kind === 'directory' ? '.github/workflows' : '.github/workflows/check.yml';
      rmSync(join(root, path), { recursive: true });
      symlinkSync(join(outside, path), join(root, path));
      expect(() => workflowReviewInventory(root)).toThrow('WORKFLOW_SOURCE_BINDING_REFUSED');
    },
  );

  it.each([
    'workflow-env',
    'job-env',
    'step-env',
    'workflow-defaults',
    'job-defaults',
    'shell',
    'action',
  ] as const)('preserves the actual adopter selector refusal for %s', (variant) => {
    const root = fixture();
    let content = workflow();
    if (variant === 'workflow-env')
      content = `env:\n  NODE_OPTIONS: --import=./hidden.mjs\n${content}`;
    if (variant === 'job-env')
      content = content.replace(
        '    steps:',
        '    env:\n      NODE_OPTIONS: --import=./hidden.mjs\n    steps:',
      );
    if (variant === 'step-env')
      content += '        env:\n          NODE_OPTIONS: --import=./hidden.mjs\n';
    if (variant === 'workflow-defaults')
      content = `defaults:\n  run:\n    working-directory: hidden\n${content}`;
    if (variant === 'job-defaults')
      content = content.replace(
        '    steps:',
        '    defaults:\n      run:\n        working-directory: hidden\n    steps:',
      );
    if (variant === 'shell') content += '        shell: python\n';
    if (variant === 'action')
      content = content.replace('run: node scripts/main.mjs', 'uses: actions/checkout@v4');
    put(root, '.github/workflows/check.yml', content);
    const result = workflowReviewInventory(root);
    expect(result.status).toBe('unknown');
    expect(result.workflows[0]?.steps).toHaveLength(1);
    expect(result.workflows[0]?.steps[0]?.closure).toMatchObject({
      status: 'unknown',
      files: null,
    });
  });

  it('uses the explicit contained working directory instead of the root executable with the same basename', () => {
    const root = fixture();
    put(root, 'app/package.json', '{"type":"module"}');
    put(root, 'app/scripts/main.mjs', "import './leaf.mjs';\n");
    put(root, 'app/scripts/leaf.mjs', 'export const nested = true;\n');
    put(root, '.github/workflows/check.yml', `${workflow()}        working-directory: app\n`);
    const result = workflowReviewInventory(root);
    expect(result.status).toBe('complete');
    expect(result.workflows[0]?.steps[0]?.closure.files?.map((row) => row.path)).toEqual([
      'app/package.json',
      'app/scripts/leaf.mjs',
      'app/scripts/main.mjs',
    ]);
  });

  it('refuses a symlinked higher-priority TypeScript resolution candidate instead of crediting a regular fallback', () => {
    const root = fixture();
    const outside = fixture();
    put(root, 'scripts/main.ts', "import './shadow.js';\n");
    put(root, 'scripts/shadow.js', 'export const fallback = true;\n');
    put(outside, 'outside.ts', 'export const external = true;\n');
    symlinkSync(join(outside, 'outside.ts'), join(root, 'scripts/shadow.ts'));
    put(root, '.github/workflows/check.yml', workflow('tsx scripts/main.ts'));
    const result = workflowReviewInventory(root);
    expect(result.status).toBe('unknown');
    expect(result.workflows[0]?.steps[0]?.closure).toMatchObject({
      status: 'unknown',
      files: null,
    });
  });

  it('reports missing workflows explicitly instead of vacuous completeness', () => {
    const root = fixture();
    rmSync(join(root, '.github/workflows'), { recursive: true });
    expect(workflowReviewInventory(root)).toEqual({
      schemaVersion: '1.0.0',
      status: 'unknown',
      reason: 'WORKFLOW_INVENTORY_EMPTY',
      workflows: [],
    });
  });
});
