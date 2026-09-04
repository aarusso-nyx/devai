import { describe, expect, it } from 'vitest';
import {
  assertReleaseMutationInputProjectionV21,
  buildReleaseMutationInputPlanV21,
  isDerivedReleaseMutationInputPlanV21,
  type ReleaseMutationExecutionCoverageV21,
} from '../../src/services/release-mutation-inputs.js';
import { fixture, build } from '../helpers/release-mutation-inputs-fixture.js';

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
