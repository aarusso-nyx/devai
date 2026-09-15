import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const { checkMutationFreeDelivery } = await import(
  pathToFileURL(resolve('scripts/check-mutation-free-delivery.mjs')).href
);
const roots: string[] = [];
function fixture(body: string) {
  const root = mkdtempSync(join(tmpdir(), 'delivery-'));
  roots.push(root);
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  writeFileSync(
    join(root, '.github/workflows/test.yml'),
    `on: workflow_dispatch\njobs:\n  test:\n    steps:\n      - run: ${body}\n`,
  );
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
it.each([
  'npx stryker run',
  'npx @stryker-mutator/core@9.6.1 run',
  'node node_modules/@stryker-mutator/core/bin/stryker.js run',
  'bedel run --all',
  'bedel resume prior',
  'pnpm test:mutation',
])('rejects explicit mutation execution in any CI trigger: %s', (body) => {
  expect(checkMutationFreeDelivery(fixture(body)).ok).toBe(false);
});
it('retains ordinary historical report-reader tests', () => {
  expect(checkMutationFreeDelivery(fixture('pnpm test:mutation-report-readers')).ok).toBe(true);
  expect(checkMutationFreeDelivery(fixture('pnpm test:mutation:report-readers')).ok).toBe(true);
  expect(
    checkMutationFreeDelivery(fixture('pnpm exec vitest run mutation-report.test.ts')).ok,
  ).toBe(true);
});
it('prevents accidental engine installation in DEVAI', () => {
  const root = fixture('pnpm test');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ devDependencies: { '@stryker-mutator/core': '9.6.1' } }),
  );
  expect(checkMutationFreeDelivery(root).violations).toContain(
    'package.json: @stryker-mutator/core',
  );
});
it('accepts the current mutation-free delivery manifests and workflows', () => {
  expect(checkMutationFreeDelivery(resolve('.'))).toEqual({ ok: true, violations: [] });
});

function put(root: string, name: string, content: string) {
  const path = join(root, name);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, content);
}
it('inspects all declared workspaces, including nonstandard directories', () => {
  const root = fixture('pnpm -r test');
  put(root, 'pnpm-workspace.yaml', 'packages:\n  - tools/*\n');
  put(
    root,
    'tools/hardener/package.json',
    JSON.stringify({ scripts: { test: 'npx stryker run' } }),
  );
  expect(checkMutationFreeDelivery(root).ok).toBe(false);
});
it('rejects workspace engine dependencies without matching ordinary mutation test names', () => {
  const root = fixture('pnpm test');
  put(
    root,
    'packages/library/package.json',
    JSON.stringify({ devDependencies: { '@stryker-mutator/core': '9.6.1' } }),
  );
  expect(checkMutationFreeDelivery(root).violations).toContain(
    'packages/library/package.json: @stryker-mutator/core',
  );
});
it('inspects task argv regardless of task identity', () => {
  const root = fixture('pnpm test');
  put(
    root,
    'test-tasks.json',
    JSON.stringify({
      tasks: [{ nodeId: 'ordinary-looking', argv: ['npx', 'stryker', 'run'], cwd: '.' }],
    }),
  );
  expect(checkMutationFreeDelivery(root).ok).toBe(false);
});
it('follows a task wrapper, its imported helper, and subprocess argv', () => {
  const root = fixture('pnpm test');
  put(
    root,
    'test-tasks.json',
    JSON.stringify({
      tasks: [{ nodeId: 'ordinary-looking', argv: ['node', 'scripts/launch.mjs'], cwd: '.' }],
    }),
  );
  put(root, 'scripts/launch.mjs', "import './helper.mjs';\n");
  put(
    root,
    'scripts/helper.mjs',
    "import { spawnSync } from 'node:child_process'; spawnSync('npx', ['stryker', 'run']);\n",
  );
  expect(checkMutationFreeDelivery(root).violations).toContain(
    'scripts/helper.mjs: mutation execution',
  );
});
it('follows interpreter wrappers relative to process cwd, not script location', () => {
  const root = fixture('node scripts/launch.mjs');
  put(
    root,
    'scripts/launch.mjs',
    "import { spawnSync } from 'node:child_process'; spawnSync('node', ['scripts/next.mjs']);\n",
  );
  put(
    root,
    'scripts/next.mjs',
    "import { execSync } from 'node:child_process'; execSync('bedel run --all');\n",
  );
  expect(checkMutationFreeDelivery(root).violations).toContain(
    'scripts/next.mjs: mutation execution',
  );
});
it('follows package script aliases and shell indirection', () => {
  const root = fixture('pnpm test');
  put(
    root,
    'package.json',
    JSON.stringify({ scripts: { test: 'pnpm run checks', checks: 'bash scripts/check.sh' } }),
  );
  put(root, 'scripts/check.sh', 'echo start; node scripts/launch.mjs\n');
  put(
    root,
    'scripts/launch.mjs',
    "import { execSync } from 'node:child_process'; execSync('npx stryker run');\n",
  );
  expect(checkMutationFreeDelivery(root).ok).toBe(false);
});
it('follows reusable workflows and composite actions', () => {
  const root = fixture('pnpm test');
  put(
    root,
    '.github/workflows/test.yml',
    'on: push\njobs:\n  check:\n    uses: ./.github/workflows/reusable.yml\n',
  );
  put(
    root,
    '.github/workflows/reusable.yml',
    'on: workflow_call\njobs:\n  check:\n    steps:\n      - uses: ./.github/actions/check\n',
  );
  put(
    root,
    '.github/actions/check/action.yml',
    'name: check\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: node scripts/check.mjs\n',
  );
  put(
    root,
    'scripts/check.mjs',
    "import { execSync } from 'node:child_process'; execSync('bedel resume prior');\n",
  );
  expect(checkMutationFreeDelivery(root).ok).toBe(false);
});
it('follows local JavaScript action entrypoints', () => {
  const root = fixture('pnpm test');
  put(
    root,
    '.github/workflows/test.yml',
    'on: push\njobs:\n  check:\n    steps:\n      - uses: ./.github/actions/check\n',
  );
  put(
    root,
    '.github/actions/check/action.yml',
    'name: check\nruns:\n  using: node24\n  main: index.js\n',
  );
  put(root, '.github/actions/check/index.js', "const engine = require('@stryker-mutator/core');\n");
  expect(checkMutationFreeDelivery(root).ok).toBe(false);
});
it('terminates cyclic wrapper imports and treats historical data as nonexecution', () => {
  const root = fixture('node scripts/a.mjs');
  put(root, 'scripts/a.mjs', "import './b.mjs'; const historical = 'npx stryker run';\n");
  put(
    root,
    'scripts/b.mjs',
    "import './a.mjs'; const testName = 'source-write-mutation.test.ts';\n",
  );
  expect(checkMutationFreeDelivery(root)).toEqual({ ok: true, violations: [] });
});
