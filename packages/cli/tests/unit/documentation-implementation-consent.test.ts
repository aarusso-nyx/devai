// ADR-AUT-0009 native admission controls. No successful context/receipt is fabricated.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
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
const _POLICY = '.devai/config/authority-policy.json';
const _RECEIPT = '.devai/config/adopter-policy-binding.json';
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
function _parsed(root: string, path: string) {
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
// Observe real native issuance. The negative invocation uses the genuine still-unused
// declaration receipt with mismatched consent; it never fabricates a successful context.
const derivations = vi.hoisted(() => [] as { refused: unknown; result: unknown }[]);
vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  return {
    ...actual,
    deriveMachineAuthorityContext: (
      ...args: Parameters<typeof actual.deriveMachineAuthorityContext>
    ) => {
      const input = args[0];
      assert(input !== null && typeof input === 'object');
      const refused = actual.deriveMachineAuthorityContext(
        { ...input, consent: { write: false, allow_publish: false, experimental: false } },
        args[1],
      );
      const result = actual.deriveMachineAuthorityContext(...args);
      derivations.push({ refused, result });
      return result;
    },
  };
});

describe('selected docs native derived principal and explicit consent', () => {
  it('uses the actual harness context and refuses missing consent without consuming its genuine receipt', async () => {
    const root = await fixture(),
      a = await apis();
    const entry = a.registry.canonicalRegistry().find((value) => value.name === 'task start');
    assert(entry);
    expect(entry.authority_contract.subject).toEqual({
      kind: 'derived-machine',
      actor: 'harness',
      transition: 'harness-write',
      initiator: { allowed_roles: ['engineer'], preserve_in_context: true },
    });
    derivations.length = 0;
    const target = files[0];
    assert(target);
    const operation = vi.fn(() =>
      writeFileSync(join(root, target), '// native derived principal\n'),
    );
    const h = host(root, a);
    try {
      h.scope.apply_effect(
        {
          kind: 'filesystem',
          symbol: 'writeFileSync',
          arguments: [join(root, target), '// native derived principal\n'],
        },
        operation,
      );
      expect(operation).toHaveBeenCalledOnce();
      expect(text(root, target)).toBe('// native derived principal\n');
      expect(derivations).toHaveLength(1);
      expect(derivations[0]?.refused).toMatchObject({
        ok: false,
        code: 'AUTHORITY_DECLARATION_RECEIPT_BINDING_MISMATCH',
      });
      expect(derivations[0]?.result).toMatchObject({
        ok: true,
        value: {
          context: {
            kind: 'trusted-transition',
            principal: {
              kind: 'machine',
              actor: 'harness',
              derivation: {
                action_id: 'task start',
                transition: 'harness-write',
                trusted_adapter_id: 'devai-cli-authority',
              },
            },
            initiated_by: { role: 'engineer' },
            consent: { write: true, allow_publish: false, experimental: false },
          },
        },
      });
    } finally {
      h.dispose();
    }
  });

  it('refuses an actual CLI task-start invocation without write consent before selected file mutation', async () => {
    const root = await fixture();
    const before = Object.fromEntries(files.map((file) => [file, text(root, file)]));
    const result = await runCli([
      'task',
      'start',
      '--round',
      'R-0007',
      '--task',
      'TASK-7001',
      '--repo-root',
      root,
      '--as-role',
      'engineer',
    ]);
    expect(result.exit).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('AUTHORITY_WRITE_CONSENT_REQUIRED');
    expect(Object.fromEntries(files.map((file) => [file, text(root, file)]))).toEqual(before);
  });
});
