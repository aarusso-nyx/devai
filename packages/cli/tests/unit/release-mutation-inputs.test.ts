import { createHash } from 'node:crypto';
import { canonicalSha256 } from '@devai-nyx/utils';
import { describe, expect, it } from 'vitest';
import { encodeContainerDependencyArchive } from '../../src/services/container-archive.js';
import type { ProtectedContainerDependency } from '../../src/services/release-certification-container.js';
import { buildResolvedReleasePlanReceipt } from '../../src/services/release-lifecycle.js';
import {
  assertReleaseMutationInputPackageIdentity,
  assertReleaseMutationInputProjectionV21,
  buildReleaseMutationInputPlanV21,
  captureReleaseMutationInputExecutionContext,
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

function expectRefusal(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ message: code, code });
    return;
  }
  throw new Error(`fixture expected refusal ${code}`);
}

describe('protected release mutation input derivation', () => {
  it('derives all ten packages and all twelve immutable bindings from genuine snapshots', () => {
    const value = build(fixture());

    expect(value.receipt.determination).toMatchObject({ support: 'current', mutation: 'targeted' });
    expect(isDerivedReleaseMutationInputPlanV21(value.plan)).toBe(true);
    expect(isDerivedReleaseMutationInputPlanV21(null)).toBe(false);
    expect(isDerivedReleaseMutationInputPlanV21({})).toBe(false);
    expect(isDerivedReleaseMutationInputPlanV21(() => undefined)).toBe(false);
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

  it('projects the current disabled survivor ceiling as a compatibility sentinel', () => {
    const value = build(currentFixture());

    for (const entry of value.plan.packages) {
      expect(entry.expected.thresholds).toEqual({
        break: 60,
        high: 60,
        low: 60,
        scoreMin: 60,
        survivedMax: Number.MAX_SAFE_INTEGER,
      });
    }
  });

  it('preserves roster refusal identity for verified blocked receipts and duplicate roster ids', () => {
    const base = currentFixture();
    const current = build(base);
    const receiptInput = current.receipt.inputs[0]?.inline_document;
    if (receiptInput === null || typeof receiptInput !== 'object' || Array.isArray(receiptInput))
      throw new Error('fixture receipt intent missing');
    const blockedReceipt = buildResolvedReleasePlanReceipt({
      resolution: current.resolution,
      intent: { ...receiptInput, current_version: '1.5.0' },
    });
    expect(blockedReceipt.verdict).toBe('block');
    expectRefusal(
      () =>
        buildReleaseMutationInputPlanV21({
          candidate: current.snapshot,
          resolution: current.resolution,
          plan_receipt: blockedReceipt,
          controls: current.controls,
        }),
      'MUTATION_ROSTER_MISMATCH',
    );

    const roster = currentRoster();
    const original = roster.find((entry) => entry['id'] === 'utils');
    if (original === undefined) throw new Error('fixture roster entry missing');
    const duplicate = {
      ...original,
      package: '@fixture/duplicate',
      task_node: 'test:duplicate',
      manifest_path: 'packages/duplicate/package.json',
    };
    expectRefusal(
      () => build(currentFixture({ mutation_roster: [...roster, duplicate] })),
      'MUTATION_ROSTER_MISMATCH',
    );
  });

  it('retains genuine package identity, candidate population, proof bytes, and projection custody', () => {
    const base = currentFixture();
    const value = build(base);
    const entry = value.plan.packages.find((item) => item.id === 'utils');
    if (entry === undefined) throw new Error('fixture package missing');

    expect(() =>
      assertReleaseMutationInputPackageIdentity(value.plan, base.installed.identity),
    ).not.toThrow();
    const nullPrototypeIdentity = Object.assign(
      Object.create(null) as Record<string, unknown>,
      base.installed.identity,
    );
    expect(() =>
      assertReleaseMutationInputPackageIdentity(value.plan, nullPrototypeIdentity),
    ).not.toThrow();
    expect(() =>
      assertReleaseMutationInputPackageIdentity(value.plan, {
        ...base.installed.identity,
        version: '1.5.1',
      }),
    ).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
    expect(() =>
      assertReleaseMutationInputPackageIdentity({ ...value.plan }, base.installed.identity),
    ).toThrow('MUTATION_INPUT_IDENTITY_MISSING');

    const context = captureReleaseMutationInputExecutionContext(value.plan);
    expect(context.repository).toEqual(value.snapshot.repository);
    expect(context.candidate_files.map((member) => member.path)).toEqual(
      [...base.files.keys()].sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      ),
    );
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.candidate_files)).toBe(true);
    expect(() => captureReleaseMutationInputExecutionContext({ ...value.plan })).toThrow(
      'MUTATION_INPUT_IDENTITY_MISSING',
    );
    expectRefusal(
      () =>
        assertReleaseMutationInputProjectionV21(
          { ...value.plan },
          entry.expected.packageName,
          entry.expected.inputProjection,
        ),
      'MUTATION_INPUT_IDENTITY_MISSING',
    );

    const proof = value.plan.readProof();
    const [objectId, member] = [...proof][0] ?? [];
    if (objectId === undefined || member === undefined || member.bytes.length === 0)
      throw new Error('fixture proof missing');
    const original = member.bytes[0];
    member.bytes[0] = original === 0 ? 1 : 0;
    expect(value.plan.readProof().get(objectId)?.bytes[0]).toBe(original);

    const alleged = structuredClone(entry.expected.inputProjection) as Record<string, unknown>;
    const bindings = alleged['bindings'] as Record<string, Record<string, unknown>>;
    bindings['source'] = {
      ...bindings['source'],
      memberCount: Number(bindings['source']?.['memberCount']) + 1,
    };
    expect(() =>
      assertReleaseMutationInputProjectionV21(value.plan, entry.expected.packageName, alleged),
    ).toThrow('MUTATION_INPUT_DIGEST_MISMATCH');
    expect(() =>
      assertReleaseMutationInputProjectionV21(value.plan, '@fixture/unlisted', {}),
    ).toThrow('MUTATION_INPUT_DIGEST_MISMATCH');
  });

  it('binds exact manifest and mutation-target populations and refuses their safety boundaries', () => {
    const base = currentFixture();
    for (const [name, source] of [
      ['packages/utils/src/a.ts', 'export const a = true;\n'],
      ['packages/utils/src/z.js', 'export const z = true;\n'],
      ['packages/utils/src/skip.spec.ts', 'export const skipped = true;\n'],
      ['packages/utils/src/nested/tests/skip.ts', 'export const skipped = true;\n'],
      ['packages/utils/src/types.d.mts', 'export type Skipped = true;\n'],
      ['packages/utils/src/asset.txt', 'not executable source\n'],
    ] as const)
      base.files.set(name, Buffer.from(source));
    const value = build(base);
    const entry = value.plan.packages.find((item) => item.id === 'utils');
    if (entry === undefined) throw new Error('fixture package missing');

    expect(entry.mutation_targets.map((member) => member.path)).toEqual([
      'src/a.ts',
      'src/main.ts',
      'src/z.js',
    ]);
    expect(entry.selected_source.map((member) => member.path)).toEqual(
      expect.arrayContaining([
        'packages/utils/package.json',
        'packages/utils/src/asset.txt',
        'packages/utils/src/nested/tests/skip.ts',
        'packages/utils/src/skip.spec.ts',
        'packages/utils/src/types.d.mts',
      ]),
    );
    expect(entry.selected_tests.map((member) => member.path)).toEqual([
      'packages/utils/tests/main.test.ts',
    ]);
    const bindings = entry.expected.inputProjection['bindings'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(bindings['source']?.['memberCount']).toBe(entry.selected_source.length);
    expect(bindings['tests']?.['memberCount']).toBe(entry.selected_tests.length);
    expect(bindings['manifests']?.['memberCount']).toBe(12);
    expect(entry.prerequisite_nodes).toEqual([]);
    expect(entry.reuse.unresolved).toEqual([
      'frozen-dependency-closure-missing',
      'toolchain-fixture-validation-required',
    ]);
    const executionCoverage = value.controls.execution_coverage;
    if (executionCoverage.kind !== 'owner-approved-complete-devai-roster')
      throw new Error('fixture execution coverage missing');
    expect(value.plan.execution_coverage).toEqual({
      kind: 'owner-approved-complete-devai-roster',
      repository: value.snapshot.repository,
      release_unit: '@aarusso-nyx/devai',
      target_version: '1.5.0',
      release_plan_receipt_digest: value.receipt.receipt_digest_sha256,
      release_profile_digest: value.plan.release_profile_digest,
      policy_resolution_digest: executionCoverage.policy_resolution_digest,
      expected_package_inputs_digest: canonicalSha256(
        value.plan.packages.map((item) => ({
          id: item.id,
          package: item.expected.packageName,
          input_digest: item.input_digest,
          mutation_configuration: (
            item.expected.inputProjection['bindings'] as Record<string, unknown>
          )['mutationConfiguration'],
        })),
      ),
    });

    const invalidVersion = mutate(
      base.files,
      'packages/utils/package.json',
      Buffer.from('{"name":"@devai-nyx/utils","version":"not-semver"}'),
    );
    expect(() => build(base, invalidVersion)).toThrow('MUTATION_ROSTER_MISMATCH');
    expect(() =>
      build(base, base.files, { modePath: 'packages/utils/package.json', mode: '120000' }),
    ).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
    expect(() =>
      build(
        base,
        mutate(base.files, 'pnpm-workspace.yaml', Buffer.from('packages:\n  - packages/**\n')),
      ),
    ).toThrow('MUTATION_ROSTER_MISMATCH');
    for (const controls of [
      { ...value.controls, maximum_source_entries: value.snapshot.paths.length - 1 },
      { ...value.controls, maximum_source_bytes: 1 },
      { ...value.controls, environment: { ...value.controls.environment, BAD: 'line\nbreak' } },
    ])
      expect(() =>
        buildReleaseMutationInputPlanV21({
          candidate: value.snapshot,
          resolution: value.resolution,
          plan_receipt: value.receipt,
          controls,
        }),
      ).toThrow('MUTATION_INPUT_IDENTITY_MISSING');

    expect(() =>
      buildReleaseMutationInputPlanV21({
        candidate: value.snapshot,
        resolution: value.resolution,
        plan_receipt: value.receipt,
        controls: {
          ...value.controls,
          toolchain: { ...value.controls.toolchain, stryker: '9.6.2' },
        },
      }),
    ).toThrow('MUTATION_VERSION_UNSUPPORTED');
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

  it('accepts only exact bounded protected dependency archives', () => {
    const base = currentFixture();
    const current = build(base);
    const archive = encodeContainerDependencyArchive([
      {
        path: '@fixture/dependency/index.js',
        mode: '100644',
        bytes: Buffer.from('module.exports = true;\n'),
      },
    ]);
    const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
    const manifestPaths = [...base.files.keys()]
      .filter((path) => /^packages\/[^/]+\/package\.json$/u.test(path))
      .sort();
    const inputPaths = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', ...manifestPaths];
    const dependency: ProtectedContainerDependency = {
      mount_path: 'node_modules',
      archive,
      sha256: digest(archive),
      inputs: {
        files: inputPaths.map((path) => {
          const bytes = base.files.get(path);
          if (bytes === undefined) throw new Error(`fixture dependency input missing: ${path}`);
          return { path, sha256: digest(bytes) };
        }),
        workspace_packages: manifestPaths.map((path) => {
          const bytes = base.files.get(path);
          if (bytes === undefined) throw new Error(`fixture package manifest missing: ${path}`);
          const manifest = JSON.parse(Buffer.from(bytes).toString('utf8')) as { name: string };
          return {
            path: path.slice(0, -'/package.json'.length),
            name: manifest.name,
            manifest_sha256: digest(bytes),
          };
        }),
      },
    };
    const derivePopulation = (
      entries: readonly ProtectedContainerDependency[],
      maximumArchiveBytes = archive.length,
    ) =>
      buildReleaseMutationInputPlanV21({
        candidate: current.snapshot,
        resolution: current.resolution,
        plan_receipt: current.receipt,
        controls: {
          ...current.controls,
          dependencies: entries,
          container: {
            ...current.controls.container,
            maximum_archive_bytes: maximumArchiveBytes,
          },
        },
      });
    const derive = (entry: ProtectedContainerDependency, maximumArchiveBytes = archive.length) =>
      derivePopulation([entry], maximumArchiveBytes);

    expect(
      captureReleaseMutationInputExecutionContext(derive(dependency)).container_identity,
    ).toMatchObject({
      dependencies: [{ mount_path: dependency.mount_path, sha256: dependency.sha256 }],
    });
    const frozenDependencies = Object.freeze([dependency]);
    expect(
      captureReleaseMutationInputExecutionContext(derivePopulation(frozenDependencies))
        .container_identity,
    ).toMatchObject({
      dependencies: [{ mount_path: dependency.mount_path, sha256: dependency.sha256 }],
    });

    const foreignPrototype = Buffer.from(archive);
    Object.setPrototypeOf(foreignPrototype, Object.create(Buffer.prototype));
    for (const [label, entry, maximumArchiveBytes] of [
      [
        'a non-Buffer archive',
        { ...dependency, archive: new Uint8Array(archive) as unknown as Buffer },
        archive.length,
      ],
      [
        'a Buffer with a foreign prototype',
        { ...dependency, archive: foreignPrototype },
        archive.length,
      ],
      ['an oversized archive', dependency, archive.length - 1],
    ] as const) {
      expect(() => derive(entry, maximumArchiveBytes), label).toThrow(
        'MUTATION_INPUT_IDENTITY_MISSING',
      );
    }

    const sparseDependencies = new Array<ProtectedContainerDependency>(1);
    const foreignDependencies = [dependency];
    Object.setPrototypeOf(foreignDependencies, Object.create(Array.prototype));
    const extendedDependencies = [dependency] as ProtectedContainerDependency[] & {
      unexpected?: boolean;
    };
    extendedDependencies.unexpected = true;
    const nonEnumerableDependencies = new Array<ProtectedContainerDependency>(1);
    Object.defineProperty(nonEnumerableDependencies, '0', {
      value: dependency,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    let accessorReads = 0;
    const accessorDependencies = new Array<ProtectedContainerDependency>(1);
    Object.defineProperty(accessorDependencies, '0', {
      get: () => {
        accessorReads += 1;
        return dependency;
      },
      enumerable: true,
      configurable: true,
    });
    for (const [_label, entries] of [
      ['a sparse dependency population', sparseDependencies],
      ['a dependency population with a foreign prototype', foreignDependencies],
      ['a dependency population with an extra own field', extendedDependencies],
      ['a dependency population with a non-enumerable element', nonEnumerableDependencies],
      ['a dependency population with an accessor element', accessorDependencies],
    ] as const) {
      expect(() => derivePopulation(entries)).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
    }
    expect(accessorReads).toBe(0);

    const firstInput = dependency.inputs.files[0];
    const firstWorkspace = dependency.inputs.workspace_packages[0];
    if (firstInput === undefined || firstWorkspace === undefined)
      throw new Error('fixture dependency population missing');
    for (const entry of [
      {
        ...dependency,
        inputs: {
          ...dependency.inputs,
          files: [{ ...firstInput, sha256: '0'.repeat(64) }, ...dependency.inputs.files.slice(1)],
        },
      },
      {
        ...dependency,
        inputs: {
          ...dependency.inputs,
          workspace_packages: dependency.inputs.workspace_packages.slice(1),
        },
      },
      {
        ...dependency,
        inputs: {
          ...dependency.inputs,
          workspace_packages: [
            { ...firstWorkspace, name: '@fixture/foreign' },
            ...dependency.inputs.workspace_packages.slice(1),
          ],
        },
      },
    ])
      expect(() => derive(entry)).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
  });

  it('selects declaration producers only from generated namespaces bound to workspace dependencies', () => {
    const base = currentFixture();
    const descriptor = JSON.parse(
      Buffer.from(base.files.get('test-tasks.json') ?? []).toString('utf8'),
    ) as {
      tasks: Array<{
        nodeId: string;
        dependencies: string[];
        outputContract: Record<string, unknown>;
      }>;
    };
    const schemas = descriptor.tasks.find((task) => task.nodeId === 'test:schemas');
    if (schemas === undefined) throw new Error('fixture schemas task missing');
    const buildWith = (generatedNamespaces: unknown) => {
      schemas.outputContract = {
        kind: 'tracked-files',
        paths: ['packages/schemas/package.json'],
        generated_namespaces: generatedNamespaces,
      };
      return build(
        base,
        mutate(base.files, 'test-tasks.json', Buffer.from(JSON.stringify(descriptor), 'utf8')),
      ).plan.packages.find((entry) => entry.id === 'authority');
    };

    expect(
      buildWith([
        null,
        1,
        [],
        {},
        { package_manifest: 1 },
        { package_manifest: 'packages/cli/package.json' },
      ])?.prerequisite_nodes,
    ).toEqual([]);
    schemas.dependencies = ['test:utils'];
    expect(
      buildWith([
        null,
        { package_manifest: 'packages/cli/package.json' },
        {
          derivation: 'typescript-declarations',
          prefix: 'packages/schemas/dist/',
          package_manifest: 'packages/schemas/package.json',
        },
      ])?.prerequisite_nodes,
    ).toEqual(expect.arrayContaining(['test:schemas', 'test:utils']));
  });

  it('distinguishes tracked prerequisites from generated outputs and unresolved declared inputs', () => {
    const buildWith = (
      outputContract: Record<string, unknown>,
      inputSelectors: readonly Record<string, unknown>[],
    ) => {
      const base = currentFixture();
      const descriptor = JSON.parse(
        Buffer.from(base.files.get('test-tasks.json') ?? []).toString('utf8'),
      ) as {
        tasks: Array<{
          nodeId: string;
          dependencies: string[];
          inputSelectors: readonly Record<string, unknown>[];
          outputContract: Record<string, unknown>;
        }>;
      };
      const producer = descriptor.tasks.find((task) => task.nodeId === 'test:schemas');
      const consumer = descriptor.tasks.find((task) => task.nodeId === 'test:utils');
      if (producer === undefined || consumer === undefined)
        throw new Error('fixture prerequisite tasks missing');
      producer.outputContract = outputContract;
      producer.inputSelectors = inputSelectors;
      consumer.dependencies = [producer.nodeId];
      return build(
        base,
        mutate(base.files, 'test-tasks.json', Buffer.from(JSON.stringify(descriptor), 'utf8')),
      ).plan.packages.find((entry) => entry.id === 'utils');
    };
    const tracked = buildWith({ kind: 'tracked-files', paths: ['packages/schemas/package.json'] }, [
      { kind: 'prefix', pattern: 'packages/schemas/' },
    ]);
    expect(tracked?.prerequisite_nodes).toEqual(['test:schemas']);
    expect(tracked?.reuse.unresolved).not.toContain('prerequisite-output-proof-required');
    expect(tracked?.reuse.unresolved).not.toContain('declared-task-input-unresolved');

    const generated = buildWith({ kind: 'build', paths: ['packages/schemas/dist/index.js'] }, [
      { kind: 'prefix', pattern: 'packages/schemas/' },
    ]);
    expect(generated?.prerequisite_nodes).toEqual(['test:schemas']);
    expect(generated?.reuse.unresolved).toContain('prerequisite-output-proof-required');

    const missingInput = buildWith(
      { kind: 'tracked-files', paths: ['packages/schemas/package.json'] },
      [{ kind: 'prefix', pattern: 'packages/missing/' }],
    );
    expect(missingInput?.prerequisite_nodes).toEqual(['test:schemas']);
    expect(missingInput?.reuse.unresolved).toContain('declared-task-input-unresolved');
  });

  it.each([
    [
      'an unknown workspace dependency',
      { '@fixture/missing': 'workspace:*' },
      'workspace-dependency-alias-unresolved',
      true,
    ],
    [
      'an unknown ordinary registry dependency',
      { '@fixture/missing': '^1.0.0' },
      'workspace-dependency-alias-unresolved',
      false,
    ],
    [
      'an unknown dependency whose URL merely contains an alias token',
      { '@fixture/missing': 'https://registry.invalid/workspace:package' },
      'workspace-dependency-alias-unresolved',
      false,
    ],
    [
      'an incompatible workspace dependency',
      { '@devai-nyx/schemas': 'workspace:^999.0.0' },
      'workspace-dependency-range-unresolved',
      true,
    ],
  ] as const)(
    'keeps %s inside the exact fail-safe dependency population',
    (_label, dependencies, reason, expandsToFullRoster) => {
      const base = currentFixture();
      const manifestPath = 'packages/utils/package.json';
      const manifest = JSON.parse(base.files.get(manifestPath)?.toString() ?? '') as Record<
        string,
        unknown
      >;
      const value = build(
        base,
        mutate(
          base.files,
          manifestPath,
          Buffer.from(JSON.stringify({ ...manifest, dependencies }), 'utf8'),
        ),
      );
      const entry = value.plan.packages.find((item) => item.id === 'utils');
      if (entry === undefined) throw new Error('fixture package missing');
      const fullRoster = value.plan.packages
        .map((item) => item.expected.packageName)
        .filter((name) => name !== entry.expected.packageName)
        .sort();

      expect(entry.reuse.unresolved.includes(reason)).toBe(expandsToFullRoster);
      expect(entry.workspace_dependencies).toEqual(expandsToFullRoster ? fullRoster : []);
    },
  );

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

  it('discovers only root and package-root TypeScript configurations for the historical closure', () => {
    const base = fixture();
    const count = (value: ReturnType<typeof build>): number => {
      const entry = value.plan.packages.find((item) => item.id === 'utils');
      const bindings = entry?.expected.inputProjection['bindings'] as
        Record<string, Record<string, unknown>> | undefined;
      const memberCount = bindings?.['mutationConfiguration']?.['memberCount'];
      if (typeof memberCount !== 'number') throw new Error('fixture binding count missing');
      return memberCount;
    };
    const initialBuild = build(base);
    const initial = count(initialBuild);
    expect(
      initialBuild.plan.packages.find((entry) => entry.id === 'utils')?.reuse.unresolved,
    ).not.toContain('typescript-package-configuration-missing');
    for (const [label, paths, increase] of [
      ['eligible roots', ['tsconfig.packet23.json', 'packages/utils/tsconfig.packet23.json'], 2],
      [
        'ineligible names and directories',
        [
          'configs/tsconfig.packet23.json',
          'packages/utils/nested/tsconfig.packet23.json',
          'packages/utils/prefix-tsconfig.packet23.json',
          'packages/utils/tsconfig.packet23.json.backup',
        ],
        0,
      ],
    ] as const) {
      const files = new Map(base.files);
      for (const path of paths) files.set(path, Buffer.from('{"compilerOptions":{}}\n'));
      expect(count(build(base, files)), label).toBe(initial + increase);
    }

    const missing = new Map(base.files);
    missing.delete('packages/utils/tsconfig.json');
    expect(
      build(base, missing).plan.packages.find((entry) => entry.id === 'utils')?.reuse.unresolved,
    ).toContain('typescript-package-configuration-missing');
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

  it('resolves directory project references without granting shared root configuration source authority', () => {
    const mapped = mappedFixture();
    mapped.base.files.set(
      mapped.typescript,
      Buffer.from('{"references":[{"path":"../packages/utils"}]}\n'),
    );
    const mappedEntry = build(mapped.base).plan.packages.find((entry) => entry.id === 'utils');
    expect(
      mappedEntry?.execution_configuration?.typescript_closure.map((member) => member.path),
    ).toEqual(['configs/typed-build.json', 'packages/utils/tsconfig.json', 'tsconfig.base.json']);
    expect(mappedEntry?.reuse.unresolved).not.toContain(
      'typescript-configuration-reference-unresolved',
    );

    const historical = fixture();
    historical.files.set(
      'tsconfig.base.json',
      Buffer.from('{"references":[{"path":"./packages/evidence"}]}\n'),
    );
    const historicalEntry = build(historical).plan.packages.find((entry) => entry.id === 'utils');
    expect(historicalEntry?.reuse.unresolved).not.toContain(
      'typescript-project-dependency-unresolved',
    );
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
    ['invalid JSONC', '{'],
    ['a null root', 'null'],
    ['a scalar root', '"configuration"'],
    ['an array root', '[]'],
  ] as const)(
    'keeps %s TypeScript configuration ineligible without evaluating it',
    (_label, text) => {
      const { base, typescript } = mappedFixture();
      base.files.set(typescript, Buffer.from(`${text}\n`));
      const value = build(base);
      expect(value.plan.packages.find((entry) => entry.id === 'utils')?.reuse).toEqual({
        eligible: false,
        unresolved: expect.arrayContaining([
          'typescript-configuration-syntax-unresolved',
          'toolchain-fixture-validation-required',
        ]),
      });
      expect(value.plan.grants).toEqual({ execution: false, certification: false, reuse: false });
    },
  );

  it.each([
    ['missing', '{"extends":"./missing.json"}', 'typescript-configuration-reference-unresolved'],
    [
      'escaping',
      '{"extends":"../../outside.json"}',
      'typescript-configuration-reference-unresolved',
    ],
    ['cyclic', '{"extends":"./typed-build.json"}', 'typescript-configuration-cycle'],
    [
      'non-array project references',
      '{"references":{}}',
      'typescript-configuration-reference-unresolved',
    ],
    [
      'null project-reference entry',
      '{"references":[null]}',
      'typescript-configuration-reference-unresolved',
    ],
    [
      'scalar project-reference entry',
      '{"references":[1]}',
      'typescript-configuration-reference-unresolved',
    ],
    [
      'array project-reference entry',
      '{"references":[[]]}',
      'typescript-configuration-reference-unresolved',
    ],
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

  it.each([
    [
      'a wildcard alias inside the package root',
      { paths: { '#u/*': ['../packages/utils/src/*'] } },
      false,
      'typescript-path-alias-resolution-unproven',
    ],
    [
      'a non-string alias target',
      { paths: { '#a/*': [1] } },
      true,
      'typescript-path-alias-resolution-unproven',
    ],
    ['a null alias map', { paths: null }, true, 'typescript-path-alias-resolution-unproven'],
    [
      'a missing path below the package root',
      { paths: { '#a/*': ['../packages/utils/missing/*'] } },
      true,
      'typescript-path-alias-resolution-unproven',
    ],
    [
      'an empty alias target population',
      { paths: { '#a/*': [] } },
      true,
      'typescript-path-alias-resolution-unproven',
    ],
    [
      'the exact package root',
      { paths: { '#a/*': ['../packages/utils'] } },
      false,
      'typescript-path-alias-resolution-unproven',
    ],
    [
      'a scalar alias map',
      { paths: 'packages' },
      true,
      'typescript-path-alias-resolution-unproven',
    ],
    [
      'an interior wildcard',
      { paths: { '#a/*': ['../packages/utils/*/../src'] } },
      true,
      'typescript-path-alias-resolution-unproven',
    ],
    [
      'another package root',
      { paths: { '#a/*': ['../packages/schemas/src/*'] } },
      true,
      'typescript-path-alias-resolution-unproven',
    ],
    [
      'an explicit parent base URL',
      { baseUrl: '..', paths: { '#a/*': ['packages/utils/src/*'] } },
      false,
      'typescript-path-alias-resolution-unproven',
    ],
    [
      'an absolute base URL',
      { baseUrl: '/../packages/utils', paths: { '#a/*': ['src/*'] } },
      true,
      'typescript-path-alias-resolution-unproven',
    ],
    [
      'an absolute alias target',
      { paths: { '#a/*': ['/../packages/utils/src/*'] } },
      true,
      'typescript-path-alias-resolution-unproven',
    ],
    [
      'an exact package source member',
      { paths: { '#a/*': ['../packages/utils/src/main.ts'] } },
      false,
      'typescript-path-alias-resolution-unproven',
    ],
    ['an array compiler configuration', [], true, 'typescript-configuration-syntax-unresolved'],
  ] as const)(
    'classifies %s without expanding mutation source authority',
    (_label, compilerOptions, blocked, reason) => {
      const { base, typescript } = mappedFixture();
      base.files.set(typescript, Buffer.from(`${JSON.stringify({ compilerOptions })}\n`));
      const unresolved = build(base).plan.packages.find((item) => item.id === 'utils')?.reuse
        .unresolved;
      expect(unresolved).toEqual(
        blocked ? expect.arrayContaining([reason]) : expect.not.arrayContaining([reason]),
      );
    },
  );

  it('rejects an ambiguous multi-wildcard alias even when its literal prefix is populated', () => {
    const { base, typescript } = mappedFixture();
    base.files.set(
      'packages/utils/src/*/main.ts',
      Buffer.from('export const literalWildcardDirectory = true;\n'),
    );
    base.files.set(
      typescript,
      Buffer.from(
        `${JSON.stringify({ compilerOptions: { paths: { '#u/*': ['../packages/utils/src/*/*'] } } })}\n`,
      ),
    );

    expect(
      build(base).plan.packages.find((item) => item.id === 'utils')?.reuse.unresolved,
    ).toContain('typescript-path-alias-resolution-unproven');
  });

  it('accepts an alias inside one transitive dependency root and refuses an absent exact member', () => {
    const dependency = currentFixture();
    dependency.files.set(
      'packages/authority/tsconfig.json',
      Buffer.from(
        `${JSON.stringify({ compilerOptions: { paths: { '#u/*': ['../utils/src/*'] } } })}\n`,
      ),
    );
    expect(
      build(dependency).plan.packages.find((item) => item.id === 'authority')?.reuse.unresolved,
    ).not.toContain('typescript-path-alias-resolution-unproven');

    const { base, typescript } = mappedFixture();
    base.files.set(
      typescript,
      Buffer.from(
        `${JSON.stringify({ compilerOptions: { paths: { '#missing': ['../packages/utils/src/absent.ts'] } } })}\n`,
      ),
    );
    expect(
      build(base).plan.packages.find((item) => item.id === 'utils')?.reuse.unresolved,
    ).toContain('typescript-path-alias-resolution-unproven');
  });

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
