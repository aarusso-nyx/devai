// ADR-AUT-0009 native admission controls. No successful context/receipt is fabricated.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  existsSync,
  renameSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync as _symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SOURCE = 'law/policy/docs-implementation.json';
const POLICY = '.devai/config/authority-policy.json';
const RECEIPT = '.devai/config/adopter-policy-binding.json';
const files = [
  'docs/site/docusaurus.config.js',
  'docs/site/scripts/generate-api-reference.mjs',
  'docs/site/scripts/run-lighthouse.mjs',
  'docs/site/scripts/sync-content.mjs',
  'docs/site/scripts/verify-api-reference.mjs',
];
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function put(root: string, path: string, value: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
}
function text(root: string, path: string) {
  return readFileSync(join(root, path), 'utf8');
}
function record(value: unknown): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
}
function parsed(root: string, path: string) {
  const value: unknown = JSON.parse(text(root, path));
  record(value);
  return value;
}
// Same genuine in-process CLI fixture mechanism as existing materialization tests.
async function runCli(args: readonly string[]) {
  vi.resetModules();
  const old = {
    argv: process.argv,
    exitCode: process.exitCode,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', ...args, '--format', 'json'];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    await import('../../src/bin.js');
    await new Promise<void>((done) => setImmediate(done));
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = old.argv;
    process.exitCode = old.exitCode;
    process.stdout.write = old.stdout;
    process.stderr.write = old.stderr;
  }
}
function source(withBlock = true) {
  return JSON.stringify({
    schemaVersion: '1.0.0',
    policy_id: 'inspector.docs',
    policy_version: '1.0.0',
    ...(withBlock ? { documentation_implementation: { files } } : {}),
  });
}
async function bind(root: string) {
  const result = await runCli([
    'init',
    'bind',
    '--adopter-policy',
    SOURCE,
    '--target',
    root,
    '--as-role',
    'architect',
    '--write',
  ]);
  expect(result.exit, `${result.stdout}\n${result.stderr}`).toBe(0);
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-docs-native-')));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const result = await runCli([
    'init',
    'bind',
    '--full',
    '--tier',
    'tier1',
    '--target',
    root,
    '--as-role',
    'architect',
    '--write',
  ]);
  expect(result.exit, `${result.stdout}\n${result.stderr}`).toBe(0);
  for (const path of files) put(root, path, 'export {};\n');
  put(root, 'docs/site/sidebars.js', 'export {};\n');
  put(root, SOURCE, source());
  await bind(root);
  return root;
}
// Import all context consumers after the last reset so they share the actual native WeakMap.
async function apis() {
  return {
    native: await import('@devai-nyx/authority'),
    cli: await import('../../src/authority/documentation-context.js'),
    broker: await import('../../src/authority/broker.js'),
    registry: await import('../../src/define-command.js'),
    version: await import('../../src/version.js'),
    paths: await import('@devai-nyx/spec'),
    frames: await import('@devai-nyx/spec'),
    mutations: await import('@devai-nyx/spec'),
    scope: await import('../../src/services/write-scope/index.js'),
  };
}
type APIs = Awaited<ReturnType<typeof apis>>;
function host(root: string, a: APIs) {
  const entries = a.registry.canonicalRegistry();
  const entry = entries.find((v) => v.name === 'task start');
  assert(entry);
  return a.broker.createAuthorityHostBroker({
    entry,
    entries,
    argv: [
      process.execPath,
      'devai',
      'task',
      'start',
      '--round',
      'R-0007',
      '--task',
      'TASK-7001',
      '--as-role',
      'engineer',
      '--write',
    ],
    role: 'engineer',
    declaration: { as_role: 'engineer' },
    repository_root: root,
    package_version: a.version.resolveCliVersion(),
    bootstrap_policy: false,
  });
}
function _frame(
  path: string,
  context: object,
): Parameters<APIs['frames']['evaluateTranslationFrames']>[0] {
  return {
    documentation_authority: context,
    witness: {
      strategy: 'regression',
      touched: [path],
      red_green: [{ test_ref: 'tests/docs.test.ts' }],
      frame: {
        authority_role: 'engineer',
        inventory_delta_confined_to: ['core'],
        effects_claimed: ['fs:plant'],
      },
    },
    registered_test_refs: ['tests/docs.test.ts'],
    task_scope: [path],
    diff_paths: [path],
    base_executions: [
      {
        test_ref: 'tests/docs.test.ts',
        outcome: 'fail',
        failure_mode: 'assertion',
      },
    ],
    candidate_executions: [
      { test_ref: 'tests/docs.test.ts', outcome: 'pass', failure_mode: 'none' },
    ],
    weakening_clean: true,
    inventory_delta_modules: ['core'],
    inferred_effects: ['fs:plant'],
    expected_state_changes: [],
    observed_state_changes: [],
    strategy_coverage: { status: 'pass' },
  };
}
function _tamperUnrelatedCore(root: string) {
  const policy = parsed(root, POLICY);
  const rules = policy['rules'];
  assert(Array.isArray(rules));
  const selected = rules.filter((row: unknown) => {
    record(row);
    return String(row['rule_id']).startsWith('core-documentation-implementation-');
  });
  const before = JSON.stringify(selected);
  const receipt = text(root, RECEIPT);
  const target = rules.find((row: unknown) => {
    record(row);
    return (
      row['origin'] === 'immutable-core' &&
      !String(row['rule_id']).startsWith('core-documentation-implementation-')
    );
  });
  record(target);
  assert.equal(typeof target['rationale'], 'string');
  target['rationale'] += ' Inspector unrelated-core tamper sentinel.';
  put(root, POLICY, JSON.stringify(policy));
  expect(JSON.stringify(selected)).toBe(before);
  expect(text(root, RECEIPT)).toBe(receipt);
}

// Transparent observation of the actual resolver. No result or native receipt is replaced.
const resolutions = vi.hoisted(() => [] as { query: unknown; result: unknown }[]);
vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  return {
    ...actual,
    resolveAuthorityPolicy: (...args: Parameters<typeof actual.resolveAuthorityPolicy>) => {
      const result = actual.resolveAuthorityPolicy(...args);
      resolutions.push({ query: args[1], result });
      return result;
    },
  };
});
const cases = [
  ['selected-to-unselected', files[0], 'docs/site/sidebars.js', false],
  ['unselected-to-selected', 'docs/site/sidebars.js', files[1], false],
  ['selected-to-selected', files[0], files[1], true],
  ['independent-to-selected', 'packages/core/src/endpoint.ts', files[1], true],
  ['selected-to-independent', files[0], 'packages/core/src/endpoint.ts', true],
] as const;
describe('native rename endpoints independently authorized', () => {
  for (const [name, from, to, allowed] of cases)
    it(name, async () => {
      assert(from && to);
      const root = await fixture();
      put(root, 'packages/core/src/endpoint.ts', '// independent source\n');
      const a = await apis();
      const h = host(root, a);
      resolutions.length = 0;
      const before = { source: text(root, from), destination: text(root, to) };
      const operation = vi.fn(() => renameSync(join(root, from), join(root, to)));
      let caught: unknown;
      try {
        h.scope.apply_effect(
          {
            kind: 'filesystem',
            symbol: 'renameSync',
            arguments: [join(root, from), join(root, to)],
          },
          operation,
        );
      } catch (error) {
        caught = error;
      } finally {
        h.dispose();
      }
      const observation = {
        name,
        from,
        to,
        allowed,
        calls: operation.mock.calls.length,
        error: caught === undefined ? null : String(caught),
        before,
        after: {
          sourceExists: existsSync(join(root, from)),
          source: existsSync(join(root, from)) ? text(root, from) : null,
          destination: text(root, to),
        },
        resolutions,
      };
      expect(resolutions.length).toBeGreaterThan(0);
      const last = resolutions.at(-1);
      assert(last);
      record(last.query);
      record(last.result);
      expect(last.query.resource).toMatchObject({
        operation: 'rename',
        canonical_relative_path: to,
        rename_from_canonical_relative_path: from,
      });
      if (allowed) {
        expect(caught).toBeUndefined();
        expect(operation).toHaveBeenCalledOnce();
        expect(observation.after.sourceExists).toBe(false);
        expect(observation.after.destination).toBe(before.source);
        expect(last.result.outcome).toBe('allow');
      } else {
        expect(caught).toBeDefined();
        expect(operation).not.toHaveBeenCalled();
        expect(observation.after.source).toBe(before.source);
        expect(observation.after.destination).toBe(before.destination);
        expect(last.result.outcome).toBe('deny');
      }
    });
});
