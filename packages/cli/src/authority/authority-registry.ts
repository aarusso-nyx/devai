import type { RegistryEntry } from '../define-command.js';
import { validateDeclaredCapabilityConsistency } from '../command-manifest.js';
import {
  type HumanRole,
  type JsonRecord,
  isRecord,
  ROLES,
  type ActionContract,
} from './authority-results.js';

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

export function actionId(argv: readonly string[]): string {
  if (argv[0] === 'catalog' && argv[1] === 'actions') return 'catalog actions';
  if (argv[0] === 'docs' && argv[1] === 'cli') return 'docs cli';
  if (argv[0] === 'init' && argv[1] === 'bind') return 'init bind';
  if (argv[0] === 'init' && argv[1] === 'record') return 'init record';
  if (argv[0] === 'init' && argv[1] === 'apply' && argv[2] === 'owner') return 'init apply owner';
  return argv.slice(0, 2).join(' ');
}

export function targetFor(action: string): JsonRecord {
  return {
    kind: 'fs',
    id: action === 'init bind' ? 'fs:.devai/config/authority-policy.json' : 'fs:docs/reference/cli',
    repository_id: 'adopter-repository',
    canonical_relative_path:
      action === 'init bind'
        ? '.devai/config/authority-policy.json'
        : 'docs/reference/cli/index.md',
    operation: action === 'init bind' ? 'create' : 'update',
  };
}

export function allowedRoles(contract: ActionContract): readonly HumanRole[] {
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

export function entryForArgv(
  argv: readonly string[],
  entries: readonly RegistryEntry[],
): RegistryEntry | undefined {
  const words = argv.slice(2).filter((value) => !value.startsWith('-'));
  return entries
    .filter((entry) => entry.path.every((part, index) => words[index] === part))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

export function routeRoles(entry: RegistryEntry, _argv: readonly string[]): readonly HumanRole[] {
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
