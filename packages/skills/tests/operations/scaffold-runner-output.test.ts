import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, expect, it } from 'vitest';
import { runScaffolder, type ScaffolderTargetTask } from '../../src/operations/scaffold/runner.js';
import type { StackAdapterPack } from '../../src/pack-resolver/index.js';
import { withAuthorityHostTestScope } from '../unit/authority-host-test-scope.js';

const roots: string[] = [];
aroundEach((runTest) => withAuthorityHostTestScope(runTest));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(
  tasks: readonly ScaffolderTargetTask[],
  allowed = tasks.map((task) => task.target_path),
) {
  const root = mkdtempSync(join(tmpdir(), 'devai-scaffold-output-'));
  roots.push(root);
  writeFileSync(
    join(root, 'blueprint.json'),
    readFileSync(new URL('./fixtures/blueprint.json', import.meta.url)),
  );
  writeFileSync(join(root, 'template.txt'), 'generated body\n');
  const run = () =>
    runScaffolder({
      spec: { operationId: 'fixture-scaffold', templateIds: ['fixture'], deriveTasks: () => tasks },
      ctx: {
        repoRoot: root,
        inputs: { blueprint_path: 'blueprint.json' },
        allowedPaths: allowed,
        canonicalPack: {
          id: 'fixture-pack',
          _packDir: root,
          templates: { fixture: { path: 'template.txt', consumed_by: 'fixture-scaffold' } },
        } as unknown as StackAdapterPack,
      },
    });
  return { root, run };
}

it.each([
  ['guide.md', '<!-- ', ' -->'],
  ['guide.HTML', '<!-- ', ' -->'],
  ['table.sql', '-- ', ''],
  ['table.SQL', '-- ', ''],
  ['ci.yml', '# ', ''],
  ['ci.YAML', '# ', ''],
  ['module.ts', '// ', ''],
  ['module.JS', '// ', ''],
])(
  'renders a language-appropriate provenance header for %s and preserves it on rerun',
  (name, prefix, suffix) => {
    const { root, run } = fixture([{ template_id: 'fixture', target_path: name }]);
    const first = run();
    expect(first.status).toBe('pass');
    const evidence = first.evidence as { blueprint_sha256: string };
    expect(evidence.blueprint_sha256).toMatch(/^[a-f0-9]{64}$/u);
    const text = readFileSync(join(root, name), 'utf8');
    expect(text).toBe(
      `${prefix}Generated from BP-DEMO-BOOKMARK-001 v1.0.0 sha256:${evidence.blueprint_sha256.slice(0, 8)}${suffix}\ngenerated body\n`,
    );
    expect(first.evidence).toMatchObject({
      schemaVersion: '1.0.0',
      files_created: [name],
      files_modified: [],
      idempotency: 'fresh',
    });
    expect(first.evidence).not.toHaveProperty('drift_report');
    const second = run();
    expect(second.status).toBe('pass');
    expect(second.evidence).toMatchObject({
      files_created: [],
      files_modified: [],
      idempotency: 'no-op',
      files_skipped: [{ path: name, reason: 'already_exists_no_template_change' }],
    });
    expect(readFileSync(join(root, name), 'utf8')).toBe(text);
  },
);

it('reports both drift hashes and preserves owner edits while creating a missing sibling', () => {
  const tasks = ['first.ts', 'second.ts'].map((target_path) => ({
    template_id: 'fixture',
    target_path,
  }));
  const { root, run } = fixture(tasks);
  expect(run().status).toBe('pass');
  const generated = readFileSync(join(root, 'first.ts'), 'utf8');
  const owner = 'owner edit\n';
  writeFileSync(join(root, 'first.ts'), owner);
  rmSync(join(root, 'second.ts'));
  const result = run();
  expect(result.status).toBe('review');
  expect(result.evidence).toMatchObject({
    files_created: ['second.ts'],
    files_modified: [],
    idempotency: 'drift-detected',
    drift_report: {
      differing_files: [
        { path: 'first.ts', expected_sha256: hash(generated), actual_sha256: hash(owner) },
      ],
    },
  });
  expect(readFileSync(join(root, 'first.ts'), 'utf8')).toBe(owner);
  expect(readFileSync(join(root, 'second.ts'), 'utf8')).toBe(generated);
});

it('refuses the entire output population before writing when only one target is authorized', () => {
  const { root, run } = fixture(
    [
      { template_id: 'fixture', target_path: 'allowed.ts' },
      { template_id: 'fixture', target_path: 'outside.ts' },
    ],
    ['allowed.ts'],
  );
  expect(run()).toMatchObject({
    status: 'fail',
    notes: ['derived scaffold output is absent from the exact invocation write_paths'],
  });
  expect(existsSync(join(root, 'allowed.ts'))).toBe(false);
  expect(existsSync(join(root, 'outside.ts'))).toBe(false);
});

it('passes per-task rendering flags without applying one task flags to another', () => {
  const { root, run } = fixture([
    { template_id: 'fixture', target_path: 'enabled.ts', flags: { feature: true } },
    { template_id: 'fixture', target_path: 'disabled.ts', flags: { feature: false } },
    { template_id: 'fixture', target_path: 'absent.ts' },
  ]);
  writeFileSync(
    join(root, 'template.txt'),
    'before <!-- IF:feature -->enabled <!-- ENDIF:feature -->after\n',
  );
  expect(run().status).toBe('pass');
  expect(readFileSync(join(root, 'enabled.ts'), 'utf8')).toContain('\nbefore enabled after\n');
  for (const name of ['disabled.ts', 'absent.ts'])
    expect(readFileSync(join(root, name), 'utf8')).toContain('\nbefore after\n');
});
