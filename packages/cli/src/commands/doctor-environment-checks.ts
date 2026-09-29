import { spawnSync } from '@devai-nyx/authority';
import { existsSync, readFileSync, statSync } from '@devai-nyx/authority';
import { join, relative, resolve, sep } from 'node:path';
import { verifyConstitutionBinding } from '@devai-nyx/skills';
import { checkDocsGovernance } from './check/docs-governance.js';
import {
  readBoundTrackingConfig,
  TRACKING_WORKFLOW_RELATIVE,
  verifyTrackingBinding,
} from '../services/github-issues-tracking/config.js';
import { probeCredentialManifest } from '../services/credential-probe.js';
import { listBacklogItems } from '#runtime-core';
import {
  type CheckResult,
  readPathOverrides,
  applyPathOverride,
  CLAUDE_AGENTS_IMPORT,
  FIVE_ROLES,
  READING_ORDER_SOURCES,
  type CliProbe,
} from './doctor-support.js';

/**
 * D-119: verifies the canonical constitution-binding shape — a
 * vendored `.devai/pin/constitution.md` plus a {version, sha256} pin
 * in project.json that matches it.
 */
export function checkConstitutionBinding(repoRoot: string): CheckResult {
  const status = verifyConstitutionBinding(repoRoot);
  const upstreamNote =
    status.upstreamAhead === true
      ? [
          `pinned version ${status.pin?.version ?? '?'} differs from installed ${status.upstreamVersion ?? '?'} (run \`devai init bind --constitution --as-role architect --write\` to bind the installed contract)`,
        ]
      : [];
  return {
    name: 'constitution-binding',
    ok: status.ok,
    info: {
      has_pin: status.hasPin,
      has_vendored_copy: status.hasVendoredCopy,
      pin: status.pin,
      vendored_version: status.vendoredVersion,
      upstream_version: status.upstreamVersion,
      upstream_ahead: status.upstreamAhead,
    },
    ...((status.errors.length > 0 || upstreamNote.length > 0) && {
      errors: [...status.errors, ...upstreamNote],
    }),
  };
}

/**
 * ADR-GOV-0020: AGENTS.md is the only instruction contract and CLAUDE.md is
 * exactly the single import line `@AGENTS.md`. The required content (the
 * Article 6 reference, the five roles, and the reading-order sources) is
 * checked in AGENTS.md alone; any other CLAUDE.md, including a full copy of
 * AGENTS.md from an older bootstrap, fails.
 */
export function checkAgentsClaudeSync(repoRoot: string): CheckResult {
  const claudePath = join(repoRoot, 'CLAUDE.md');
  const agentsPath = join(repoRoot, 'AGENTS.md');
  if (!existsSync(claudePath) || !existsSync(agentsPath)) {
    return {
      name: 'agents-claude-sync',
      ok: false,
      errors: ['CLAUDE.md or AGENTS.md missing at repo root'],
    };
  }
  const claudeText = readFileSync(claudePath, 'utf8');
  const agentsText = readFileSync(agentsPath, 'utf8');
  const overrides = readPathOverrides(repoRoot);
  const errors: string[] = [];
  if (!isAgentsImport(claudeText)) {
    errors.push(
      `CLAUDE.md: must be exactly the single line '${CLAUDE_AGENTS_IMPORT}' (ADR-GOV-0020); move any guidance into AGENTS.md and replace the whole of CLAUDE.md, including a full copy of AGENTS.md written by an older bootstrap, with that one line`,
    );
  }
  if (!agentsText.includes('Article 6')) {
    errors.push('AGENTS.md: missing Constitution Article 6 reference');
  }
  for (const role of FIVE_ROLES) {
    if (!agentsText.includes(role)) {
      errors.push(`AGENTS.md: missing role '${role}'`);
    }
  }
  for (const src of READING_ORDER_SOURCES) {
    const resolvedSrc = applyPathOverride(src, overrides);
    if (!agentsText.includes(resolvedSrc)) {
      errors.push(`AGENTS.md: missing reading-order source '${resolvedSrc}'`);
    }
  }
  return {
    name: 'agents-claude-sync',
    ok: errors.length === 0,
    ...(errors.length > 0 && { errors }),
  };
}

/** True when the text is the import line alone, with at most one line ending. */
function isAgentsImport(text: string): boolean {
  return [
    CLAUDE_AGENTS_IMPORT,
    `${CLAUDE_AGENTS_IMPORT}\n`,
    `${CLAUDE_AGENTS_IMPORT}\r\n`,
  ].includes(text);
}

export function checkChainPathWritableDir(chainPath: string): CheckResult {
  try {
    const dir = chainPath.substring(0, chainPath.lastIndexOf('/'));
    const stat = statSync(dir);
    if (!stat.isDirectory()) {
      return {
        name: 'chain-dir-writable',
        ok: false,
        errors: [`${dir} is not a directory`],
      };
    }
    return { name: 'chain-dir-writable', ok: true, info: { dir } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'chain-dir-writable', ok: false, errors: [msg] };
  }
}

/**
 * Surface availability of the optional CLI bridge
 * LLM backends (`claude-cli`, `codex-cli`). Always informational — an
 * adopter who uses `claude` (the SDK family with an API key) or `mock`
 * is unaffected; the check reports which bridges are wired so an
 * adopter setting `DEVAI_LLM_BACKEND=claude-cli` sees a clear yes/no
 * + a hint when the CLI is missing or unauthenticated.
 */
export function checkLlmBridges(): CheckResult {
  const bridges = [probeCli('claude'), probeCli('codex')] as const;
  return {
    name: 'llm-bridges',
    ok: true,
    info: {
      bridges: bridges.map((b) => ({
        family: b.family,
        cli: b.cli,
        on_path: b.onPath,
        version: b.version,
        usable: b.usable,
        hint: b.hint,
      })),
    },
  };
}

function probeCli(cli: 'claude' | 'codex'): CliProbe {
  const family = (cli === 'claude' ? 'claude-cli' : 'codex-cli') as CliProbe['family'];
  const which = spawnSync('sh', ['-lc', `command -v ${cli}`], {
    encoding: 'utf8',
  });
  const onPath =
    which.status === 0 && typeof which.stdout === 'string' && which.stdout.trim().length > 0;
  if (!onPath) {
    return {
      family,
      cli,
      onPath: false,
      version: null,
      usable: false,
      hint: `Install the ${cli} CLI and ensure it is on PATH; then re-run \`devai doctor\`.`,
    };
  }
  const ver = spawnSync(cli, ['--version'], { encoding: 'utf8', timeout: 5_000 });
  const versionLine = typeof ver.stdout === 'string' ? ver.stdout.trim() : '';
  const usable = ver.status === 0;
  return {
    family,
    cli,
    onPath: true,
    version: versionLine.length > 0 ? (versionLine.split('\n')[0] ?? versionLine) : null,
    usable,
    hint: usable
      ? `Set DEVAI_LLM_BACKEND=${family} to use the host ${cli} CLI (auth via host OAuth — no API key required).`
      : `\`${cli} --version\` exited non-zero; the CLI may need a re-login (run it interactively once to refresh credentials).`,
  };
}

export function checkDocsGovernanceDoctor(repoRoot: string, skip: boolean): CheckResult {
  if (skip) {
    return {
      name: 'docs-governance',
      ok: true,
      info: { skipped: true, reason: '--skip docs-governance flag set' },
    };
  }
  try {
    const report = checkDocsGovernance({ repoRoot, noPublishCheck: true });
    const ok = report.verdict !== 'fail';
    const errors: string[] = report.findings
      .filter((f) => f.severity === 'fail')
      .map(
        (f) =>
          `[${f.ruleId}] ${f.message}${f.remediation !== undefined ? ` — ${f.remediation}` : ''}`,
      );
    return {
      name: 'docs-governance',
      ok,
      info: {
        verdict: report.verdict,
        fail_count: report.fail_count,
        warn_count: report.warn_count,
      },
      ...(errors.length > 0 && { errors }),
    };
  } catch (err) {
    return {
      name: 'docs-governance',
      ok: false,
      errors: [`docs-governance check threw: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/**
 * Governance tracking is opt-in, so absence is a valid posture and must not be
 * reported as a defect. What Doctor does refuse is a binding that misrepresents
 * itself: a wrong repository, workflow drift, excess permissions, a mutable
 * action reference, a credential fallback, or a coverage claim wider than the
 * runtime can actually mediate. No network call is ever made here — remote
 * reachability is tracking health, not adoption posture.
 */
export function checkGovernanceTracking(repoRoot: string): CheckResult {
  const name = 'governance-tracking-binding';
  let config;
  try {
    config = readBoundTrackingConfig(repoRoot);
  } catch (error) {
    return {
      name,
      ok: false,
      errors: [`tracking configuration is unreadable: ${String(error)}`],
    };
  }
  if (config === undefined) {
    return { name, ok: true, info: { mode: 'disabled', opt_out: true, network_calls: 0 } };
  }

  const workflowPath = join(repoRoot, TRACKING_WORKFLOW_RELATIVE);
  const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, 'utf8') : undefined;
  const findings = verifyTrackingBinding({ repoRoot, config, workflow });

  const errors = findings.map((finding) => `${finding.code}: ${finding.detail}`);
  if (workflow !== undefined) {
    if (workflow.includes('pull_request_target')) {
      errors.push('TRACKING_WORKFLOW_TRUST_BOUNDARY_INVALID: pull_request_target is prohibited');
    }
    // A tag or branch reference can be moved under the adopter at any time.
    for (const [, reference] of workflow.matchAll(/uses:\s*(\S+)/gu)) {
      if (!/@[0-9a-f]{40}$/u.test(reference ?? '')) {
        errors.push(`TRACKING_WORKFLOW_ACTION_MUTABLE: ${String(reference)}`);
      }
    }
    if (/PACKAGES_READ_TOKEN|github_pat_|\bPAT\b/u.test(workflow)) {
      errors.push('TRACKING_WORKFLOW_CREDENTIAL_FALLBACK: only GITHUB_TOKEN is permitted');
    }
  }

  return {
    name,
    ok: errors.length === 0,
    info: {
      mode: 'github-issues',
      repository: config.binding.repository,
      disclosure_profile: config.defaults.disclosure.profile,
      readiness_impact: config.defaults.adapter.readiness_impact,
      coverage: 'devai-mediated-actions-only',
      network_calls: 0,
    },
    ...(errors.length === 0 ? {} : { errors }),
  };
}

/**
 * ADR-GOV-0019: surface open repository backlog items at session start. The
 * items are committed, so a fresh clone sees them without host-specific state.
 * Open items are information for the next session, never a failure.
 */
export function checkBacklogOpenItems(repoRoot: string): CheckResult {
  const name = 'backlog-open-items';
  try {
    const items = listBacklogItems({ repoRoot }).map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      status: item.status,
      ...(item.round_id === undefined ? {} : { round_id: item.round_id }),
    }));
    return { name, ok: true, info: { count: items.length, items } };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return {
      name,
      ok: true,
      info: { count: 0, items: [], unreadable: typeof code === 'string' ? code : 'unreadable' },
    };
  }
}

/**
 * ADR-SEC-0001: every credential the governing manifest declares, with its
 * probe status. Informational: absence is reported, never a doctor failure,
 * because most entries are workflow secrets that cannot be observed locally.
 * The info carries ids, kinds, statuses, and fixed reason words, never a value.
 */
export function checkCredentialRequirements(repoRoot: string): CheckResult {
  const name = 'credential-requirements';
  try {
    const { manifest, results } = probeCredentialManifest(repoRoot, (argv) => {
      const [command = '', ...args] = argv;
      const result = spawnSync(command, args, {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: false,
        timeout: 15_000,
      });
      if (result.error !== undefined) throw new Error('refused');
      return {
        status: result.status,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
      };
    });
    return {
      name,
      ok: true,
      info: {
        manifest: manifest.path.startsWith(`${resolve(repoRoot)}${sep}`)
          ? relative(resolve(repoRoot), manifest.path).split(sep).join('/')
          : 'packaged',
        entries: results,
      },
    };
  } catch (error) {
    return {
      name,
      ok: true,
      info: {
        entries: [],
        unreadable: error instanceof Error ? error.message : 'CREDENTIAL_MANIFEST_UNREADABLE',
      },
    };
  }
}
