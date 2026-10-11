import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adopterWorkflowClosure } from '../../src/harness/adopter-workflow-closure.js';
import type { ReviewedWorkflowStep } from '../../src/harness/reviewed-workflow-steps.js';
import { jobEffectFacts, workflowStepInventory } from '../../src/harness/workflow-parser.js';

const roots: string[] = [];
const workflowFile = '.github/workflows/adopter.yml';
const target = '.devai/config/reviewed-workflow-steps.json';
const source = 'law/adopter-policy.json';
const hash = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
const put = (root: string, path: string, body: string | object) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body));
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function workflow(
  step = '      - name: Reviewed adopter check\n        run: tsx scripts/main.ts',
): string {
  return `name: Adopter checks\non: push\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n${step}\n`;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai reviewed workflow ç '));
  roots.push(root);
  put(root, workflowFile, workflow());
  put(
    root,
    'scripts/main.ts',
    "import { value } from '@owned/helper.js'; export const result = value;\n",
  );
  put(root, 'scripts/helper.ts', 'export const value = 1;\n');
  put(root, 'tsconfig.json', {
    compilerOptions: {
      moduleResolution: 'NodeNext',
      baseUrl: '.',
      paths: { '@owned/*': ['scripts/*'] },
    },
  });
  put(root, 'package.json', { private: true, scripts: { audit: 'tsx scripts/main.ts' } });
  const digest = workflowStepInventory(workflow(), root)[0]?.sha256;
  if (digest === undefined) throw new Error('Fixture canonical step missing');
  const entry: ReviewedWorkflowStep = {
    sha256: digest,
    effect: 'read-only',
    workflow: `${workflowFile}#verify[0]`,
    step: 'Reviewed adopter check',
    review: 'Inspector fixture proves exact candidate closure and occurrence.',
    files: ['package.json', 'scripts/helper.ts', 'scripts/main.ts', 'tsconfig.json'].map(
      (path) => ({ path, sha256: hash(readFileSync(join(root, path))) }),
    ),
  };
  return { root, entry };
}
function bind(root: string, entries: readonly ReviewedWorkflowStep[]): void {
  const document = { schemaVersion: '1.0.0', steps: entries };
  const policy = {
    schemaVersion: '1.0.0',
    policy_id: 'fixture.workflow-review',
    policy_version: '1.0.0',
    reviewed_workflow_steps: document,
  };
  put(root, source, policy);
  put(root, target, document);
  put(root, '.devai/config/adopter-policy-binding.json', {
    schemaVersion: '1.0.0',
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    source_path: source,
    source_digest_sha256: hash(readFileSync(join(root, source))),
    materialized: { [target]: hash(readFileSync(join(root, target))) },
  });
}
const effect = (root: string, content = readFileSync(join(root, workflowFile), 'utf8')) =>
  jobEffectFacts(content, root, 'verify', new Set(), workflowFile).effect;

describe('candidate-bound reviewed adopter workflow effects', () => {
  it.each(['read-only', 'repository-write', 'publication'] as const)(
    'admits exactly reviewed %s effects with a complete TypeScript alias closure',
    (reviewedEffect) => {
      const { root, entry } = fixture();
      bind(root, [{ ...entry, effect: reviewedEffect }]);
      expect(adopterWorkflowClosure(root, 'tsx scripts/main.ts', entry)).toEqual(
        entry.files.map((file) => file.path),
      );
      expect(effect(root)).toBe(reviewedEffect);
    },
  );

  it('does not grant an unbound authored registry standing', () => {
    const { root, entry } = fixture();
    put(root, target, { schemaVersion: '1.0.0', steps: [entry] });
    expect(effect(root)).toBe('unknown');
  });

  it.each(['file', 'target', 'source'] as const)('refuses changed %s bytes', (which) => {
    const { root, entry } = fixture();
    bind(root, [entry]);
    if (which === 'file') put(root, 'scripts/helper.ts', 'export const value = 2;\n');
    if (which === 'target')
      put(root, target, { schemaVersion: '1.0.0', steps: [{ ...entry, effect: 'publication' }] });
    if (which === 'source') put(root, source, '{}');
    expect(effect(root)).toBe('unknown');
  });

  it.each(['copied', 'moved', 'edited'] as const)(
    'refuses %s step occurrences without new review',
    (which) => {
      const { root, entry } = fixture();
      bind(root, [entry]);
      if (which === 'copied') put(root, '.github/workflows/copied.yml', workflow());
      if (which === 'moved') put(root, workflowFile, workflow().replace('  verify:', '  moved:'));
      if (which === 'edited')
        put(
          root,
          workflowFile,
          workflow().replace('tsx scripts/main.ts', 'node scripts/helper.ts'),
        );
      expect(effect(root)).toBe('unknown');
    },
  );

  it.each(['missing', 'extra', 'unsorted'] as const)(
    'refuses %s executable closure declarations',
    (which) => {
      const { root, entry } = fixture();
      put(root, 'scripts/unrelated.ts', 'export const unrelated = true;\n');
      const files =
        which === 'missing'
          ? entry.files.filter((file) => file.path !== 'scripts/helper.ts')
          : which === 'extra'
            ? [
                ...entry.files,
                {
                  path: 'scripts/unrelated.ts',
                  sha256: hash(readFileSync(join(root, 'scripts/unrelated.ts'))),
                },
              ].sort((a, b) => a.path.localeCompare(b.path))
            : [...entry.files].reverse();
      bind(root, [{ ...entry, files }]);
      expect(effect(root)).toBe('unknown');
    },
  );

  it('follows reviewed computed imports and refuses a missing computed reachability cover', () => {
    const { root, entry } = fixture();
    put(root, 'scripts/main.ts', "const selected = './helper.js'; await import(selected);\n");
    const files = entry.files.map((file) => ({
      ...file,
      sha256: hash(readFileSync(join(root, file.path))),
    }));
    bind(root, [{ ...entry, files }]);
    expect(effect(root)).toBe('unknown');
    bind(root, [
      {
        ...entry,
        files,
        computed_imports: [
          {
            from: 'scripts/main.ts',
            reason: 'Only the reviewed helper is selected.',
            files: ['scripts/helper.ts'],
          },
        ],
      },
    ]);
    expect(effect(root)).toBe('read-only');
  });

  it('follows package lifecycle script closure instead of trusting the package command name', () => {
    const { root, entry } = fixture();
    put(root, 'scripts/pre.ts', 'export const before = true;\n');
    put(root, 'package.json', {
      scripts: { preaudit: 'tsx scripts/pre.ts', audit: 'tsx scripts/main.ts' },
    });
    put(
      root,
      workflowFile,
      workflow('      - name: Reviewed adopter check\n        run: pnpm run audit'),
    );
    const sha256 = workflowStepInventory(readFileSync(join(root, workflowFile), 'utf8'), root)[0]
      ?.sha256;
    if (sha256 === undefined) throw new Error('Package command digest missing');
    const files = [...entry.files.map((file) => file.path), 'scripts/pre.ts']
      .sort()
      .map((path) => ({ path, sha256: hash(readFileSync(join(root, path))) }));
    bind(root, [{ ...entry, sha256, files }]);
    expect(effect(root)).toBe('read-only');
    put(root, 'scripts/pre.ts', 'export const before = false;\n');
    expect(effect(root)).toBe('unknown');
  });

  it.each([
    '      - name: Reviewed adopter check\n        run: tsx scripts/main.ts && node scripts/helper.ts',
    '      - name: Reviewed adopter check\n        run: node --import ./scripts/helper.ts scripts/main.ts',
    '      - name: Reviewed adopter check\n        shell: custom-shell\n        run: tsx scripts/main.ts',
    '      - name: Reviewed adopter check\n        uses: ./.github/actions/custom',
  ])('keeps unsupported shell, loader, and composite forms unknown: %s', (step) => {
    const { root, entry } = fixture();
    const content = workflow(step);
    put(root, workflowFile, content);
    const sha256 = workflowStepInventory(content, root)[0]?.sha256;
    if (sha256 === undefined) throw new Error('Unsupported fixture digest missing');
    bind(root, [{ ...entry, sha256 }]);
    expect(effect(root)).toBe('unknown');
  });

  it('keeps mixed Node and TSX package lifecycle resolution unknown', () => {
    const { root, entry } = fixture();
    put(root, 'scripts/pre.ts', 'export const before = true;\n');
    put(root, 'package.json', {
      scripts: { preaudit: 'node scripts/pre.ts', audit: 'tsx scripts/main.ts' },
    });
    expect(adopterWorkflowClosure(root, 'pnpm run audit', entry)).toBeUndefined();
  });

  it('does not grant Node a TypeScript path alias that only TSX can resolve', () => {
    const { root, entry } = fixture();
    expect(adopterWorkflowClosure(root, 'node scripts/main.ts', entry)).toBeUndefined();
  });

  it('does not substitute a TypeScript sibling for the exact JavaScript file Node imports', () => {
    const { root, entry } = fixture();
    put(root, 'scripts/native.mjs', "import './shadow.js';\n");
    put(root, 'scripts/shadow.ts', 'export const shadow = true;\n');
    expect(adopterWorkflowClosure(root, 'node scripts/native.mjs', entry)).toBeUndefined();
  });

  it('refuses computed child-process executor access in a reviewed transitive helper', () => {
    const { root, entry } = fixture();
    put(
      root,
      'scripts/helper.ts',
      "import * as cp from 'node:child_process'; cp['execFileSync']('node', ['unreviewed.js']); export const value = 1;\n",
    );
    const files = entry.files.map((file) => ({
      ...file,
      sha256: hash(readFileSync(join(root, file.path))),
    }));
    bind(root, [{ ...entry, files }]);
    expect(effect(root)).toBe('unknown');
  });

  it.each(['workflow', 'job', 'step'] as const)(
    'refuses omitted runtime loader selection through %s environment',
    (scope) => {
      const { root, entry } = fixture();
      let content = workflow();
      if (scope === 'workflow')
        content = content.replace('jobs:', 'env:\n  NODE_OPTIONS: --require ./injected.cjs\njobs:');
      if (scope === 'job')
        content = content.replace(
          '    steps:',
          '    env:\n      TSX_TSCONFIG_PATH: injected.json\n    steps:',
        );
      if (scope === 'step')
        content = content.replace(
          '        run:',
          '        env:\n          NODE_OPTIONS: --require ./injected.cjs\n        run:',
        );
      put(root, workflowFile, content);
      const sha256 = workflowStepInventory(content, root)[0]?.sha256;
      if (sha256 === undefined) throw new Error('Loader fixture digest missing');
      bind(root, [{ ...entry, sha256 }]);
      expect(effect(root)).toBe('unknown');
    },
  );

  it('refuses a symlink in the reviewed candidate closure', () => {
    const { root, entry } = fixture();
    bind(root, [entry]);
    rmSync(join(root, 'scripts/helper.ts'));
    symlinkSync('main.ts', join(root, 'scripts/helper.ts'));
    expect(effect(root)).toBe('unknown');
  });
});
