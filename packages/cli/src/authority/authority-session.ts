import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import type { RegistryEntry } from '../define-command.js';
import { buildTrustedAuthoritySources } from './policy.js';
import { resolveCliVersion } from '../version.js';
import {
  type HumanRole,
  type JsonRecord,
  isRecord,
  flagValue,
  type FailureCategory,
  type TaggedFailure,
  taggedFailure,
  canonicalSha256,
} from './authority-results.js';

export function targetRoot(entry: RegistryEntry, argv: readonly string[]): string {
  const adoptionTarget = [
    'init bind',
    'init apply owner',
    'init apply architect',
    'init apply harness',
  ].includes(entry.name)
    ? flagValue(argv, '--target')
    : undefined;
  return resolve(adoptionTarget ?? flagValue(argv, '--repo-root') ?? '.');
}

export function taggedAuthorityFailure(
  category: FailureCategory,
  code: string,
  entry: RegistryEntry,
  argv: readonly string[],
): TaggedFailure {
  if (code === 'AUTHORITY_POLICY_MISSING') {
    const repositoryRoot = targetRoot(entry, argv);
    const plainBind = `devai init bind --target ${repositoryRoot} --as-role architect --write`;
    const commands = existsSync(resolve(repositoryRoot, '.devai/pin/constitution.md'))
      ? [plainBind]
      : [
          `devai init bind --target ${repositoryRoot} --tier tier1 --constitution --as-role architect --write`,
          `devai init bind --target ${repositoryRoot} --operational-law --as-role architect --write`,
          `devai init bind --target ${repositoryRoot} --subprocess-effects --as-role architect --write`,
          plainBind,
        ];
    return taggedFailure(category, code, {
      action_id: entry.name,
      repository_root: repositoryRoot,
      command: commands[0],
      commands,
    });
  }
  return taggedFailure(category, code, { action_id: entry.name });
}

export function authorityBindingMissing(entry: RegistryEntry, argv: readonly string[]): boolean {
  if (!entry.authority_contract.readiness.requires_binding) return false;
  if (
    ['init bind', 'init apply owner', 'init apply architect', 'init apply harness'].includes(
      entry.name,
    )
  ) {
    return false;
  }
  return !existsSync(resolve(targetRoot(entry, argv), '.devai/config/authority-policy.json'));
}

export function sessionRole(
  sessionId: string,
  root: string,
  entries: readonly RegistryEntry[],
): TaggedFailure | Readonly<{ ok: true; role: HumanRole }> {
  const path = resolve(root, '.devai/state/authority-sessions', `${sessionId}.json`);
  if (!existsSync(path)) return taggedFailure('refused', 'AUTHORITY_SESSION_NOT_FOUND');
  let session: JsonRecord;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed) || !validators.authoritySession(parsed)) {
      return taggedFailure('refused', 'AUTHORITY_SESSION_SCHEMA_INVALID');
    }
    session = parsed;
  } catch {
    return taggedFailure('refused', 'AUTHORITY_SESSION_SCHEMA_INVALID');
  }
  const { session_digest_sha256: _digest, ...unsigned } = session;
  if (canonicalSha256(unsigned) !== session.session_digest_sha256) {
    return taggedFailure('refused', 'AUTHORITY_SESSION_DIGEST_MISMATCH');
  }
  if (session.status === 'revoked') return taggedFailure('refused', 'AUTHORITY_SESSION_REVOKED');
  if (session.status === 'stale') return taggedFailure('refused', 'AUTHORITY_SESSION_STALE');
  if (session.status === 'expired' || Date.parse(String(session.expires_at)) <= Date.now()) {
    return taggedFailure('refused', 'AUTHORITY_SESSION_EXPIRED');
  }
  const sources = buildTrustedAuthoritySources(entries, root, resolveCliVersion());
  if (session.repository_id !== sources.repository_id) {
    return taggedFailure('refused', 'AUTHORITY_SESSION_REPOSITORY_MISMATCH');
  }
  const binding = session.policy_binding;
  if (
    !isRecord(binding) ||
    binding.policy_id !== sources.provenance.policy_id ||
    binding.policy_version !== sources.provenance.policy_version ||
    binding.resolved_digest_sha256 !== sources.provenance.resolved_digest_sha256
  ) {
    return taggedFailure('refused', 'AUTHORITY_SESSION_POLICY_MISMATCH');
  }
  if (
    canonicalSha256(session.constitution_binding) !== canonicalSha256(sources.constitution_binding)
  ) {
    return taggedFailure('refused', 'AUTHORITY_SESSION_CONSTITUTION_MISMATCH');
  }
  if (canonicalSha256(session.package_binding) !== canonicalSha256(sources.package_binding)) {
    return taggedFailure('refused', 'AUTHORITY_SESSION_PACKAGE_MISMATCH');
  }
  return { ok: true, role: session.role as HumanRole };
}

/**
 * Whether one invocation's authority decision is recordable as a governance
 * event. This runs on the hot path for every command, so the cheap structural
 * guards come first and nothing touches disk until all of them pass.
 *
 * Each guard is a deliberate coverage boundary, not an optimisation:
 *
 *  - Reads carry no authority decision; the layer reports them as not
 *    applicable, so there is nothing to record.
 *  - A dry run decided nothing that took effect.
 *  - Without `--round` there is no round to attribute the decision to, and a
 *    round is never inferred.
 *  - Only decisions that reach outward or carry publication consent are worth
 *    recording. A local harness write is already bracketed by its
 *    action_intended / action_completed pair, so recording its authorization
 *    too would crowd findings and verification results out of the projection
 *    without adding signal.
 *  - `round tracking` actions record their own authorization with more
 *    fidelity; a second, vaguer event would only blur them.
 *  - Without `fs:f5-state` the action could not write runtime state anyway and
 *    the boundary would refuse silently. Every action that survives the gate
 *    above already declares it, so this is a fail-closed backstop rather than a
 *    coverage limit.
 */
export function authorityDecisionRecordable(
  entry: RegistryEntry,
  context: Readonly<{ dryRun: boolean; round: string | undefined; role: HumanRole | undefined }>,
): boolean {
  if (entry.effects === 'read' || context.dryRun) return false;
  if (context.round === undefined || context.role === undefined) return false;
  if (entry.path[0] === 'round' && entry.path[1] === 'tracking') return false;
  if (entry.effects !== 'remote-write' && entry.authority_contract.consent.allow_publish !== true) {
    return false;
  }
  return entry.authority_contract.capabilities.includes('fs:f5-state');
}
