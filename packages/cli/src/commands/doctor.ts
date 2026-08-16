import { spawnSync } from '@devai-nyx/authority';
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from '@devai-nyx/authority';
import { dirname, join, resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import type { CAC } from 'cac';
import { validators } from '@devai-nyx/schemas';
import { verifyConstitutionBinding } from '@devai-nyx/skills';
import { verifyChain } from '@devai-nyx/evidence';
import {
  readProfile,
  profileAtLeast,
  EXIT_PASS,
  EXIT_REVIEW,
  EXIT_USAGE,
  type AdoptionProfile,
} from '@devai-nyx/utils';
import { canonicalRegistry, defineCommand } from '../define-command.js';
import { buildTrustedAuthoritySources, canonicalSha256 } from '../authority/policy.js';
import { checkDocsGovernance } from './check/docs-governance.js';
import { resolveCliProvenance, resolveCliVersion } from '../version.js';
import { verifyInstalledPostMergeAdapter } from '../services/hooks-install/index.js';
import { verifyGithubActionsAdapter } from '../services/github-actions-adapter/index.js';
import {
  inspectRemoteLocalOnlyNodes,
  readAttestedRcConfig,
} from './check/ci-local-only.js';
import {
  ATTESTED_RC_WORKFLOW_FILE,
  attestedRcVerificationWorkflow,
} from '../services/ci-scaffold/index.js';

const DEFAULT_REPO_ROOT = '.';
const DEFAULT_CHAIN_RELATIVE = 'record/proofs/chain.json';

const F1_PATHS = [
  'product',
  'law/invariants',
  'law/schemas',
  'law/adr',
  'docs/dev/operations',
  'docs/dev/security',
  'law/glossary',
] as const;

const READING_ORDER_SOURCES = [
  'README.md',
  'law/constitution.md',
  'law/adr',
  'law/schemas',
] as const;
const FIVE_ROLES = ['Owner', 'Architect', 'Inspector', 'Engineer', 'Auditor'] as const;

interface DoctorOptions {
  readonly repoRoot?: string;
  readonly chain?: string;
  readonly human?: boolean;
  readonly probe?: string;
  /** Comma-separated list of checks to skip, e.g. "docs-governance". */
  readonly skip?: string;
}

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  /** D-112: true when the check is above the declared adoption profile — reported, never failing the run. */
  readonly advisory?: boolean;
  readonly info?: Record<string, unknown>;
  readonly errors?: readonly string[];
}

interface Report {
  readonly ok: boolean;
  /** Declared adoption profile (D-112); absent project.json key resolves to tier3. */
  readonly profile: AdoptionProfile;
  readonly checks: readonly CheckResult[];
}

/**
 * D-125: adopters whose docs substrate has legitimately relocated (e.g. per
 * a binding ADR reclassifying an F1 path, as ADR-DOCS-IA Decision 11's §6
 * criterion can require) declare the relocation in
 * `.devai/config/project.json`'s `docs.ia.path_overrides` — a map from the
 * canonical F1/reading-order key (a `docs/`-rooted path with the `docs/`
 * prefix stripped, e.g. `"framework/contracts"`) to the adopter's actual
 * current relative path (e.g. `"reference/contracts"`). Absent config, or
 * an absent/malformed key, resolves to `{}`, so `f1-paths-present` and
 * `agents-claude-sync` stay byte-identical to pre-D-125 behavior for every
 * adopter that hasn't declared an override.
 */
function readPathOverrides(repoRoot: string): Record<string, string> {
  const configPath = join(repoRoot, '.devai/config/project.json');
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
      docs?: { ia?: { path_overrides?: Record<string, string> } };
    };
    return parsed.docs?.ia?.path_overrides ?? {};
  } catch {
    return {};
  }
}

/**
 * Resolves a canonical `docs/...`-rooted path through the override map.
 * Root-level filenames (no `docs/` prefix — the other four
 * `READING_ORDER_SOURCES` entries) pass through unchanged: the override
 * only covers F1-substrate relocations, not adopter substitution of the
 * root reading-order files themselves (that is a separate, adopter-local
 * ADR concern, e.g. PEC's ADR-0008).
 */
function applyPathOverride(
  canonicalPath: string,
  overrides: Readonly<Record<string, string>>,
): string {
  if (!canonicalPath.startsWith('docs/')) return canonicalPath;
  const key = canonicalPath.slice('docs/'.length);
  const override = overrides[key];
  return override !== undefined ? `docs/${override}` : canonicalPath;
}

function checkF1Paths(repoRoot: string): CheckResult {
  const expected = F1_PATHS;
  const overrides = readPathOverrides(repoRoot);
  const resolvedPaths: string[] = [];
  const missing: string[] = [];
  for (const p of expected) {
    const actual = applyPathOverride(p, overrides);
    resolvedPaths.push(actual);
    if (!existsSync(join(repoRoot, actual))) missing.push(actual);
  }
  return {
    name: 'f1-paths-present',
    ok: missing.length === 0,
    info: {
      paths: resolvedPaths,
      missing,
      ...(Object.keys(overrides).length > 0 && { path_overrides: overrides }),
    },
    ...(missing.length > 0 && { errors: missing.map((p) => `missing F1 path: ${p}`) }),
  };
}

function checkEvidenceChain(chainPath: string): CheckResult {
  if (!existsSync(chainPath)) {
    return {
      name: 'evidence-chain-valid',
      ok: false,
      errors: [`chain file missing: ${chainPath}`],
    };
  }
  try {
    const result = verifyChain(chainPath);
    return {
      name: 'evidence-chain-valid',
      ok: result.valid,
      info: { chain: chainPath },
      ...(result.errors.length > 0 && { errors: [...result.errors] }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'evidence-chain-valid', ok: false, errors: [msg] };
  }
}

/** Verify that the adopter Constitution pointer resolves to installed contract text. */
function checkConstitutionSymlink(repoRoot: string): CheckResult {
  const linkPath = join(repoRoot, '.devai/constitution.md');
  if (!existsSync(linkPath)) {
    return {
      name: 'constitution-symlink',
      ok: false,
      errors: [`missing: ${linkPath}`],
    };
  }
  const stat = lstatSync(linkPath);
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(linkPath);
    const resolved = resolve(linkPath, '..', target);
    if (resolved.endsWith('/constitution.md') && existsSync(resolved)) {
      return {
        name: 'constitution-symlink',
        ok: true,
        info: { shape: 'symlink', target, resolved },
      };
    }
    return {
      name: 'constitution-symlink',
      ok: false,
      info: { shape: 'symlink-invalid', target, resolved },
      errors: [`symlink ${linkPath} points to ${resolved}; expected an installed constitution.md`],
    };
  }
  // Plain file pointer (`# See <path>`).
  let body: string;
  try {
    body = readFileSync(linkPath, 'utf8');
  } catch (err) {
    return {
      name: 'constitution-symlink',
      ok: false,
      errors: [`failed to read ${linkPath}: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  const firstLine = body.split('\n')[0] ?? '';
  const match = /^#\s+See\s+(.+?)\s*$/.exec(firstLine);
  if (match === null) {
    return {
      name: 'constitution-symlink',
      ok: false,
      info: { shape: 'plain-file-malformed', first_line: firstLine },
      errors: [
        `${linkPath} is a plain file but does not start with '# See <path-to-constitution.md>'`,
      ],
    };
  }
  const pointer = match[1] ?? '';
  if (pointer.length === 0 || pointer.includes('<unresolved>')) {
    return {
      name: 'constitution-symlink',
      ok: false,
      info: { shape: 'pointer-file-unresolved', pointer },
      errors: [
        `${linkPath} contains an unresolved pointer '${pointer}'. Edit the file to name the actual path to your DEVAI installation's constitution.md.`,
      ],
    };
  }
  const resolved = pointer.startsWith('/') ? pointer : resolve(dirname(linkPath), pointer);
  if (!resolved.endsWith('/constitution.md')) {
    return {
      name: 'constitution-symlink',
      ok: false,
      info: { shape: 'pointer-file-target-wrong-name', pointer, resolved },
      errors: [
        `${linkPath} pointer resolves to ${resolved}; expected a file named constitution.md`,
      ],
    };
  }
  if (!existsSync(resolved)) {
    return {
      name: 'constitution-symlink',
      ok: false,
      info: { shape: 'pointer-file-target-missing', pointer, resolved },
      errors: [`${linkPath} pointer resolves to ${resolved}, which does not exist`],
    };
  }
  return {
    name: 'constitution-symlink',
    ok: true,
    info: { shape: 'pointer-file', pointer, resolved },
  };
}

/** Compare the adopter's version pin with the installed CLI package. */
function checkDevaiVersionMatch(repoRoot: string): CheckResult {
  const configPath = join(repoRoot, '.devai/config/project.json');
  if (!existsSync(configPath)) {
    return { name: 'devai-version-match', ok: false, errors: [`missing: ${configPath}`] };
  }
  let pinned: string | undefined;
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { devai_version?: string };
    pinned = parsed.devai_version;
  } catch (err) {
    return {
      name: 'devai-version-match',
      ok: false,
      errors: [`cannot parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  const running = resolveCliVersion();
  const provenance = resolveCliProvenance();
  const provenanceInfo = { source: provenance.source };
  if (pinned === undefined) {
    return {
      name: 'devai-version-match',
      ok: false,
      info: { running, provenance: provenanceInfo },
      errors: ['project.json carries no devai_version field'],
    };
  }
  const ok = pinned === running;
  return {
    name: 'devai-version-match',
    ok,
    info: { pinned, running, provenance: provenanceInfo },
    ...(!ok && {
      errors: [
        `project.json devai_version (${pinned}) does not match the installed @aarusso-nyx/devai (${running}); re-run \`devai init bind --as-role architect --write\` to re-bind`,
      ],
    }),
  };
}

function checkAuthorityEnforcement(repoRoot: string): CheckResult {
  const projectPath = join(repoRoot, '.devai/config/project.json');
  const policyPath = join(repoRoot, '.devai/config/authority-policy.json');
  try {
    const project = JSON.parse(readFileSync(projectPath, 'utf8')) as {
      authority_enforcement?: { mode?: string; adapter_config?: string };
    };
    const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
    if (!validators.authorityPolicy(policy)) {
      return {
        name: 'authority-enforcement',
        ok: false,
        errors: ['authority-policy.json does not validate against authority-policy.schema.json'],
      };
    }
    const expected = buildTrustedAuthoritySources(
      canonicalRegistry(),
      repoRoot,
      resolveCliVersion(),
    ).provenance;
    const bindingMatches =
      policy['repository_id'] === expected.repository_id &&
      canonicalSha256(policy['framework_package']) ===
        canonicalSha256(expected.framework_package) &&
      canonicalSha256(policy['constitution']) === canonicalSha256(expected.constitution) &&
      canonicalSha256(policy['source_policy']) === canonicalSha256(expected.source_policy) &&
      canonicalSha256(policy['additive_extensions']) ===
        canonicalSha256(expected.additive_extensions) &&
      policy['resolved_digest_sha256'] === expected.resolved_digest_sha256;
    const enforcement = policy['enforcement'] as { mode?: string } | undefined;
    const host = policy['host_enforcement'] as
      { mode?: string; adapter?: { adapter_id?: string } } | undefined;
    const declaredMode = project.authority_enforcement?.mode;
    const adapterConfig = project.authority_enforcement?.adapter_config;
    const selectedAdapterBound =
      declaredMode !== 'host-integrated' ||
      (adapterConfig === '.devai/config/post-merge-host-adapter.json' &&
        host?.adapter?.adapter_id === 'post-merge-host-adapter') ||
      (adapterConfig === '.devai/config/github-actions-host-adapter.json' &&
        host?.adapter?.adapter_id === 'github-actions-main-observation');
    const localPostMerge =
      declaredMode === 'host-integrated'
        ? verifyInstalledPostMergeAdapter(repoRoot, resolveCliVersion())
        : { ok: false, facts: {}, errors: [] as readonly string[] };
    const githubActions = verifyGithubActionsAdapter(repoRoot, resolveCliVersion());
    const adapterDeclared =
      declaredMode !== 'host-integrated' ||
      (adapterConfig === '.devai/config/post-merge-host-adapter.json' && localPostMerge.ok) ||
      (adapterConfig === '.devai/config/github-actions-host-adapter.json' && githubActions.ok);
    const ok =
      bindingMatches &&
      enforcement?.mode === 'binding' &&
      host?.mode === declaredMode &&
      ['cli-only', 'host-integrated'].includes(declaredMode ?? '') &&
      selectedAdapterBound &&
      adapterDeclared;
    return {
      name: 'authority-enforcement',
      ok,
      info: {
        enforcement: enforcement?.mode ?? 'unknown',
        host_mode: host?.mode ?? 'unknown',
        declared_mode: declaredMode ?? 'unknown',
        policy_binding: bindingMatches ? 'current' : 'mismatch',
        selected_adapter_policy_bound: selectedAdapterBound,
        cli_runtime_enforced: bindingMatches && enforcement?.mode === 'binding',
        local_post_merge_enforced: bindingMatches && localPostMerge.ok,
        local_post_merge_facts: localPostMerge.facts,
        github_actions_enforced: bindingMatches && githubActions.ok,
        github_actions_facts: githubActions.facts,
        arbitrary_host_tools_enforced: false,
      },
      ...(!ok && {
        errors: [
          'authority posture is missing, stale, non-binding, or inconsistent; re-materialize with `devai init bind --as-role architect --write`',
          ...localPostMerge.errors,
          ...(adapterConfig === '.devai/config/github-actions-host-adapter.json'
            ? githubActions.errors
            : []),
        ],
      }),
    };
  } catch (error) {
    return {
      name: 'authority-enforcement',
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function checkTrustedLocalRcBoundary(repoRoot: string): CheckResult {
  const loaded = readAttestedRcConfig(repoRoot);
  if (loaded.config === undefined) {
    return {
      name: 'trusted-local-rc-boundary',
      ok: loaded.errors.length === 0,
      info: {
        configured: false,
        local_rc_execution_configured: false,
        remote_receipt_verification_configured: false,
        proof_transport_configured: false,
        exact_tree_binding_configured: false,
        signer_trust_configured: false,
        remote_workflow_can_execute_local_only_node: false,
      },
      ...(loaded.errors.length > 0 && { errors: loaded.errors }),
    };
  }
  const workflowDirectory = join(repoRoot, '.github/workflows');
  const workflows = existsSync(workflowDirectory)
    ? readdirSync(workflowDirectory)
        .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
        .sort()
        .map((file) => ({ file, text: readFileSync(join(workflowDirectory, file), 'utf8') }))
    : [];
  const inspection = inspectRemoteLocalOnlyNodes(repoRoot, workflows);
  const workflowPath = join(workflowDirectory, ATTESTED_RC_WORKFLOW_FILE);
  const workflowCurrent =
    existsSync(workflowPath) &&
    readFileSync(workflowPath, 'utf8') === attestedRcVerificationWorkflow();
  let scripts: Record<string, string> = {};
  try {
    scripts =
      (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      }).scripts ?? {};
  } catch {
    scripts = {};
  }
  const localRcExecution =
    inspection.errors.length === 0 &&
    typeof scripts['devai:rc:prepare'] === 'string' &&
    typeof scripts['devai:rc:publish'] === 'string';
  const trustPath = join(repoRoot, '.devai/control/local-rc-trust-store.json');
  let signerTrust = false;
  let signerCount = 0;
  try {
    const trust = JSON.parse(readFileSync(trustPath, 'utf8')) as {
      schemaVersion?: string;
      trustedSigners?: Array<{ signerId?: string; publicKeyPem?: string }>;
      revokedSignerIds?: string[];
    };
    const signers = trust.trustedSigners ?? [];
    const revoked = new Set(trust.revokedSignerIds ?? []);
    signerCount = signers.filter((signer) => !revoked.has(signer.signerId ?? '')).length;
    signerTrust =
      trust.schemaVersion === '1.0.0' &&
      signerCount > 0 &&
      signers.every(
        (signer) =>
          typeof signer.signerId === 'string' &&
          typeof signer.publicKeyPem === 'string' &&
          signer.publicKeyPem.includes('BEGIN PUBLIC KEY') &&
          !signer.publicKeyPem.includes('PRIVATE'),
      );
  } catch {
    signerTrust = false;
  }
  const protectedControls =
    existsSync(join(repoRoot, '.devai/control/local-rc-toolchain.json')) &&
    existsSync(join(repoRoot, '.devai/control/local-rc-environment.json'));
  const proofTransport =
    loaded.config.transport === 'protected-tag-v1' &&
    loaded.config.tag_prefix.startsWith('devai-local-evidence/') &&
    workflowCurrent;
  const exactTreeBinding =
    loaded.config.binding === 'exact-tree' &&
    workflowCurrent &&
    readFileSync(workflowPath, 'utf8').includes('binding=exact-tree');
  const remoteVerification = workflowCurrent && protectedControls && signerTrust;
  const remoteCanExecuteLocalOnly = inspection.violations.length > 0;
  const errors = [
    ...inspection.errors,
    ...inspection.violations,
    ...(!localRcExecution ? ['devai:rc:prepare and devai:rc:publish are not both configured'] : []),
    ...(!workflowCurrent ? ['generated trusted local RC verifier workflow is missing or stale'] : []),
    ...(!protectedControls ? ['protected local RC toolchain or environment control is missing'] : []),
    ...(!signerTrust ? ['approved non-revoked local RC signer trust is missing'] : []),
  ];
  return {
    name: 'trusted-local-rc-boundary',
    ok: errors.length === 0,
    info: {
      configured: true,
      local_rc_execution_configured: localRcExecution,
      remote_receipt_verification_configured: remoteVerification,
      proof_transport_configured: proofTransport,
      exact_tree_binding_configured: exactTreeBinding,
      signer_trust_configured: signerTrust,
      approved_non_revoked_signers: signerCount,
      remote_workflow_can_execute_local_only_node: remoteCanExecuteLocalOnly,
      remote_mutation_fallback_configured: false,
      attestation_boundary:
        'trusted signer identity and byte integrity; workstation execution is not independently reproduced by GitHub',
    },
    ...(errors.length > 0 && { errors }),
  };
}

/**
 * D-119: verifies the canonical constitution-binding shape — a
 * vendored `.devai/pin/constitution.md` plus a {version, sha256} pin
 * in project.json that matches it.
 */
function checkConstitutionBinding(repoRoot: string): CheckResult {
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

function checkAgentsClaudeSync(repoRoot: string): CheckResult {
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
  for (const f of [
    { name: 'CLAUDE.md', text: claudeText },
    { name: 'AGENTS.md', text: agentsText },
  ]) {
    if (!f.text.includes('Article 6')) {
      errors.push(`${f.name}: missing Constitution Article 6 reference`);
    }
    for (const role of FIVE_ROLES) {
      if (!f.text.includes(role)) {
        errors.push(`${f.name}: missing role '${role}'`);
      }
    }
    for (const src of READING_ORDER_SOURCES) {
      const resolvedSrc = applyPathOverride(src, overrides);
      if (!f.text.includes(resolvedSrc)) {
        errors.push(`${f.name}: missing reading-order source '${resolvedSrc}'`);
      }
    }
  }
  return {
    name: 'agents-claude-sync',
    ok: errors.length === 0,
    ...(errors.length > 0 && { errors }),
  };
}

function checkChainPathWritableDir(chainPath: string): CheckResult {
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
function checkLlmBridges(): CheckResult {
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

interface CliProbe {
  readonly family: 'claude-cli' | 'codex-cli';
  readonly cli: string;
  readonly onPath: boolean;
  readonly version: string | null;
  readonly usable: boolean;
  readonly hint: string;
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

function checkDocsGovernanceDoctor(repoRoot: string, skip: boolean): CheckResult {
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

interface CheckSpec {
  readonly name: string;
  /**
   * D-112: lowest adoption profile at which this check is binding.
   * Below it the check still runs but is reported advisory and
   * excluded from the report's `ok`. Default tier1 (always binding).
   */
  readonly minProfile?: AdoptionProfile;
  readonly run: (
    repoRoot: string,
    chainPath: string,
    skipDocsGovernance?: boolean,
  ) => CheckResult | Promise<CheckResult>;
}

const CHECK_SPECS: readonly CheckSpec[] = [
  {
    name: 'f1-paths-present',
    run: (repoRoot) => checkF1Paths(repoRoot),
  },
  {
    name: 'constitution-symlink',
    run: (repoRoot) => checkConstitutionSymlink(repoRoot),
  },
  {
    name: 'agents-claude-sync',
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
