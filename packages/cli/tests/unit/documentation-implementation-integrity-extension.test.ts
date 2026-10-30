// ADR-AUT-0009 native admission controls. No successful context/receipt is fabricated.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
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

describe('complete native integrity and unchanged canonical reconstruction', () => {
  for (const mode of ['without-block', 'documentation', 'documentation-and-adopter'] as const) {
    it(`preserves complete pre-source-action bytes/order/digests with exact historical five-rule delta: ${mode}`, async () => {
      const root = await fixture();
      if (mode !== 'documentation') {
        const value = JSON.parse(source(mode !== 'without-block'));
        if (mode === 'documentation-and-adopter')
          value.authority = {
            extension_id: 'inspector.path-authority',
            roots: ['apps'],
            classes: {
              test: { selectors: ['**/*.spec.*'] },
              architecture: { selectors: ['**/ddl/**/*.sql'] },
            },
          };
        put(root, SOURCE, JSON.stringify(value));
        await bind(root);
      }
      const a = await apis();
      const current = await import('../../src/authority/policy.js');
      const original =
        await import('../fixtures/documentation-authority-baseline/canonical/packages/cli/src/authority/policy.js');
      const entries = a.registry.canonicalRegistry();
      const version = a.version.resolveCliVersion();
      // Keep the historical code/registry types immutable. The actual current registry is
      // passed unchanged through one fixed native call; its result is initially unknown.
      const before: unknown = Reflect.apply(original.buildTrustedAuthoritySources, undefined, [
        entries,
        root,
        version,
      ]);
      record(before);
      const oldCore = before['immutableCore'];
      record(oldCore);
      const oldSource = oldCore['source_document'];
      record(oldSource);
      const oldProvenance = before['provenance'];
      record(oldProvenance);
      const oldSourcePolicy = oldProvenance['source_policy'];
      record(oldSourcePolicy);
      const oldVirtual = before['virtualPolicy'];
      record(oldVirtual);
      const oldDocument = oldVirtual['document'];
      record(oldDocument);
      const oldRaw = oldDocument['raw'];
      record(oldRaw);
      const oldView = oldDocument['view'];
      record(oldView);
      const oldCoreRules: unknown = oldCore['rules'];
      const oldRules: unknown = before['rules'];
      function array(value: unknown): asserts value is readonly unknown[] {
        assert(Array.isArray(value));
      }
      array(oldCoreRules);
      array(oldRules);
      const baseline =
        await import('../fixtures/documentation-authority-current-main-baseline/canonical/packages/cli/src/authority/policy.js');
      const mainCore =
        await import('../fixtures/documentation-authority-current-main-baseline/canonical/packages/cli/src/authority/policy-core-rules.js');
      const mainSupport =
        await import('../fixtures/documentation-authority-current-main-baseline/canonical/packages/cli/src/authority/policy-support.js');
      const expected = baseline.buildTrustedAuthoritySources(entries, root, version);
      const mainRows = mainCore.buildCoreAuthorityRules({
        entries,
        groups: mainSupport.subjectGroups(entries),
        repositoryId: expected.repository_id,
        human: (role) => [{ kind: 'human', roles: [role] }],
        joint: [{ kind: 'human', roles: ['owner', 'architect'] }],
      });
      const added = mainRows.slice(0, 5);
      expect(added.map((row) => row.rule_id)).toEqual([
        'core-evidence-reconcile-approve',
        'core-evidence-reconcile-materialize',
        'core-evidence-reconcile-stage-proof',
        'core-sense-bootstrap-inventory',
        'core-reconciliation-host-provision',
      ]);
      expect(expected.immutableCore.rules.slice(0, 5)).toEqual(added);
      expect(expected.immutableCore.rules.slice(5)).toEqual(oldCoreRules);
      const coreRules = [...added, ...oldCoreRules];
      const rules = [...added, ...oldRules];
      const sourceDocument = { ...oldSource, rules: coreRules };
      const provenance = {
        ...oldProvenance,
        source_policy: {
          ...oldSourcePolicy,
          digest_sha256: original.sha256Bytes(original.canonicalBytes(sourceDocument)),
        },
        resolved_digest_sha256: original.canonicalSha256(rules),
      };
      const projectedOld = {
        ...before,
        immutableCore: {
          ...oldCore,
          rules: coreRules,
          source_document: sourceDocument,
          canonical_source_bytes: original.canonicalBytes(sourceDocument),
        },
        rules,
        provenance,
        virtualPolicy: {
          ...oldVirtual,
          document: {
            ...oldDocument,
            raw: { ...oldRaw, rules },
            view: { ...oldView, rules },
            canonical_bytes: original.canonicalBytes({ rules }),
          },
          provenance,
          resolved_rule_bytes: original.canonicalBytes(rules),
        },
      };
      // Full result equality permits exactly the pre-existing five main rows and their
      // derived bytes/digests. Any other registry-induced output difference must fail.
      expect(expected).toEqual(projectedOld);
      expect([...baseline.canonicalBytes(expected)]).toEqual([
        ...original.canonicalBytes(projectedOld),
      ]);
      const after = current.buildTrustedAuthoritySources(entries, root, version);
      // Project only the independently accepted source-action delta onto the frozen
      // full historical result. Every other rule, order, byte and digest stays exact.
      const sourceRows = [
        [
          'core-inspector-source-tests',
          'tests/**',
          'Article 6 Inspector source application in the core tests root.',
        ],
        [
          'core-inspector-source-package-tests',
          'packages/*/tests/**',
          'Article 6 Inspector source application in package test roots.',
        ],
      ].map(([id, path, rationale]) =>
        mainSupport.rule({
          id,
          origin: 'immutable-core',
          precedence: 800,
          actionIds: ['source apply inspector'],
          selector: {
            ...mainSupport.fsSelector(expected.repository_id, path),
            operations: ['create', 'update'],
          },
          subjects: [{ kind: 'human', roles: ['inspector'] }],
          rationale,
        }),
      );
      function sourceDelta(rows: readonly unknown[], insert: boolean): readonly unknown[] {
        return rows.flatMap((row) => {
          record(row);
          const actions = row['action_ids'];
          array(actions);
          const action_ids =
            JSON.stringify(actions) === JSON.stringify(['round run', 'task finish', 'task start'])
              ? ['round run', 'source apply engineer', 'task finish', 'task start']
              : ['core-inspector-tests', 'core-inspector-tests-plural'].includes(
                    String(row['rule_id']),
                  )
                ? actions.filter((id) => id !== 'source apply inspector')
                : actions;
          const result = { ...row, action_ids };
          return insert && row['rule_id'] === 'core-inspector-tests'
            ? [result, ...sourceRows]
            : [result];
        });
      }
      const integratedCoreRules = sourceDelta(expected.immutableCore.rules, true);
      const integratedExtensions = expected.additiveExtensions.map((extension) => {
        const rules = sourceDelta(extension.rules, false);
        const source_document = { ...extension.source_document, rules };
        return {
          ...extension,
          rules,
          source_document,
          canonical_source_bytes: baseline.canonicalBytes(source_document),
        };
      });
      const integratedRules = [
        ...integratedCoreRules,
        ...integratedExtensions.flatMap((extension) => extension.rules),
      ];
      const integratedSource = {
        ...expected.immutableCore.source_document,
        rules: integratedCoreRules,
      };
      const integratedProvenance = {
        ...expected.provenance,
        source_policy: {
          ...expected.provenance.source_policy,
          digest_sha256: baseline.sha256Bytes(baseline.canonicalBytes(integratedSource)),
        },
        additive_extensions: integratedExtensions.map((extension) => ({
          extension_id: extension.extension_id,
          extension_version: extension.extension_version,
          digest_sha256: baseline.sha256Bytes(baseline.canonicalBytes(extension.source_document)),
        })),
        resolved_digest_sha256: baseline.canonicalSha256(integratedRules),
      };
      const integrated = {
        ...expected,
        immutableCore: {
          ...expected.immutableCore,
          rules: integratedCoreRules,
          source_document: integratedSource,
          canonical_source_bytes: baseline.canonicalBytes(integratedSource),
        },
        additiveExtensions: integratedExtensions,
        rules: integratedRules,
        provenance: integratedProvenance,
        virtualPolicy: {
          ...expected.virtualPolicy,
          document: {
            ...expected.virtualPolicy.document,
            raw: { ...expected.virtualPolicy.document.raw, rules: integratedRules },
            view: { ...expected.virtualPolicy.document.view, rules: integratedRules },
            canonical_bytes: baseline.canonicalBytes({ rules: integratedRules }),
          },
          provenance: integratedProvenance,
          resolved_rule_bytes: baseline.canonicalBytes(integratedRules),
        },
      };
      expect(after).toEqual(integrated);
      expect([...current.canonicalBytes(after)]).toEqual([...baseline.canonicalBytes(integrated)]);
      expect(after.additiveExtensions.length).toBe(mode === 'documentation-and-adopter' ? 2 : 1);
      if (mode === 'without-block') {
        expect(a.cli.loadDocumentationImplementationContext(root)).toBeUndefined();
        expect(() => a.native.loadBoundDocumentationImplementation(root)).toThrow(
          'DOCUMENTATION_IMPLEMENTATION_CONTEXT_BINDING_MISMATCH',
        );
      } else expect(a.native.loadBoundDocumentationImplementation(root)).toBeDefined();
    });
  }

  it('combines documentation specialization with all three source actions and native test rules', async () => {
    const root = await fixture();
    const a = await apis();
    const { buildTrustedAuthoritySources } = await import('../../src/authority/policy.js');
    const { subjectGroups } = await import('../../src/authority/policy-support.js');
    const entries = a.registry.canonicalRegistry();
    const groups = subjectGroups(entries);
    expect(groups.engineer).toContain('source apply engineer');
    expect(groups.architect).toContain('source apply architect');
    expect(groups.inspector).not.toContain('source apply inspector');
    const built = buildTrustedAuthoritySources(entries, root, a.version.resolveCliVersion());
    const rules = built.immutableCore.rules;
    expect(
      rules
        .filter((row) => row.rule_id.startsWith('core-inspector-source-'))
        .map((row) => row.rule_id),
    ).toEqual(['core-inspector-source-tests', 'core-inspector-source-package-tests']);
    const selected = rules.filter((row) =>
      row.rule_id.startsWith('core-documentation-implementation-'),
    );
    expect(selected).toHaveLength(files.length);
    for (const row of selected) {
      expect(row.action_ids).toContain('source apply engineer');
      expect(row.subjects).toEqual(
        expect.arrayContaining([{ kind: 'human', roles: ['engineer'] }]),
      );
    }
    expect(a.native.loadBoundDocumentationImplementation(root)).toBeDefined();
  });

  it('refuses stale genuine handle through every direct spec boundary before runner', async () => {
    const root = await fixture();
    const a = await apis();
    const context = a.native.loadBoundDocumentationImplementation(root);
    assert(context);
    const path = files[0];
    assert(path);
    expect(a.paths.classifyTranslationPath('engineer', path, context).allowed).toBe(true);
    tamperUnrelatedCore(root);
    expect(() => a.paths.classifyTranslationPath('engineer', path, context)).toThrow(
      /DOCUMENTATION_IMPLEMENTATION|AUTHORITY_POLICY/,
    );
    expect(() => a.frames.evaluateTranslationFrames(frame(path, context))).toThrow(
      /DOCUMENTATION_IMPLEMENTATION|AUTHORITY_POLICY/,
    );
    const run = vi.fn(async () => undefined);
    await expect(
      a.mutations.recordMutationCandidate({
        repo_root: root,
        intent: {},
        documentation_authority: context,
        emitted_at: '2026-10-25T00:00:00.000Z',
        run,
      }),
    ).rejects.toThrow(/DOCUMENTATION_IMPLEMENTATION|AUTHORITY_POLICY/);
    expect(run).not.toHaveBeenCalled();
  });

  for (const mode of [
    'base-additive',
    'core-self-digest',
    'additive-self-digest',
    'source-drift',
  ] as const) {
    it(`refuses fresh native and CLI issuance after ${mode}`, async () => {
      const root = await fixture();
      const a = await apis();
      const current = await import('../../src/authority/policy.js');
      const canonical = current.buildTrustedAuthoritySources(
        a.registry.canonicalRegistry(),
        root,
        a.version.resolveCliVersion(),
      );
      expect(a.native.loadBoundDocumentationImplementation(root)).toBeDefined();
      const receipt = text(root, RECEIPT);
      const policy = parsed(root, POLICY);
      const rules = policy.rules;
      assert(Array.isArray(rules));
      const selectedBefore = JSON.stringify(
        rules.filter((row) => String(row.rule_id).startsWith('core-documentation-implementation-')),
      );
      if (mode === 'source-drift') {
        const value = parsed(root, SOURCE);
        value.policy_version = '1.0.1';
        put(root, SOURCE, JSON.stringify(value));
      } else {
        const target = rules.find((row) =>
          mode === 'core-self-digest'
            ? row.origin === 'immutable-core' &&
              !String(row.rule_id).startsWith('core-documentation-implementation-')
            : row.origin === 'additive-extension',
        );
        record(target);
        target.rationale = String(target.rationale) + ' native tamper';
        if (mode.endsWith('self-digest')) {
          // Repair every materialized digest for the altered source. This is deliberately
          // an invalid attack fixture, never used as a positive bind or context proof.
          policy.resolved_digest_sha256 = current.canonicalSha256(rules);
          if (mode === 'core-self-digest') {
            record(policy.source_policy);
            policy.source_policy.digest_sha256 = current.canonicalSha256({
              ...canonical.immutableCore.source_document,
              rules: rules.filter((row) => row.origin === 'immutable-core'),
            });
          } else {
            assert(Array.isArray(policy.additive_extensions));
            const ext = policy.additive_extensions[0];
            record(ext);
            const source = canonical.additiveExtensions[0];
            assert(source);
            ext.digest_sha256 = current.canonicalSha256({
              ...source.source_document,
              rules: rules.filter((row) => row.origin === 'additive-extension'),
            });
          }
        }
        put(root, POLICY, JSON.stringify(policy));
      }
      expect(text(root, RECEIPT)).toBe(receipt);
      expect(
        JSON.stringify(
          rules.filter((row) =>
            String(row.rule_id).startsWith('core-documentation-implementation-'),
          ),
        ),
      ).toBe(selectedBefore);
      expect(() => a.native.loadBoundDocumentationImplementation(root)).toThrow(
        /DOCUMENTATION_IMPLEMENTATION|AUTHORITY_POLICY|ADOPTER/,
      );
      expect(() => a.cli.loadDocumentationImplementationContext(root)).toThrow(
        /DOCUMENTATION_IMPLEMENTATION|AUTHORITY_POLICY|ADOPTER/,
      );
    });
  }
});

describe('selected path ordinary host enforcement', () => {
  it('enforces actual registered action and role on all five selections', async () => {
    const root = await fixture();
    const a = await apis();
    const entries = a.registry.canonicalRegistry();
    for (const [verb, role, args] of [
      ['task start', 'engineer', ['task', 'start', '--round', 'R-0007', '--task', 'TASK-7001']],
      ['check', 'inspector', ['check', '--suite', 'quick']],
      ['round seal', 'architect', ['round', 'seal']],
      ['task start', 'architect', ['task', 'start', '--round', 'R-0007', '--task', 'TASK-7001']],
    ] as const) {
      const entry = entries.find((e) => e.name === verb);
      assert(entry);
      for (const path of files) {
        const operation = vi.fn(() => writeFileSync(join(root, path), '// selected operation\n'));
        let h: ReturnType<APIs['broker']['createAuthorityHostBroker']> | undefined;
        const action = () => {
          h = a.broker.createAuthorityHostBroker({
            entry,
            entries,
            argv: [process.execPath, 'devai', ...args, '--as-role', role, '--write'],
            role,
            declaration: { as_role: role },
            repository_root: root,
            package_version: a.version.resolveCliVersion(),
            bootstrap_policy: false,
          });
          h.scope.apply_effect(
            {
              kind: 'filesystem',
              symbol: 'writeFileSync',
              arguments: [join(root, path), '// selected operation\n'],
            },
            operation,
          );
        };
        try {
          if (verb === 'task start' && role === 'engineer') {
            action();
            expect(operation).toHaveBeenCalledOnce();
          } else {
            expect(action).toThrow();
            expect(operation).not.toHaveBeenCalled();
          }
        } finally {
          h?.dispose();
        }
      }
    }
  });
  it('checks both rename endpoints before applying and permits two selected endpoints', async () => {
    const root = await fixture();
    const a = await apis();
    const h = host(root, a);
    const first = files[0],
      second = files[1];
    assert(first && second);
    try {
      for (const [from, to] of [
        [first, 'docs/site/sidebars.js'],
        ['docs/site/sidebars.js', second],
      ]) {
        assert(from && to);
        const before = [text(root, from), text(root, to)];
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
        }
        expect(caught).toBeDefined();
        expect(operation).not.toHaveBeenCalled();
        expect([text(root, from), text(root, to)]).toEqual(before);
      }
      const operation = vi.fn(() => renameSync(join(root, first), join(root, second)));
      h.scope.apply_effect(
        {
          kind: 'filesystem',
          symbol: 'renameSync',
          arguments: [join(root, first), join(root, second)],
        },
        operation,
      );
      expect(operation).toHaveBeenCalledOnce();
      expect(text(root, second)).toBe('export {};\n');
    } finally {
      h.dispose();
    }
  });
  it('refuses protected overlap rebind without replacing prior complete policy and receipt', async () => {
    const root = await fixture();
    const original = { policy: text(root, POLICY), receipt: text(root, RECEIPT) };
    const value = parsed(root, SOURCE);
    value.documentation_implementation = { files: [...files, 'docs/probe.spec.ts'] };
    put(root, 'docs/probe.spec.ts', 'export {};\n');
    put(root, SOURCE, JSON.stringify(value));
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
    expect(result.exit).not.toBe(0);
    expect({ policy: text(root, POLICY), receipt: text(root, RECEIPT) }).toEqual(original);
    const a = await apis();
    expect(() => a.native.loadBoundDocumentationImplementation(root)).toThrow();
    put(root, SOURCE, source());
    await bind(root);
    const fresh = await apis();
    expect(fresh.native.loadBoundDocumentationImplementation(root)).toBeDefined();
  });
});

// Current-main prospective review is a projection, never a pending write grant.
describe('prospective documentation binding boundary', () => {
  function observedBytes(root: string) {
    return [
      SOURCE,
      POLICY,
      RECEIPT,
      '.devai/config/project.json',
      '.devai/pin/constitution.md',
      '.devai/config/adopter-policy-binding.journal.json',
      ...files,
    ].map((path) => ({
      path,
      bytes: existsSync(join(root, path))
        ? readFileSync(join(root, path)).toString('base64')
        : null,
    }));
  }

  it.each([false, true])(
    'preserves actual source bytes in matching prospective projection; selected=%s',
    async (selected) => {
      const root = await fixture();
      if (!selected) {
        put(root, SOURCE, source(false));
        await bind(root);
      }
      const a = await apis();
      const current = await import('../../src/authority/policy.js');
      const entries = a.registry.canonicalRegistry();
      const version = a.version.resolveCliVersion();
      const before = observedBytes(root);
      const ordinary = current.buildTrustedAuthoritySources(entries, root, version);
      const prospective = current.buildProspectiveAuthoritySources(entries, root, version);
      expect(prospective.sources).toEqual(ordinary);
      expect([...current.canonicalBytes(prospective.sources)]).toEqual([
        ...current.canonicalBytes(ordinary),
      ]);
      expect(prospective.bindings).toEqual(current.authorityBindings(root, version));
      expect(observedBytes(root)).toEqual(before);
      expect(a.cli.loadDocumentationImplementationContext(root) !== undefined).toBe(selected);
    },
  );

  it.each(['framework_package', 'constitution'] as const)(
    'refuses a tampered selected %s receipt without implicit rebind, then accepts registered repair',
    async (field) => {
      const root = await fixture();
      const a = await apis();
      const current = await import('../../src/authority/policy.js');
      const receipt = parsed(root, RECEIPT);
      const bound = receipt['documentation_implementation'];
      record(bound);
      const identity = bound[field];
      record(identity);
      identity['version'] = field === 'constitution' ? '1.2.0' : '0.0.0-inspector-stale';
      put(root, RECEIPT, JSON.stringify(receipt));
      const before = observedBytes(root);
      expect(() =>
        current.buildProspectiveAuthoritySources(
          a.registry.canonicalRegistry(),
          root,
          a.version.resolveCliVersion(),
        ),
      ).toThrow('DOCUMENTATION_IMPLEMENTATION_BINDING_MISMATCH');
      expect(() => a.native.loadBoundDocumentationImplementation(root)).toThrow(
        /DOCUMENTATION_IMPLEMENTATION/,
      );
      expect(observedBytes(root)).toEqual(before);
      // This executes the registered normal command; no successful receipt is authored here.
      await bind(root);
      const fresh = await apis();
      const refreshed = await import('../../src/authority/policy.js');
      expect(
        refreshed.buildProspectiveAuthoritySources(
          fresh.registry.canonicalRegistry(),
          root,
          fresh.version.resolveCliVersion(),
        ).sources,
      ).toEqual(
        refreshed.buildTrustedAuthoritySources(
          fresh.registry.canonicalRegistry(),
          root,
          fresh.version.resolveCliVersion(),
        ),
      );
      expect(fresh.native.loadBoundDocumentationImplementation(root)).toBeDefined();
    },
  );

  it('keeps a genuine open journal materialization-only and omits documentation from bootstrap', async () => {
    const root = await fixture();
    const a = await apis();
    const current = await import('../../src/authority/policy.js');
    const journal = await import('../../src/commands/init/bind-adapters.js');
    // Use the existing real issuer/boundary composition for fixture journal effects only.
    const { withAuthorityHostTestScope } =
      await import('../../../skills/tests/unit/authority-host-test-scope.js');
    const entries = a.registry.canonicalRegistry();
    const version = a.version.resolveCliVersion();
    const original = observedBytes(root);
    const expected = current.buildTrustedAuthoritySources(entries, root, version);
    await withAuthorityHostTestScope(() => journal.openBindJournal(root));
    try {
      expect(existsSync(join(root, journal.BIND_JOURNAL))).toBe(true);
      const pending = observedBytes(root);
      expect(current.buildMaterializationAuthoritySources(entries, root, version)).toEqual(
        expected,
      );
      expect(() => current.buildProspectiveAuthoritySources(entries, root, version)).toThrow(
        'DOCUMENTATION_IMPLEMENTATION_BINDING_MISMATCH',
      );
      expect(() => current.buildTrustedAuthoritySources(entries, root, version)).toThrow(
        'DOCUMENTATION_IMPLEMENTATION_BINDING_MISMATCH',
      );
      expect(() => a.native.loadBoundDocumentationImplementation(root)).toThrow(
        /DOCUMENTATION_IMPLEMENTATION/,
      );
      const bootstrap = current.buildBootstrapAuthoritySources(entries, root, version);
      expect(bootstrap.immutableCore.source_document).not.toHaveProperty(
        'documentation_implementation',
      );
      expect(
        bootstrap.rules.filter((row) =>
          row.rule_id.startsWith('core-documentation-implementation-'),
        ),
      ).toEqual([]);
      expect(observedBytes(root)).toEqual(pending);
    } finally {
      await withAuthorityHostTestScope(() => journal.commitBindJournal(root));
    }
    expect(observedBytes(root)).toEqual(original);
    expect(a.native.loadBoundDocumentationImplementation(root)).toBeDefined();
  });
});
