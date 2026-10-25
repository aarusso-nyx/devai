import { types } from 'node:util';
import { resolve } from 'node:path';
import { canonicalJson } from '@devai-nyx/utils';
import { issuerState } from '../runtime/contracts.js';
import { requireScope } from './host-operation.js';
import { scopes, type AuthorityHostEffectScope } from './host-scope.js';
import {
  captureReconciliationHostContext,
  disposeReconciliationHostContext,
  readReconciliationHostObservation,
} from './reconciliation-host-context.js';
import type { ReconciliationInstallationBindings } from './reconciliation-host-operation.js';
import { provisionSha } from './reconciliation-host-namespace.js';

interface Controls {
  readonly invocation_id: string;
  readonly action_id: string;
  readonly receipt_store: object;
  readonly repository_root: string;
  readonly repository_id: string;
  readonly original_argv_sha256: string;
  readonly readCurrentBindings: () => ReconciliationInstallationBindings;
  readonly verifyActual: () => void;
}
const actions = new Set(['check', 'evidence verify', 'evidence record']);
const fields = [
  'invocation_id',
  'action_id',
  'receipt_store',
  'repository_root',
  'repository_id',
  'original_argv_sha256',
  'readCurrentBindings',
  'verifyActual',
];
const bindingFields = [
  'package_sha256',
  'module_sha256',
  'registry_sha256',
  'constitution_sha256',
  'policy_sha256',
];
const observations = new WeakMap<
  object,
  {
    readonly controls: Controls;
    active: boolean;
    origin?: AuthorityHostEffectScope;
    readonly admitted: WeakSet<AuthorityHostEffectScope>;
  }
>();
function invalid(): never {
  throw new Error('AUTHORITY_RECONCILIATION_OBSERVATION_INVALID');
}
function data(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    invalid();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (Reflect.ownKeys(value).length !== keys.length) invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
/** Trusted broker constructor for existing read/check/recovery observations only. */
export function createReconciliationObservation(controls: Controls): object {
  const value = data(controls, fields);
  if (
    typeof value.action_id !== 'string' ||
    !actions.has(value.action_id) ||
    typeof value.invocation_id !== 'string' ||
    !value.invocation_id ||
    typeof value.repository_root !== 'string' ||
    !value.repository_root.startsWith('/') ||
    resolve(value.repository_root) !== value.repository_root ||
    /[\p{Cc}\p{Cs}]/u.test(value.repository_root) ||
    typeof value.repository_id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.repository_id) ||
    !digest(value.original_argv_sha256) ||
    typeof value.readCurrentBindings !== 'function' ||
    typeof value.verifyActual !== 'function'
  )
    invalid();
  const issuer = issuerState(value.receipt_store);
  if (!issuer || issuer.closed || issuer.invocation_id !== value.invocation_id) invalid();
  const capsule = Object.freeze({});
  observations.set(capsule, {
    controls: Object.freeze({ ...value }) as unknown as Controls,
    active: true,
    admitted: new WeakSet(),
  });
  return capsule;
}
export function disposeReconciliationObservation(capsule: object): void {
  const state = observations.get(capsule);
  if (state) state.active = false;
}
/** Called by the actual ALS runner before user code, never by an effect adapter. */
export function registerReconciliationObservationScope(
  original: AuthorityHostEffectScope,
  actual: AuthorityHostEffectScope,
): void {
  const capsule = original.reconciliation_observation;
  if (!capsule) return;
  const state = observations.get(capsule);
  if (!state?.active) invalid();
  const c = state.controls;
  if (
    (state.origin !== undefined && state.origin !== original) ||
    actual.action_id !== c.action_id ||
    actual.invocation_id !== c.invocation_id ||
    actual.receipt_store !== c.receipt_store
  ) {
    state.active = false;
    invalid();
  }
  state.origin = original;
  state.admitted.add(actual);
}

/** A failed native checkpoint observation cannot be revived within the action. */
export function invalidateReconciliationObservation(): void {
  const scope = scopes.getStore();
  const state =
    scope?.reconciliation_observation && observations.get(scope.reconciliation_observation);
  if (state && scope && state.admitted.has(scope)) state.active = false;
}

function current(scope: AuthorityHostEffectScope, root: string): Controls {
  const state =
    scope.reconciliation_observation && observations.get(scope.reconciliation_observation);
  if (!state?.active || !state.admitted.has(scope)) invalid();
  const c = state.controls,
    issuer = issuerState(c.receipt_store);
  if (
    scopes.getStore() !== scope ||
    scope.action_id !== c.action_id ||
    scope.invocation_id !== c.invocation_id ||
    scope.receipt_store !== c.receipt_store ||
    !issuer ||
    issuer.closed ||
    issuer.invocation_id !== c.invocation_id ||
    root !== c.repository_root ||
    provisionSha(process.argv) !== c.original_argv_sha256
  )
    invalid();
  try {
    c.verifyActual();
  } catch {
    state.active = false;
    invalid();
  }
  return c;
}
function bindings(c: Controls): ReconciliationInstallationBindings {
  const value = data(c.readCurrentBindings(), bindingFields);
  if (bindingFields.some((key) => !digest(value[key]))) invalid();
  return Object.freeze({ ...value }) as unknown as ReconciliationInstallationBindings;
}
/** Fresh native observations only; no operation token, signer, lease, admission or mutation. */
export function readReconciliationObservationBinding(repositoryRoot: string) {
  const scope = requireScope('process');
  let context: ReturnType<typeof captureReconciliationHostContext> | undefined;
  try {
    const c = current(scope, repositoryRoot),
      before = bindings(c);
    context = captureReconciliationHostContext(c.repository_root, c.repository_id);
    const observation = readReconciliationHostObservation(context);
    current(scope, repositoryRoot);
    const after = bindings(c);
    if (canonicalJson(before) !== canonicalJson(after)) invalid();
    return Object.freeze({
      ...observation,
      bindings: after,
      binding_sha256: provisionSha(after),
      grants_authority: false,
    });
  } catch (error) {
    const state =
      scope.reconciliation_observation && observations.get(scope.reconciliation_observation);
    if (state) state.active = false;
    throw error;
  } finally {
    if (context) disposeReconciliationHostContext(context);
  }
}
