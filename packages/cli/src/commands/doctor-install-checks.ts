import { existsSync, lstatSync, readFileSync, readlinkSync } from '@devai-nyx/authority';
import { dirname, join, resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { lt, valid } from 'semver';
import { validators } from '@devai-nyx/schemas';
import { verifyChain } from '@devai-nyx/evidence';
import { canonicalRegistry } from '../define-command.js';
import { buildTrustedAuthoritySources, canonicalSha256 } from '../authority/policy.js';
import { resolveCliProvenance, resolveCliVersion } from '../version.js';
import {
  locatePostMergeBinding,
  verifyInstalledPostMergeAdapter,
} from '../services/hooks-install/index.js';
import { verifyGithubActionsAdapter } from '../services/github-actions-adapter/index.js';
import { inspectRemoteLocalOnlyNodes, readAttestedRcConfig } from './check/ci-local-only.js';
import {
  ATTESTED_RC_WORKFLOW_FILE,
  attestedRcVerificationWorkflow,
} from '../services/ci-scaffold/index.js';
import type { CheckResult } from './doctor-support.js';

export function checkEvidenceChain(chainPath: string): CheckResult {
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
export function checkConstitutionSymlink(repoRoot: string): CheckResult {
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
export function checkDevaiVersionMatch(repoRoot: string): CheckResult {
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

const CORE_EXTENSION_ID = 'devai-adopter-authority';

type ExtensionEntry = {
  readonly extension_id: string;
  readonly extension_version: string;
  readonly digest_sha256: string;
};

function extensionEntries(value: unknown): ExtensionEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is ExtensionEntry =>
      entry !== null &&
      typeof entry === 'object' &&
      typeof (entry as Record<string, unknown>)['extension_id'] === 'string',
  );
}

/** The receipt's bound source and adopter extension, read leniently for reporting only. */
function boundAdopterReceipt(repoRoot: string): {
  readonly source_path?: string;
  readonly authority_extension?: ExtensionEntry;
} {
  try {
    const receipt = JSON.parse(
      readFileSync(join(repoRoot, '.devai/config/adopter-policy-binding.json'), 'utf8'),
    ) as Record<string, unknown>;
    const extension = extensionEntries([receipt['authority_extension']])[0];
    return {
      ...(typeof receipt['source_path'] === 'string' && { source_path: receipt['source_path'] }),
      ...(extension !== undefined && {
        authority_extension: {
          extension_id: extension.extension_id,
          extension_version: extension.extension_version,
          digest_sha256: extension.digest_sha256,
        },
      }),
    };
  } catch {
    return {};
  }
}

/**
 * ADR-AUT-0003: name the adopter extension the materialized policy and the receipt carry, and,
 * on a mismatch, the extension entries that differ between the policy and the rebuilt sources
 * together with the refusal the rebuilt sources give for the bound source.
 */
function adopterExtensionReport(
  repoRoot: string,
  policy: Record<string, unknown>,
  expected: ReturnType<typeof buildTrustedAuthoritySources>,
  bindingMatches: boolean,
): { readonly info: Record<string, unknown>; readonly errors: string[] } {
  const materialized = extensionEntries(policy['additive_extensions']);
  const rebuilt = extensionEntries(expected.provenance.additive_extensions);
  const receipt = boundAdopterReceipt(repoRoot);
  const adopter =
    materialized.find((entry) => entry.extension_id !== CORE_EXTENSION_ID) ??
    receipt.authority_extension;
  const info: Record<string, unknown> = {
    ...(adopter !== undefined && {
      adopter_extension: {
        extension_id: adopter.extension_id,
        extension_version: adopter.extension_version,
        digest_sha256: adopter.digest_sha256,
      },
    }),
  };
  if (bindingMatches) return { info, errors: [] };
  const key = (entry: ExtensionEntry) => canonicalSha256(entry);
  const differing = [
    ...materialized.filter((entry) => !rebuilt.some((other) => key(other) === key(entry))),
    ...rebuilt.filter((entry) => !materialized.some((other) => key(other) === key(entry))),
  ];
  const named = [
    ...new Set(
      [
        ...differing.map((entry) => entry.extension_id),
        ...(receipt.authority_extension === undefined
          ? []
          : [receipt.authority_extension.extension_id]),
      ].filter((id) => id !== CORE_EXTENSION_ID),
    ),
  ];
  let refusal: string | undefined;
  try {
    void expected.additiveExtensions;
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  if (named.length === 0 && refusal === undefined) return { info, errors: [] };
  const rebind =
    receipt.source_path === undefined
      ? 'devai init bind --target . --as-role architect --write'
      : `devai init bind --target . --adopter-policy ${receipt.source_path} --as-role architect --write`;
  return {
    info: {
      ...info,
      extension_mismatch: {
        extension_ids: named,
        materialized: differing.filter((entry) => materialized.includes(entry)),
        rebuilt: differing.filter((entry) => rebuilt.includes(entry)),
        ...(refusal !== undefined && { refusal }),
        remediation_command: rebind,
      },
    },
    errors: [
      `adopter extension ${named.join(', ') || 'binding'} differs from the sources rebuilt from the binding receipt; rebind with \`${rebind}\``,
    ],
  };
}

const POST_MERGE_CONFIG = '.devai/config/post-merge-host-adapter.json';
const GITHUB_ACTIONS_CONFIG = '.devai/config/github-actions-host-adapter.json';
const POST_MERGE_REBIND =
  'devai init bind --target . --host-adapter post-merge --as-role architect --write';
const GITHUB_ACTIONS_REBIND =
  'devai init bind --target . --host-adapter github-actions --as-role architect --write';

// The host-adapter finding ids of #266, quoted so the error-code reference lists them.
const HOST_ADAPTER_REASONS = {
  notApplicableHere: 'POST_MERGE_ADAPTER_NOT_APPLICABLE_HERE',
  unverifiableHere: 'POST_MERGE_ADAPTER_UNVERIFIABLE_HERE',
  bindingStale: 'POST_MERGE_ADAPTER_BINDING_STALE',
  postMergeVersionLag: 'POST_MERGE_ADAPTER_VERSION_LAG',
  githubActionsVersionLag: 'GITHUB_ACTIONS_ADAPTER_VERSION_LAG',
} as const;

/** The package version a host-adapter configuration binds, read leniently for reporting only. */
function boundAdapterVersion(repoRoot: string, config: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(repoRoot, config), 'utf8')) as unknown;
    const binding =
      parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)['package_binding']
        : undefined;
    const version =
      binding !== null && typeof binding === 'object'
        ? (binding as Record<string, unknown>)['version']
        : undefined;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * #266: warn on every host-adapter configuration whose package binding lags the installed
 * package, naming the rebind that refreshes it. Rebinding GitHub Actions re-selects it and
 * re-materializes the authority policy the post-merge attestation pins, so a bound post-merge
 * adapter is rebound after it. A warning never fails the check: the selected adapter's own
 * verification already refuses a binding to another version.
 */
function hostAdapterVersionLags(
  repoRoot: string,
  installed: string,
  postMergeCheckout: string | undefined,
): { readonly reasons: string[]; readonly warnings: string[] } {
  const lagging = (config: string): string | undefined => {
    const bound = boundAdapterVersion(repoRoot, config);
    return bound !== undefined &&
      valid(bound) !== null &&
      valid(installed) !== null &&
      lt(bound, installed)
      ? bound
      : undefined;
  };
  const postMergeRebind = `rebind the post-merge adapter in the checkout that bound it${
    postMergeCheckout === undefined ? '' : ` (${postMergeCheckout})`
  } with \`${POST_MERGE_REBIND}\``;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const githubActions = lagging(GITHUB_ACTIONS_CONFIG);
  if (githubActions !== undefined) {
    reasons.push(HOST_ADAPTER_REASONS.githubActionsVersionLag);
    warnings.push(
      `${HOST_ADAPTER_REASONS.githubActionsVersionLag}: ${GITHUB_ACTIONS_CONFIG} binds @aarusso-nyx/devai ${githubActions}, behind the installed ${installed}; rebind with \`${GITHUB_ACTIONS_REBIND}\`${
        existsSync(join(repoRoot, POST_MERGE_CONFIG)) ? `, then ${postMergeRebind}` : ''
      }`,
    );
  }
  const postMerge = lagging(POST_MERGE_CONFIG);
  if (postMerge !== undefined) {
    reasons.push(HOST_ADAPTER_REASONS.postMergeVersionLag);
    warnings.push(
      `${HOST_ADAPTER_REASONS.postMergeVersionLag}: ${POST_MERGE_CONFIG} binds @aarusso-nyx/devai ${postMerge}, behind the installed ${installed}; ${postMergeRebind}`,
    );
  }
  return { reasons, warnings };
}

export function checkAuthorityEnforcement(repoRoot: string): CheckResult {
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
    const sources = buildTrustedAuthoritySources(
      canonicalRegistry(),
      repoRoot,
      resolveCliVersion(),
    );
    const expected = sources.provenance;
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
    const hostIntegrated = declaredMode === 'host-integrated';
    const postMergeSelected = adapterConfig === POST_MERGE_CONFIG;
    const selectedAdapterBound =
      !hostIntegrated ||
      (postMergeSelected && host?.adapter?.adapter_id === 'post-merge-host-adapter') ||
      (adapterConfig === GITHUB_ACTIONS_CONFIG &&
        host?.adapter?.adapter_id === 'github-actions-main-observation');
    // #266: a post-merge binding made in another checkout is verifiable only there; here it is
    // not applicable, and authority enforcement rests on an adapter this checkout can verify.
    const postMergeLocation = hostIntegrated ? locatePostMergeBinding(repoRoot) : undefined;
    const postMergeElsewhere = postMergeLocation?.scope === 'other-checkout';
    const boundCheckout = postMergeLocation?.bound_checkout;
    const localPostMerge =
      hostIntegrated && !postMergeElsewhere
        ? verifyInstalledPostMergeAdapter(repoRoot, resolveCliVersion())
        : { ok: false, facts: {}, errors: [] as readonly string[] };
    const githubActions = verifyGithubActionsAdapter(repoRoot, resolveCliVersion());
    const unverifiableHere = postMergeSelected && postMergeElsewhere && !githubActions.ok;
    const adapterDeclared =
      !hostIntegrated ||
      (postMergeSelected && (postMergeElsewhere ? githubActions.ok : localPostMerge.ok)) ||
      (adapterConfig === GITHUB_ACTIONS_CONFIG && githubActions.ok);
    const lags = hostIntegrated
      ? hostAdapterVersionLags(repoRoot, resolveCliVersion(), boundCheckout)
      : { reasons: [], warnings: [] };
    // This checkout's own post-merge binding decides nothing while another adapter is selected,
    // yet its merge receipts are refused while it does not verify, for example after a later
    // host-adapter bind re-materialized the authority policy its attestation pins.
    const bindingStale =
      hostIntegrated &&
      !postMergeSelected &&
      postMergeLocation?.scope === 'this-checkout' &&
      !localPostMerge.ok;
    const warnings = [
      ...(bindingStale
        ? [
            `${HOST_ADAPTER_REASONS.bindingStale}: this checkout's post-merge host adapter does not verify (${localPostMerge.errors.join(', ')}); it is not the selected host identity, so it does not decide this check, but its merge receipts are refused until it is rebound with \`${POST_MERGE_REBIND}\`, which selects it`,
          ]
        : []),
      ...lags.warnings,
    ];
    const reasonIds = [
      ...(postMergeElsewhere ? [HOST_ADAPTER_REASONS.notApplicableHere] : []),
      ...(unverifiableHere ? [HOST_ADAPTER_REASONS.unverifiableHere] : []),
      ...(bindingStale ? [HOST_ADAPTER_REASONS.bindingStale] : []),
      ...lags.reasons,
    ];
    const adopter = adopterExtensionReport(repoRoot, policy, sources, bindingMatches);
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
        ...adopter.info,
        selected_adapter_policy_bound: selectedAdapterBound,
        cli_runtime_enforced: bindingMatches && enforcement?.mode === 'binding',
        local_post_merge_enforced: bindingMatches && localPostMerge.ok,
        local_post_merge_facts: localPostMerge.facts,
        ...(postMergeLocation !== undefined && {
          local_post_merge_scope: postMergeLocation.scope,
          ...(boundCheckout !== undefined && { local_post_merge_bound_checkout: boundCheckout }),
        }),
        ...(postMergeElsewhere && {
          host_adapter_note: `${HOST_ADAPTER_REASONS.notApplicableHere}: the post-merge host adapter was bound in ${String(boundCheckout)} and is verifiable only in that checkout; run \`devai doctor\` there to verify it, or rebind it with \`${POST_MERGE_REBIND}\` in a live checkout if that one is gone. Here authority enforcement rests on the GitHub Actions adapter${githubActions.ok ? '' : ', which this checkout does not verify'}.`,
        }),
        github_actions_enforced: bindingMatches && githubActions.ok,
        github_actions_facts: githubActions.facts,
        arbitrary_host_tools_enforced: false,
        ...(reasonIds.length > 0 && { reason_ids: reasonIds }),
      },
      ...(!ok && {
        errors: [
          'authority posture is missing, stale, non-binding, or inconsistent; re-materialize with `devai init bind --as-role architect --write`',
          ...adopter.errors,
          ...localPostMerge.errors,
          ...(unverifiableHere
            ? [
                `${HOST_ADAPTER_REASONS.unverifiableHere}: the selected post-merge host adapter was bound in ${String(boundCheckout)} and this checkout binds no host adapter it can verify; in that checkout run \`${GITHUB_ACTIONS_REBIND}\`, then \`${POST_MERGE_REBIND}\`, and commit the result`,
              ]
            : []),
          ...(adapterConfig === GITHUB_ACTIONS_CONFIG || (postMergeSelected && postMergeElsewhere)
            ? githubActions.errors
            : []),
        ],
      }),
      ...(warnings.length > 0 && { warnings }),
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
      (
        JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
          scripts?: Record<string, string>;
        }
      ).scripts ?? {};
  } catch {
    scripts = {};
  }
  const localRcExecution =
    inspection.errors.length === 0 &&
    typeof scripts['devai:rc:prepare'] === 'string' &&
    typeof scripts['devai:rc:publish'] === 'string';
  const trustPath = join(repoRoot, 'law/policy/devai-local-rc-trust-store.json');
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
    existsSync(join(repoRoot, 'law/policy/devai-local-rc-toolchain.json')) &&
    existsSync(join(repoRoot, 'law/policy/devai-local-rc-environment.json'));
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
    ...(!workflowCurrent
      ? ['generated trusted local RC verifier workflow is missing or stale']
      : []),
    ...(!protectedControls
      ? ['protected local RC toolchain or environment control is missing']
      : []),
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
