import { isDeepStrictEqual } from 'node:util';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv2020, { type AnySchema } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  checkForbiddenRegistryCoverage,
  checkPrCompliance,
  loadBlueprint,
  loadDomains,
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
import { validators } from '@devai-nyx/schemas';
import {
  senseHarnessPerformance,
  senseHarnessSecurity,
  senseInventoryPerformance,
  senseSecurityScan,
  senseSpecPerformanceTargets,
  senseSpecSecurityCoverage,
  senseTestPerformanceCoverage,
  senseTestSecurityCoverage,
  type SensorReading,
} from '@devai-nyx/sensors';
import { validateInvariantStrategies, type InvariantLike } from '@devai-nyx/spec';
import { runActionCoverageCheck } from '../spec/validate-action-coverage.js';
import { trackedPaths } from '../../services/check-runner/policy.js';
import { loadChangeTaxonomy } from '../../services/change-taxonomy.js';
import type { CheckStatus } from './contracts.js';
import {
  type CheckExecutionOptions,
  type RawExecution,
  fromValue,
  record,
} from './adapters-execution.js';

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

export function invariantReport(repoRoot: string): unknown {
  return specContext(repoRoot).invariants;
}

export function journeyReport(repoRoot: string): unknown {
  const context = specContext(repoRoot);
  return validateJourneys({
    journeysDir: join(repoRoot, 'product/journeys'),
    invariantIds: context.invariantIds,
  });
}

export function glossaryReport(repoRoot: string): unknown {
  const context = specContext(repoRoot);
  return validateGlossary({
    glossaryDir: join(repoRoot, 'law/glossary'),
    invariantIds: context.invariantIds,
  });
}

export function traceReport(repoRoot: string): unknown {
  const context = specContext(repoRoot);
  return validateTrace({
    tracePath: join(repoRoot, 'law/trace.json'),
    invariantIds: context.invariantIds,
  });
}

export function testTraceReport(repoRoot: string): unknown {
  return validateTestTrace({
    repoRoot,
    tracePath: join(repoRoot, 'law/trace.json'),
    invariantsDir: join(repoRoot, 'law/invariants'),
  });
}

export function strategyReport(repoRoot: string): unknown {
  const invariants = readdirSync(join(repoRoot, 'law/invariants'))
    .filter((name) => /^INV-[A-Z0-9-]+\.json$/u.test(name))
    .sort()
    .map(
      (name) =>
        JSON.parse(readFileSync(join(repoRoot, 'law/invariants', name), 'utf8')) as InvariantLike,
    );
  return validateInvariantStrategies(invariants);
}

export function actionCoverageReport(repoRoot: string): unknown {
  const domains = loadDomains(join(repoRoot, '.devai/config/domains.json'));
  const report = runActionCoverageCheck({
    repoRoot,
    invariantsDir: join(repoRoot, 'law/invariants'),
    domains,
    scope: 'self',
  });
  return { ...report, ok: report.ok };
}

export function schemaInstanceReport(options: CheckExecutionOptions): unknown {
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

export function blueprintReport(options: CheckExecutionOptions): unknown {
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

export function adrsReport(repoRoot: string): unknown {
  return validateAdrs({ adrsDir: join(repoRoot, 'law/adr') });
}

export function overridesReport(repoRoot: string): unknown {
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

export function forbiddenActionsReport(options: CheckExecutionOptions): unknown {
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

export function prComplianceReport(options: CheckExecutionOptions): unknown {
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

export async function inventoryIntegrityReport(repoRoot: string): Promise<unknown> {
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

/** Classify every tracked path; name each path no binding covers (ADR-GOV-0017). */
export function changeTaxonomyReport(repoRoot: string): RawExecution {
  const paths = trackedPaths(repoRoot);
  const counts: Record<string, number> = {};
  const unclassified: string[] = [];
  try {
    const taxonomy = loadChangeTaxonomy(repoRoot);
    for (const path of paths) {
      const className = taxonomy.classify(path);
      if (className === undefined) unclassified.push(path);
      else counts[className] = (counts[className] ?? 0) + 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^(CHANGE_TAXONOMY_[A-Z_]+)/u.exec(message)?.[1] ?? 'CHANGE_TAXONOMY_LOAD_FAILED';
    return { status: 'fail', code, message, value: { ok: false, code, message } };
  }
  const ok = unclassified.length === 0;
  return {
    status: ok ? 'pass' : 'fail',
    ...(ok
      ? {}
      : {
          code: 'CHANGE_TAXONOMY_PATH_UNCLASSIFIED',
          message: `unclassified tracked paths: ${unclassified.join(', ')}`,
        }),
    value: { ok, tracked_paths: paths.length, classes: counts, unclassified },
  };
}

export function mutationDeprecationReport(): RawExecution {
  return {
    status: 'na',
    code: 'MUTATION_OFFLOADED_TO_BEDEL',
    message:
      'Mutation testing is not required by DEVAI. Use bedel (https://github.com/aarusso-nyx/bedel).',
  };
}

export function securityPerformanceReport(repoRoot: string): RawExecution {
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

export function evidenceIntegrityReport(repoRoot: string): RawExecution {
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

export function releaseScorecardReport(repoRoot: string): RawExecution {
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

export function provenanceReadinessReport(repoRoot: string): RawExecution {
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
