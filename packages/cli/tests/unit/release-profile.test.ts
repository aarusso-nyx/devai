import { describe, expect, it } from 'vitest';
import {
  resolveReleaseMutationTaskNodes,
  resolveReleaseTaskNodes,
  resolveReleaseVerification,
} from '../../src/services/release-profile.js';

describe('release verification profile resolver', () => {
  it('classifies SemVer transitions and keeps build metadata non-behavioral', () => {
    expect(
      resolveReleaseVerification({
        currentVersion: '1.1.1',
        targetVersion: '1.1.2',
        support: 'current',
      }).transition,
    ).toBe('patch');
    expect(
      resolveReleaseVerification({
        currentVersion: '1.1.2',
        targetVersion: '1.2.0',
        support: 'current',
      }).transition,
    ).toBe('minor');
    expect(
      resolveReleaseVerification({
        currentVersion: '1.2.0',
        targetVersion: '2.0.0+build.7',
        support: 'current',
      }).transition,
    ).toBe('major');
  });

  it('fails closed for invalid, downgrade, and ordinary same-version releases', () => {
    for (const input of [
      { currentVersion: '1.2', targetVersion: '1.2.1', support: 'current' as const },
      { currentVersion: '1.2.0', targetVersion: '1.1.9', support: 'current' as const },
      { currentVersion: '1.2.0', targetVersion: '1.2.0', support: 'current' as const },
    ])
      expect(resolveReleaseVerification(input).verdict).toBe('block');
  });

  it('requires explicit support promotion for same-version LTS and full mutation', () => {
    const result = resolveReleaseVerification({
      currentVersion: '1.2.0',
      targetVersion: '1.2.0',
      support: 'lts',
      supportPromotion: true,
    });
    expect(result.verdict).toBe('ready');
    expect(result.mutation).toBe('full-roster');
    expect(result.capabilities).toContain('provenance');
    expect(result.capabilities).toEqual(
      expect.arrayContaining(['security', 'database', 'tenancy', 'operational-matrix']),
    );
  });

  it('orders prerelease identifiers according to SemVer and ignores build metadata', () => {
    expect(
      resolveReleaseVerification({
        currentVersion: '1.4.0-alpha.2',
        targetVersion: '1.4.0-alpha.10',
        support: 'preview',
      }),
    ).toMatchObject({ verdict: 'ready', transition: 'prerelease' });
    expect(
      resolveReleaseVerification({
        currentVersion: '1.4.0+build.1',
        targetVersion: '1.4.0+build.2',
        support: 'current',
      }),
    ).toMatchObject({
      verdict: 'block',
      blockingReasons: ['same-version-without-support-promotion'],
    });
  });

  it('fails closed for an unknown risk instead of selecting a cheaper profile', () => {
    expect(
      resolveReleaseVerification({
        currentVersion: '1.0.0',
        targetVersion: '1.0.1',
        support: 'current',
        risks: ['mystery-risk'],
      }),
    ).toMatchObject({ verdict: 'block', blockingReasons: ['unknown-risk:mystery-risk'] });
  });

  it('allows adopter-declared risk classes only through an explicit capability mapping', () => {
    expect(
      resolveReleaseVerification({
        currentVersion: '1.0.0',
        targetVersion: '1.0.1',
        support: 'current',
        risks: ['regulated-export'],
        riskCapabilities: { 'regulated-export': ['consumer', 'security'] },
      }),
    ).toMatchObject({ verdict: 'ready', mutation: 'targeted' });
  });

  it('maps every required capability to known task nodes and fails closed on gaps', () => {
    const decision = resolveReleaseVerification({
      currentVersion: '1.0.0',
      targetVersion: '1.0.1',
      support: 'current',
      changeKind: 'documentation',
    });
    const tasks = Object.fromEntries(
      decision.capabilities.map((capability) => [capability, ['gate']]),
    );
    expect(resolveReleaseTaskNodes(decision, tasks, ['gate'])).toEqual(['gate']);
    expect(() => resolveReleaseTaskNodes(decision, {}, ['gate'])).toThrow(
      'CHECK_RELEASE_PROFILE_CAPABILITY_UNSATISFIED',
    );
    expect(() => resolveReleaseTaskNodes(decision, tasks, [])).toThrow(
      'CHECK_RELEASE_PROFILE_UNKNOWN_TASK:gate',
    );
  });

  it('keeps MAJOR targeted while LTS alone requires the full mutation roster', () => {
    const major = resolveReleaseVerification({
      currentVersion: '1.0.0',
      targetVersion: '2.0.0',
      support: 'current',
    });
    expect(major.mutation).toBe('targeted');
    expect(major.capabilities).toEqual(
      expect.arrayContaining([
        'unit',
        'integration',
        'e2e',
        'consumer',
        'api-compatibility',
        'migration',
        'rollback',
        'security',
        'database',
        'tenancy',
        'provenance',
        'reproducibility',
      ]),
    );
    expect(
      resolveReleaseVerification({
        currentVersion: '2.0.0',
        targetVersion: '2.0.0',
        support: 'lts',
        supportPromotion: true,
      }).mutation,
    ).toBe('full-roster');
  });

  it('selects the MINOR behavior, consumer, materialization, and E2E floor', () => {
    expect(
      resolveReleaseVerification({
        currentVersion: '1.0.0',
        targetVersion: '1.1.0',
        support: 'current',
      }).capabilities,
    ).toEqual(
      expect.arrayContaining([
        'unit',
        'integration',
        'e2e',
        'consumer',
        'api-compatibility',
        'adopter-materialization',
      ]),
    );
  });

  it('records documentation patch mutation as not-required and behavior as targeted', () => {
    expect(
      resolveReleaseVerification({
        currentVersion: '1.1.1',
        targetVersion: '1.1.2',
        support: 'current',
        changeKind: 'documentation',
      }).mutationDisposition,
    ).toEqual({ status: 'not-required', reason: 'documentation-only' });
    expect(
      resolveReleaseVerification({
        currentVersion: '1.1.1',
        targetVersion: '1.1.2',
        support: 'current',
        changeKind: 'behavioral',
      }).mutation,
    ).toBe('affected');
  });

  it('records targeted mutation as not-required when the adopter declares no mutation roster', () => {
    expect(
      resolveReleaseVerification({
        currentVersion: '1.3.3',
        targetVersion: '1.4.0',
        support: 'current',
        changeKind: 'behavioral',
        mutationRosterSize: 0,
      }),
    ).toMatchObject({
      mutation: 'none',
      mutationDisposition: { status: 'not-required', reason: 'mutation-roster-empty' },
    });
    expect(
      resolveReleaseVerification({
        currentVersion: '1.4.0',
        targetVersion: '1.4.0',
        support: 'lts',
        supportPromotion: true,
        mutationRosterSize: 0,
      }),
    ).toMatchObject({ verdict: 'block', blockingReasons: ['lts-mutation-roster-empty'] });
  });

  it('unions escalation capabilities without allowing a de-escalation', () => {
    const result = resolveReleaseVerification({
      currentVersion: '1.1.1',
      targetVersion: '1.1.2',
      support: 'preview',
      changeKind: 'documentation',
      risks: ['authorization'],
      ownerEscalations: ['consumer'],
    });
    expect(result.capabilities).toEqual(
      expect.arrayContaining(['security', 'consumer', 'integration']),
    );
    expect(result.mutation).toBe('targeted');
  });

  it('selects affected, risk-targeted, and full-roster mutation task nodes', () => {
    const roster = [
      {
        id: 'a',
        package: '@example/a',
        task_node: 'mutation:a',
        source_selectors: ['packages/a/src/'],
      },
      {
        id: 'b',
        package: '@example/b',
        task_node: 'mutation:b',
        risk_classes: ['authorization'],
      },
    ];
    const affected = resolveReleaseVerification({
      currentVersion: '1.0.0',
      targetVersion: '1.0.1',
      support: 'current',
      changeKind: 'behavioral',
      mutationRosterSize: roster.length,
    });
    expect(
      resolveReleaseMutationTaskNodes(
        affected,
        roster,
        [],
        ['packages/a/src/index.ts'],
        [],
        ['mutation:a', 'mutation:b'],
      ),
    ).toEqual({ taskNodes: ['mutation:a'], rosterEntryIds: ['a'] });

    const targeted = resolveReleaseVerification({
      currentVersion: '1.0.0',
      targetVersion: '1.1.0',
      support: 'current',
      risks: ['authorization'],
      mutationRosterSize: roster.length,
    });
    expect(
      resolveReleaseMutationTaskNodes(
        targeted,
        roster,
        [],
        [],
        ['authorization'],
        ['mutation:a', 'mutation:b'],
      ),
    ).toEqual({ taskNodes: ['mutation:b'], rosterEntryIds: ['b'] });

    const lts = resolveReleaseVerification({
      currentVersion: '1.1.0',
      targetVersion: '1.1.0',
      support: 'lts',
      supportPromotion: true,
      mutationRosterSize: roster.length,
    });
    expect(
      resolveReleaseMutationTaskNodes(lts, roster, [], [], [], ['mutation:a', 'mutation:b']),
    ).toEqual({ taskNodes: ['mutation:a', 'mutation:b'], rosterEntryIds: ['a', 'b'] });
  });

  it('fails closed when affected mutation cannot resolve a roster package', () => {
    const decision = resolveReleaseVerification({
      currentVersion: '1.0.0',
      targetVersion: '1.0.1',
      support: 'current',
      changeKind: 'behavioral',
      mutationRosterSize: 1,
    });
    expect(() =>
      resolveReleaseMutationTaskNodes(
        decision,
        [{ id: 'a', package: '@example/a', task_node: 'mutation:a' }],
        [],
        [],
        [],
        ['mutation:a'],
      ),
    ).toThrow('CHECK_RELEASE_MUTATION_TARGET_UNRESOLVED');
  });

  it('applies the unconditional hygiene and candidate-integrity floor to every profile', () => {
    for (const input of [
      { currentVersion: '1.1.1', targetVersion: '1.1.2', support: 'preview' as const },
      { currentVersion: '1.1.1', targetVersion: '1.2.0', support: 'current' as const },
      { currentVersion: '1.2.0', targetVersion: '2.0.0', support: 'current' as const },
      {
        currentVersion: '2.0.0',
        targetVersion: '2.0.0',
        support: 'lts' as const,
        supportPromotion: true,
      },
    ]) {
      expect(resolveReleaseVerification(input).capabilities).toEqual(
        expect.arrayContaining([
          'formatting-hygiene',
          'lint',
          'type-integrity',
          'schema-consistency',
          'secret-scan',
          'path-portability',
          'package-integrity',
          'exact-candidate',
        ]),
      );
    }
  });
});
