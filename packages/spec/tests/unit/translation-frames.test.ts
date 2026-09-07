import { describe, expect, it } from 'vitest';
import {
  evaluateTranslationFrames,
  validateInvariantStrategies,
} from '../../src/translation-validation/index.js';

type Input = Parameters<typeof evaluateTranslationFrames>[0];
function valid(): Input {
  return {
    witness: {
      strategy: 'regression',
      touched: ['src/a.ts'],
      red_green: [{ test_ref: 'tests/a.test.ts' }],
      frame: {
        authority_role: 'engineer',
        inventory_delta_confined_to: ['core'],
        effects_claimed: ['fs:plant'],
      },
    },
    registered_test_refs: ['tests/a.test.ts'],
    task_scope: ['src/**'],
    diff_paths: ['src/a.ts'],
    base_executions: [{ test_ref: 'tests/a.test.ts', outcome: 'fail', failure_mode: 'assertion' }],
    candidate_executions: [{ test_ref: 'tests/a.test.ts', outcome: 'pass', failure_mode: 'none' }],
    weakening_clean: true,
    inventory_delta_modules: ['core'],
    inferred_effects: ['fs:plant'],
    expected_state_changes: [{ path: 'proof.json', operation: 'create' }],
    observed_state_changes: [{ path: 'proof.json', operation: 'create' }],
    strategy_coverage: { status: 'pass' },
  };
}
function failed(input: Input): string[] {
  const result = evaluateTranslationFrames(input);
  expect(result.verdict).toBe('FAIL');
  return result.frames.filter((frame) => frame.status === 'FAIL').map((frame) => frame.name);
}

describe('translation validation frames', () => {
  it.each(['regression', 'feature-overlay'] as const)(
    'requires every frame for a passing %s proof',
    (strategy) => {
      const input = valid();
      const result = evaluateTranslationFrames({
        ...input,
        witness: { ...input.witness, strategy },
      });
      expect(result.verdict).toBe('PASS');
      expect(result.executed_test_refs).toEqual(['tests/a.test.ts']);
      expect(result.frames).toEqual(
        [
          'witness-structure',
          'no-op',
          'red-proof',
          'candidate-proof',
          'scope',
          'authority',
          'test-weakening',
          'inventory',
          'effects',
          'strategy-coverage',
          'expected-diff',
        ].map((name) => ({ name, status: 'PASS', evidence_refs: [] })),
      );
    },
  );

  it.each([
    ['scope', { task_scope: ['other/**'] }],
    ['test-weakening', { weakening_clean: false }],
    ['inventory', { inventory_delta_modules: ['core', 'outside'] }],
    ['effects', { inferred_effects: ['fs:plant', 'proc:network'] }],
    ['expected-diff', { observed_state_changes: [] }],
    ['expected-diff', { observed_state_changes: [{ path: 'other.json', operation: 'create' }] }],
    ['expected-diff', { observed_state_changes: [{ path: 'proof.json', operation: 'append' }] }],
    [
      'expected-diff',
      {
        observed_state_changes: [
          { path: 'proof.json', operation: 'create' },
          { path: 'extra.json', operation: 'create' },
        ],
      },
    ],
    [
      'strategy-coverage',
      { strategy_coverage: { status: 'fail', finding: 'missing adapter proof' } },
    ],
  ] satisfies [string, Partial<Input>][])('independently rejects %s violations', (name, patch) => {
    expect(failed({ ...valid(), ...patch })).toEqual([name]);
  });

  it('rejects role violations independently of task scope', () => {
    const input = valid();
    expect(
      failed({
        ...input,
        witness: { ...input.witness, frame: { ...input.witness.frame, authority_role: 'owner' } },
      }),
    ).toEqual(['authority']);
  });

  it.each(['timeout', 'missing-file', 'load-error', 'signal', 'infrastructure', 'none'] as const)(
    'does not accept a %s failure as assertion-red evidence',
    (failure_mode) => {
      const input = valid();
      expect(
        failed({
          ...input,
          base_executions: [{ test_ref: 'tests/a.test.ts', outcome: 'fail', failure_mode }],
        }),
      ).toEqual(['red-proof']);
    },
  );

  it.each(['pass', 'crash'] as const)(
    'rejects base outcome %s even with an assertion label',
    (outcome) => {
      expect(
        failed({
          ...valid(),
          base_executions: [{ test_ref: 'tests/a.test.ts', outcome, failure_mode: 'assertion' }],
        }),
      ).toEqual(['red-proof']);
    },
  );

  it.each([
    { outcome: 'fail', failure_mode: 'none' },
    { outcome: 'crash', failure_mode: 'none' },
    { outcome: 'pass', failure_mode: 'assertion' },
  ] as const)('rejects inconsistent or failed candidate evidence %j', (execution) => {
    expect(
      failed({ ...valid(), candidate_executions: [{ test_ref: 'tests/a.test.ts', ...execution }] }),
    ).toEqual(['candidate-proof']);
  });

  it('requires executions for the claimed reference, not unrelated passing records', () => {
    const input = valid();
    expect(
      failed({
        ...input,
        base_executions: [
          { outcome: 'fail', failure_mode: 'assertion', test_ref: 'tests/other.test.ts' },
        ],
        candidate_executions: [],
      }),
    ).toEqual(['red-proof', 'candidate-proof']);
  });

  it.each(['unregistered', 'empty', 'different-path', 'extra-path'] as const)(
    'invalidates executable references when witness structure is %s',
    (kind) => {
      const input = valid();
      const patch: Partial<Input> =
        kind === 'unregistered'
          ? { registered_test_refs: [] }
          : {
              witness: {
                ...input.witness,
                ...(kind === 'empty'
                  ? { red_green: [] }
                  : { touched: kind === 'extra-path' ? ['src/a.ts', 'src/b.ts'] : ['src/b.ts'] }),
              },
            };
      const result = evaluateTranslationFrames({ ...input, ...patch });
      expect(result.verdict).toBe('FAIL');
      expect(result.executed_test_refs).toEqual([]);
      expect(
        result.frames.filter((frame) => frame.status === 'FAIL').map((frame) => frame.name),
      ).toEqual(['witness-structure', 'red-proof', 'candidate-proof']);
    },
  );

  it('rejects an empty diff even with a matching empty witness', () => {
    const input = valid();
    expect(
      failed({ ...input, diff_paths: [], witness: { ...input.witness, touched: [] } }),
    ).toEqual(['no-op']);
  });

  it.each(['structural', 'behavioral-equivalence', 'semantic-review'] as const)(
    'keeps unimplemented %s adapters at REVIEW, with failures taking precedence',
    (strategy) => {
      const input = valid();
      const review = { ...input, witness: { ...input.witness, strategy, red_green: [] } };
      const result = evaluateTranslationFrames(review);
      expect(result.verdict).toBe('REVIEW');
      expect(result.executed_test_refs).toEqual([]);
      expect(result.frames.find((frame) => frame.name === 'candidate-proof')).toEqual({
        name: 'candidate-proof',
        status: 'REVIEW',
        evidence_refs: [],
        finding: `No trusted deterministic ${strategy} adapter is registered.`,
      });
      expect(failed({ ...review, weakening_clean: false })).toEqual(['test-weakening']);
      expect(
        failed({
          ...review,
          witness: { ...review.witness, red_green: [{ test_ref: 'tests/a.test.ts' }] },
        }),
      ).toEqual(['witness-structure']);
    },
  );
});

describe('invariant strategy population', () => {
  const active = {
    id: 'INV-AUTH-001',
    status: 'active',
    severity: 'hard-fail',
    verification: { strategy: { primary: 'regression' as const } },
  };
  it.each(['constitutional', 'hard-fail', 'gate'])(
    'includes supported active %s invariants',
    (severity) => {
      expect(validateInvariantStrategies([{ ...active, severity }])).toEqual({
        status: 'pass',
        population: 1,
        findings: [],
      });
    },
  );
  it('excludes experimental, inactive and advisory invariants without letting them satisfy a zero population', () => {
    expect(
      validateInvariantStrategies([
        { ...active, lifecycle: 'experimental' },
        { ...active, status: 'retired' },
        { ...active, severity: 'advisory' },
      ]),
    ).toEqual({ status: 'fail', population: 0, findings: ['STRATEGY_POPULATION_ZERO'] });
  });
  it('aggregates missing strategies and semantic misclassification with failure precedence', () => {
    expect(
      validateInvariantStrategies([
        { status: 'active', severity: 'gate' },
        {
          ...active,
          verification: {
            strategy: { primary: 'semantic-review', deterministic_check_available: true },
          },
        },
      ]),
    ).toEqual({
      status: 'fail',
      population: 2,
      findings: [
        '<unknown>: STRATEGY_MISSING',
        'INV-AUTH-001: DETERMINISTIC_PROPERTY_DECLARED_SEMANTIC',
      ],
    });
  });
  it('requires review for a deterministic property declared semantic', () => {
    expect(
      validateInvariantStrategies([
        {
          ...active,
          lifecycle: 'supported',
          verification: {
            strategy: {
              primary: 'semantic-review',
              deterministic_check_available: true,
            },
          },
        },
      ]),
    ).toEqual({
      status: 'review',
      population: 1,
      findings: ['INV-AUTH-001: DETERMINISTIC_PROPERTY_DECLARED_SEMANTIC'],
    });
  });
});
