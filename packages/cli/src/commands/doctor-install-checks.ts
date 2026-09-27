import { existsSync, lstatSync, readFileSync, readlinkSync } from '@devai-nyx/authority';
import { dirname, join, resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { validators } from '@devai-nyx/schemas';
import { verifyChain } from '@devai-nyx/evidence';
import { canonicalRegistry } from '../define-command.js';
import { buildTrustedAuthoritySources, canonicalSha256 } from '../authority/policy.js';
import { resolveCliProvenance, resolveCliVersion } from '../version.js';
import { verifyInstalledPostMergeAdapter } from '../services/hooks-install/index.js';
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
