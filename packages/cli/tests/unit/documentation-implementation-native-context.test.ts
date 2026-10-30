// ADR-AUT-0009 native admission controls. No successful context/receipt is fabricated.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
function frame(
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
function tamperUnrelatedCore(root: string) {
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

describe('ordinary bound native documentation context', () => {
  it('uses genuine bind, native handle, all selected classifiers and actual broker writes', async () => {
    const root = await fixture();
    const a = await apis();
    const context = a.native.loadBoundDocumentationImplementation(root);
    expect(context).toBeDefined();
    assert(context);
    expect(a.cli.loadDocumentationImplementationContext(root)).toBeDefined();
    const h = host(root, a);
    try {
      for (const path of files) {
        expect(a.native.documentationImplementationOwnsPath(context, path)).toBe(true);
        expect(a.scope.article6Role(path, context)).toBe('engineer');
        expect(a.paths.classifyTranslationPath('engineer', path, context)).toEqual({
          allowed: true,
          effect: 'fs:plant',
        });
        for (const role of ['owner', 'architect', 'inspector', 'auditor'] as const)
          expect(a.paths.classifyTranslationPath(role, path, context).allowed).toBe(false);
        expect(a.frames.evaluateTranslationFrames(frame(path, context)).verdict).toBe('PASS');
        const operation = vi.fn(() =>
          writeFileSync(join(root, path), '// governed actual write\n'),
        );
        h.scope.apply_effect(
          {
            kind: 'filesystem',
            symbol: 'writeFileSync',
            arguments: [join(root, path), '// governed actual write\n'],
          },
          operation,
        );
        expect(operation).toHaveBeenCalledOnce();
        expect(text(root, path)).toBe('// governed actual write\n');
      }
      const unselected = 'docs/site/sidebars.js';
      const operation = vi.fn();
      expect(a.native.documentationImplementationOwnsPath(context, unselected)).toBe(false);
      expect(() =>
        h.scope.apply_effect(
          {
            kind: 'filesystem',
            symbol: 'writeFileSync',
            arguments: [join(root, unselected), 'wrong'],
          },
          operation,
        ),
      ).toThrow();
      expect(operation).not.toHaveBeenCalled();
      expect(text(root, unselected)).toBe('export {};\n');
    } finally {
      h.dispose();
    }
  });

  it('refuses a forged DI context and leaves missing-context defaults unchanged', async () => {
    const a = await apis();
    const path = files[0];
    assert(path);
    expect(() => a.native.documentationImplementationOwnsPath({}, path)).toThrow(
      'DOCUMENTATION_IMPLEMENTATION_CONTEXT_BINDING_MISMATCH',
    );
    expect(a.paths.classifyTranslationPath('engineer', path)).toEqual({
      allowed: false,
      effect: 'fs:architect-spec',
    });
    expect(a.paths.classifyTranslationPath('architect', path)).toEqual({
      allowed: true,
      effect: 'fs:architect-spec',
    });
  });

  it('rereads policy at the host mutation boundary and refuses before callback', async () => {
    const root = await fixture();
    const a = await apis();
    const h = host(root, a);
    const path = files[0];
    assert(path);
    const original = text(root, path);
    try {
      tamperUnrelatedCore(root);
      const operation = vi.fn(() => writeFileSync(join(root, path), 'unauthorized'));
      expect(() =>
        h.scope.apply_effect(
          {
            kind: 'filesystem',
            symbol: 'writeFileSync',
            arguments: [join(root, path), 'unauthorized'],
          },
          operation,
        ),
      ).toThrow();
      expect(operation).not.toHaveBeenCalled();
      expect(text(root, path)).toBe(original);
    } finally {
      h.dispose();
    }
  });

  it('refuses fresh exported native issuance after unrelated core tampering', async () => {
    const root = await fixture();
    const a = await apis();
    expect(a.native.loadBoundDocumentationImplementation(root)).toBeDefined();
    tamperUnrelatedCore(root);
    // This is a new full-resolution security sentinel, not a baseline success oracle.
    expect(() => a.cli.loadDocumentationImplementationContext(root)).toThrow();
    expect(() => a.native.loadBoundDocumentationImplementation(root)).toThrow();
  });

  it('cannot authorize direct spec consumers through a freshly minted post-tamper handle', async () => {
    const root = await fixture();
    const a = await apis();
    tamperUnrelatedCore(root);
    // A correct loader may stop this path before a handle exists. If it returns a handle,
    // require each direct consumer to refuse it, including the native mutation entrypoint.
    let context: object;
    try {
      context = a.native.loadBoundDocumentationImplementation(root);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/DOCUMENTATION_IMPLEMENTATION|AUTHORITY_POLICY/);
      return;
    }
    const path = files[0];
    assert(path);
    expect.soft(() => a.paths.classifyTranslationPath('engineer', path, context)).toThrow();
    expect.soft(() => a.frames.evaluateTranslationFrames(frame(path, context))).toThrow();
    const run = vi.fn(async () => undefined);
    await expect
      .soft(
        a.mutations.recordMutationCandidate({
          repo_root: root,
          intent: {},
          documentation_authority: context,
          emitted_at: '2026-10-25T00:00:00.000Z',
          run,
        }),
      )
      .rejects.toThrow(/DOCUMENTATION_IMPLEMENTATION|AUTHORITY_POLICY/);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses foreign repository handles and selected symlink replacement', async () => {
    const root = await fixture();
    const a = await apis();
    const context = a.native.loadBoundDocumentationImplementation(root);
    const foreign = realpathSync(mkdtempSync(join(tmpdir(), 'devai-docs-foreign-')));
    roots.push(foreign);
    expect(() => a.native.assertDocumentationContextRepository(context, foreign)).toThrow();
    const path = files[0];
    assert(path);
    const target = join(root, path);
    rmSync(target);
    symlinkSync(join(root, 'docs/site/sidebars.js'), target);
    expect(() => a.native.documentationImplementationOwnsPath(context, path)).toThrow();
    expect(() => a.native.loadBoundDocumentationImplementation(root)).toThrow();
  });

  it('rebinds deterministically and retires specialization on ordinary source removal', async () => {
    const root = await fixture();
    const initial = {
      policy: text(root, POLICY),
      receipt: text(root, RECEIPT),
    };
    await bind(root);
    expect({
      policy: text(root, POLICY),
      receipt: text(root, RECEIPT),
    }).toEqual(initial);
    put(root, SOURCE, source(false));
    await bind(root);
    const a = await apis();
    expect(a.cli.loadDocumentationImplementationContext(root)).toBeUndefined();
    for (const path of files) {
      expect(a.paths.classifyTranslationPath('architect', path).allowed).toBe(true);
      expect(a.paths.classifyTranslationPath('engineer', path).allowed).toBe(false);
    }
    const h = host(root, a);
    const operation = vi.fn();
    const path = files[0];
    assert(path);
    try {
      expect(() =>
        h.scope.apply_effect(
          {
            kind: 'filesystem',
            symbol: 'writeFileSync',
            arguments: [join(root, path), 'wrong'],
          },
          operation,
        ),
      ).toThrow();
      expect(operation).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  });
});
