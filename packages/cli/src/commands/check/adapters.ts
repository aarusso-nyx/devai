import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { checkPromptOverlays, loadRecipes } from '#runtime-core';
import type { ExecutorEffect } from '@devai-nyx/loop';

import { senseBuild, senseLint, senseTest, senseTypeCheck } from '@devai-nyx/sensors';

import { auditDocumentationLinks } from '../docs/links.js';
import { executeTranslationValidation } from '../verify/translation.js';

import { runCheckTasks } from '../../services/check-runner/index.js';

import { checkActionEffects } from './action-effects.js';
import { checkCiEconomy } from './ci-economy.js';
import { checkDependencies } from './dependencies.js';
import { checkDocsGovernance } from './docs-governance.js';
import { checkGlobGuards } from './glob-guards.js';
import { checkSchemasForRepository } from './schemas.js';
import { checkSensorIntegrity } from './sensor-integrity.js';
import { buildCanonicalDescriptorHandoffReport } from './documentation-report.js';
import type { CheckBinding, CheckMemberResult, ResolvedCheckMember } from './contracts.js';
import {
  type CheckExecutionOptions,
  type RawExecution,
  fromValue,
  executeArgv,
} from './adapters-execution.js';
import {
  invariantReport,
  journeyReport,
  glossaryReport,
  traceReport,
  testTraceReport,
  strategyReport,
  actionCoverageReport,
  inventoryIntegrityReport,
  mutationDeprecationReport,
  securityPerformanceReport,
  evidenceIntegrityReport,
  releaseScorecardReport,
  provenanceReadinessReport,
  changeTaxonomyReport,
  adrsReport,
  forbiddenActionsReport,
  overridesReport,
  prComplianceReport,
  blueprintReport,
  schemaInstanceReport,
} from './adapters-reports.js';
export type { CheckExecutionOptions } from './adapters-execution.js';

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
      return fromValue(checkSchemasForRepository(repoRoot));
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
      return mutationDeprecationReport();
    case 'mutation-verification':
      return mutationDeprecationReport();
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
    case 'workflow-reference':
      return executeArgv(member, ['node', 'scripts/check-workflows.mjs'], repoRoot);
    // Planning-lane members (ADR-CHK-0003): the campaign contract and the
    // rendered scorecard page, checked without generate or build.
    case 'campaign':
      return executeArgv(member, ['node', 'scripts/check-campaign.mjs'], repoRoot);
    case 'scorecard-page':
      return executeArgv(
        member,
        ['node', 'scripts/generate-scorecard-page.mjs', '--check'],
        repoRoot,
      );
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
    case 'change-taxonomy':
      return changeTaxonomyReport(repoRoot);
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
