import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CAC } from 'cac';
import { EXIT_FAIL, EXIT_PASS } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';

/**
 * CI-economy check behind the canonical `check` facade.
 *
 * Enforces ADR-CI-ECONOMY's mechanical rules against a repo's
 * `.github/workflows/`. Mechanical rules (hard unless noted):
 *
 *   1. ci-economy.concurrency-cancel — every pull_request-triggered
 *      workflow declares `concurrency` with `cancel-in-progress: true`
 *      (Decision 5.2).
 *   2. ci-economy.no-macos-on-pr — no macOS runner reference in any
 *      pull_request-triggered workflow (Decision 5.1; macOS bills 10×).
 *   3. ci-economy.no-triple-trigger — no workflow triggered by all three
 *      of pull_request + push + schedule. The single remote verifier has
 *      no scheduled product-validation lane.
 *   4. ci-economy.evidence-gate-wired — at least one workflow invokes the
 *      independently pinned DEVAI ledger verifier. Severity is
 *      profile-conditioned (Decision 8 as amended by D-116): hard under
 *      the default `full` CI-economy profile; ADVISORY when the target
 *      repo's `.devai/config/project.json` declares
 *      `ci_economy.profile: "gate-staged"` (incremental-adoption path —
 *      still evaluated and reported, never silently dropped). Rules 1–3
 *      are hard under both profiles.
 *
 * Judgment rules are emitted as ADVISORY findings (severity `warn`,
 * exit 0) because their correct resolution depends on what the repo's
 * gates consume (ADR-CI-ECONOMY Decision 8): path-filter opportunities,
 * cron cadence, macOS cost outside PR paths, scheduled-audit presence,
 * shared-Postgres DB-isolation heuristics.
 *
 * Parsing is deliberately line-based (no YAML dependency): every rule
 * is a structural presence/absence check on trigger keys and well-known
 * tokens, which survives the full range of workflow-file styles the
 * governed repos actually use.
 *
 * Authority: policy_firewall (same family as `check docs-governance`).
 */

const DEFAULT_REPO_ROOT = '.';
const DEFAULT_WORKFLOWS_DIR = '.github/workflows';

export interface CiEconomyFinding {
  readonly ruleId: string;
  readonly severity: 'fail' | 'warn' | 'pass';
  readonly message: string;
  readonly remediation?: string;
  readonly locations?: string[];
}

export type CiEconomyProfile = 'full' | 'gate-staged';

export interface CiEconomyReport {
  readonly verdict: 'pass' | 'warn' | 'fail';
  readonly rules_checked: number;
  readonly workflows_scanned: number;
  /** Enforcement profile read from the target repo's .devai/config/project.json (D-116). */
  readonly ci_economy_profile: CiEconomyProfile;
  readonly findings: readonly CiEconomyFinding[];
  readonly fail_count: number;
  readonly warn_count: number;
}

export interface CheckCiEconomyOptions {
  readonly repoRoot: string;
  readonly workflowsDir?: string;
}

interface WorkflowFacts {
  readonly file: string;
  readonly triggers: ReadonlySet<string>;
  readonly crons: readonly string[];
  readonly hasConcurrencyKey: boolean;
  readonly hasCancelInProgress: boolean;
  readonly hasPathFilters: boolean;
  readonly referencesMacos: boolean;
  readonly hasPostgresService: boolean;
  readonly hasEvidenceMarker: boolean;
}

/** Trigger keys recognized at the top level of an `on:` block. */
const KNOWN_TRIGGERS = new Set([
  'push',
  'pull_request',
  'pull_request_target',
  'schedule',
  'workflow_call',
  'workflow_dispatch',
  'workflow_run',
  'release',
  'merge_group',
  'issue_comment',
  'create',
  'delete',
]);

/**
 * Read the CI-economy enforcement profile from the target repo's
 * `.devai/config/project.json` (`ci_economy.profile`, project-config
 * schema). Missing file, unparseable JSON, absent key, or any value
 * other than the exact staging declaration all resolve to `full` —
 * the strict default; staging is only ever an explicit declaration
 * (ADR-CI-ECONOMY Decision 8 as amended by D-116).
 */
export function readCiEconomyProfile(repoRoot: string): CiEconomyProfile {
  const cfgPath = join(repoRoot, '.devai/config/project.json');
  if (!existsSync(cfgPath)) return 'full';
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
      ci_economy?: { profile?: string };
    };
    return cfg.ci_economy?.profile === 'gate-staged' ? 'gate-staged' : 'full';
  } catch {
    return 'full';
  }
}

const VERIFIER_REPOSITORY = /repository:\s*devai-nyx\/devai-verifier/u;
const VERIFIER_PIN = /ref:\s*2c6e5acaade7aae65d23f86fc7f6fdf7e56d945c/u;
const VERIFIER_INVOCATION = /node\s+\.devai-verifier\/src\/cli\.js/u;

/**
 * Extract the trigger set from a workflow file. Handles the three
 * authoring shapes: `on: push`, `on: [push, pull_request]`, and the
 * block form with trigger keys indented under `on:`.
 */
export function parseTriggers(text: string): Set<string> {
  const triggers = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = /^(?:on|"on"|'on'):\s*(.*)$/.exec(line);
    if (m === null) continue;
    const rest = (m[1] ?? '').replace(/#.*$/, '').trim();
    if (rest !== '') {
      // Inline forms.
      if (rest.startsWith('[')) {
        for (const item of rest.replace(/^\[|\]$/g, '').split(',')) {
          const t = item.trim().replace(/^['"]|['"]$/g, '');
          if (t !== '') triggers.add(t);
        }
      } else {
        triggers.add(rest.replace(/^['"]|['"]$/g, ''));
      }
      return triggers;
    }
    // Block form: collect keys until the next column-0 key.
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? '';
      if (l.trim() === '' || l.trim().startsWith('#')) continue;
      if (/^[^\s#]/.test(l)) break; // next top-level key
      const km = /^(\s+)(- )?([A-Za-z_]+):/.exec(l);
      if (km === null) continue;
      const indent = (km[1] ?? '').length;
      const key = km[3] ?? '';
      // Only first-level keys under `on:` are triggers; deeper keys
      // (branches, paths, types, cron) have larger indents, but a
      // fixed indent cannot be assumed — filter by the known-trigger
      // vocabulary instead, at the shallowest indent seen.
      if (indent <= 2 && KNOWN_TRIGGERS.has(key)) triggers.add(key);
    }
    return triggers;
  }
  return triggers;
}

function collectFacts(dir: string, file: string): WorkflowFacts {
  const text = readFileSync(join(dir, file), 'utf8');
  const triggers = parseTriggers(text);
  const crons: string[] = [];
  for (const cm of text.matchAll(/-\s*cron:\s*['"]?([^'"#\n]+)['"]?/g)) {
    crons.push((cm[1] ?? '').trim());
  }
  return {
    file,
    triggers,
    crons,
    hasConcurrencyKey: /^concurrency:/m.test(text),
    hasCancelInProgress: /cancel-in-progress:\s*true/.test(text),
    hasPathFilters: /^\s+paths(-ignore)?:/m.test(text),
    referencesMacos: /\bmacos-/i.test(text) || /runs-on:.*macos/i.test(text),
    hasPostgresService: /image:\s*['"]?postgres/.test(text),
    hasEvidenceMarker:
      VERIFIER_REPOSITORY.test(text) && VERIFIER_PIN.test(text) && VERIFIER_INVOCATION.test(text),
  };
}

function hasPrTrigger(f: WorkflowFacts): boolean {
  return f.triggers.has('pull_request') || f.triggers.has('pull_request_target');
}

/** A cron that fires daily or more often: day-of-month AND day-of-week both '*'. */
export function cronIsDailyOrMore(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const dom = fields[2] ?? '*';
  const dow = fields[4] ?? '*';
  return dom === '*' && dow === '*';
}

export function checkCiEconomy(opts: CheckCiEconomyOptions): CiEconomyReport {
  const workflowsDir = join(opts.repoRoot, opts.workflowsDir ?? DEFAULT_WORKFLOWS_DIR);
  const profile = readCiEconomyProfile(opts.repoRoot);
  const findings: CiEconomyFinding[] = [];

  let files: string[] = [];
  if (existsSync(workflowsDir)) {
    files = readdirSync(workflowsDir)
      .filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))
      .sort();
  }

  const facts = files.map((f) => collectFacts(workflowsDir, f));

  // ── Rule 1 — ci-economy.concurrency-cancel (hard) ────────────────────
  const missingConcurrency = facts.filter(
    (f) => hasPrTrigger(f) && !(f.hasConcurrencyKey && f.hasCancelInProgress),
  );
  findings.push(
    missingConcurrency.length === 0
      ? {
          ruleId: 'ci-economy.concurrency-cancel',
          severity: 'pass',
          message:
            'every pull_request-triggered workflow declares concurrency with cancel-in-progress: true',
        }
      : {
          ruleId: 'ci-economy.concurrency-cancel',
          severity: 'fail',
          message: `${String(missingConcurrency.length)} pull_request-triggered workflow(s) lack a concurrency block with cancel-in-progress: true`,
          remediation:
            'Add `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }` (ADR-CI-ECONOMY Decision 5.2).',
          locations: missingConcurrency.map((f) => f.file),
        },
  );

  // ── Rule 2 — ci-economy.no-macos-on-pr (hard) ────────────────────────
  const macosOnPr = facts.filter((f) => hasPrTrigger(f) && f.referencesMacos);
  findings.push(
    macosOnPr.length === 0
      ? {
          ruleId: 'ci-economy.no-macos-on-pr',
          severity: 'pass',
          message: 'no macOS runner reference in any pull_request-triggered workflow',
        }
      : {
          ruleId: 'ci-economy.no-macos-on-pr',
          severity: 'fail',
          message: `${String(macosOnPr.length)} pull_request-triggered workflow(s) reference macOS runners (10× Linux pricing)`,
          remediation:
            'The remote ledger verifier must use the Linux runner; product validation remains local.',
          locations: macosOnPr.map((f) => f.file),
        },
  );

  // ── Rule 3 — ci-economy.no-triple-trigger (hard) ─────────────────────
  const tripleTrigger = facts.filter(
    (f) => hasPrTrigger(f) && f.triggers.has('push') && f.triggers.has('schedule'),
  );
  findings.push(
    tripleTrigger.length === 0
      ? {
          ruleId: 'ci-economy.no-triple-trigger',
          severity: 'pass',
          message: 'no workflow is triggered by all of pull_request + push + schedule',
        }
      : {
          ruleId: 'ci-economy.no-triple-trigger',
          severity: 'fail',
          message: `${String(tripleTrigger.length)} workflow(s) run the same content on pull_request + push + schedule`,
          remediation:
            'Keep the single pull_request + push ledger-verification workflow and remove scheduled product validation.',
          locations: tripleTrigger.map((f) => f.file),
        },
  );

  // ── Rule 4 — ci-economy.evidence-gate-wired ──────────────────────────
  // Hard under the (default) `full` profile; ADVISORY when the target
  // repo declares ci_economy.profile: "gate-staged" — still evaluated
  // and reported, never silently dropped (D-116).
  const evidenceWired = facts.some((f) => f.hasEvidenceMarker);
  if (evidenceWired) {
    findings.push({
      ruleId: 'ci-economy.evidence-gate-wired',
      severity: 'pass',
      message:
        profile === 'gate-staged'
          ? 'evidence substrate is wired into at least one workflow — the gate-staged declaration is no longer needed; set ci_economy.profile to "full" in .devai/config/project.json'
          : 'evidence substrate is wired into at least one workflow',
    });
  } else {
    const notWiredMessage =
      files.length === 0
        ? `no workflow files found under ${opts.workflowsDir ?? DEFAULT_WORKFLOWS_DIR}`
        : 'no workflow invokes the pinned independent DEVAI ledger verifier';
    findings.push(
      profile === 'gate-staged'
        ? {
            ruleId: 'ci-economy.evidence-gate-wired',
            severity: 'warn',
            message: `${notWiredMessage} — ADVISORY, not FAIL: ci_economy.profile = "gate-staged" declared in .devai/config/project.json`,
            remediation:
              'Wire the pinned devai-nyx/devai-verifier checkout and CLI invocation, then graduate ci_economy.profile to "full".',
          }
        : {
            ruleId: 'ci-economy.evidence-gate-wired',
            severity: 'fail',
            message: notWiredMessage,
            remediation:
              'Add the single ledger-verification workflow with devai-nyx/devai-verifier pinned to its approved immutable commit. Incremental adopters may declare ci_economy.profile: "gate-staged" until that verifier is wired.',
          },
    );
  }

  // ── Advisory — ci-economy.path-filters ───────────────────────────────
  const unfiltered = facts.filter(
    (f) =>
      (hasPrTrigger(f) || f.triggers.has('push')) &&
      !f.hasPathFilters &&
      !f.triggers.has('workflow_call'),
  );
  if (unfiltered.length > 0) {
    findings.push({
      ruleId: 'ci-economy.path-filters',
      severity: 'warn',
      message: `${String(unfiltered.length)} pull_request/push workflow(s) declare no paths/paths-ignore filters`,
      remediation:
        'Advisory (judgment rule): add filters for content the gates do not consume — but never filter content a gate reads (ADR-CI-ECONOMY Decision 5.3; devai itself runs unfiltered because its Markdown is a tested artifact).',
      locations: unfiltered.map((f) => f.file),
    });
  }

  // ── Advisory — ci-economy.cron-cadence ───────────────────────────────
  const dailyCrons = facts.filter((f) => f.crons.some(cronIsDailyOrMore));
  if (dailyCrons.length > 0) {
    findings.push({
      ruleId: 'ci-economy.cron-cadence',
      severity: 'warn',
      message: `${String(dailyCrons.length)} workflow(s) carry a cron firing daily or more often`,
      remediation:
        'The RC CI contract has no scheduled lane; remove the cron unless it is independently authorized.',
      locations: dailyCrons.map((f) => f.file),
    });
  }

  // ── Advisory — ci-economy.macos-cost ─────────────────────────────────
  const macosElsewhere = facts.filter((f) => !hasPrTrigger(f) && f.referencesMacos);
  if (macosElsewhere.length > 0) {
    findings.push({
      ruleId: 'ci-economy.macos-cost',
      severity: 'warn',
      message: `${String(macosElsewhere.length)} non-PR workflow(s) reference macOS runners (10× Linux pricing)`,
      remediation:
        'The remote ledger verifier is platform-neutral and must stay on the Linux runner.',
      locations: macosElsewhere.map((f) => f.file),
    });
  }

  // ── Advisory — ci-economy.db-isolation ───────────────────────────────
  const postgresWorkflows = facts.filter((f) => f.hasPostgresService);
  if (postgresWorkflows.length > 0) {
    findings.push({
      ruleId: 'ci-economy.db-isolation',
      severity: 'warn',
      message: `${String(postgresWorkflows.length)} workflow(s) run a Postgres service container`,
      remediation:
        'Advisory: if test suites execute concurrently against it, isolate them — per-package ephemeral databases or serialized DB-heavy suites; timeout inflation is not compliance (ADR-CI-ECONOMY Decision 6).',
      locations: postgresWorkflows.map((f) => f.file),
    });
  }

  const failCount = findings.filter((f) => f.severity === 'fail').length;
  const warnCount = findings.filter((f) => f.severity === 'warn').length;

  return {
    verdict: failCount > 0 ? 'fail' : warnCount > 0 ? 'warn' : 'pass',
    rules_checked: 4,
    workflows_scanned: files.length,
    ci_economy_profile: profile,
    findings,
    fail_count: failCount,
    warn_count: warnCount,
  };
}

export const checkCiEconomyCmd = defineCommand({
  name: 'check ci-economy',
  description:
    'Validate .github/workflows/ against the cheap remote ledger-verification contract: cancel-in-progress concurrency on PR workflows, no macOS on pull_request, no pull_request+push+schedule triple triggers, and an independently pinned verifier. Rules 1-3 always hard-fail; rule 4 is hard under the default "full" profile and advisory under an explicit "gate-staged" profile. Path-filter, cron, macOS-cost, and DB-isolation findings remain advisory.',
  authority: 'policy_firewall',
  register(cli: CAC): void {
    cli
      .command('check-ci-economy', 'Validate CI-economy rules (ADR-CI-ECONOMY)')
      .option('--repo-root <path>', `Repo root (default: ${DEFAULT_REPO_ROOT})`)
      .option(
        '--workflows-dir <path>',
        `Workflows directory relative to repo root (default: ${DEFAULT_WORKFLOWS_DIR})`,
      )
      .option('--human', 'Human-readable output')
      .action((options: { repoRoot?: string; workflowsDir?: string; human?: boolean }) => {
        const report = checkCiEconomy({
          repoRoot: options.repoRoot ?? DEFAULT_REPO_ROOT,
          ...(options.workflowsDir !== undefined && { workflowsDir: options.workflowsDir }),
        });

        if (options.human === true) {
          const lines: string[] = [];
          const verdictLabel =
            report.verdict === 'pass' ? 'PASS' : report.verdict === 'warn' ? 'WARN' : 'FAIL';
          lines.push(
            `check ci-economy: ${verdictLabel} (${String(report.workflows_scanned)} workflow(s), ${String(report.rules_checked)} mechanical rules, ${String(report.fail_count)} fail, ${String(report.warn_count)} advisory, profile: ${report.ci_economy_profile})`,
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

        // Hard rules fail the run; advisories exit 0 (judgment rules).
        process.exitCode = report.fail_count > 0 ? EXIT_FAIL : EXIT_PASS;
      });
  },
});
