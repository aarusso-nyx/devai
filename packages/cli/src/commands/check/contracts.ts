import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutorEffect } from '@devai-nyx/loop';
import { EXIT_FAIL, EXIT_PASS, EXIT_REVIEW } from '@devai-nyx/utils';

export type CheckSuiteName = 'quick' | 'standard' | 'full' | 'release';
export type CheckCost = 'low' | 'medium' | 'high';
export type CheckStatus = 'pass' | 'review' | 'fail' | 'unknown' | 'na' | 'error';

export interface CheckBinding {
  readonly kind: 'package-script' | 'action' | 'runtime-gate' | 'test-file' | 'literal-argv';
  readonly argv?: readonly string[];
  readonly gate_id?: string;
}

export interface CheckMemberDefinition {
  readonly id: string;
  readonly binding: CheckBinding;
  readonly effect: ExecutorEffect;
  readonly cost: CheckCost;
  readonly output: string;
}

export interface CheckSuiteDefinition {
  readonly name: CheckSuiteName;
  readonly members: readonly string[];
  readonly excluded: readonly string[];
}

export interface CheckSuitePolicy {
  readonly schemaVersion: '1.0.0';
  readonly id: 'check-suites';
  readonly status: 'active';
  readonly authority: 'Architect';
  readonly ordering: 'members-execute-in-declared-order-without-coalescing';
  readonly unknown_behavior: 'error-never-pass';
  readonly prerequisites: readonly string[];
  readonly suites: readonly CheckSuiteDefinition[];
  readonly member_definitions: readonly CheckMemberDefinition[];
}

export interface ResolvedCheckMember extends CheckMemberDefinition {
  readonly source: 'suite-policy' | 'current-selector';
  readonly service_id: string;
}

export interface ResolvedCheckPlan {
  readonly selection: Readonly<
    | { readonly kind: 'suite'; readonly suite: CheckSuiteName }
    | { readonly kind: 'only'; readonly member: string }
  >;
  readonly prerequisites: readonly string[];
  readonly ordering: CheckSuitePolicy['ordering'];
  readonly members: readonly ResolvedCheckMember[];
  readonly maximum_effect: ExecutorEffect;
}

export interface CheckMemberResult {
  readonly id: string;
  readonly status: CheckStatus;
  readonly effect: ExecutorEffect;
  readonly binding: CheckBinding;
  readonly duration_ms: number;
  readonly value?: unknown;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exit_code?: number | null;
  readonly code?: string;
  readonly message?: string;
}

export interface CheckAggregate {
  readonly execution_status: 'pass' | 'error';
  readonly readiness_status: Exclude<CheckStatus, 'error'>;
  readonly counts: Readonly<Record<CheckStatus, number>>;
  readonly exit_code: 0 | 1 | 2;
}

export interface CheckRunReport extends CheckAggregate {
  readonly ok: boolean;
  readonly selection: ResolvedCheckPlan['selection'];
  readonly ordering: CheckSuitePolicy['ordering'];
  readonly prerequisites: readonly string[];
  readonly maximum_effect: ExecutorEffect;
  readonly results: readonly CheckMemberResult[];
}

const EFFECT_ORDER: Readonly<Record<ExecutorEffect, number>> = {
  read: 0,
  'harness-write': 1,
  'local-write': 2,
  'remote-write': 3,
};

const SUITES: readonly CheckSuiteName[] = ['quick', 'standard', 'full', 'release'];
const BINDING_KINDS = new Set<CheckBinding['kind']>([
  'package-script',
  'action',
  'runtime-gate',
  'test-file',
  'literal-argv',
]);
const EFFECTS = new Set<ExecutorEffect>(['read', 'harness-write', 'local-write', 'remote-write']);
const COSTS = new Set<CheckCost>(['low', 'medium', 'high']);

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${code}: expected object`);
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${code}: expected string array`);
  }
  return value as readonly string[];
}

function unique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${code}: duplicate value`);
}

export function loadCheckSuitePolicy(repoRoot: string): CheckSuitePolicy {
  const source = JSON.parse(
    readFileSync(join(repoRoot, 'law/policy/check-suites.json'), 'utf8'),
  ) as unknown;
  const policy = record(source, 'CHECK_POLICY_INVALID');
  if (
    policy['schemaVersion'] !== '1.0.0' ||
    policy['id'] !== 'check-suites' ||
    policy['status'] !== 'active' ||
    policy['authority'] !== 'Architect' ||
    policy['decision'] !== undefined ||
    policy['ordering'] !== 'members-execute-in-declared-order-without-coalescing' ||
    policy['unknown_behavior'] !== 'error-never-pass'
  ) {
    throw new Error('CHECK_POLICY_INVALID: canonical identity or behavior drifted');
  }

  const prerequisites = strings(policy['prerequisites'], 'CHECK_POLICY_PREREQUISITES_INVALID');
  unique(prerequisites, 'CHECK_POLICY_PREREQUISITES_INVALID');
  if (prerequisites.length === 0) {
    throw new Error('CHECK_POLICY_PREREQUISITES_INVALID: empty population');
  }

  if (!Array.isArray(policy['member_definitions'])) {
    throw new Error('CHECK_POLICY_MEMBERS_INVALID: expected array');
  }
  const members = policy['member_definitions'].map((raw, index): CheckMemberDefinition => {
    const member = record(raw, `CHECK_POLICY_MEMBER_INVALID:${String(index)}`);
    const binding = record(member['binding'], `CHECK_POLICY_BINDING_INVALID:${String(index)}`);
    if (
      typeof member['id'] !== 'string' ||
      !BINDING_KINDS.has(binding['kind'] as CheckBinding['kind']) ||
      !EFFECTS.has(member['effect'] as ExecutorEffect) ||
      !COSTS.has(member['cost'] as CheckCost) ||
      typeof member['output'] !== 'string'
    ) {
      throw new Error(`CHECK_POLICY_MEMBER_INVALID:${String(index)}`);
    }
    const argv = binding['argv'];
    const gateId = binding['gate_id'];
    const hasArgv =
      Array.isArray(argv) && argv.length > 0 && argv.every((item) => typeof item === 'string');
    const hasGate = typeof gateId === 'string' && gateId.length > 0;
    if (hasArgv === hasGate) {
      throw new Error(`CHECK_POLICY_BINDING_INVALID:${member['id']}`);
    }
    return {
      id: member['id'],
      binding: {
        kind: binding['kind'] as CheckBinding['kind'],
        ...(hasArgv ? { argv: argv as readonly string[] } : { gate_id: gateId as string }),
      },
      effect: member['effect'] as ExecutorEffect,
      cost: member['cost'] as CheckCost,
      output: member['output'],
    };
  });
  unique(
    members.map((member) => member.id),
    'CHECK_POLICY_MEMBERS_INVALID',
  );
  const byId = new Map(members.map((member) => [member.id, member]));

  if (!Array.isArray(policy['suites'])) throw new Error('CHECK_POLICY_SUITES_INVALID');
  const suites = policy['suites'].map((raw, index): CheckSuiteDefinition => {
    const suite = record(raw, `CHECK_POLICY_SUITE_INVALID:${String(index)}`);
    const name = suite['name'];
    if (name !== SUITES[index]) {
      throw new Error(`CHECK_POLICY_SUITE_ORDER_INVALID:${String(name)}`);
    }
    const suiteMembers = strings(
      suite['members'],
      `CHECK_POLICY_SUITE_MEMBERS_INVALID:${String(name)}`,
    );
    const excluded = strings(
      suite['excluded'],
      `CHECK_POLICY_SUITE_EXCLUDED_INVALID:${String(name)}`,
    );
    unique(suiteMembers, `CHECK_POLICY_SUITE_MEMBERS_INVALID:${String(name)}`);
    unique(excluded, `CHECK_POLICY_SUITE_EXCLUDED_INVALID:${String(name)}`);
    const unknown = suiteMembers.filter((member) => !byId.has(member));
    if (unknown.length > 0) {
      throw new Error(`CHECK_POLICY_SUITE_MEMBER_UNKNOWN:${unknown.join(',')}`);
    }
    return { name: name as CheckSuiteName, members: suiteMembers, excluded };
  });
  if (suites.length !== SUITES.length) throw new Error('CHECK_POLICY_SUITES_INVALID');

  return {
    schemaVersion: '1.0.0',
    id: 'check-suites',
    status: 'active',
    authority: 'Architect',
    ordering: 'members-execute-in-declared-order-without-coalescing',
    unknown_behavior: 'error-never-pass',
    prerequisites,
    suites,
    member_definitions: members,
  };
}

const CURRENT_SELECTOR_ALIASES: Readonly<Record<string, string>> = {
  schemas: 'schema-config-load',
  invariants: 'invariant-validation',
  journeys: 'journey-validation',
  glossary: 'glossary-validation',
  trace: 'trace-validation',
  'test-trace': 'test-trace-validation',
  'invariant-strategies': 'strategy-validation',
};

const CURRENT_ONLY_SELECTORS = new Set([
  'action-coverage',
  'action-effects',
  'adrs',
  'blueprint',
  'ci-economy',
  'cli-reference',
  'dependencies',
  'docs-governance',
  'docs-links',
  'forbidden-actions',
  'glob-guards',
  'glossary',
  'invariant-strategies',
  'invariants',
  'journeys',
  'mutation',
  'overrides',
  'pr-compliance',
  'prompt-overlays',
  'schema',
  'schemas',
  'sensor-integrity',
  'test-trace',
  'trace',
  'translation',
]);

function maximumEffect(members: readonly CheckMemberDefinition[]): ExecutorEffect {
  return members.reduce<ExecutorEffect>(
    (current, member) =>
      EFFECT_ORDER[member.effect] > EFFECT_ORDER[current] ? member.effect : current,
    'read',
  );
}

export function resolveCheckPlan(
  repoRoot: string,
  options: Readonly<{ readonly suite?: string; readonly only?: string }>,
): ResolvedCheckPlan {
  const policy = loadCheckSuitePolicy(repoRoot);
  if (options.suite !== undefined && options.only !== undefined) {
    throw new Error('CHECK_SELECTION_CONFLICT: --suite and --only are mutually exclusive');
  }
  const byId = new Map(policy.member_definitions.map((member) => [member.id, member]));
  if (options.only !== undefined) {
    const selector = options.only;
    const canonicalMember =
      byId.get(selector) ?? byId.get(CURRENT_SELECTOR_ALIASES[selector] ?? '');
    if (canonicalMember !== undefined) {
      const member = {
        ...canonicalMember,
        id: selector,
        source: byId.has(selector) ? ('suite-policy' as const) : ('current-selector' as const),
        service_id: selector === 'mutation' ? 'mutation-verification' : selector,
      };
      return {
        selection: { kind: 'only', member: selector },
        prerequisites: policy.prerequisites,
        ordering: policy.ordering,
        members: [member],
        maximum_effect: member.effect,
      };
    }
    if (!CURRENT_ONLY_SELECTORS.has(selector)) throw new Error(`CHECK_MEMBER_UNKNOWN:${selector}`);
    const effect: ExecutorEffect = selector === 'translation' ? 'local-write' : 'read';
    const member: ResolvedCheckMember = {
      id: selector,
      source: 'current-selector',
      service_id: selector,
      binding: { kind: 'runtime-gate', gate_id: `check-${selector}` },
      effect,
      cost: selector === 'translation' ? 'high' : 'low',
      output: `action-envelope-plus-${selector}-report`,
    };
    return {
      selection: { kind: 'only', member: selector },
      prerequisites: policy.prerequisites,
      ordering: policy.ordering,
      members: [member],
      maximum_effect: member.effect,
    };
  }

  const suiteName = options.suite ?? 'standard';
  if (!SUITES.includes(suiteName as CheckSuiteName)) {
    throw new Error(`CHECK_SUITE_UNKNOWN:${suiteName}`);
  }
  const suite = policy.suites.find((candidate) => candidate.name === suiteName);
  if (suite === undefined) throw new Error(`CHECK_SUITE_UNKNOWN:${suiteName}`);
  const members = suite.members.map((id) => {
    const member = byId.get(id);
    if (member === undefined) throw new Error(`CHECK_MEMBER_UNKNOWN:${id}`);
    return { ...member, source: 'suite-policy' as const, service_id: id };
  });
  return {
    selection: { kind: 'suite', suite: suite.name },
    prerequisites: policy.prerequisites,
    ordering: policy.ordering,
    members,
    maximum_effect: maximumEffect(members),
  };
}

export function aggregateCheckResults(results: readonly CheckMemberResult[]): CheckAggregate {
  const counts: Record<CheckStatus, number> = {
    pass: 0,
    review: 0,
    fail: 0,
    unknown: 0,
    na: 0,
    error: 0,
  };
  for (const result of results) counts[result.status] += 1;
  const readinessStatus: CheckAggregate['readiness_status'] =
    counts.fail > 0
      ? 'fail'
      : counts.review > 0
        ? 'review'
        : counts.unknown > 0
          ? 'unknown'
          : counts.pass > 0
            ? 'pass'
            : 'na';
  const executionStatus = counts.error > 0 ? 'error' : 'pass';
  const exitCode =
    executionStatus === 'error' || readinessStatus === 'fail'
      ? EXIT_FAIL
      : readinessStatus === 'review' || readinessStatus === 'unknown'
        ? EXIT_REVIEW
        : EXIT_PASS;
  return {
    execution_status: executionStatus,
    readiness_status: readinessStatus,
    counts,
    exit_code: exitCode,
  };
}

export async function runCheckPlan(
  plan: ResolvedCheckPlan,
  execute: (member: ResolvedCheckMember) => Promise<CheckMemberResult> | CheckMemberResult,
): Promise<CheckRunReport> {
  const results: CheckMemberResult[] = [];
  for (const member of plan.members) {
    try {
      const result = await execute(member);
      results.push(
        result.id === member.id
          ? result
          : {
              id: member.id,
              status: 'error',
              effect: member.effect,
              binding: member.binding,
              duration_ms: result.duration_ms,
              code: 'CHECK_RESULT_IDENTITY_MISMATCH',
              message: `executor returned ${result.id} for ${member.id}`,
            },
      );
    } catch (error) {
      results.push({
        id: member.id,
        status: 'error',
        effect: member.effect,
        binding: member.binding,
        duration_ms: 0,
        code: 'CHECK_EXECUTION_ERROR',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const aggregate = aggregateCheckResults(results);
  return {
    ok: aggregate.execution_status === 'pass' && aggregate.readiness_status === 'pass',
    selection: plan.selection,
    ordering: plan.ordering,
    prerequisites: plan.prerequisites,
    maximum_effect: plan.maximum_effect,
    results,
    ...aggregate,
  };
}
