/**
 * Shared, side-effect-free contracts for executor adapters.
 *
 * Discipline is deliberately carried as data supplied by the task boundary. Neither
 * this module nor an adapter is allowed to manufacture authority from an executor,
 * model, skill, capability, or provider response.
 */

export type ExecutorEffect = 'read' | 'harness-write' | 'local-write' | 'remote-write';

export type ExecutorDiscipline = 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';

export type AgentClass = 'coding-agent' | 'review-agent' | 'ops-agent';
export type PermissionTier = 'read' | 'write' | 'act';

export interface ExecutorFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export function executorFailure(code: string, message: string): ExecutorFailure {
  return { ok: false, code, message };
}

export function isRelativeExecutorPath(value: string): boolean {
  if (value.length === 0 || value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/u.test(value)) return false;
  return !value.split(/[\\/]/u).includes('..');
}

export function isUniqueNonEmptyStrings(values: readonly string[]): boolean {
  return (
    values.every((value) => value.length > 0 && !value.includes('\0')) &&
    new Set(values).size === values.length
  );
}

export function isExecutorEffect(value: string): value is ExecutorEffect {
  return (
    value === 'read' ||
    value === 'harness-write' ||
    value === 'local-write' ||
    value === 'remote-write'
  );
}

export function permissionTierAllows(granted: PermissionTier, required: PermissionTier): boolean {
  const order: Readonly<Record<PermissionTier, number>> = { read: 0, write: 1, act: 2 };
  return order[granted] >= order[required];
}
