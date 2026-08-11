import { isDeepStrictEqual } from 'node:util';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv2020, { type AnySchema } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { spawnSync } from '@devai-nyx/authority';
import {
  checkForbiddenRegistryCoverage,
  checkPrCompliance,
  checkPromptOverlays,
  loadBlueprint,
  loadDomains,
  loadRecipes,
  regenerateInventory,
  scanForbiddenActions,
  scanInvOverrides,
  validateAdrs,
  validateBlueprint,
  validateGlossary,
  validateInvariants,
  validateJourneys,
  validateTestTrace,
  validateTrace,
  verifyChain,
} from '#runtime-core';
import { executeRoutineExecutor, type ExecutorEffect } from '@devai-nyx/loop';
import { validators } from '@devai-nyx/schemas';
import {
  senseBuild,
  senseHarnessPerformance,
  senseHarnessSecurity,
  senseInventoryPerformance,
  senseLint,
  senseSecurityScan,
  senseSpecPerformanceTargets,
  senseSpecSecurityCoverage,
  senseTest,
  senseTestPerformanceCoverage,
  senseTestSecurityCoverage,
  senseTypeCheck,
  type SensorReading,
} from '@devai-nyx/sensors';
import { validateInvariantStrategies, type InvariantLike } from '@devai-nyx/spec';
import { ACTION_REGISTRY } from '../../generated/action-registry.js';
import { auditDocumentationLinks } from '../docs/links.js';
import { checkMutationReport } from '../mutation/report-check.js';
import { executeTranslationValidation } from '../verify/translation.js';
import { runActionCoverageCheck } from '../spec/validate-action-coverage.js';
import { runCheckTasks } from '../../services/check-runner/index.js';
import { checkActionEffects } from './action-effects.js';
import { checkCiEconomy } from './ci-economy.js';
import { checkDependencies } from './dependencies.js';
import { checkDocsGovernance } from './docs-governance.js';
import { checkGlobGuards } from './glob-guards.js';
import { checkSchemaCanon } from './schemas.js';
import { checkSensorIntegrity } from './sensor-integrity.js';
import { buildCanonicalDescriptorHandoffReport } from './documentation-report.js';
import type {
  CheckBinding,
  CheckMemberResult,
  CheckStatus,
  ResolvedCheckMember,
} from './contracts.js';

export interface CheckExecutionOptions {
  readonly repoRoot: string;
  readonly schema?: string;
  readonly instance?: string;
  readonly file?: string;
  readonly witness?: string;
  readonly databaseUrl?: string;
  readonly prBodyFile?: string;
  readonly optional?: boolean;
  readonly strict?: boolean;
  readonly sinceRef?: string;
  readonly maxCommits?: number;
  readonly skipPublishCheck?: boolean;
  readonly mutationBaseline?: string;
  readonly mutationCurrent?: string;
  readonly mutationThresholds?: string;
}

interface RawExecution {
  readonly status: CheckStatus;
  readonly value?: unknown;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exit_code?: number | null;
  readonly code?: string;
  readonly message?: string;
}

interface ProcessCapture {
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function statusFromValue(value: unknown): CheckStatus {
  const object = record(value);
  if (object === undefined) return 'pass';
  const raw = object['status'] ?? object['verdict'];
  if (typeof raw === 'string') {
    switch (raw.toLowerCase()) {
      case 'pass':
      case 'green':
      case 'valid':
        return 'pass';
      case 'warn':
      case 'review':
      case 'amber':
      case 'yellow':
        return 'review';
      case 'fail':
      case 'block':
      case 'red':
      case 'invalid':
        return 'fail';
      case 'unknown':
      case 'inconclusive':
        return 'unknown';
      case 'na':
      case 'n/a':
      case 'skipped':
        return 'na';
      case 'error':
      case 'killed':
      case 'crash':
        return 'error';
      default:
        return 'error';
    }
  }
  if (typeof object['ok'] === 'boolean') return object['ok'] ? 'pass' : 'fail';
  if (typeof object['valid'] === 'boolean') return object['valid'] ? 'pass' : 'fail';
  return 'pass';
}

function fromValue(value: unknown): RawExecution {
  return { status: statusFromValue(value), value };
}

function parseProcess(capture: ProcessCapture): RawExecution {
  if (capture.exit_code === null) {
    return { status: 'error', ...capture, code: 'CHECK_PROCESS_NO_EXIT' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(capture.stdout.trim()) as unknown;
  } catch {
    parsed = undefined;
  }
  const structured = parsed === undefined ? undefined : statusFromValue(parsed);
  if (structured === 'error') return { status: 'error', value: parsed, ...capture };
  if (capture.exit_code !== 0) {
    return { status: structured === 'review' ? 'review' : 'fail', value: parsed, ...capture };
  }
  return { status: structured ?? 'pass', value: parsed, ...capture };
}

function timeoutFor(member: ResolvedCheckMember): number {
  return member.cost === 'high' ? 3_600_000 : member.cost === 'medium' ? 600_000 : 120_000;
}

async function executeArgv(
  member: ResolvedCheckMember,
  argv: readonly string[],
  repoRoot: string,
): Promise<RawExecution> {
  let capture: ProcessCapture | undefined;
  const checkAction = ACTION_REGISTRY.find((entry) => entry.action_id === 'check');
  if (checkAction === undefined) throw new Error('CHECK_ACTION_CONTRACT_MISSING');
  const execution = await executeRoutineExecutor({
    executor: {
      kind: 'routine',
      argv,
      cwd: '.',
      inputs: [],
      outputs: [],
      effects: [member.effect],
      timeout_ms: timeoutFor(member),
    },
    authority: {
      discipline: 'inspector',
      capabilities: checkAction.authority_contract.capabilities,
      write: true,
      allow_publish: false,
    },
    runArgv: (command, options) => {
      const result = spawnSync(command[0] ?? '', command.slice(1), {
        cwd: resolve(repoRoot, options.cwd),
        encoding: 'utf8',
        shell: false,
        timeout: options.timeout,
        env: process.env,
      });
      capture = {
        exit_code: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
      return capture;
    },
  });
  if (capture !== undefined) return parseProcess(capture);
  return {
    status: 'error',
    code: execution.ok ? 'CHECK_PROCESS_RESULT_MISSING' : execution.code,
    message: execution.ok ? 'routine executor returned no process result' : execution.message,
  };
}

function specContext(repoRoot: string) {
  const domains = loadDomains(join(repoRoot, '.devai/config/domains.json'));
  const invariants = validateInvariants({
    invariantsDir: join(repoRoot, 'law/invariants'),
    domains,
    repoRoot,
  });
  return {
    domains,
    invariants,
    invariantIds: new Set(invariants.invariants.map((item) => item.id)),
  };
}

function invariantReport(repoRoot: string): unknown {
  return specContext(repoRoot).invariants;
}

function journeyReport(repoRoot: string): unknown {
  const context = specContext(repoRoot);
  return validateJourneys({
    journeysDir: join(repoRoot, 'product/journeys'),
    invariantIds: context.invariantIds,
  });
}

function glossaryReport(repoRoot: string): unknown {
  const context = specContext(repoRoot);
  return validateGlossary({
    glossaryDir: join(repoRoot, 'law/glossary'),
    invariantIds: context.invariantIds,
  });
}

function traceReport(repoRoot: string): unknown {
  const context = specContext(repoRoot);
  return validateTrace({
    tracePath: join(repoRoot, 'law/trace.json'),
    invariantIds: context.invariantIds,
  });
}

function testTraceReport(repoRoot: string): unknown {
  return validateTestTrace({
    repoRoot,
    tracePath: join(repoRoot, 'law/trace.json'),
    invariantsDir: join(repoRoot, 'law/invariants'),
  });
}

function strategyReport(repoRoot: string): unknown {
  const invariants = readdirSync(join(repoRoot, 'law/invariants'))
    .filter((name) => /^INV-[A-Z0-9-]+\.json$/u.test(name))
    .sort()
    .map(
      (name) =>
        JSON.parse(readFileSync(join(repoRoot, 'law/invariants', name), 'utf8')) as InvariantLike,
    );
  return validateInvariantStrategies(invariants);
}

function actionCoverageReport(repoRoot: string): unknown {
  const domains = loadDomains(join(repoRoot, '.devai/config/domains.json'));
  const report = runActionCoverageCheck({
    repoRoot,
    invariantsDir: join(repoRoot, 'law/invariants'),
    domains,
    scope: 'self',
  });
  return { ...report, ok: report.ok };
}

function schemaInstanceReport(options: CheckExecutionOptions): unknown {
  if (options.schema === undefined || options.instance === undefined) {
    throw new Error('CHECK_SCHEMA_INPUT_REQUIRED: --schema and --instance are required');
  }
  const schemaPath = resolve(options.repoRoot, options.schema);
  const instancePath = resolve(options.repoRoot, options.instance);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as AnySchema;
  const instance = JSON.parse(readFileSync(instancePath, 'utf8')) as unknown;
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const valid = validate(instance);
  if (typeof valid !== 'boolean') throw new Error('CHECK_SCHEMA_ASYNC_FORBIDDEN');
  return {
    ok: valid,
    schema: schemaPath,
    instance: instancePath,
    errors: valid ? [] : (validate.errors ?? []),
  };
}

function blueprintReport(options: CheckExecutionOptions): unknown {
  if (options.file === undefined)
    throw new Error('CHECK_BLUEPRINT_FILE_REQUIRED: --file is required');
  const loaded = loadBlueprint(resolve(options.repoRoot, options.file));
  if (!loaded.ok || loaded.blueprint === undefined) {
    return { ok: false, schema_errors: loaded.errors, violations: [] };
  }
  const report = validateBlueprint(loaded.blueprint);
  return {
    ok: report.ok,
    blueprint_id: loaded.blueprint.id,
    blueprint_version: loaded.blueprint.module.version,
    schema_errors: [],
    violations: report.violations,
  };
}

function adrsReport(repoRoot: string): unknown {
  return validateAdrs({ adrsDir: join(repoRoot, 'law/adr') });
}

function overridesReport(repoRoot: string): unknown {
  const catalog = new Map<string, { severity: string }>();
  for (const name of readdirSync(join(repoRoot, 'law/invariants')).filter((item) =>
    item.endsWith('.json'),
  )) {
    try {
      const invariant = JSON.parse(
        readFileSync(join(repoRoot, 'law/invariants', name), 'utf8'),
      ) as { readonly id?: unknown; readonly severity?: unknown };
      if (typeof invariant.id === 'string' && typeof invariant.severity === 'string') {
        catalog.set(invariant.id, { severity: invariant.severity });
      }
    } catch {
      // The invariant validator reports malformed entries; this adapter keeps a total scan.
    }
  }
  const result = scanInvOverrides({ repoRoot, roots: ['packages'], invariants: catalog });
  return { ok: result.findings.length === 0, ...result };
}

function forbiddenActionsReport(options: CheckExecutionOptions): unknown {
  const result = scanForbiddenActions({
    repoRoot: options.repoRoot,
    ...(options.maxCommits !== undefined && { maxCommits: options.maxCommits }),
    ...(options.sinceRef !== undefined && { sinceRef: options.sinceRef }),
  });
  const coverage = checkForbiddenRegistryCoverage(
    join(options.repoRoot, '.devai/config/forbidden-actions.json'),
  );
  return {
    ok: result.findings.length === 0 && coverage.ok,
    ...result,
    coverage,
  };
}

function prComplianceReport(options: CheckExecutionOptions): unknown {
  let body: string;
  if (options.prBodyFile !== undefined) body = readFileSync(options.prBodyFile, 'utf8');
  else if (!process.stdin.isTTY) body = readFileSync(0, 'utf8');
  else throw new Error('CHECK_PR_BODY_REQUIRED: --pr-body-file or stdin is required');
  const invariantIds = new Set<string>();
  for (const name of readdirSync(join(options.repoRoot, 'law/invariants'))) {
    if (!name.endsWith('.json')) continue;
    try {
      const invariant = JSON.parse(
        readFileSync(join(options.repoRoot, 'law/invariants', name), 'utf8'),
      ) as { readonly id?: unknown };
      if (typeof invariant.id === 'string') invariantIds.add(invariant.id);
    } catch {
      // The invariant validator owns malformed invariant diagnostics.
    }
  }
  return checkPrCompliance({
    body,
    invariant_ids: invariantIds,
    required: options.optional !== true,
  });
}

async function inventoryIntegrityReport(repoRoot: string): Promise<unknown> {
  const inputs = {
    repoRoot,
    timestamp: '1970-01-01T00:00:00.000Z',
    integrationHead: '0'.repeat(39) + 'f',
  };
  const first = await regenerateInventory(inputs);
  const second = await regenerateInventory(inputs);
  const schemaValid = validators.inventory(first) && validators.inventory(second);
  return {
    ok: schemaValid && isDeepStrictEqual(first, second),
    schema_valid: schemaValid,
    deterministic: isDeepStrictEqual(first, second),
    inventory: first,
  };
}

function mutationPolicyReport(repoRoot: string): RawExecution {
  const policyPath = join(repoRoot, 'law/policy/mutation-strength.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
  const validPolicy =
    policy['schemaVersion'] === '1.0.0' &&
    policy['id'] === 'mutation-strength' &&
    policy['status'] === 'active';
  if (!validPolicy) return fromValue({ ok: false, policy: policyPath });
  const required = readdirSync(join(repoRoot, 'law/invariants'))
    .filter((name) => name.endsWith('.json'))
    .some((name) => {
      const invariant = JSON.parse(
        readFileSync(join(repoRoot, 'law/invariants', name), 'utf8'),
      ) as Record<string, unknown>;
      return JSON.stringify(invariant['verification'] ?? {}).includes('mutation');
    });
  if (!required) {
    return {
      status: 'na',
      value: {
        status: 'na',
        applicable: false,
        reason: 'no invariant verification strategy declares mutation',
        policy: policyPath,
      },
    };
  }
  try {
    return fromValue(checkMutationReport({ repoRoot }));
  } catch (error) {
    return {
      status: 'unknown',
      code: 'CHECK_MUTATION_EVIDENCE_MISSING',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function mutationVerificationReport(options: CheckExecutionOptions): RawExecution {
  try {
    return fromValue(
      checkMutationReport({
        repoRoot: options.repoRoot,
        ...(options.mutationBaseline !== undefined && { baseline: options.mutationBaseline }),
        ...(options.mutationCurrent !== undefined && { current: options.mutationCurrent }),
        ...(options.mutationThresholds !== undefined && { thresholds: options.mutationThresholds }),
      }),
    );
  } catch (error) {
    return {
      status: 'unknown',
      code: 'CHECK_MUTATION_EVIDENCE_MISSING',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function securityPerformanceReport(repoRoot: string): RawExecution {
  const readings: readonly SensorReading[] = [
    senseSecurityScan({ repoRoot }),
    senseSpecSecurityCoverage({ repoRoot }),
    senseSpecPerformanceTargets({ repoRoot }),
    senseTestSecurityCoverage({ repoRoot }),
    senseTestPerformanceCoverage({ repoRoot }),
    senseInventoryPerformance({ repoRoot }),
    senseHarnessPerformance({ repoRoot }),
    senseHarnessSecurity({ repoRoot }).reading,
  ];
  const statuses = readings.map((reading) => reading.status);
  const status: CheckStatus = statuses.some((item) => item === 'error' || item === 'killed')
    ? 'error'
    : statuses.some((item) => item === 'fail')
      ? 'fail'
      : statuses.some((item) => item === 'review')
        ? 'review'
        : statuses.some((item) => item === 'unknown')
          ? 'unknown'
          : statuses.every((item) => item === 'skipped')
            ? 'na'
            : 'pass';
  return { status, value: { status, readings } };
}

function evidenceIntegrityReport(repoRoot: string): RawExecution {
  const path = join(repoRoot, 'record/proofs/chain.json');
  const result = verifyChain(path);
  if (!result.valid) return fromValue({ ok: false, ...result });
  const chain = JSON.parse(readFileSync(path, 'utf8')) as { readonly records?: readonly unknown[] };
  if (!Array.isArray(chain.records) || chain.records.length === 0) {
    return {
      status: 'unknown',
      value: { status: 'unknown', valid: true, records: 0, reason: 'evidence population is empty' },
    };
  }
  return fromValue({ ok: true, ...result, records: chain.records.length });
}

function releaseScorecardReport(repoRoot: string): RawExecution {
  const path = join(repoRoot, '.devai/state/scorecards/latest.json');
  if (!existsSync(path)) {
    return {
      status: 'unknown',
      value: { status: 'unknown', path, reason: 'release scorecard is absent' },
    };
  }
  const scorecard = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!validators.scorecard(scorecard)) {
    return {
      status: 'error',
      value: { status: 'error', path, errors: validators.scorecard.errors },
    };
  }
  const object = scorecard as Record<string, unknown>;
  return fromValue({
    status: object['overall_state'] ?? object['gate_decision'] ?? 'unknown',
    scorecard,
  });
}

function provenanceReadinessReport(repoRoot: string): RawExecution {
  const candidates = ['record/proofs/compliance/releases', '.devai/state/releases'].flatMap(
    (directory) => {
      const path = join(repoRoot, directory);
      if (!existsSync(path)) return [];
      return readdirSync(path)
        .filter((name) => name.endsWith('.json'))
        .map((name) => join(path, name));
    },
  );
  if (candidates.length === 0) {
    return {
      status: 'unknown',
      value: {
        status: 'unknown',
        reason: 'no artifact/source provenance record is available',
      },
    };
  }
  const malformed = candidates.filter((path) => {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return record(value) === undefined;
    } catch {
      return true;
    }
  });
  return fromValue({ ok: malformed.length === 0, records: candidates, malformed });
}

async function directService(
  member: ResolvedCheckMember,
  options: CheckExecutionOptions,
): Promise<RawExecution> {
  const repoRoot = resolve(options.repoRoot);
  switch (member.service_id) {
    case 'ledger-local':
    case 'ledger-rc': {
      const report = runCheckTasks({
        repoRoot,
        target: member.service_id === 'ledger-local' ? 'local' : 'rc',
        operation: 'run',
      });
      return {
        status: report.exitCode === 0 ? 'pass' : 'fail',
        value: report,
        exit_code: report.exitCode,
      };
    }
    case 'build':
      return fromValue(senseBuild({ cwd: repoRoot }));
    case 'lint':
      return fromValue(senseLint({ cwd: repoRoot }));
    case 'type-check':
      return fromValue(senseTypeCheck({ cwd: repoRoot, strategy: 'root' }).aggregate);
    case 'unit-test':
      return fromValue(senseTest({ cwd: repoRoot, suite: 'unit' }));
    case 'schema-config-load':
    case 'schemas':
      return fromValue(checkSchemaCanon(repoRoot));
    case 'invariant-validation':
    case 'invariants':
      return fromValue(invariantReport(repoRoot));
    case 'journey-validation':
    case 'journeys':
      return fromValue(journeyReport(repoRoot));
    case 'glossary-validation':
    case 'glossary':
      return fromValue(glossaryReport(repoRoot));
    case 'trace-validation':
    case 'trace':
      return fromValue(traceReport(repoRoot));
    case 'test-trace-validation':
    case 'test-trace':
      return fromValue(testTraceReport(repoRoot));
    case 'strategy-validation':
    case 'invariant-strategies':
      return fromValue(strategyReport(repoRoot));
    case 'action-coverage':
      return fromValue(actionCoverageReport(repoRoot));
    case 'full-tests':
      return executeArgv(member, ['pnpm', 'vitest', 'run'], repoRoot);
    case 'inventory-integrity':
      return fromValue(await inventoryIntegrityReport(repoRoot));
    case 'mutation':
      return mutationPolicyReport(repoRoot);
    case 'mutation-verification':
      return mutationVerificationReport(options);
    case 'security-performance':
      return securityPerformanceReport(repoRoot);
    case 'harness-integrity':
      return executeArgv(
        member,
        ['pnpm', 'vitest', 'run', '--config', 'tests/config/rc.containment.config.ts'],
        repoRoot,
      );
    case 'coverage':
      return executeArgv(
        member,
        [
          'pnpm',
          'vitest',
          'run',
          '--config',
          'tests/config/rc.coverage.config.ts',
          '--coverage.reportsDirectory=scratch/coverage/rc',
        ],
        repoRoot,
      );
    case 'evidence-integrity':
      return evidenceIntegrityReport(repoRoot);
    case 'release-scorecard':
      return releaseScorecardReport(repoRoot);
    case 'dependency-security':
    case 'dependencies':
      return fromValue(checkDependencies({ repoRoot }));
    case 'provenance-readiness':
      return provenanceReadinessReport(repoRoot);
    case 'changeset-version':
      return executeArgv(member, ['node', 'scripts/check-changesets.mjs'], repoRoot);
    case 'workflow-reference':
      return executeArgv(member, ['node', 'scripts/check-workflows.mjs'], repoRoot);
    case 'cli-reference':
      return fromValue(buildCanonicalDescriptorHandoffReport(repoRoot));
    case 'docs-links': {
      const scanDir = join(repoRoot, 'docs');
      if (!existsSync(scanDir)) throw new Error(`CHECK_DOCS_DIR_MISSING:${scanDir}`);
      const broken = auditDocumentationLinks(repoRoot, scanDir);
      return fromValue({ ok: broken.length === 0, broken_count: broken.length, broken });
    }
    case 'action-effects':
      return fromValue(await checkActionEffects({ repoRoot }));
    case 'adrs':
      return fromValue(adrsReport(repoRoot));
    case 'ci-economy':
      return fromValue(checkCiEconomy({ repoRoot }));
    case 'docs-governance':
      return fromValue(
        checkDocsGovernance({
          repoRoot,
          noPublishCheck: options.skipPublishCheck === true,
        }),
      );
    case 'forbidden-actions':
      return fromValue(forbiddenActionsReport(options));
    case 'glob-guards':
      return fromValue(checkGlobGuards({ repoRoot }));
    case 'overrides':
      return fromValue(overridesReport(repoRoot));
    case 'pr-compliance':
      return fromValue(prComplianceReport(options));
    case 'prompt-overlays':
      return fromValue(checkPromptOverlays({ manifests: loadRecipes() }));
    case 'sensor-integrity':
      return fromValue(checkSensorIntegrity({ repoRoot }));
    case 'blueprint':
      return fromValue(blueprintReport(options));
    case 'schema':
      return fromValue(schemaInstanceReport(options));
    case 'translation': {
      if (options.witness === undefined) {
        throw new Error('CHECK_TRANSLATION_WITNESS_REQUIRED: --witness is required');
      }
      const report = await executeTranslationValidation({
        witness: options.witness,
        repoRoot,
        ...(options.databaseUrl !== undefined && { databaseUrl: options.databaseUrl }),
      });
      return fromValue(report);
    }
    default:
      throw new Error(`CHECK_SERVICE_UNKNOWN:${member.service_id}`);
  }
}

export async function executeCheckMember(
  member: ResolvedCheckMember,
  options: CheckExecutionOptions,
): Promise<CheckMemberResult> {
  const started = performance.now();
  let raw: RawExecution;
  try {
    raw = await directService(member, options);
  } catch (error) {
    raw = {
      status: 'error',
      code: 'CHECK_SERVICE_ERROR',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    id: member.id,
    status: raw.status,
    effect: member.effect as ExecutorEffect,
    binding: member.binding as CheckBinding,
    duration_ms: Math.max(0, Math.round(performance.now() - started)),
    ...(raw.value !== undefined && { value: raw.value }),
    ...(raw.stdout !== undefined && { stdout: raw.stdout }),
    ...(raw.stderr !== undefined && { stderr: raw.stderr }),
    ...(raw.exit_code !== undefined && { exit_code: raw.exit_code }),
    ...(raw.code !== undefined && { code: raw.code }),
    ...(raw.message !== undefined && { message: raw.message }),
  };
}
