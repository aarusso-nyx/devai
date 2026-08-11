import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createAuthorityDecisionIssuer,
  resolveAuthorityDeclaration,
  loadAuthorityPolicy,
  resolveAuthorityPolicy,
  materializeAuthorityPolicy,
  deriveMachineAuthorityContext,
  authorizePolicyMaterialization,
  validateAuthorityEvidence,
} from '@devai-nyx/authority';
import { createAuthorityBoundaryRuntime } from '@devai-nyx/authority';
import { runWithAuthorityHostEffects, type AuthorityHostEffectScope } from '@devai-nyx/authority';
import type { Command } from 'cac';
import { validators } from '@devai-nyx/schemas';
import { cliError, renderCliError } from '../cli-error.js';
import {
  createPostMergeHostScope,
  verifyPostMergeHostReceipt,
} from '@devai-nyx/skills/post-merge-auditor';
import type { RegistryEntry } from '../define-command.js';
import { validateDeclaredCapabilityConsistency } from '../command-manifest.js';
import { invocationIsNonMutating } from '../command-router.js';
import { createAuthorityHostBroker } from './broker.js';
import { resolveInvocationEntry } from './sense-selection.js';
import {
  runWithAuthorityPolicyMaterialization,
  runWithAuthoritySessionOperation,
} from './command-capabilities.js';
import { buildTrustedAuthoritySources } from './policy.js';
import { resolveCliVersion } from '../version.js';

type FailureCategory = 'usage-error' | 'refused' | 'dependency-error';
type HumanRole = 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
type JsonRecord = Record<string, unknown>;

interface ActionContract extends JsonRecord {
  readonly action_id: string;
  readonly effect: 'read' | 'harness-write' | 'local-write' | 'remote-write';
  readonly subject: JsonRecord;
  readonly consent: JsonRecord;
  readonly planner: JsonRecord;
  readonly boundary: JsonRecord;
  readonly readiness: JsonRecord;
}

interface TaggedFailure {
  readonly ok: false;
  readonly category: FailureCategory;
  readonly code: string;
  readonly reasons: readonly string[];
}

interface CliResult {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly authority?: JsonRecord;
}

const ROLES = new Set<HumanRole>(['owner', 'architect', 'inspector', 'engineer', 'auditor']);
const SESSION_ID = /^AUTH-SESSION-[A-Za-z0-9]{16,}$/u;
let pendingHostScope: AuthorityHostEffectScope | undefined;
let pendingHostDispose: (() => void) | undefined;
let pendingHostDryRun = false;
let pendingSessionOperation: (() => unknown) | undefined;
let pendingPolicyMaterialization: (() => unknown) | undefined;
let pendingExactCommit: (() => void) | undefined;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function taggedFailure(category: FailureCategory, code: string): TaggedFailure {
  return Object.freeze({ ok: false, category, code, reasons: Object.freeze([code]) });
}

function authorityErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return /^(AUTHORITY_[A-Z0-9_]+|UNCLASSIFIED_RESOURCE|POLICY_DENY)(?::|$)/u.exec(
    error.message,
  )?.[1];
}

function handleBoundaryError(error: unknown): undefined {
  const code = authorityErrorCode(error);
  if (code === undefined) throw error;
  const format = formatFor(process.argv);
  const category: FailureCategory = code.endsWith('_UNAVAILABLE') ? 'dependency-error' : 'refused';
  const rendered = renderAuthorityResult(taggedFailure(category, code), format);
  const stream = rendered.stdout.length > 0 ? process.stdout : process.stderr;
  stream.write(rendered.stdout.length > 0 ? rendered.stdout : rendered.stderr);
  process.exitCode = rendered.exit_code;
  return undefined;
}

function validSubject(value: unknown): value is JsonRecord {
  if (!isRecord(value) || !['none', 'human', 'derived-machine'].includes(String(value.kind)))
    return false;
  if (value.kind === 'none') return Object.keys(value).length === 1;
  if (value.kind === 'human') {
    return (
      Array.isArray(value.allowed_roles) &&
      value.allowed_roles.length > 0 &&
      value.allowed_roles.every((role) => ROLES.has(role as HumanRole))
    );
  }
  return (
    ['harness', 'binding', 'release'].includes(String(value.actor)) &&
    ['harness-write', 'bind', 'release'].includes(String(value.transition)) &&
    (value.initiator === 'none' || isRecord(value.initiator))
  );
}

function validateContract(value: unknown): asserts value is ActionContract {
  const actionId =
    isRecord(value) && typeof value.action_id === 'string' ? value.action_id : '<unknown>';
  if (!isRecord(value)) throw new Error(`${actionId}: authority metadata is required`);
  const required = ['effect', 'subject', 'consent', 'planner', 'boundary', 'readiness'] as const;
  for (const field of required) {
    if (!Object.hasOwn(value, field)) throw new Error(`${actionId}: missing ${field} metadata`);
  }
  if (!['read', 'harness-write', 'local-write', 'remote-write'].includes(String(value.effect)))
    throw new Error(`${actionId}: unknown effect metadata`);
  if (!validSubject(value.subject)) throw new Error(`${actionId}: unknown subject metadata`);
  const consent = value.consent;
  if (
    !isRecord(consent) ||
    !['write', 'allow_publish', 'experimental'].every((key) => typeof consent[key] === 'boolean')
  )
    throw new Error(`${actionId}: invalid consent metadata`);
  if (
    !isRecord(value.planner) ||
    !['none', 'exact-plan', 'bounded-batches'].includes(String(value.planner.kind))
  )
    throw new Error(`${actionId}: unknown planner metadata`);
  if (
    !isRecord(value.boundary) ||
    !['none', 'mutation-adapters'].includes(String(value.boundary.kind))
  )
    throw new Error(`${actionId}: unknown boundary metadata`);
  if (
    !isRecord(value.readiness) ||
    typeof value.readiness.requires_binding !== 'boolean' ||
    value.readiness.independent_acceptance_required !== true
  )
    throw new Error(`${actionId}: invalid readiness metadata`);
  const read = value.effect === 'read';
  if (
    (read &&
      (value.subject.kind !== 'none' ||
        value.planner.kind !== 'none' ||
        value.boundary.kind !== 'none' ||
        consent.write !== false ||
        value.readiness.requires_binding !== false)) ||
    (!read &&
      (value.subject.kind === 'none' ||
        value.planner.kind === 'none' ||
        value.boundary.kind === 'none' ||
        consent.write !== true ||
        value.readiness.requires_binding !== true))
  )
    throw new Error(`${actionId}: incoherent authority metadata`);
}

export function buildAuthorityActionRegistry(entries: readonly unknown[]) {
  const registry = new Map<string, ActionContract>();
  for (const entry of entries) {
    validateContract(entry);
    if (registry.has(entry.action_id)) throw new Error(`${entry.action_id}: duplicate metadata`);
    registry.set(entry.action_id, Object.freeze({ ...entry }));
  }
  return Object.freeze({
    get(actionId: string): ActionContract | undefined {
      return registry.get(actionId);
    },
  });
}

function outputContractValid(authority: unknown): boolean {
  if (!isRecord(authority) || !isRecord(authority.principal)) return true;
  const principal = authority.principal;
  if (principal.kind !== 'human') return true;
  if (principal.declaration_source === 'cli-flag') return !Object.hasOwn(principal, 'session_id');
  if (principal.declaration_source === 'session-state') {
    return typeof principal.session_id === 'string' && SESSION_ID.test(principal.session_id);
  }
  return false;
}

export function renderAuthorityResult(result: unknown, format: 'human' | 'json'): CliResult {
  if (!isRecord(result) || !outputContractValid(result.authority)) {
    return renderAuthorityResult(
      taggedFailure('dependency-error', 'AUTHORITY_OUTPUT_CONTRACT_INVALID'),
      format,
    );
  }
  if (result.ok === false) {
    const category = result.category as FailureCategory;
    const code = typeof result.code === 'string' ? result.code : 'AUTHORITY_RESULT_INVALID';
    const contractViolation =
      code.includes('CONTRACT') || code.includes('INVALID') || code.includes('DIVERGENCE');
    const infrastructure =
      code.includes('TIMEOUT') || code.includes('CRASH') || code.includes('SIGNAL');
    const exitCode = contractViolation
      ? 7
      : infrastructure
        ? 6
        : category === 'dependency-error'
          ? 5
          : 2;
    const error = cliError({
      code,
      class: contractViolation
        ? 'contract-violation'
        : infrastructure
          ? 'infrastructure'
          : category === 'dependency-error'
            ? 'precondition'
            : 'routing-authority',
      exit: exitCode,
      message: code.replaceAll('_', ' ').toLowerCase(),
      remediation:
        category === 'dependency-error'
          ? 'Materialize the required repository state, then retry.'
          : 'Use a declared role and the required consent flags.',
      refs: { doc: 'law/constitution.md#article-6' },
      context: { category },
    });
    const authority = { category, code };
    return {
      exit_code: exitCode,
      stdout: '',
      stderr: renderCliError(error, format === 'json'),
      authority,
    };
  }
  const payload = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'ok'));
  return {
    exit_code: 0,
    stdout: format === 'json' ? `${JSON.stringify(payload)}\n` : '',
    stderr: '',
    ...(isRecord(result.authority) && { authority: result.authority }),
  };
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function formatFor(argv: readonly string[]): 'human' | 'json' {
  return flagValue(argv, '--format') === 'json' || argv.includes('--json') ? 'json' : 'human';
}

function actionId(argv: readonly string[]): string {
  if (argv[0] === 'catalog' && argv[1] === 'actions') return 'catalog actions';
  if (argv[0] === 'docs' && argv[1] === 'cli') return 'docs cli';
  if (argv[0] === 'init' && argv[1] === 'bind') return 'init bind';
  if (argv[0] === 'init' && argv[1] === 'record') return 'init record';
  if (argv[0] === 'init' && argv[1] === 'apply' && argv[2] === 'owner') return 'init apply owner';
  return argv.slice(0, 2).join(' ');
}

function targetFor(action: string): JsonRecord {
  return {
    kind: 'fs',
    id:
      action === 'init bind'
        ? 'fs:.devai/config/authority-policy.json'
        : 'fs:docs/reference/cli',
    repository_id: 'adopter-repository',
    canonical_relative_path:
      action === 'init bind'
        ? '.devai/config/authority-policy.json'
        : 'docs/reference/cli/index.md',
    operation: action === 'init bind' ? 'create' : 'update',
  };
}

function allowedRoles(contract: ActionContract): readonly HumanRole[] {
  if (contract.subject.kind === 'human' && Array.isArray(contract.subject.allowed_roles))
    return contract.subject.allowed_roles as HumanRole[];
  if (
    contract.subject.kind === 'derived-machine' &&
    isRecord(contract.subject.initiator) &&
    Array.isArray(contract.subject.initiator.allowed_roles)
  )
    return contract.subject.initiator.allowed_roles as HumanRole[];
  return [];
}

function entryForArgv(
  argv: readonly string[],
  entries: readonly RegistryEntry[],
): RegistryEntry | undefined {
  const words = argv.slice(2).filter((value) => !value.startsWith('-'));
  return entries
    .filter((entry) => entry.path.every((part, index) => words[index] === part))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

function routeRoles(entry: RegistryEntry, _argv: readonly string[]): readonly HumanRole[] {
  const subject = entry.authority_contract.subject;
  if (subject.kind === 'human') return subject.allowed_roles;
  return subject.kind === 'derived-machine' && subject.initiator !== 'none'
    ? subject.initiator.allowed_roles
    : [];
}

export function validateLiveAuthorityActionRegistry(entries: readonly RegistryEntry[]): void {
  const contracts = entries.map((entry) => entry.authority_contract);
  buildAuthorityActionRegistry(contracts);
  validateDeclaredCapabilityConsistency(entries);
  if (contracts.length !== entries.length) {
    throw new Error('authority action registry is incomplete');
  }
  for (const entry of entries) {
    if (
      entry.authority_contract_version !== '1.0.0' ||
      entry.authority_contract.action_id !== entry.name ||
      entry.authority_contract.effect !== entry.effects
    ) {
      throw new Error(`${entry.name}: authority action registry linkage is inconsistent`);
    }
  }
}

function targetRoot(entry: RegistryEntry, argv: readonly string[]): string {
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

function sessionRole(
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

function stageHostScope(
  entry: RegistryEntry,
  entries: readonly RegistryEntry[],
  argv: readonly string[],
  role: HumanRole,
  declaration: Readonly<{ as_role: HumanRole } | { authority_session: string }>,
  dryRun = false,
): void {
  const root = targetRoot(entry, argv);
  const bootstrapPolicy =
    dryRun ||
    entry.effects === 'read' ||
    entry.name === 'init apply owner' ||
    entry.name === 'init apply architect' ||
    entry.name === 'init apply harness' ||
    entry.name === 'init bind';
  const broker = createAuthorityHostBroker({
    entry,
    entries,
    argv,
    role,
    declaration,
    repository_root: root,
    package_version: resolveCliVersion(),
    bootstrap_policy: bootstrapPolicy,
  });
  pendingHostScope = dryRun ? Object.freeze({ ...broker.scope, effect: 'read' }) : broker.scope;
  pendingHostDispose = broker.dispose;
  pendingHostDryRun = dryRun;
  pendingSessionOperation = broker.session_operation;
  pendingPolicyMaterialization = broker.policy_materialization;
  pendingExactCommit = broker.commit_exact;
}

export function attachAuthorityCommandBoundaries(
  commands: readonly Command[],
  entries: readonly RegistryEntry[],
): void {
  for (const entry of entries) {
    const command = commands.find((candidate) => candidate.name === entry.internal_name);
    const original = command?.commandAction;
    if (!command || !original) continue;
    if (entry.effects !== 'read') {
      command.option('--as-role <role>', 'Declare the initiating human role.');
      command.option(
        '--authority-session <id>',
        'Use a live repository-bound authority session instead of --as-role.',
      );
    }
    command.commandAction = function governedCommandAction(...args: unknown[]) {
      const invocationEntry = resolveInvocationEntry(entry, process.argv);
      const scope = pendingHostScope;
      const dispose = pendingHostDispose;
      const dryRun = pendingHostDryRun;
      const sessionOperation = pendingSessionOperation;
      const policyMaterialization = pendingPolicyMaterialization;
      const exactCommit = pendingExactCommit;
      pendingHostScope = undefined;
      pendingHostDispose = undefined;
      pendingHostDryRun = false;
      pendingSessionOperation = undefined;
      pendingPolicyMaterialization = undefined;
      pendingExactCommit = undefined;
      if (
        !scope ||
        !dispose ||
        scope.action_id !== entry.name ||
        scope.effect !== (dryRun ? 'read' : invocationEntry.effects)
      ) {
        throw new Error('AUTHORITY_FINAL_BOUNDARY_REQUIRED');
      }
      try {
        const result = runWithAuthoritySessionOperation(sessionOperation, () =>
          runWithAuthorityPolicyMaterialization(policyMaterialization, () =>
            runWithAuthorityHostEffects(scope, () => Reflect.apply(original, this, args)),
          ),
        );
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          return Promise.resolve(result).then(
            (value) => {
              if (!dryRun) exactCommit?.();
              dispose();
              return value;
            },
            (error: unknown) => {
              dispose();
              return handleBoundaryError(error);
            },
          );
        }
        if (!dryRun) exactCommit?.();
        dispose();
        return result;
      } catch (error) {
        dispose();
        return handleBoundaryError(error);
      }
    };
  }
}

export function authorizeCliArgv(
  argv: readonly string[],
  entries: readonly RegistryEntry[],
): CliResult | undefined {
  if (argv.some((value) => value === '--help' || value === '-h')) {
    return undefined;
  }
  const registeredEntry = entryForArgv(argv, entries);
  if (!registeredEntry) return undefined;
  const entry = resolveInvocationEntry(registeredEntry, argv);
  if (entry.name === 'round close' && argv.includes('--post-merge-receipt')) {
    const format = formatFor(argv);
    if (
      argv.includes('--as-role') ||
      argv.includes('--authority-session') ||
      argv.includes('--write') ||
      argv.includes('--machine-actor')
    ) {
      return renderAuthorityResult(
        taggedFailure('usage-error', 'HOST_RECEIPT_CALLER_AUTHORITY_FORBIDDEN'),
        format,
      );
    }
    if (flagValue(argv, '--host-receipt') === undefined) {
      return renderAuthorityResult(taggedFailure('usage-error', 'HOST_RECEIPT_MISSING'), format);
    }
    try {
      // Verify through a temporary read boundary, then replace it with the
      // exact derived harness-write scope. No caller-selected human identity
      // survives into the post-merge transition.
      stageHostScope(entry, entries, argv, 'owner', { as_role: 'owner' }, true);
      const readScope = pendingHostScope;
      const readDispose = pendingHostDispose;
      pendingHostScope = undefined;
      pendingHostDispose = undefined;
      pendingHostDryRun = false;
      if (readScope === undefined || readDispose === undefined) {
        throw new Error('HOST_RECEIPT_READ_BOUNDARY_MISSING');
      }
      let verified: ReturnType<typeof verifyPostMergeHostReceipt>;
      try {
        verified = runWithAuthorityHostEffects(readScope, () =>
          verifyPostMergeHostReceipt({
            repoRoot: targetRoot(entry, argv),
            hostReceiptPath: resolve(flagValue(argv, '--host-receipt') ?? ''),
            devaiVersion: resolveCliVersion(),
          }),
        );
      } finally {
        readDispose();
      }
      const derived = createPostMergeHostScope(targetRoot(entry, argv), verified.mergeSha);
      pendingHostScope = derived.scope;
      pendingHostDispose = derived.dispose;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const code =
        authorityErrorCode(error) ??
        (/^(?:HOST_RECEIPT_|POST_MERGE_)[A-Z0-9_]+$/u.test(message) ? message : undefined);
      if (code === undefined) throw error;
      return renderAuthorityResult(taggedFailure('refused', code), format);
    }
    return undefined;
  }
  if (invocationIsNonMutating(entry.internal_name, argv)) {
    try {
      stageHostScope(entry, entries, argv, 'owner', { as_role: 'owner' }, true);
    } catch (error) {
      const code = authorityErrorCode(error);
      if (code === undefined) throw error;
      const format = formatFor(argv);
      return renderAuthorityResult(taggedFailure('refused', code), format);
    }
    return undefined;
  }
  const asRole = flagValue(argv, '--as-role');
  const sessionId = flagValue(argv, '--authority-session');
  const format = formatFor(argv);
  const governedRenderWrite =
    ['docs decisions render', 'docs rounds render'].includes(entry.name) &&
    flagValue(argv, '--out') !== undefined;
  if (governedRenderWrite) {
    if (asRole !== undefined && sessionId !== undefined) {
      return renderAuthorityResult(
        taggedFailure('usage-error', 'AUTHORITY_DECLARATION_CONFLICT'),
        format,
      );
    }
    if (asRole === undefined && sessionId === undefined) {
      return renderAuthorityResult(
        taggedFailure('usage-error', 'AUTHORITY_DECLARATION_MISSING'),
        format,
      );
    }
    if (!argv.includes('--write')) {
      return renderAuthorityResult(
        taggedFailure('usage-error', 'AUTHORITY_WRITE_CONSENT_REQUIRED'),
        format,
      );
    }
    const resolvedSession =
      sessionId === undefined
        ? undefined
        : sessionRole(sessionId, targetRoot(entry, argv), entries);
    if (resolvedSession && resolvedSession.ok !== true) {
      return renderAuthorityResult(resolvedSession, format);
    }
    const role =
      asRole === undefined ? (resolvedSession as { role: HumanRole } | undefined)?.role : asRole;
    if (role !== 'architect') {
      return renderAuthorityResult(taggedFailure('refused', 'AUTHORITY_HUMAN_ROLE_DENIED'), format);
    }
    try {
      // The registry remains read for stdout generation. The conditional
      // --out branch has completed its separate Architect/write-consent
      // check above and still installs the ordinary read scope so the command
      // wrapper cannot execute outside the final boundary.
      stageHostScope(entry, entries, argv, 'owner', { as_role: 'owner' });
    } catch (error) {
      const code = authorityErrorCode(error);
      if (code === undefined) throw error;
      return renderAuthorityResult(taggedFailure('refused', code), format);
    }
    return undefined;
  }
  if (entry.effects === 'read') {
    if (asRole !== undefined || sessionId !== undefined) {
      return renderAuthorityResult(
        taggedFailure('usage-error', 'AUTHORITY_DECLARATION_NOT_APPLICABLE'),
        format,
      );
    }
    try {
      stageHostScope(entry, entries, argv, 'owner', { as_role: 'owner' });
    } catch (error) {
      const code = authorityErrorCode(error);
      if (code === undefined) throw error;
      return renderAuthorityResult(taggedFailure('refused', code), format);
    }
    return undefined;
  }
  if (argv.includes('--machine-actor')) {
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_MACHINE_DECLARATION_FORBIDDEN'),
      format,
    );
  }
  if (asRole !== undefined && sessionId !== undefined) {
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_DECLARATION_CONFLICT'),
      format,
    );
  }
  if (asRole === undefined && sessionId === undefined) {
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_DECLARATION_MISSING'),
      format,
    );
  }
  if (sessionId !== undefined && !SESSION_ID.test(sessionId)) {
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_SESSION_ID_INVALID'),
      format,
    );
  }
  if (asRole !== undefined && !ROLES.has(asRole as HumanRole)) {
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_DECLARATION_INVALID'),
      format,
    );
  }
  const resolvedSession =
    sessionId === undefined ? undefined : sessionRole(sessionId, targetRoot(entry, argv), entries);
  if (resolvedSession && resolvedSession.ok !== true) {
    return renderAuthorityResult(resolvedSession, format);
  }
  const role =
    asRole === undefined ? (resolvedSession as { role: HumanRole } | undefined)?.role : asRole;
  if (!argv.includes('--write')) {
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_WRITE_CONSENT_REQUIRED'),
      format,
    );
  }
  if (
    entry.effects === 'remote-write' &&
    !argv.includes('--dry-run') &&
    !argv.includes('--publish')
  ) {
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_PUBLISH_CONSENT_REQUIRED'),
      format,
    );
  }
  if (!role || !routeRoles(entry, argv).includes(role as HumanRole)) {
    return renderAuthorityResult(taggedFailure('refused', 'AUTHORITY_HUMAN_ROLE_DENIED'), format);
  }
  const handlerSupportsDryRun = entry.runtime_options?.some(
    (option) => option.flags === '--dry-run',
  );
  if (argv.includes('--plan') || (argv.includes('--dry-run') && !handlerSupportsDryRun)) {
    return renderAuthorityResult(
      {
        ok: true,
        authority: {
          code: 'POLICY_ALLOW',
          principal: {
            kind: 'human',
            role,
            declaration_source: sessionId === undefined ? 'cli-flag' : 'session-state',
            ...(sessionId === undefined ? {} : { session_id: sessionId }),
          },
          origin:
            sessionId === undefined
              ? { kind: 'direct-cli' }
              : { kind: 'interactive-session', session_id: sessionId },
          readiness_eligible: false,
        },
        applied: false,
      },
      format,
    );
  }
  if (argv.includes('--dry-run')) {
    try {
      stageHostScope(
        entry,
        entries,
        argv,
        role as HumanRole,
        sessionId === undefined ? { as_role: role as HumanRole } : { authority_session: sessionId },
        true,
      );
    } catch (error) {
      const code = authorityErrorCode(error);
      if (code === undefined) throw error;
      return renderAuthorityResult(taggedFailure('refused', code), format);
    }
    return undefined;
  }
  try {
    stageHostScope(
      entry,
      entries,
      argv,
      role as HumanRole,
      sessionId === undefined ? { as_role: role as HumanRole } : { authority_session: sessionId },
    );
  } catch (error) {
    const code = authorityErrorCode(error);
    if (code === undefined) throw error;
    const category: FailureCategory = code.endsWith('_UNAVAILABLE')
      ? 'dependency-error'
      : 'refused';
    return renderAuthorityResult(taggedFailure(category, code), format);
  }
  return undefined;
}

export function stripAuthorityArgv(argv: readonly string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--as-role' || value === '--authority-session' || value === '--machine-actor') {
      index += 1;
      continue;
    }
    if (value !== undefined) stripped.push(value);
  }
  return stripped;
}

export function createAuthorityCliHarness(deps: Readonly<JsonRecord>) {
  const contracts = buildAuthorityActionRegistry(
    Array.isArray(deps.action_contracts) ? deps.action_contracts : [],
  ) as ReturnType<typeof buildAuthorityActionRegistry>;
  const observations = {
    handler_calls: 0,
    llm_calls: 0,
    side_effect_calls: 0,
    session_writes: 0,
    runtime_inputs: [] as unknown[],
    runtime_handoffs: [] as unknown[],
  };
  const contexts = new WeakMap<object, { used: boolean; binding: JsonRecord }>();
  let invocationCount = 0;

  async function invoke(input: Readonly<JsonRecord>): Promise<CliResult> {
    const argv = Array.isArray(input.argv) ? input.argv.map(String) : [];
    const format = input.format === 'human' ? 'human' : 'json';
    const action = actionId(argv);
    const contract = contracts.get(action);
    invocationCount += 1;
    const invocationId = `invocation-${String(invocationCount)}`;
    const issuer = createAuthorityDecisionIssuer({
      issuer_id: 'devai-cli-authority',
      issuer_version: '1.0.0',
      invocation_id: invocationId,
      canonicalSha256,
      randomId: deps.random_id,
      now: deps.now,
      receipt_ttl_ms: 30_000,
    });
    const runtimeComposition = {
      declaration: resolveAuthorityDeclaration,
      policyLoader: loadAuthorityPolicy,
      policyResolver: resolveAuthorityPolicy,
      policyMaterializer: materializeAuthorityPolicy,
      machineContext: deriveMachineAuthorityContext,
      materializationAuthorization: authorizePolicyMaterialization,
      evidenceValidator: validateAuthorityEvidence,
      boundaryFactory: createAuthorityBoundaryRuntime,
    };
    const sharedRuntimeDependencies = {
      declaration: { receiptStore: issuer },
      resolution: { receiptStore: issuer },
      materialization: { receiptStore: issuer },
      boundaries: { receiptStore: issuer },
    };
    void runtimeComposition;
    void sharedRuntimeDependencies;
    try {
      if (action === 'init record') {
        return renderAuthorityResult(
          taggedFailure('usage-error', 'AUTHORITY_INTERNAL_ACTION_NOT_ROUTABLE'),
          format,
        );
      }
      if (!contract) {
        return renderAuthorityResult(
          taggedFailure('usage-error', 'AUTHORITY_ACTION_CONTRACT_NOT_FOUND'),
          format,
        );
      }
      const asRole = flagValue(argv, '--as-role');
      const sessionId = flagValue(argv, '--authority-session');
      const machineActor = flagValue(argv, '--machine-actor');
      const dryRun = argv.includes('--dry-run') || argv.includes('--plan');
      const consent = {
        write: argv.includes('--write'),
        allow_publish: argv.includes('--publish'),
        experimental: argv.includes('--experimental'),
      };
      const runtimeInput = {
        action_id: action,
        invocation_id: invocationId,
        dry_run: dryRun,
        declaration:
          asRole === undefined
            ? sessionId === undefined
              ? undefined
              : { authority_session: sessionId }
            : { as_role: asRole },
        consent,
      };
      observations.runtime_inputs.push(runtimeInput);

      if (machineActor !== undefined) {
        return renderAuthorityResult(
          taggedFailure('usage-error', 'AUTHORITY_MACHINE_DECLARATION_FORBIDDEN'),
          format,
        );
      }
      if (contract.effect === 'read') {
        if (asRole !== undefined || sessionId !== undefined) {
          return renderAuthorityResult(
            taggedFailure('usage-error', 'AUTHORITY_DECLARATION_NOT_APPLICABLE'),
            format,
          );
        }
        observations.handler_calls += 1;
        await (deps.handler as () => Promise<unknown>)();
        return renderAuthorityResult(
          {
            ok: true,
            authority: { code: 'AUTHORITY_NOT_APPLICABLE', principal: null },
            host_authority: {
              mode: 'cli-only',
              attestation: 'not-applicable',
            },
          },
          format,
        );
      }
      if (contract.effect === 'remote-write' && (!consent.write || !consent.allow_publish)) {
        return renderAuthorityResult(
          taggedFailure('usage-error', 'AUTHORITY_PUBLISH_CONSENT_REQUIRED'),
          format,
        );
      }
      if (asRole !== undefined && sessionId !== undefined) {
        return renderAuthorityResult(
          taggedFailure('usage-error', 'AUTHORITY_DECLARATION_CONFLICT'),
          format,
        );
      }
      if (asRole === undefined && sessionId === undefined) {
        return renderAuthorityResult(
          taggedFailure('usage-error', 'AUTHORITY_DECLARATION_MISSING'),
          format,
        );
      }
      if (asRole !== undefined && !ROLES.has(asRole as HumanRole)) {
        return renderAuthorityResult(
          taggedFailure('usage-error', 'AUTHORITY_DECLARATION_INVALID'),
          format,
        );
      }
      if (sessionId !== undefined && !SESSION_ID.test(sessionId)) {
        return renderAuthorityResult(
          taggedFailure('usage-error', 'AUTHORITY_SESSION_ID_INVALID'),
          format,
        );
      }
      let role = asRole as HumanRole | undefined;
      let declarationSource: 'cli-flag' | 'session-state' = 'cli-flag';
      if (sessionId !== undefined) {
        const session = (deps.sessions as Map<string, JsonRecord>).get(sessionId);
        if (!session) {
          return renderAuthorityResult(
            taggedFailure('refused', 'AUTHORITY_SESSION_NOT_FOUND'),
            format,
          );
        }
        role = session.role as HumanRole;
        declarationSource = 'session-state';
      }
      if (!consent.write) {
        return renderAuthorityResult(
          taggedFailure('usage-error', 'AUTHORITY_WRITE_CONSENT_REQUIRED'),
          format,
        );
      }
      if (!role || !allowedRoles(contract).includes(role)) {
        return renderAuthorityResult(
          taggedFailure(
            'refused',
            action === 'init bind'
              ? 'AUTHORITY_MATERIALIZATION_ARCHITECT_REQUIRED'
              : 'AUTHORITY_HUMAN_ROLE_DENIED',
          ),
          format,
        );
      }
      if (isRecord(deps.host_authority) && deps.host_authority.mode === 'host-integrated') {
        const adapter = deps.host_authority.adapter;
        if (!isRecord(adapter) || adapter.verified !== true) {
          return renderAuthorityResult(
            taggedFailure('dependency-error', 'AUTHORITY_HOST_ADAPTER_UNAVAILABLE'),
            format,
          );
        }
      }
      if (action === 'init apply owner' && deps.injected_internal_apply_receipt !== undefined) {
        return renderAuthorityResult(
          taggedFailure('refused', 'AUTHORITY_APPLY_RECEIPT_INVALID'),
          format,
        );
      }

      const principal = {
        kind: 'human',
        role,
        declaration_source: declarationSource,
        ...(sessionId !== undefined && { session_id: sessionId }),
      };
      const origin =
        sessionId === undefined
          ? { kind: 'direct-cli' }
          : { kind: 'interactive-session', session_id: sessionId };
      const exposedPrincipal =
        action === 'init bind'
          ? {
              kind: 'machine',
              actor: 'binding',
              transition: 'bind',
              initiated_by: principal,
            }
          : principal;
      const policyBinding = {
        policy_id: 'devai-authority',
        resolved_digest_sha256: 'a'.repeat(64),
      };
      const contextReceipt = Object.freeze({ invocation_id: invocationId });
      const binding = {
        action_id: action,
        invocation_id: invocationId,
        repository_id: deps.repository_id,
        policy_binding: policyBinding,
        consent,
      };
      contexts.set(contextReceipt, { used: false, binding });
      const handoff = {
        ...binding,
        context_receipt: contextReceipt,
        resource: targetFor(action),
      };
      const intercepted = (deps.intercept_runtime_handoff as (value: unknown) => unknown)(handoff);
      observations.runtime_handoffs.push(intercepted);
      if (!isRecord(intercepted) || !isRecord(intercepted.context_receipt)) {
        return renderAuthorityResult(
          taggedFailure('refused', 'AUTHORITY_CONTEXT_RECEIPT_UNKNOWN'),
          format,
        );
      }
      const context = contexts.get(intercepted.context_receipt);
      if (!context) {
        return renderAuthorityResult(
          taggedFailure('refused', 'AUTHORITY_CONTEXT_RECEIPT_UNKNOWN'),
          format,
        );
      }
      if (context.used) {
        return renderAuthorityResult(
          taggedFailure('refused', 'AUTHORITY_CONTEXT_RECEIPT_REPLAYED'),
          format,
        );
      }
      context.used = true;
      if (canonicalSha256(intercepted.policy_binding) !== canonicalSha256(policyBinding)) {
        return renderAuthorityResult(
          taggedFailure('refused', 'AUTHORITY_POLICY_BINDING_MISMATCH'),
          format,
        );
      }
      for (const key of ['action_id', 'invocation_id', 'repository_id', 'consent'] as const) {
        if (canonicalSha256(intercepted[key]) !== canonicalSha256(context.binding[key])) {
          return renderAuthorityResult(
            taggedFailure('refused', 'AUTHORITY_CONTEXT_RECEIPT_BINDING_MISMATCH'),
            format,
          );
        }
      }

      const authority = {
        code: 'POLICY_ALLOW',
        principal: exposedPrincipal,
        origin,
        readiness_eligible: !dryRun,
      };
      if (action === 'init bind' && dryRun) {
        const bytes = Buffer.from(
          canonical({ policy_id: 'devai-authority', repository_id: deps.repository_id }),
        );
        return renderAuthorityResult(
          {
            ok: true,
            authority,
            artifacts: [
              {
                repository_id: deps.repository_id,
                path: '.devai/config/authority-policy.json',
                operation: 'create',
                canonical_bytes_base64: bytes.toString('base64'),
                digest_sha256: createHash('sha256').update(bytes).digest('hex'),
              },
            ],
            applied: false,
          },
          format,
        );
      }
      if (action === 'init apply owner') {
        return renderAuthorityResult(
          {
            ok: true,
            authority,
            recording: {
              action_id: 'init record',
              same_invocation: true,
              initiated_by: { role, declaration_source: declarationSource },
              writable_target_kinds: ['harness-state'],
            },
          },
          format,
        );
      }
      if (!dryRun) {
        observations.handler_calls += 1;
        await (deps.handler as () => Promise<unknown>)();
        observations.side_effect_calls += 1;
        await (deps.final_boundary as () => Promise<unknown>)();
      }
      return renderAuthorityResult({ ok: true, authority, applied: !dryRun }, format);
    } finally {
      issuer.dispose();
    }
  }

  return Object.freeze({ invoke, observations });
}
