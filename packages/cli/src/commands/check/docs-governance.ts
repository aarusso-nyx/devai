import type { CAC } from 'cac';
import { EXIT_FAIL, EXIT_PASS } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';
import {
  type GovernanceFinding,
  type CheckDocsGovernanceOptions,
  type DocsGovernanceReport,
  readProjectConfig,
  checkClassification,
  checkBuilderDeclared,
  checkLibraryDocusaurusRequired,
  checkOptOutAdr,
  checkSiteDirShape,
  checkBuildToolchain,
} from './docs-governance-config-checks.js';
import {
  checkGhPagesBranch,
  checkNoCiPublish,
  checkConfigNotPlaceholder,
} from './docs-governance-publish-checks.js';
import {
  checkDocsIaLandingExists,
  checkDocsIaConstitutionPublished,
  checkDocsIaSidebarCurated,
  checkDocsIaFrameworkMetaSplit,
  checkDocsIaDashboardCurrent,
} from './docs-governance-ia-checks.js';
export type {
  GovernanceFinding,
  DocsGovernanceReport,
  CheckDocsGovernanceOptions,
} from './docs-governance-config-checks.js';

export function checkDocsGovernance(opts: CheckDocsGovernanceOptions = {}): DocsGovernanceReport {
  const repoRoot = opts.repoRoot ?? '.';
  const noPublishCheck = opts.noPublishCheck ?? false;

  const cfg = readProjectConfig(repoRoot);

  const rule1 = checkClassification(cfg, repoRoot);
  const rule2 = checkBuilderDeclared(cfg, repoRoot);
  const rule3Finding = checkLibraryDocusaurusRequired(rule1.kind, rule2.builder);
  const rule4Finding = checkOptOutAdr(repoRoot, rule1.kind, rule2.builder);
  const rule5Finding = checkSiteDirShape(repoRoot, rule2.builder);
  const rule6Finding = checkBuildToolchain(repoRoot, cfg, rule2.builder);
  const rule7Finding = checkGhPagesBranch(repoRoot, cfg, noPublishCheck);
  const rule8Finding = checkNoCiPublish(repoRoot);
  const rule9Finding = checkConfigNotPlaceholder(repoRoot, rule2.builder);
  const ruleIa1 = checkDocsIaLandingExists(repoRoot, rule2.builder);
  const ruleIa2 = checkDocsIaConstitutionPublished(repoRoot, rule2.builder);
  const ruleIa3 = checkDocsIaSidebarCurated(repoRoot, rule2.builder);
  const ruleIa4 = checkDocsIaFrameworkMetaSplit(repoRoot, rule2.builder);
  const ruleIa5 = checkDocsIaDashboardCurrent(repoRoot, rule2.builder);

  const allFindings: GovernanceFinding[] = [
    rule1.finding,
    rule2.finding,
    rule3Finding,
    rule4Finding,
    rule5Finding,
    rule6Finding,
    rule7Finding,
    rule8Finding,
    rule9Finding,
    ruleIa1,
    ruleIa2,
    ruleIa3,
    ruleIa4,
    ruleIa5,
  ];

  const failCount = allFindings.filter((f) => f.severity === 'fail').length;
  const warnCount = allFindings.filter((f) => f.severity === 'warn').length;

  let verdict: 'pass' | 'warn' | 'fail';
  if (failCount > 0) {
    verdict = 'fail';
  } else if (warnCount > 0) {
    verdict = 'warn';
  } else {
    verdict = 'pass';
  }

  return {
    verdict,
    rules_checked: allFindings.length,
    findings: allFindings,
    fail_count: failCount,
    warn_count: warnCount,
  };
}

// ---------------------------------------------------------------------------
// CLI command
// ---------------------------------------------------------------------------

const DEFAULT_REPO_ROOT = process.cwd();

export const checkDocsGovernanceCmd = defineCommand({
  name: 'check docs-governance',
  description:
    'Validate the documented repository classification, builder choice, opt-out ADR, site shape, build toolchain, publication branch, and no-CI-publish rule.',
  authority: 'policy_firewall',
  register(cli: CAC): void {
    cli
      .command('check-docs-governance', 'Validate the documented docs-governance rules')
      .option('--repo-root <path>', `Repo root (default: cwd)`)
      .option(
        '--skip-publish-check',
        'Skip the gh-pages branch existence check (for pre-conversion adopters)',
      )
      .option('--human', 'Human-readable output')
      .action((options: { repoRoot?: string; skipPublishCheck?: boolean; human?: boolean }) => {
        const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
        const report = checkDocsGovernance({
          repoRoot,
          noPublishCheck: options.skipPublishCheck === true,
        });

        if (options.human === true) {
          const lines: string[] = [];
          const verdictLabel =
            report.verdict === 'pass' ? 'PASS' : report.verdict === 'warn' ? 'WARN' : 'FAIL';
          lines.push(
            `check docs-governance: ${verdictLabel} (${String(report.rules_checked)} rules, ${String(report.fail_count)} fail, ${String(report.warn_count)} warn)`,
          );
          for (const f of report.findings) {
            const icon = f.severity === 'pass' ? '✓' : f.severity === 'warn' ? '!' : '✗';
            lines.push(`  [${icon}] ${f.ruleId}: ${f.message}`);
            if (f.severity !== 'pass' && f.remediation !== undefined) {
              lines.push(`      Remediation: ${f.remediation}`);
            }
            if (f.locations !== undefined && f.locations.length > 0) {
              lines.push(`      Locations: ${f.locations.join(', ')}`);
            }
          }
          process.stdout.write(lines.join('\n') + '\n');
        } else {
          process.stdout.write(JSON.stringify(report) + '\n');
        }

        // Exit fail only on hard-fail findings; warn exits 0 (advisory).
        process.exit(report.fail_count > 0 ? EXIT_FAIL : EXIT_PASS);
      });
  },
});
