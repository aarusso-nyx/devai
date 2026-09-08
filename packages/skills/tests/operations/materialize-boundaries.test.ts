import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, aroundEach, beforeEach, describe, expect, it } from 'vitest';
import { listOperations } from '../../src/operations/index.js';
import { executeMaterializeOperation } from '../../src/operations/materialize.js';
import type { OperationHostRequest, OperationId } from '../../src/operations/types.js';
import { loadRecipe } from '../../src/recipes/index.js';
import { withAuthorityHostTestScope } from '../unit/authority-host-test-scope.js';

let parent: string;
let root: string;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'materialize-boundaries-'));
  root = join(parent, 'candidate');
  mkdirSync(root);
});
afterEach(() => rmSync(parent, { recursive: true, force: true }));
aroundEach((runTest) => withAuthorityHostTestScope(runTest));

function request(
  operation: OperationId,
  write_paths: string[],
  inputs?: Record<string, unknown>,
): OperationHostRequest {
  const recipe = operation === 'scaffold.tests-from-docs' ? 'devai-scaffold' : 'devai-round';
  const variant =
    operation === 'scaffold.tests-from-docs' ? 'tests-from-docs' : (operation.split('.')[1] ?? '');
  const definition = listOperations().find((item) => item.id === operation);
  const variant_contract = loadRecipe(recipe).manifest.variants[variant];
  if (!definition || !variant_contract) throw new Error('fixture contract is unavailable');
  return {
    recipe,
    variant,
    operation,
    repo_root: root,
    write_paths,
    ...(inputs && { inputs }),
    definition,
    variant_contract,
  };
}
function materializeSuccessfully(input: OperationHostRequest) {
  let result: ReturnType<typeof executeMaterializeOperation> | undefined;
  expect(() => {
    result = executeMaterializeOperation(input);
  }).not.toThrow();
  return result;
}

function file(path: string, content = 'export const example = "ação";\n') {
  return { path, content, source_documents: ['docs/Z.md', 'docs/A.md', 'docs/Z.md'] };
}
function put(path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

const a = 'packages/demo/tests/a.test.ts';
const z = 'packages/demo/tests/z.test.ts';

describe('materialized candidate writes', () => {
  it('matches unordered exact write sets, deduplicates sorted source evidence and skips identical output', () => {
    const first = file(a);
    const last = file(z, 'last\n');
    put(a, first.content);
    const input = request('scaffold.tests-from-docs', [z, a], { files: [first, last] });
    expect(materializeSuccessfully(input)).toEqual({
      operation: input.operation,
      status: 'pass',
      evidence: { source_documents: ['docs/A.md', 'docs/Z.md'], written: [z], unchanged: [a] },
    });
    expect(readFileSync(join(root, a), 'utf8')).toBe(first.content);
    expect(readFileSync(join(root, z), 'utf8')).toBe(last.content);
    expect(materializeSuccessfully(input)).toEqual({
      operation: input.operation,
      status: 'skipped',
      evidence: { source_documents: ['docs/A.md', 'docs/Z.md'], written: [], unchanged: [a, z] },
    });
  });

  it('reports every drifted file and creates no earlier missing output', () => {
    put(a, 'adopter a\n');
    put(z, 'adopter z\n');
    const missing = 'packages/demo/tests/missing.test.ts';
    const input = request('scaffold.tests-from-docs', [missing, a, z], {
      files: [file(missing), file(a), file(z)],
    });
    expect(materializeSuccessfully(input)).toEqual({
      operation: input.operation,
      status: 'review',
      evidence: { source_documents: ['docs/A.md', 'docs/Z.md'], drifted: [a, z] },
    });
    expect(existsSync(join(root, missing))).toBe(false);
    expect(readFileSync(join(root, a), 'utf8')).toBe('adopter a\n');
    expect(readFileSync(join(root, z), 'utf8')).toBe('adopter z\n');
  });

  it.each([undefined, null, [], 'files'].map((files) => ({ files })))(
    'refuses absent or empty file population: $files',
    ({ files }) => {
      expect(() =>
        executeMaterializeOperation(request('scaffold.tests-from-docs', [a], { files })),
      ).toThrow('OPERATION_INPUT_REQUIRED:files');
      expect(readdirSync(root)).toEqual([]);
    },
  );

  it.each(
    [
      null,
      [],
      'candidate',
      7,
      { ...file(a), path: 7 },
      { ...file(a), content: false },
      { ...file(a), source_documents: undefined },
      { ...file(a), source_documents: [] },
      { ...file(a), source_documents: ['docs/valid.md', 'README.md'] },
      { ...file(a), source_documents: ['docs/valid.md', 42] },
    ].map((candidate) => ({ candidate })),
  )('refuses malformed candidate before any write: $candidate', ({ candidate }) => {
    expect(() =>
      executeMaterializeOperation(request('scaffold.tests-from-docs', [a], { files: [candidate] })),
    ).toThrow('OPERATION_INPUT_INVALID:files');
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses duplicate output identities even if their contents agree', () => {
    expect(() =>
      executeMaterializeOperation(
        request('scaffold.tests-from-docs', [a], { files: [file(a), file(a)] }),
      ),
    ).toThrow('OPERATION_INPUT_DUPLICATE_PATH');
    expect(readdirSync(root)).toEqual([]);
  });

  it.each([[a, z], [z], []].map((paths) => ({ paths })))(
    'refuses unmatched approved and supplied paths: $paths',
    ({ paths }) => {
      expect(() =>
        executeMaterializeOperation(
          request('scaffold.tests-from-docs', paths, { files: [file(a)] }),
        ),
      ).toThrow('OPERATION_INPUT_WRITE_PATH_MISMATCH');
      expect(readdirSync(root)).toEqual([]);
    },
  );

  it.each(['../outside.ts', 'nested/../../outside.ts', '.'])(
    'refuses %s before creating any output',
    (path) => {
      expect(() =>
        executeMaterializeOperation(
          request('scaffold.tests-from-docs', [path], { files: [file(path)] }),
        ),
      ).toThrow(`OPERATION_WRITE_PATH_ESCAPE:${path}`);
      expect(readdirSync(root)).toEqual([]);
      expect(readdirSync(parent)).toEqual(['candidate']);
    },
  );
});

describe('round preview materialization', () => {
  it.each([
    { paths: [] },
    { paths: ['.devai/state/round-runs/R-1/plan.json', '.devai/state/round-runs/R-2/plan.json'] },
  ])('requires exactly one preview destination: $paths', ({ paths }) => {
    expect(() =>
      executeMaterializeOperation(request('round.plan.preview', paths, { plan: {} })),
    ).toThrow('OPERATION_PREVIEW_EXACT_PATH_REQUIRED');
    expect(readdirSync(root)).toEqual([]);
  });

  it.each([
    ['plan', 'plan', { tasks: ['T-2', 'T-1'] }],
    ['run', 'child_results', [{ task: 'T-1', status: 'pass' }]],
    ['close', 'verification', { complete: true, checks: ['verified'] }],
  ] as const)(
    'writes the exact %s phase payload and repeats without writing',
    (phase, key, payload) => {
      const path = `.devai/state/round-runs/R-1/${phase}.json`;
      const operation = `round.${phase}.preview` as OperationId;
      const input = request(operation, [path], { [key]: payload });
      expect(materializeSuccessfully(input)).toEqual({
        operation,
        status: 'pass',
        evidence: { phase, written: [path], unchanged: [] },
      });
      expect(JSON.parse(readFileSync(join(root, path), 'utf8'))).toEqual({
        schemaVersion: '1.0.0',
        operation,
        phase,
        round_run_id: 'R-1',
        [key]: payload,
      });
      expect(readFileSync(join(root, path), 'utf8').endsWith('\n')).toBe(true);
      expect(materializeSuccessfully(input)).toEqual({
        operation,
        status: 'skipped',
        evidence: { phase, written: [], unchanged: [path] },
      });
    },
  );

  it.each([null, [], 'plan', 1].map((plan) => ({ plan })))(
    'refuses invalid plan payload $plan',
    ({ plan }) => {
      expect(() =>
        executeMaterializeOperation(
          request('round.plan.preview', ['.devai/state/round-runs/R-1/plan.json'], { plan }),
        ),
      ).toThrow('OPERATION_INPUT_REQUIRED:plan');
      expect(readdirSync(root)).toEqual([]);
    },
  );

  it.each([undefined, [], {}, 'results'].map((child_results) => ({ child_results })))(
    'refuses empty or invalid run results $child_results',
    ({ child_results }) => {
      expect(() =>
        executeMaterializeOperation(
          request('round.run.preview', ['.devai/state/round-runs/R-1/run.json'], { child_results }),
        ),
      ).toThrow('OPERATION_INPUT_REQUIRED:child_results');
      expect(readdirSync(root)).toEqual([]);
    },
  );

  it.each([undefined, false, 'true', 1])(
    'requires literal completed verification, not %j',
    (complete) => {
      expect(() =>
        executeMaterializeOperation(
          request('round.close.preview', ['.devai/state/round-runs/R-1/close.json'], {
            verification: { complete },
          }),
        ),
      ).toThrow('OPERATION_PREVIEW_CLOSE_INCOMPLETE');
      expect(readdirSync(root)).toEqual([]);
    },
  );

  it.each([
    'prefix/.devai/state/round-runs/R-1/plan.json',
    '.devai/state/round-runs/R-1/plan.json.backup',
    '.devai/state/round-runs/R-1/run.json',
    '.devai/state/round-runs/-invalid/plan.json',
  ])('refuses a preview path outside its exact phase contract: %s', (path) => {
    expect(() =>
      executeMaterializeOperation(request('round.plan.preview', [path], { plan: {} })),
    ).toThrow('OPERATION_PREVIEW_PATH_INVALID');
    expect(readdirSync(root)).toEqual([]);
  });
});
