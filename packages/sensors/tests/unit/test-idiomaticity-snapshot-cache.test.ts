// ADR-SCR-0017: reused local analysis must preserve each root's complete helper graph.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestMockClassifier } from '../../src/test-mock-classification.js';
import { senseTestIdiomaticity } from '../../src/test-idiomaticity.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-mock-snapshot-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function put(path: string, body: string | object) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof body === 'string' ? body : JSON.stringify(body));
}
const observer = "import {port} from '../src/port.js'; vi.spyOn(port, 'read');";
const replacement =
  "import {port} from '../src/port.js'; vi.spyOn(port, 'read').mockResolvedValue(0);";
function graph(helper = replacement) {
  put('tsconfig.json', { compilerOptions: { moduleResolution: 'NodeNext' }, include: ['**/*'] });
  put('src/port.ts', 'export const port = { async read() { return 42; } };');
  put('support/a.ts', "import './b.js'; import './c.js';");
  put('support/b.ts', "import './shared.js';");
  put('support/c.ts', "import './shared.js';");
  put('support/shared.ts', `import './a.js'; ${helper}`);
  for (const name of ['first', 'second'])
    put(
      `tests/integration/${name}.test.ts`,
      "import '../../support/a.js'; it('uses the graph', () => expect(1).toBe(1));",
    );
}
const measure = () => senseTestIdiomaticity({ repoRoot: root, testGlobs: ['tests'] });

it('counts a shared diamond/cycle once per test root without enumerating config include paths', () => {
  graph();
  const directories = vi.spyOn(ts.sys, 'readDirectory');
  const reads = vi.spyOn(ts.sys, 'readFile');
  const reading = measure();
  expect(reading.metrics).toMatchObject({
    test_files: 2,
    mock_calls: 2,
    mocks_in_integration_files: 2,
  });
  expect(
    reading.findings
      ?.filter((finding) => finding.code === 'TEST_IDIOMATICITY_MOCK_IN_INTEGRATION')
      .map((finding) => finding.file)
      .sort(),
  ).toEqual(['tests/integration/first.test.ts', 'tests/integration/second.test.ts']);
  expect(directories).not.toHaveBeenCalled();
  expect(reads.mock.calls.filter(([path]) => path === join(root, 'tsconfig.json'))).toHaveLength(1);
});

it('rebuilds helper facts on the next sensor invocation after owned implementation bytes change', () => {
  graph(observer);
  expect(measure()).toMatchObject({
    status: 'pass',
    metrics: { mock_calls: 0, call_through_observers: 2 },
  });
  put('support/shared.ts', `import './a.js'; ${replacement}`);
  expect(measure()).toMatchObject({
    status: 'review',
    metrics: { mock_calls: 2, call_through_observers: 0 },
  });
  put('support/shared.ts', `import './a.js'; ${observer}`);
  expect(measure()).toMatchObject({
    status: 'pass',
    metrics: { mock_calls: 0, call_through_observers: 2 },
  });
});

it('resolves changed compiler paths afresh without carrying owned classification across invocations', () => {
  put('src/port.ts', 'export const port = {};');
  put('node_modules/external/port.ts', 'export const port = {};');
  const config = (target: string) => ({
    compilerOptions: {
      moduleResolution: 'NodeNext',
      baseUrl: '.',
      paths: { '@selected/port': [target] },
    },
  });
  const file = join(root, 'tests/integration/selection.test.ts');
  const body = "vi.mock('@selected/port', () => ({}));";
  put('tests/integration/selection.test.ts', body);
  put('tsconfig.json', config('src/port.ts'));
  expect(createTestMockClassifier(root)(file, body)).toMatchObject({
    mocks: 1,
    ownedSubstitutions: 1,
    externalPorts: 0,
  });
  put('tsconfig.json', config('node_modules/external/port.ts'));
  expect(createTestMockClassifier(root)(file, body)).toMatchObject({
    mocks: 0,
    ownedSubstitutions: 0,
    externalPorts: 1,
  });
  put('tsconfig.json', config('missing/port.ts'));
  expect(createTestMockClassifier(root)(file, body)).toMatchObject({
    mocks: 1,
    ownedSubstitutions: 0,
    unresolved: 1,
  });
});
