import { minimatch } from 'minimatch';
import { classifyTranslationPath } from './path-authority.js';

export type TranslationStrategy =
  'regression' | 'feature-overlay' | 'behavioral-equivalence' | 'structural' | 'semantic-review';

export interface StateChange {
  readonly path: string;
  readonly operation: 'create' | 'append' | 'retire';
}

interface TestExecution {
  readonly test_ref: string;
  readonly outcome: 'pass' | 'fail' | 'crash';
  readonly failure_mode:
    'none' | 'assertion' | 'missing-file' | 'load-error' | 'timeout' | 'signal' | 'infrastructure';
}

interface EvaluationInput {
  readonly witness: {
    readonly strategy: TranslationStrategy;
    readonly touched: readonly string[];
    readonly frame: {
      readonly authority_role: 'owner' | 'architect' | 'inspector' | 'engineer';
      readonly inventory_delta_confined_to: readonly string[];
      readonly effects_claimed: readonly string[];
    };
    readonly red_green?: readonly { readonly test_ref: string }[];
    readonly notes?: readonly string[];
  };
  readonly registered_test_refs: readonly string[];
  readonly task_scope: readonly string[];
  readonly diff_paths: readonly string[];
  readonly base_executions: readonly TestExecution[];
  readonly candidate_executions: readonly TestExecution[];
  readonly weakening_clean: boolean;
  readonly inventory_delta_modules: readonly string[];
  readonly inferred_effects: readonly string[];
  readonly expected_state_changes: readonly StateChange[];
  readonly observed_state_changes: readonly StateChange[];
  readonly strategy_coverage: {
    readonly status: 'pass' | 'fail';
    readonly finding?: string;
  };
}

export interface ValidationFrame {
  readonly name: string;
  readonly status: 'PASS' | 'REVIEW' | 'FAIL';
  readonly evidence_refs: readonly string[];
  readonly finding?: string;
}

export interface FrameEvaluation {
  readonly verdict: 'PASS' | 'REVIEW' | 'FAIL';
  readonly frames: readonly ValidationFrame[];
  readonly executed_test_refs: readonly string[];
}

function frame(name: string, pass: boolean, finding: string): ValidationFrame {
  return pass
    ? { name, status: 'PASS', evidence_refs: [] }
    : { name, status: 'FAIL', evidence_refs: [], finding };
}

function stateKey(change: StateChange): string {
  return `${change.operation}:${change.path}`;
}

function roleAllowsPath(
  role: EvaluationInput['witness']['frame']['authority_role'],
  path: string,
): boolean {
  return classifyTranslationPath(role, path).allowed;
}

export function evaluateTranslationFrames(input: EvaluationInput): FrameEvaluation {
  const claimedRefs = (input.witness.red_green ?? []).map((entry) => entry.test_ref);
  const registered = new Set(input.registered_test_refs);
  const testBacked = ['regression', 'feature-overlay'].includes(input.witness.strategy);
  const refsOk = testBacked
    ? claimedRefs.length > 0 && claimedRefs.every((ref) => registered.has(ref))
    : claimedRefs.length === 0;
  const touched = new Set(input.witness.touched);
  const diff = new Set(input.diff_paths);
  const structureOk =
    refsOk && touched.size === diff.size && [...touched].every((path) => diff.has(path));
  const executedRefs = structureOk ? claimedRefs : [];
  const baseByRef = new Map(
    input.base_executions.map((execution) => [execution.test_ref, execution]),
  );
  const candidateByRef = new Map(
    input.candidate_executions.map((execution) => [execution.test_ref, execution]),
  );
  const expected = new Set(input.expected_state_changes.map(stateKey));
  const observed = new Set(input.observed_state_changes.map(stateKey));
  const redProof: ValidationFrame = testBacked
    ? frame(
        'red-proof',
        structureOk &&
          executedRefs.every((ref) => {
            const execution = baseByRef.get(ref);
            return execution?.outcome === 'fail' && execution.failure_mode === 'assertion';
          }),
        'Base or feature-overlay execution does not provide an assertion-red proof.',
      )
    : { name: 'red-proof', status: 'PASS', evidence_refs: [] };
  const candidateProof: ValidationFrame = testBacked
    ? frame(
        'candidate-proof',
        structureOk &&
          executedRefs.every((ref) => {
            const execution = candidateByRef.get(ref);
            return execution?.outcome === 'pass' && execution.failure_mode === 'none';
          }),
        'Candidate execution is not green.',
      )
    : {
        name: 'candidate-proof',
        status: 'REVIEW',
        evidence_refs: [],
        finding: `No trusted deterministic ${input.witness.strategy} adapter is registered.`,
      };
  const strategyCoverage: ValidationFrame =
    input.strategy_coverage.status === 'pass'
      ? { name: 'strategy-coverage', status: 'PASS', evidence_refs: [] }
      : {
          name: 'strategy-coverage',
          status: 'FAIL',
          evidence_refs: [],
          finding: input.strategy_coverage.finding ?? 'Strategy coverage could not be verified.',
        };
  const frames: ValidationFrame[] = [
    frame('witness-structure', structureOk, 'Witness cites an unregistered or empty test set.'),
    frame('no-op', input.diff_paths.length > 0, 'Candidate has no changed paths.'),
    redProof,
    candidateProof,
    frame(
      'scope',
      input.diff_paths.every((path) => input.task_scope.some((glob) => minimatch(path, glob))),
      'Candidate diff escapes the declared task scope.',
    ),
    frame(
      'authority',
      input.diff_paths.every((path) => roleAllowsPath(input.witness.frame.authority_role, path)),
      'Candidate diff crosses the declared role authority.',
    ),
    frame('test-weakening', input.weakening_clean, 'Candidate weakens test evidence.'),
    frame(
      'inventory',
      input.inventory_delta_modules.every((module) =>
        input.witness.frame.inventory_delta_confined_to.includes(module),
      ),
      'Inventory delta escapes the witness frame.',
    ),
    frame(
      'effects',
      input.inferred_effects.every((effect) =>
        input.witness.frame.effects_claimed.includes(effect),
      ),
      'Inferred effects exceed the witness claim.',
    ),
    strategyCoverage,
    frame(
      'expected-diff',
      expected.size === observed.size && [...expected].every((change) => observed.has(change)),
      'Observed state changes differ from the trusted manifest.',
    ),
  ];
  return {
    verdict: frames.some((item) => item.status === 'FAIL')
      ? 'FAIL'
      : frames.some((item) => item.status === 'REVIEW')
        ? 'REVIEW'
        : 'PASS',
    frames,
    executed_test_refs: executedRefs,
  };
}

export interface InvariantLike {
  readonly id?: string;
  readonly lifecycle?: string;
  readonly status?: string;
  readonly severity?: string;
  readonly verification?: {
    readonly strategy?: {
      readonly primary?: TranslationStrategy;
      readonly deterministic_check_available?: boolean;
      readonly rationale?: string;
      readonly semantic_review_justification?: string;
    };
  };
}

export function validateInvariantStrategies(invariants: readonly InvariantLike[]): {
  readonly status: 'pass' | 'review' | 'fail';
  readonly population: number;
  readonly findings: readonly string[];
} {
  const population = invariants.filter(
    (invariant) =>
      (invariant.lifecycle === undefined || invariant.lifecycle === 'supported') &&
      invariant.status === 'active' &&
      ['constitutional', 'hard-fail', 'gate'].includes(invariant.severity ?? ''),
  );
  const findings: string[] = [];
  if (population.length === 0) findings.push('STRATEGY_POPULATION_ZERO');
  for (const invariant of population) {
    const strategy = invariant.verification?.strategy;
    if (strategy?.primary === undefined) {
      findings.push(`${invariant.id ?? '<unknown>'}: STRATEGY_MISSING`);
    } else if (
      strategy.primary === 'semantic-review' &&
      strategy.deterministic_check_available === true
    ) {
      findings.push(`${invariant.id ?? '<unknown>'}: DETERMINISTIC_PROPERTY_DECLARED_SEMANTIC`);
    }
  }
  const hasFail = findings.some((finding) =>
    /(?:POPULATION_ZERO|STRATEGY_MISSING)$/u.test(finding),
  );
  return {
    status: hasFail ? 'fail' : findings.length > 0 ? 'review' : 'pass',
    population: population.length,
    findings,
  };
}
