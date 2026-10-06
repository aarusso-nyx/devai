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
  POST_MERGE_BIND_COMMAND,
  POST_MERGE_DECLARATION,
  postMergeAttestationPath,
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

const POST_MERGE_CONFIG = POST_MERGE_DECLARATION;
const GITHUB_ACTIONS_CONFIG = '.devai/config/github-actions-host-adapter.json';
const POST_MERGE_REBIND = POST_MERGE_BIND_COMMAND;
const GITHUB_ACTIONS_REBIND =
  'devai init bind --target . --host-adapter github-actions --as-role architect --write';
const UPGRADE_COMMAND = 'devai init upgrade --target . --as-role architect --write';

// The host-adapter finding ids of #266 and #291, quoted so the error-code reference lists them.
const HOST_ADAPTER_REASONS = {
  notBoundHere: 'POST_MERGE_ADAPTER_NOT_BOUND_HERE',
  unverifiableHere: 'POST_MERGE_ADAPTER_UNVERIFIABLE_HERE',
  declarationLegacy: 'POST_MERGE_ADAPTER_DECLARATION_LEGACY',
  bindingStale: 'POST_MERGE_ADAPTER_BINDING_STALE',
  postMergeVersionLag: 'POST_MERGE_ADAPTER_VERSION_LAG',
  githubActionsVersionLag: 'GITHUB_ACTIONS_ADAPTER_VERSION_LAG',
} as const;

/** The package version a host-adapter record binds, read leniently for reporting only. */
function boundAdapterVersion(path: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
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

/** This checkout's signed post-merge attestation, or undefined without a git directory. */
function localAttestationPath(repoRoot: string): string | undefined {
  try {
    return postMergeAttestationPath(repoRoot);
  } catch {
    return undefined;
  }
}

/**
 * #266: warn on every host-adapter binding whose package binding lags the installed package,
 * naming the rebind that refreshes it. Rebinding GitHub Actions re-selects it and
 * re-materializes the authority policy a post-merge attestation pins, so each checkout that
 * binds the post-merge adapter rebinds it after. The post-merge version is read from this
 * checkout's own attestation in its git directory (#291). A warning never fails the check: the
 * selected adapter's own verification already refuses a binding to another version.
 */
function hostAdapterVersionLags(
  repoRoot: string,
  installed: string,
  postMergeBound: boolean,
): { readonly reasons: string[]; readonly warnings: string[] } {
  const lagging = (path: string | undefined): string | undefined => {
    const bound = path === undefined ? undefined : boundAdapterVersion(path);
    return bound !== undefined &&
      valid(bound) !== null &&
      valid(installed) !== null &&
      lt(bound, installed)
      ? bound
      : undefined;
  };
  const reasons: string[] = [];
  const warnings: string[] = [];
  const githubActions = lagging(join(repoRoot, GITHUB_ACTIONS_CONFIG));
  if (githubActions !== undefined) {
    reasons.push(HOST_ADAPTER_REASONS.githubActionsVersionLag);
    warnings.push(
      `${HOST_ADAPTER_REASONS.githubActionsVersionLag}: ${GITHUB_ACTIONS_CONFIG} binds @aarusso-nyx/devai ${githubActions}, behind the installed ${installed}; rebind with \`${GITHUB_ACTIONS_REBIND}\`${
        existsSync(join(repoRoot, POST_MERGE_CONFIG))
          ? `, then rebind the post-merge adapter with \`${POST_MERGE_REBIND}\` in each checkout that binds it`
          : ''
      }`,
    );
  }
  const attestation = postMergeBound ? localAttestationPath(repoRoot) : undefined;
  const postMerge = lagging(attestation);
  if (postMerge !== undefined) {
    reasons.push(HOST_ADAPTER_REASONS.postMergeVersionLag);
    warnings.push(
      `${HOST_ADAPTER_REASONS.postMergeVersionLag}: this checkout's post-merge attestation (${String(attestation)}) binds @aarusso-nyx/devai ${postMerge}, behind the installed ${installed}; rebind it with \`${POST_MERGE_REBIND}\``,
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
    // #291: the tracked file only declares the post-merge adapter; each checkout binds it in its
    // own git directory. A declared checkout without local state is not bound here, which is
    // every fresh clone, CI included, and authority enforcement rests on an adapter it verifies.
    const postMergeLocation = hostIntegrated ? locatePostMergeBinding(repoRoot) : undefined;
    const scope = postMergeLocation?.scope;
    const notBoundHere = scope === 'unbound';
    const legacy = scope === 'legacy';
    const boundCheckout = postMergeLocation?.bound_checkout;
    const localState = postMergeLocation?.local_state ?? [];
    const localPostMerge =
      hostIntegrated && !notBoundHere && !legacy
        ? verifyInstalledPostMergeAdapter(repoRoot, resolveCliVersion())
        : { ok: false, facts: {}, errors: [] as readonly string[] };
    const githubActions = verifyGithubActionsAdapter(repoRoot, resolveCliVersion());
    const unverifiableHere = postMergeSelected && notBoundHere && !githubActions.ok;
    // A legacy checkout-bound attestation in tracked configuration verifies nowhere until
    // init upgrade converts it; it refuses only while the post-merge adapter is selected.
    const legacyRefused = postMergeSelected && legacy;
    const adapterDeclared =
      !hostIntegrated ||
      (postMergeSelected && (notBoundHere ? githubActions.ok : !legacy && localPostMerge.ok)) ||
      (adapterConfig === GITHUB_ACTIONS_CONFIG && githubActions.ok);
    const lags = hostIntegrated
      ? hostAdapterVersionLags(repoRoot, resolveCliVersion(), scope === 'bound')
      : { reasons: [], warnings: [] };
    // This checkout's own post-merge binding decides nothing while another adapter is selected,
    // yet its merge receipts are refused while it does not verify, for example after a later
    // host-adapter bind re-materialized the authority policy its attestation pins.
    const bindingStale =
      hostIntegrated && !postMergeSelected && scope === 'bound' && !localPostMerge.ok;
    const legacyMessage = `${HOST_ADAPTER_REASONS.declarationLegacy}: ${POST_MERGE_CONFIG} is a checkout-bound post-merge attestation${
      boundCheckout === undefined ? '' : ` recording ${boundCheckout}`
    }, which verifies in no other checkout; convert it with \`${UPGRADE_COMMAND}\`, which moves the binding into the git directory of the checkout that holds its key and leaves a path-free declaration to commit`;
    const warnings = [
      ...(bindingStale
        ? [
            `${HOST_ADAPTER_REASONS.bindingStale}: this checkout's post-merge host adapter does not verify (${localPostMerge.errors.join(', ')}); it is not the selected host identity, so it does not decide this check, but its merge receipts are refused until it is rebound with \`${POST_MERGE_REBIND}\`, which selects it`,
          ]
        : []),
      ...(legacy && !legacyRefused ? [legacyMessage] : []),
      ...lags.warnings,
    ];
    const reasonIds = [
      ...(notBoundHere ? [HOST_ADAPTER_REASONS.notBoundHere] : []),
      ...(unverifiableHere ? [HOST_ADAPTER_REASONS.unverifiableHere] : []),
      ...(legacy ? [HOST_ADAPTER_REASONS.declarationLegacy] : []),
      ...(bindingStale ? [HOST_ADAPTER_REASONS.bindingStale] : []),
      ...lags.reasons,
    ];
    const notBoundNote = postMergeSelected
      ? `Here authority enforcement rests on the GitHub Actions adapter${githubActions.ok ? '' : ', which this checkout does not verify'}.`
      : 'It is not the selected host identity, so it does not decide this check.';
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
          ...(localState.length > 0 && { local_post_merge_state: localState }),
        }),
        ...(notBoundHere && {
          host_adapter_note: `${HOST_ADAPTER_REASONS.notBoundHere}: the post-merge host adapter is declared but not bound in this checkout; bind it here with \`${POST_MERGE_REBIND}\` to issue and verify merge receipts from it. ${notBoundNote}`,
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
          ...(legacyRefused ? [legacyMessage] : []),
          ...(unverifiableHere
            ? [
                `${HOST_ADAPTER_REASONS.unverifiableHere}: the selected post-merge host adapter is not bound in this checkout and no GitHub Actions adapter verifies here; bind it here with \`${POST_MERGE_REBIND}\`, or bind the GitHub Actions adapter with \`${GITHUB_ACTIONS_REBIND}\`, then \`${POST_MERGE_REBIND}\`, and commit the result`,
              ]
            : []),
          ...(adapterConfig === GITHUB_ACTIONS_CONFIG || (postMergeSelected && notBoundHere)
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
