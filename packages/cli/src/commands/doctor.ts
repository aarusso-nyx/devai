import { join } from 'node:path';

import type { CAC } from 'cac';

import {
  readProfile,
  profileAtLeast,
  EXIT_PASS,
  EXIT_REVIEW,
  EXIT_USAGE,
  type AdoptionProfile,
} from '@devai-nyx/utils';
import { defineCommand } from '../define-command.js';

import {
  type CheckResult,
  type CheckSpec,
  type Report,
  DEFAULT_REPO_ROOT,
  DEFAULT_CHAIN_RELATIVE,
  type DoctorOptions,
} from './doctor-support.js';
import { checkF1Paths, checkPolicyMaterializationCurrent } from './doctor-policy-checks.js';
import {
  checkConstitutionSymlink,
  checkEvidenceChain,
  checkDevaiVersionMatch,
  checkAuthorityEnforcement,
  checkTrustedLocalRcBoundary,
} from './doctor-install-checks.js';
import {
  checkGovernanceTracking,
  checkBacklogOpenItems,
  checkCredentialRequirements,
  checkAgentsClaudeSync,
  checkChainPathWritableDir,
  checkLlmBridges,
  checkDocsGovernanceDoctor,
  checkConstitutionBinding,
} from './doctor-environment-checks.js';
export { checkTrustedLocalRcBoundary } from './doctor-install-checks.js';

const CHECK_SPECS: readonly CheckSpec[] = [
  {
    name: 'f1-paths-present',
    minProfile: 'tier3',
    run: (repoRoot) => checkF1Paths(repoRoot),
  },
  {
    name: 'constitution-symlink',
    run: (repoRoot) => checkConstitutionSymlink(repoRoot),
  },
  {
    name: 'policy-materialization-current',
    run: (repoRoot) => checkPolicyMaterializationCurrent(repoRoot),
  },
  {
    name: 'governance-tracking-binding',
    run: (repoRoot) => checkGovernanceTracking(repoRoot),
  },
  {
    name: 'backlog-open-items',
    run: (repoRoot) => checkBacklogOpenItems(repoRoot),
  },
  {
    name: 'credential-requirements',
    run: (repoRoot) => checkCredentialRequirements(repoRoot),
  },
  {
    name: 'agents-claude-sync',
    minProfile: 'tier3',
    run: (repoRoot) => checkAgentsClaudeSync(repoRoot),
  },
  {
    name: 'chain-dir-writable',
    run: (_repoRoot, chainPath) => checkChainPathWritableDir(chainPath),
  },
  {
    name: 'evidence-chain-valid',
    run: (_repoRoot, chainPath) => checkEvidenceChain(chainPath),
  },
  {
    name: 'llm-bridges',
    minProfile: 'tier3',
    run: () => checkLlmBridges(),
  },
  {
    name: 'docs-governance',
    minProfile: 'tier3',
    run: (repoRoot, _chainPath, skipDocsGovernance) =>
      checkDocsGovernanceDoctor(repoRoot, skipDocsGovernance === true),
  },
  {
    name: 'devai-version-match',
    minProfile: 'tier3',
    run: (repoRoot) => checkDevaiVersionMatch(repoRoot),
  },
  {
    name: 'authority-enforcement',
    minProfile: 'tier3',
    run: (repoRoot) => checkAuthorityEnforcement(repoRoot),
  },
  {
    name: 'constitution-binding',
    minProfile: 'tier3',
    run: (repoRoot) => checkConstitutionBinding(repoRoot),
  },
  {
    name: 'trusted-local-rc-boundary',
    minProfile: 'tier3',
    run: (repoRoot) => checkTrustedLocalRcBoundary(repoRoot),
  },
];

function annotatePointerOnlyAtTier3(
  checks: readonly CheckResult[],
  profile: AdoptionProfile,
): CheckResult[] {
  if (!profileAtLeast(profile, 'tier3')) return [...checks];
  return checks.map((c) => {
    if (c.name !== 'constitution-symlink') return c;
    const shape = (c.info as { shape?: string } | undefined)?.shape;
    if (shape === undefined) return c;
    return {
      ...c,
      info: {
        ...c.info,
        tier3_note:
          'pointer resolvability is distinct from the tier3 vendored-copy and digest-pin binding requirement',
      },
    };
  });
}

async function runChecks(
  repoRoot: string,
  chainPath: string,
  skipDocsGovernance?: boolean,
): Promise<Report> {
  const profile = readProfile(repoRoot);
  const checks: CheckResult[] = [];
  for (const spec of CHECK_SPECS) {
    const result = await spec.run(repoRoot, chainPath, skipDocsGovernance);
    // D-112: checks above the declared profile still run (floor, not
    // cage) but are reported advisory and never fail the run.
    const advisory = !profileAtLeast(profile, spec.minProfile ?? 'tier1');
    checks.push(advisory ? { ...result, advisory: true } : result);
  }
  const annotated = annotatePointerOnlyAtTier3(checks, profile);
  const ok = annotated.every((c) => c.ok || c.advisory === true);
  return { ok, profile, checks: annotated };
}

function renderHuman(report: Report): string {
  const lines: string[] = [];
  lines.push(`devai doctor [profile=${report.profile}]: ${report.ok ? 'OK' : 'FAIL'}`);
  for (const c of report.checks) {
    const mark = c.ok ? '✓' : c.advisory === true ? '·' : '✗';
    lines.push(
      `  [${mark}] ${c.name}${c.advisory === true ? ' (advisory: above declared profile)' : ''}`,
    );
    if (!c.ok && c.errors) {
      for (const e of c.errors) {
        lines.push(`      ${e}`);
      }
    }
    const tier3Note = (c.info as { tier3_note?: string } | undefined)?.tier3_note;
    if (tier3Note !== undefined) {
      lines.push(`      note: ${tier3Note}`);
    }
    if (c.name === 'llm-bridges' && c.info !== undefined) {
      const bridges =
        (
          c.info as {
            bridges?: ReadonlyArray<{
              family: string;
              on_path: boolean;
              usable: boolean;
              version: string | null;
            }>;
          }
        ).bridges ?? [];
      for (const b of bridges) {
        const mark = b.usable ? '✓' : b.on_path ? '!' : '·';
        const versionSuffix = b.version !== null ? ` (${b.version})` : '';
        lines.push(`      [${mark}] ${b.family}${versionSuffix}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

function runProbe(probe: string, repoRoot: string): Report {
  if (probe !== 'llm') {
    process.stderr.write(`devai doctor: --probe must be llm (got '${probe}')\n`);
    process.exit(EXIT_USAGE);
  }
  const profile = readProfile(repoRoot);
  const check = checkLlmBridges();
  return { ok: check.ok, profile, checks: [check] };
}

export const doctor = defineCommand({
  name: 'doctor',
  description: 'Diagnose an adopter repository against its installed DEVAI contracts.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('doctor', 'Diagnose an adopter repository against its installed DEVAI contracts')
      .option('--repo-root <path>', `Repo root path (default: ${DEFAULT_REPO_ROOT})`)
      .option('--chain <path>', `Chain path (default: <repo-root>/${DEFAULT_CHAIN_RELATIVE})`)
      .option('--human', 'Emit a human-readable summary instead of JSON')
      .option('--probe <probe>', 'Run one bounded diagnostic probe: llm')
      .option(
        '--skip <checks>',
        'Comma-separated list of checks to skip (for example, "docs-governance").',
      )
      .action(async (options: DoctorOptions) => {
        const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
        const chainPath = options.chain ?? join(repoRoot, DEFAULT_CHAIN_RELATIVE);
        const skipSet = new Set(
          (options.skip ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        );
        const skipDocsGovernance = skipSet.has('docs-governance');
        const report =
          options.probe === undefined
            ? await runChecks(repoRoot, chainPath, skipDocsGovernance)
            : runProbe(options.probe, repoRoot);
        if (options.human) {
          process.stdout.write(renderHuman(report));
        } else {
          process.stdout.write(JSON.stringify(report) + '\n');
        }
        process.exit(report.ok ? EXIT_PASS : EXIT_REVIEW);
      });
  },
});
