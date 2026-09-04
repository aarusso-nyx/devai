import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertReleaseMutationInputProjectionV21,
  buildReleaseMutationInputPlanV21,
  isDerivedReleaseMutationInputPlanV21,
  type ReleaseMutationExecutionCoverageV21,
} from '../../src/services/release-mutation-inputs.js';
import { fixture, currentFixture, build } from '../helpers/release-mutation-inputs-fixture.js';

function packageDigest(plan: ReturnType<typeof build>['plan'], id: string): string {
  const entry = plan.packages.find((value) => value.id === id);
  if (entry === undefined) throw new Error(`fixture package ${id} missing`);
  return entry.input_digest;
}

function mutate(
  files: ReadonlyMap<string, Uint8Array>,
  path: string,
  bytes: Uint8Array,
): Map<string, Uint8Array> {
  const result = new Map(files);
  result.set(path, Buffer.from(bytes));
  return result;
}

describe('protected release mutation input derivation', () => {
  it('derives all ten packages and all twelve immutable bindings from genuine snapshots', () => {
    const value = build(fixture());

    expect(value.receipt.determination).toMatchObject({ support: 'current', mutation: 'targeted' });
    expect(isDerivedReleaseMutationInputPlanV21(value.plan)).toBe(true);
    expect(value.plan.grants).toEqual({ execution: false, certification: false, reuse: false });
    expect(value.plan.packages).toHaveLength(10);
    for (const entry of value.plan.packages) {
      const projection = entry.expected.inputProjection;
      if (projection === null || typeof projection !== 'object' || Array.isArray(projection))
        throw new Error('fixture projection malformed');
      const bindings = projection['bindings'];
      if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings))
        throw new Error('fixture bindings malformed');
      expect(Object.keys(bindings)).toHaveLength(12);
      expect(entry.mutation_targets.map((target) => target.path)).toEqual(['src/main.ts']);
      expect(entry.selected_source.length).toBeGreaterThan(entry.mutation_targets.length);
      expect(entry.reuse).toEqual({
        eligible: false,
        unresolved: expect.arrayContaining(['toolchain-fixture-validation-required']),
      });
      assertReleaseMutationInputProjectionV21(
        value.plan,
        entry.expected.packageName,
        entry.expected.inputProjection,
      );
    }
    expect(
      value.plan.packages.find((entry) => entry.id === 'authority')?.workspace_dependencies,
    ).toEqual(['@devai-nyx/schemas', '@devai-nyx/utils']);
  });

  it('requires the exact Owner campaign coverage for current targeted DEVAI and permits plan coverage only for lts full roster', () => {
    const base = fixture();
    const current = build(base);
    const lts = build(base, base.files, { support: 'lts' });

    expect(lts.receipt.determination).toMatchObject({ support: 'lts', mutation: 'full-roster' });
    expect(() => build(base, base.files, { coverage: { kind: 'plan-determined' } })).toThrow(
      'MUTATION_ROSTER_MISMATCH',
    );
    expect(() =>
      build(base, base.files, {
        coverage: {
          ...current.controls.execution_coverage,
          policy_resolution_digest: '0'.repeat(64),
        } as ReleaseMutationExecutionCoverageV21,
      }),
    ).toThrow('MUTATION_ROSTER_MISMATCH');
  });

  it('refuses stale, missing, and extra coverage controls before deriving a producer input plan', () => {
    const base = fixture();
    const current = build(base);
    const coverage = current.controls.execution_coverage;
    if (coverage.kind !== 'owner-approved-complete-devai-roster')
      throw new Error('fixture expected Owner campaign coverage');
    const stale = { ...coverage, release_plan_receipt_digest: '0'.repeat(64) };
    const missing = { ...current.controls, execution_coverage: undefined };
    const extra = { ...coverage, unexpected_package_list: ['cli'] };

    expect(() => build(base, base.files, { coverage: stale })).toThrow('MUTATION_ROSTER_MISMATCH');
    expect(() =>
      buildReleaseMutationInputPlanV21({
        candidate: current.snapshot,
        resolution: current.resolution,
        plan_receipt: current.receipt,
        // The public TypeScript surface is narrow, but the runtime guard must reject an
        // untrusted decoded control record whose required value is absent.
        controls: missing as unknown as typeof current.controls,
      }),
    ).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
    expect(() =>
      build(base, base.files, { coverage: extra as ReleaseMutationExecutionCoverageV21 }),
    ).toThrow('MUTATION_ROSTER_MISMATCH');
  });

  it('binds source, configuration, lock, environment, toolchain, and Git mode drift to the right packages', () => {
    const base = fixture();
    const initial = build(base);
    const source = build(
      base,
      mutate(
        base.files,
        'packages/utils/src/main.ts',
        Buffer.from('export const value = false;\n'),
      ),
    );
    const sharedConfig = build(
      base,
      mutate(
        base.files,
        'tsconfig.base.json',
        Buffer.from('{"compilerOptions":{"target":"ES2022"}}\n'),
      ),
    );
    const mode = build(base, base.files, { modePath: 'packages/utils/src/main.ts' });
    const unrelated = build(
      base,
      mutate(
        base.files,
        'packages/evidence/src/main.ts',
        Buffer.from('export const value = false;\n'),
      ),
    );

    for (const id of ['authority', 'schemas', 'utils'])
      expect(packageDigest(source.plan, id)).not.toBe(packageDigest(initial.plan, id));
    expect(packageDigest(source.plan, 'evidence')).toBe(packageDigest(initial.plan, 'evidence'));
    expect(packageDigest(unrelated.plan, 'utils')).toBe(packageDigest(initial.plan, 'utils'));
    expect(packageDigest(unrelated.plan, 'evidence')).not.toBe(
      packageDigest(initial.plan, 'evidence'),
    );
    expect(
      sharedConfig.plan.packages.every(
        (entry, index) => entry.input_digest !== initial.plan.packages[index]?.input_digest,
      ),
    ).toBe(true);
    expect(packageDigest(mode.plan, 'utils')).not.toBe(packageDigest(initial.plan, 'utils'));
    expect(() =>
      build(
        base,
        mutate(
          base.files,
          'pnpm-lock.yaml',
          Buffer.from('lockfileVersion: "9.0"\nimporters: {}\n'),
        ),
      ),
    ).toThrow(/^rpl-/u);
    expect(() =>
      buildReleaseMutationInputPlanV21({
        candidate: initial.snapshot,
        resolution: initial.resolution,
        plan_receipt: initial.receipt,
        controls: {
          ...initial.controls,
          environment: { ...initial.controls.environment, PATH: '/ambient' },
        },
      }),
    ).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
    expect(() =>
      buildReleaseMutationInputPlanV21({
        candidate: initial.snapshot,
        resolution: initial.resolution,
        plan_receipt: initial.receipt,
        controls: {
          ...initial.controls,
          toolchain: { ...initial.controls.toolchain, node: 'v0.0.0' },
        },
      }),
    ).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
  });

  it('keeps input identity stable across commit-only changes but makes empty or dynamic configuration ineligible', () => {
    const base = fixture();
    const initial = build(base);
    const sameContent = build(base, base.files, { message: 'same tree, another commit' });
    const emptyTarget = new Map(base.files);
    emptyTarget.delete('packages/utils/src/main.ts');
    const unresolvedConfig = mutate(
      base.files,
      'packages/utils/tsconfig.json',
      Buffer.from('{"extends":"unapproved-config-package"}\n'),
    );
    const dynamicConfig = mutate(
      base.files,
      'test-tasks.json',
      Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(base.files.get('test-tasks.json') ?? []).toString('utf8')),
          dynamicFallbackSelectors: [{ kind: 'prefix', pattern: 'packages/' }],
        }),
      ),
    );

    expect(sameContent.snapshot.repository.commit).not.toBe(initial.snapshot.repository.commit);
    expect(sameContent.plan.packages.map((entry) => entry.input_digest)).toEqual(
      initial.plan.packages.map((entry) => entry.input_digest),
    );
    expect(() => build(base, emptyTarget)).toThrow('MUTATION_INCOMPLETE');
    expect(
      build(base, unresolvedConfig).plan.packages.find((entry) => entry.id === 'utils')?.reuse
        .unresolved,
    ).toContain('typescript-configuration-reference-unresolved');
    const dynamic = build(base, dynamicConfig).plan;
    expect(dynamic.packages.every((entry) => entry.reuse.eligible === false)).toBe(true);
    expect(
      dynamic.packages.every((entry) =>
        entry.reuse.unresolved.includes('dynamic-task-input-selection-unresolved'),
      ),
    ).toBe(true);
  });
});

function currentRoster() {
  const base = currentFixture();
  return (
    JSON.parse(Buffer.from(base.files.get('law/policy/devai-adoption.json') ?? []).toString('utf8'))
      .release_verification as { mutation_roster: Array<Record<string, unknown>> }
  ).mutation_roster;
}

function mappedFixture(paths: { vitest?: string; typescript?: string } = {}) {
  const vitest = paths.vitest ?? 'configs/mutation-runner.ts';
  const typescript = paths.typescript ?? 'configs/typed-build.json';
  const base = currentFixture({
    mutation_roster: currentRoster().map((row) =>
      row['id'] === 'utils'
        ? {
            ...row,
            config_paths: [...(row['config_paths'] as string[]), 'configs/'],
            vitest_config_path: vitest,
            typescript_config_path: typescript,
          }
        : row,
    ),
  });
  base.files.set(vitest, Buffer.from('export default { test: { isolate: true } };\n'));
  base.files.set(
    typescript,
    Buffer.from(
      '{"extends":"./shared/typed-base.json","references":[{"path":"../packages/utils/typed-project.json"}]}\n',
    ),
  );
  base.files.set(
    'configs/shared/typed-base.json',
    Buffer.from('{"extends":"./typed-grandparent.json"}\n'),
  );
  base.files.set(
    'configs/shared/typed-grandparent.json',
    Buffer.from('{"compilerOptions":{"strict":true}}\n'),
  );
  base.files.set(
    'packages/utils/typed-project.json',
    Buffer.from('{"compilerOptions":{"composite":true}}\n'),
  );
  return { base, vitest, typescript };
}

describe('v1.2 mapped mutation execution configuration (ADR-MUT-0008)', () => {
  it('preserves the frozen v1.1 fixture and binds every current ten-package mapping without grants', () => {
    const historicalFixture = fixture();
    const historical = build(historicalFixture);
    expect(historicalFixture.installed.identity.version).toBe('1.4.5');
    expect(historical.plan.execution_template_version).toBe('1.1.0');
    expect(
      historical.plan.packages.every((entry) => entry.execution_configuration === undefined),
    ).toBe(true);
    const base = currentFixture();
    const value = build(base);
    expect(base.installed.identity.version).toBe('1.5.0');
    expect(value.receipt.determination).toMatchObject({ support: 'current', mutation: 'targeted' });
    expect(value.plan.execution_template_version).toBe('1.2.0');
    expect(value.plan.packages).toHaveLength(10);
    expect(value.plan.grants).toEqual({ execution: false, certification: false, reuse: false });
    for (const row of currentRoster()) {
      const entry = value.plan.packages.find((item) => item.id === row['id']);
      expect(entry?.execution_configuration?.task_node).toBe(row['task_node']);
      for (const [field, mapped] of [
        ['vitest_config', 'vitest_config_path'],
        ['typescript_config', 'typescript_config_path'],
      ] as const) {
        const member = entry?.execution_configuration?.[field];
        const bytes = base.files.get(String(row[mapped]));
        if (bytes === undefined) throw new Error('fixture configuration missing');
        expect(member).toMatchObject({
          path: row[mapped],
          mode: '100644',
          size: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
      expect(entry?.mutation_targets.map((member) => member.path)).toEqual(['src/main.ts']);
      expect(entry?.selected_source.map((member) => member.path)).toEqual(
        historical.plan.packages
          .find((item) => item.id === row['id'])
          ?.selected_source.map((member) => member.path),
      );
      expect(entry?.selected_tests.map((member) => member.path)).toEqual(
        historical.plan.packages
          .find((item) => item.id === row['id'])
          ?.selected_tests.map((member) => member.path),
      );
      expect(entry?.reuse).toEqual({
        eligible: false,
        unresolved: expect.arrayContaining([
          'toolchain-fixture-validation-required',
          'frozen-dependency-closure-missing',
        ]),
      });
    }
  });

  it('follows custom-named mapped TypeScript roots through complete extends and project-reference closure', () => {
    const { base, vitest, typescript } = mappedFixture();
    const value = build(base);
    const entry = value.plan.packages.find((item) => item.id === 'utils');
    expect(entry?.execution_configuration).toMatchObject({
      task_node: 'test:utils',
      vitest_config: { path: vitest },
      typescript_config: { path: typescript },
    });
    expect(entry?.execution_configuration?.typescript_closure.map((member) => member.path)).toEqual(
      [
        'configs/shared/typed-base.json',
        'configs/shared/typed-grandparent.json',
        'configs/typed-build.json',
        'packages/utils/typed-project.json',
      ],
    );
    expect(entry?.reuse.unresolved).not.toContain('typescript-configuration-reference-unresolved');
    expect(entry?.reuse.unresolved).not.toContain('typescript-configuration-cycle');
    expect(entry?.reuse.unresolved).not.toContain('typescript-project-dependency-unresolved');
    const changed = build(
      base,
      mutate(
        base.files,
        'configs/shared/typed-grandparent.json',
        Buffer.from('{"compilerOptions":{"strict":false}}\n'),
      ),
    );
    expect(packageDigest(changed.plan, 'utils')).not.toBe(packageDigest(value.plan, 'utils'));
  });

  it.each(['vitest', 'typescript'] as const)(
    'binds mapped %s path and bytes independently of conventional config selectors',
    (kind) => {
      const initialFixture = mappedFixture();
      const alternate = mappedFixture({
        [kind]: kind === 'vitest' ? 'configs/alternate-runner.ts' : 'configs/alternate-build.json',
      });
      // Keep both files in both candidates; only the bound roster mapping changes.
      const originalPath = initialFixture[kind];
      const alternatePath = alternate[kind];
      const bytes = initialFixture.base.files.get(originalPath);
      if (bytes === undefined) throw new Error('fixture mapped bytes missing');
      initialFixture.base.files.set(alternatePath, bytes);
      alternate.base.files.set(originalPath, bytes);
      const samePopulation = build(initialFixture.base);
      const changedMapping = build(alternate.base);
      expect(packageDigest(changedMapping.plan, 'utils')).not.toBe(
        packageDigest(samePopulation.plan, 'utils'),
      );
      const changedBytes = build(
        initialFixture.base,
        mutate(
          initialFixture.base.files,
          originalPath,
          Buffer.concat([Buffer.from(bytes), Buffer.from('\n')]),
        ),
      );
      expect(packageDigest(changedBytes.plan, 'utils')).not.toBe(
        packageDigest(samePopulation.plan, 'utils'),
      );
    },
  );

  it.each(['vitest', 'typescript'] as const)('refuses missing mapped %s configuration', (kind) => {
    const { base, ...paths } = mappedFixture();
    base.files.delete(paths[kind]);
    expect(() => build(base)).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
  });

  it.each([
    ['missing', '{"extends":"./missing.json"}', 'typescript-configuration-reference-unresolved'],
    [
      'escaping',
      '{"extends":"../../outside.json"}',
      'typescript-configuration-reference-unresolved',
    ],
    ['cyclic', '{"extends":"./typed-build.json"}', 'typescript-configuration-cycle'],
    [
      'outside-dependency-project',
      '{"references":[{"path":"../packages/evidence/tsconfig.json"}]}',
      'typescript-project-dependency-unresolved',
    ],
  ] as const)(
    'keeps %s TypeScript closure blocked without execution or reuse grants',
    (_fault, text, blocker) => {
      const { base, typescript } = mappedFixture();
      base.files.set(typescript, Buffer.from(text));
      const value = build(base);
      expect(value.plan.packages.find((item) => item.id === 'utils')?.reuse).toEqual({
        eligible: false,
        unresolved: expect.arrayContaining([blocker, 'toolchain-fixture-validation-required']),
      });
      expect(value.plan.grants).toEqual({ execution: false, certification: false, reuse: false });
    },
  );

  it('refuses a symlink in the mapped TypeScript closure without following it', () => {
    const { base } = mappedFixture();
    expect(() =>
      build(base, base.files, { modePath: 'configs/shared/typed-base.json', mode: '120000' }),
    ).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
  });

  it('permits a separate genuine generic full-roster census but never narrows the current Owner campaign', () => {
    const original = currentRoster().find((row) => row['id'] === 'utils');
    if (original === undefined) throw new Error('fixture roster missing');
    const row = {
      ...original,
      id: 'custom',
      package: '@fixture/custom',
      task_node: 'test:custom',
      manifest_path: 'packages/custom/package.json',
      source_selectors: ['packages/custom/'],
      test_selectors: ['packages/custom/tests/'],
      typescript_config_path: 'packages/custom/tsconfig.json',
      config_paths: [
        'test-tasks.json',
        'tests/config/local.config.ts',
        'vitest.config.ts',
        'packages/custom/tsconfig.json',
      ],
    };
    const base = currentFixture({ mutation_roster: [row] });
    const generic = build(base, base.files, {
      support: 'lts',
      coverage: { kind: 'plan-determined' },
    });
    expect(generic.receipt.determination).toMatchObject({
      support: 'lts',
      mutation: 'full-roster',
    });
    expect(generic.plan.packages.map((entry) => entry.id)).toEqual(['custom']);
    expect(generic.plan.grants).toEqual({ execution: false, certification: false, reuse: false });
    expect(() => build(base)).toThrow('MUTATION_ROSTER_MISMATCH');
    expect(() =>
      build(
        base,
        mutate(
          base.files,
          'packages/unlisted/package.json',
          Buffer.from('{"name":"@fixture/unlisted","version":"1.0.0"}'),
        ),
        { support: 'lts' },
      ),
    ).toThrow('MUTATION_ROSTER_MISMATCH');
  });
});
