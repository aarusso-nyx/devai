import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { types as nodeTypes } from 'node:util';
import { canonicalJson } from '@devai-nyx/utils';
import type { HumanRole } from './authority-results.js';

export interface ParsedReconciliationHostInput {
  readonly action_id: string;
  readonly initiator: HumanRole;
  readonly operation:
    'plan' | 'provision' | 'approve' | 'renew' | 'revoke' | 'recover-owned-lease' | 'consume-phase';
  readonly phases: readonly ('01' | '02' | '03' | '04')[];
  readonly write: boolean;
  readonly require_tty: boolean;
  readonly original_argv_sha256: string;
  readonly approval_id?: string;
  readonly plan_sha256?: string;
  readonly plan_path?: string;
  readonly expected_grant_sha256?: string;
  readonly expected_lease_sha256?: string;
  readonly selected_parent?: string;
  readonly published_ref?: string;
}

const ACTIONS = new Set([
  'init bind',
  'evidence reconcile plan',
  'evidence reconcile approve',
  'evidence reconcile materialize',
  'evidence reconcile stage-proof',
  'sense bootstrap-inventory',
]);
const SWITCHES = new Set([
  '--write',
  '--reconciliation-host',
  '--renew',
  '--revoke',
  '--recover-owned-lease',
]);
const VALUES = new Set([
  '--target',
  '--repo-root',
  '--plan',
  '--plan-sha256',
  '--as-role',
  '--format',
  '--approval',
  '--expected-grant-sha256',
  '--expected-lease-sha256',
  '--selected-parent',
  '--published-ref',
]);
const SHA = /^[a-f0-9]{64}$/u;
function hasControl(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

function invalid(): never {
  throw new Error('AUTHORITY_RECONCILIATION_INVOCATION_INVALID');
}

function publishedRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('refs/heads/') &&
    value.length <= 1024 &&
    !hasControl(value) &&
    !/[ ~^:?*[\\]/u.test(value) &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !value.endsWith('.') &&
    !value.startsWith('refs/heads/-') &&
    value.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'))
  );
}

/** Parse only the exact original CLI grammar; this capsule grants no authority. */
export function parseReconciliationHostInput(
  actionId: string,
  argv: readonly string[],
  root: string,
  role: HumanRole,
): ParsedReconciliationHostInput | undefined {
  if (!ACTIONS.has(actionId)) return undefined;
  if (nodeTypes.isProxy(argv) || !Array.isArray(argv) || argv.length > 128) invalid();
  // Inspect data descriptors before touching values, including a hostile array's getters.
  const args: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(argv, String(i));
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string' ||
      descriptor.value.length > 16384 ||
      hasControl(descriptor.value)
    )
      invalid();
    args.push(descriptor.value);
  }
  if (
    actionId === 'init bind' &&
    !args.some((value) => value.startsWith('--') && /reconciliation[-_]?host/iu.test(value))
  )
    return undefined;
  const words = actionId.split(' ');
  if (args.length < words.length + 2 || words.some((word, i) => args[i + 2] !== word)) invalid();
  const flags = new Map<string, string | true>();
  for (let i = words.length + 2; i < args.length; i += 1) {
    const flag = args[i];
    if (!flag || flags.has(flag)) invalid();
    if (SWITCHES.has(flag)) flags.set(flag, true);
    else if (VALUES.has(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) invalid();
      flags.set(flag, value);
    } else invalid();
  }
  const required = new Set(['--as-role', '--format']);
  const permitted = new Set(['--as-role', '--format', '--write']);
  const bind = actionId === 'init bind';
  const planning = actionId === 'evidence reconcile plan';
  if (planning) permitted.delete('--write');
  const owner = actionId === 'evidence reconcile approve';
  const expectedRole =
    bind || planning || actionId === 'sense bootstrap-inventory'
      ? 'architect'
      : owner
        ? 'owner'
        : 'inspector';
  if (
    role !== expectedRole ||
    flags.get('--as-role') !== expectedRole ||
    flags.get('--format') !== 'json'
  )
    invalid();
  for (const flag of bind
    ? ['--reconciliation-host', '--target']
    : planning
      ? ['--repo-root', '--selected-parent', '--published-ref']
      : ['--repo-root', '--plan', '--plan-sha256']) {
    required.add(flag);
    permitted.add(flag);
  }
  let operation: ParsedReconciliationHostInput['operation'] = bind
    ? 'provision'
    : planning
      ? 'plan'
      : owner
        ? 'approve'
        : 'consume-phase';
  let phases: ParsedReconciliationHostInput['phases'] = [];
  if (owner) {
    const modes = ['--renew', '--revoke', '--recover-owned-lease'].filter((flag) =>
      flags.has(flag),
    );
    if (modes.length > 1) invalid();
    const mode = modes[0];
    if (mode) {
      operation = mode.slice(2) as 'renew' | 'revoke' | 'recover-owned-lease';
      for (const flag of [
        mode,
        '--approval',
        mode === '--recover-owned-lease' ? '--expected-lease-sha256' : '--expected-grant-sha256',
      ]) {
        required.add(flag);
        permitted.add(flag);
      }
    }
  } else if (!bind && !planning) {
    required.add('--approval');
    permitted.add('--approval');
    phases =
      actionId === 'evidence reconcile materialize'
        ? ['01', '02']
        : actionId === 'evidence reconcile stage-proof'
          ? ['03']
          : ['04'];
  }
  if (
    [...required].some((flag) => !flags.has(flag)) ||
    [...flags.keys()].some((flag) => !permitted.has(flag))
  )
    invalid();
  const rootArg = flags.get(bind ? '--target' : '--repo-root');
  if (typeof rootArg !== 'string') invalid();
  try {
    if (resolve(rootArg) !== root || realpathSync(rootArg) !== root || realpathSync(root) !== root)
      invalid();
  } catch {
    invalid();
  }
  for (const flag of [
    '--plan-sha256',
    '--approval',
    '--expected-grant-sha256',
    '--expected-lease-sha256',
  ]) {
    const value = flags.get(flag);
    if (
      value !== undefined &&
      (typeof value !== 'string' ||
        (!SHA.test(value) && !(flag === '--expected-lease-sha256' && value === 'ABSENT')))
    )
      invalid();
  }
  const plan = flags.get('--plan');
  if (
    !bind &&
    !planning &&
    (typeof plan !== 'string' ||
      isAbsolute(plan) ||
      plan.includes('\\') ||
      plan.split('/').some((part) => !part || part === '.' || part === '..'))
  )
    invalid();
  const approval = flags.get('--approval');
  const planSha = flags.get('--plan-sha256');
  const expectedGrant = flags.get('--expected-grant-sha256');
  const expectedLease = flags.get('--expected-lease-sha256');
  const selected = flags.get('--selected-parent');
  const published = flags.get('--published-ref');
  if (
    planning &&
    (typeof selected !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(selected) ||
      !publishedRef(published))
  )
    invalid();
  const write = flags.has('--write');
  return Object.freeze({
    action_id: actionId,
    initiator: role,
    operation,
    phases: Object.freeze([...phases]),
    write,
    require_tty: write && (bind || owner),
    original_argv_sha256: createHash('sha256').update(canonicalJson(args)).digest('hex'),
    ...(typeof approval === 'string' ? { approval_id: approval } : {}),
    ...(typeof planSha === 'string' ? { plan_sha256: planSha } : {}),
    ...(typeof plan === 'string' ? { plan_path: plan } : {}),
    ...(typeof expectedGrant === 'string' ? { expected_grant_sha256: expectedGrant } : {}),
    ...(typeof expectedLease === 'string' ? { expected_lease_sha256: expectedLease } : {}),
    ...(typeof selected === 'string' ? { selected_parent: selected } : {}),
    ...(typeof published === 'string' ? { published_ref: published } : {}),
  });
}
