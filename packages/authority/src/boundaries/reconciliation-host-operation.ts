import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { canonicalJson } from '@devai-nyx/utils';
import { issuerState } from '../runtime/contracts.js';
import {
  checkReconciliationClockWindow,
  type ReconciliationClockObservation,
} from '../runtime/reconciliation-clock.js';
import type { AuthorityHostEffectRequest } from './host-atomic-effects.js';
import { requireScope } from './host-operation.js';
import type { AuthorityHostEffectScope } from './host-scope.js';
import { scopes } from './host-scope.js';
import {
  captureReconciliationHostContext,
  disposeReconciliationHostContext,
  readReconciliationHostClock,
  readReconciliationHostIdentity,
  readReconciliationHostObservation,
  readReconciliationHostPaths,
  type ReconciliationHostContext,
  type ReconciliationHostIdentity,
} from './reconciliation-host-context.js';
import {
  isProofIndexResourceTarget,
  isReconciliationHostResourceTarget,
  type ProofIndexResourceTarget,
  type ReconciliationHostResourceTarget,
} from './reconciliation-resources.js';

export interface ReconciliationInstallationBindings {
  readonly package_sha256: string;
  readonly module_sha256: string;
  readonly registry_sha256: string;
  readonly constitution_sha256: string;
  readonly policy_sha256: string;
}
export interface ReconciliationInvocationControls {
  readonly invocation_id: string;
  readonly action_id: string;
  readonly receipt_store: object;
  readonly repository_root: string;
  readonly repository_id: string;
  readonly original_argv_sha256: string;
  readonly initiator: 'architect' | 'owner' | 'inspector';
  readonly operation: ReconciliationHostResourceTarget['operation'] | 'plan';
  readonly phases: readonly ('01' | '02' | '03' | '04')[];
  readonly write: boolean;
  readonly require_tty: boolean;
  readonly approval_id?: string;
  readonly plan_sha256?: string;
  readonly plan_path?: string;
  readonly expected_grant_sha256?: string;
  readonly expected_lease_sha256?: string;
  readonly selected_parent?: string;
  readonly published_ref?: string;
  readonly readCurrentBindings: () => ReconciliationInstallationBindings;
  readonly verifyActual: () => void;
}
type Target = ReconciliationHostResourceTarget | ProofIndexResourceTarget;
export interface ReconciliationHostOperation {
  readonly target: Target;
  readonly action_id: string;
  readonly invocation_id: string;
  readonly original_argv_sha256: string;
  readonly initiator: ReconciliationInvocationControls['initiator'];
}
interface InvocationState {
  readonly controls: ReconciliationInvocationControls;
  active: boolean;
}
interface OperationState {
  stale: boolean;
  readonly invocation: object;
  readonly scope: AuthorityHostEffectScope;
  readonly controls: ReconciliationInvocationControls;
  readonly context: ReconciliationHostContext;
  readonly bindings: ReconciliationInstallationBindings;
  readonly issued: ReconciliationClockObservation;
  readonly target: Target;
  readonly view: ReconciliationHostOperation;
}
const invocations = new WeakMap<object, InvocationState>();
const pending = new WeakSet<object>();
const tokens = new WeakMap<object, OperationState>();
const views = new WeakMap<object, OperationState>();
const BINDING_FIELDS = [
  'package_sha256',
  'module_sha256',
  'registry_sha256',
  'constitution_sha256',
  'policy_sha256',
];
const REQUIRED = [
  'invocation_id',
  'action_id',
  'receipt_store',
  'repository_root',
  'repository_id',
  'original_argv_sha256',
  'initiator',
  'operation',
  'phases',
  'write',
  'require_tty',
  'readCurrentBindings',
  'verifyActual',
];
const OPTIONAL = [
  'approval_id',
  'plan_sha256',
  'plan_path',
  'expected_grant_sha256',
  'expected_lease_sha256',
  'selected_parent',
  'published_ref',
];
function fail(kind: 'INVOCATION_INVALID' | 'OPERATION_INVALID' | 'OPERATION_STALE'): never {
  throw new Error(`AUTHORITY_RECONCILIATION_${kind}`);
}
function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return undefined;
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (d?.enumerable !== true || !Object.hasOwn(d, 'value')) return undefined;
    copy[key] = d.value;
  }
  return copy;
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/u.test(value);
}
function sha(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function bindings(value: unknown): ReconciliationInstallationBindings {
  const data = record(value);
  if (!data || Object.keys(data).length !== 5 || BINDING_FIELDS.some((key) => !digest(data[key])))
    fail('OPERATION_STALE');
  return Object.freeze({ ...data }) as unknown as ReconciliationInstallationBindings;
}
function currentBindings(
  controls: ReconciliationInvocationControls,
): ReconciliationInstallationBindings {
  try {
    return bindings(controls.readCurrentBindings());
  } catch {
    fail('OPERATION_STALE');
  }
}
function assertSynchronousResult(value: unknown): void {
  if (nodeTypes.isPromise(value)) fail('OPERATION_INVALID');
  let cursor: unknown = value;
  for (
    let depth = 0;
    cursor !== null && (typeof cursor === 'object' || typeof cursor === 'function');
    depth += 1
  ) {
    if (depth > 16 || nodeTypes.isProxy(cursor)) fail('OPERATION_INVALID');
    // Inspect descriptors only. Even a then accessor is unsupported, without calling it.
    const descriptor = Object.getOwnPropertyDescriptor(cursor, 'then');
    if (
      descriptor &&
      (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value === 'function')
    )
      fail('OPERATION_INVALID');
    if (descriptor) return;
    cursor = Object.getPrototypeOf(cursor);
  }
}
function phaseList(value: unknown): readonly string[] | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    value.length > 4
  )
    return undefined;
  const result: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !Object.hasOwn(d, 'value') || typeof d.value !== 'string') return undefined;
    result.push(d.value);
  }
  return result;
}
function matrix(c: ReconciliationInvocationControls): boolean {
  if (
    Object.hasOwn(c, 'expected_grant_sha256') &&
    (c.action_id !== 'evidence reconcile approve' ||
      !['renew', 'revoke'].includes(c.operation) ||
      !digest(c.expected_grant_sha256))
  )
    return false;
  if (
    Object.hasOwn(c, 'expected_lease_sha256') &&
    (c.action_id !== 'evidence reconcile approve' ||
      c.operation !== 'recover-owned-lease' ||
      (!digest(c.expected_lease_sha256) && c.expected_lease_sha256 !== 'ABSENT'))
  )
    return false;
  if (
    Object.hasOwn(c, 'plan_path') &&
    (typeof c.plan_path !== 'string' ||
      c.plan_path.length > 4096 ||
      c.plan_path.startsWith('/') ||
      c.plan_path.includes('\\') ||
      [...c.plan_path].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      c.plan_path.split('/').some((part) => !part || part === '.' || part === '..') ||
      c.action_id === 'init bind' ||
      c.action_id === 'evidence reconcile plan')
  )
    return false;
  const phases = c.phases.join(',');
  const tty =
    c.write && (c.action_id === 'init bind' || c.action_id === 'evidence reconcile approve');
  if (c.require_tty !== tty) return false;
  if (c.action_id === 'evidence reconcile plan') {
    const ref = c.published_ref;
    return (
      c.initiator === 'architect' &&
      c.operation === 'plan' &&
      !c.write &&
      phases === '' &&
      c.approval_id === undefined &&
      c.plan_sha256 === undefined &&
      typeof c.selected_parent === 'string' &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(c.selected_parent) &&
      typeof ref === 'string' &&
      ref.startsWith('refs/heads/') &&
      ref.length <= 1024 &&
      ![...ref].some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      ) &&
      !/[~^:?*[\\]/u.test(ref) &&
      !ref.includes('..') &&
      !ref.includes('@{') &&
      !ref.endsWith('.') &&
      !ref.startsWith('refs/heads/-') &&
      ref.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'))
    );
  }
  if (Object.hasOwn(c, 'selected_parent') || Object.hasOwn(c, 'published_ref')) return false;
  if (c.action_id === 'init bind')
    return (
      c.initiator === 'architect' &&
      c.operation === 'provision' &&
      phases === '' &&
      c.approval_id === undefined &&
      c.plan_sha256 === undefined
    );
  if (!digest(c.plan_sha256)) return false;
  if (c.action_id === 'evidence reconcile approve')
    return (
      c.initiator === 'owner' &&
      ['approve', 'renew', 'revoke', 'recover-owned-lease'].includes(c.operation) &&
      phases === '' &&
      (c.operation === 'approve' ? c.approval_id === undefined : digest(c.approval_id))
    );
  if (!digest(c.approval_id) || c.operation !== 'consume-phase') return false;
  return (
    (c.action_id === 'evidence reconcile materialize' &&
      c.initiator === 'inspector' &&
      phases === '01,02') ||
    (c.action_id === 'evidence reconcile stage-proof' &&
      c.initiator === 'inspector' &&
      phases === '03') ||
    (c.action_id === 'sense bootstrap-inventory' && c.initiator === 'architect' && phases === '04')
  );
}

/** Trusted broker constructor. No filesystem capture or mutation occurs here. */
export function createReconciliationHostInvocation(
  controls: ReconciliationInvocationControls,
): object {
  const data = record(controls);
  if (
    !data ||
    REQUIRED.some((key) => !Object.hasOwn(data, key)) ||
    Object.keys(data).some((key) => !REQUIRED.includes(key) && !OPTIONAL.includes(key))
  )
    fail('INVOCATION_INVALID');
  const phases = phaseList(data.phases);
  if (
    !phases ||
    typeof data.invocation_id !== 'string' ||
    !data.invocation_id ||
    typeof data.action_id !== 'string' ||
    typeof data.repository_root !== 'string' ||
    !data.repository_root.startsWith('/') ||
    typeof data.repository_id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(data.repository_id) ||
    !digest(data.original_argv_sha256) ||
    typeof data.write !== 'boolean' ||
    typeof data.require_tty !== 'boolean' ||
    typeof data.readCurrentBindings !== 'function' ||
    typeof data.verifyActual !== 'function'
  )
    fail('INVOCATION_INVALID');
  const issuer = issuerState(data.receipt_store);
  if (!issuer || issuer.closed || issuer.invocation_id !== data.invocation_id)
    fail('INVOCATION_INVALID');
  const copy = Object.freeze({
    ...data,
    phases: Object.freeze([...phases]),
  }) as unknown as ReconciliationInvocationControls;
  if (!matrix(copy)) fail('INVOCATION_INVALID');
  const invocation = Object.freeze({});
  invocations.set(invocation, { controls: copy, active: true });
  return invocation;
}
export function disposeReconciliationHostInvocation(invocation: object): void {
  const state = invocations.get(invocation);
  if (state) state.active = false;
}
function current(
  scope: AuthorityHostEffectScope,
  expected?: object,
): { invocation: object; controls: ReconciliationInvocationControls } {
  const invocation = scope.reconciliation_invocation;
  const state = invocation && invocations.get(invocation);
  if (!invocation || !state?.active || (expected !== undefined && expected !== invocation))
    fail('INVOCATION_INVALID');
  const c = state.controls;
  const issuer = issuerState(c.receipt_store);
  if (
    scope !== scopes.getStore() ||
    scope.action_id !== c.action_id ||
    scope.invocation_id !== c.invocation_id ||
    scope.receipt_store !== c.receipt_store ||
    !issuer ||
    issuer.closed ||
    issuer.invocation_id !== c.invocation_id
  )
    fail('INVOCATION_INVALID');
  try {
    c.verifyActual();
    if (c.require_tty && !(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY))
      fail('INVOCATION_INVALID');
  } catch {
    fail('INVOCATION_INVALID');
  }
  return { invocation, controls: c };
}
export function readReconciliationHostBinding(): Readonly<{
  identity: ReconciliationHostIdentity;
  bindings: ReconciliationInstallationBindings;
  binding_sha256: string;
  clock: ReconciliationClockObservation;
  grants_authority: false;
}> {
  const { controls: c } = current(requireScope('process'));
  const context = captureReconciliationHostContext(c.repository_root, c.repository_id);
  try {
    const b = currentBindings(c);
    return Object.freeze({
      identity: readReconciliationHostIdentity(context),
      bindings: b,
      binding_sha256: sha(b),
      clock: readReconciliationHostClock(context),
      grants_authority: false,
    });
  } finally {
    disposeReconciliationHostContext(context);
  }
}

/** Readonly, synchronous, scope-bound observations; never an effect capability. */
export function withReconciliationHostBindingReader<T>(
  callback: (read: () => ReturnType<typeof readReconciliationHostBinding>) => T,
): T {
  const scope = requireScope('process');
  const { invocation, controls: c } = current(scope);
  const initial = currentBindings(c);
  const context = captureReconciliationHostContext(c.repository_root, c.repository_id);
  let active = true;
  let stale = false;
  const read = (): ReturnType<typeof readReconciliationHostBinding> => {
    try {
      if (!active || stale || requireScope('process') !== scope) fail('OPERATION_STALE');
      current(scope, invocation);
      const bindings = currentBindings(c);
      if (sha(bindings) !== sha(initial)) fail('OPERATION_STALE');
      const observation = readReconciliationHostObservation(context);
      return Object.freeze({
        ...observation,
        bindings,
        binding_sha256: sha(bindings),
        grants_authority: false,
      });
    } catch (error) {
      stale = true;
      throw error;
    }
  };
  try {
    const result = callback(read);
    assertSynchronousResult(result);
    return result;
  } finally {
    active = false;
    disposeReconciliationHostContext(context);
  }
}

/** Exact original-argv selectors from the live broker; data, never an effect token. */
export function readReconciliationPlanSelectors(): Readonly<{
  selected_parent: string;
  published_ref: string;
}> {
  const scope = requireScope('process');
  if (scope.effect !== 'read') fail('INVOCATION_INVALID');
  const { controls } = current(scope);
  if (
    controls.action_id !== 'evidence reconcile plan' ||
    controls.operation !== 'plan' ||
    controls.write ||
    typeof controls.selected_parent !== 'string' ||
    typeof controls.published_ref !== 'string'
  )
    fail('INVOCATION_INVALID');
  return Object.freeze({
    selected_parent: controls.selected_parent,
    published_ref: controls.published_ref,
  });
}

/** Initial Owner review inputs from the original live invocation; data, not permission. */
export function readReconciliationInitialApprovalInput(): Readonly<{
  plan_path: string;
  plan_sha256: string;
}> {
  const scope = requireScope('process');
  const { controls } = current(scope);
  if (
    scope.effect !== 'local-write' ||
    controls.action_id !== 'evidence reconcile approve' ||
    controls.initiator !== 'owner' ||
    controls.operation !== 'approve' ||
    Object.hasOwn(controls, 'approval_id') ||
    !controls.write ||
    !controls.require_tty ||
    typeof controls.plan_path !== 'string' ||
    !digest(controls.plan_sha256)
  )
    fail('INVOCATION_INVALID');
  return Object.freeze({ plan_path: controls.plan_path, plan_sha256: controls.plan_sha256 });
}

/** Existing approval/phase selectors from the actual invocation, never an effect handle. */
export function readReconciliationExistingApprovalInput() {
  const scope = requireScope('process');
  const { controls: c } = current(scope);
  const owner =
    c.action_id === 'evidence reconcile approve' &&
    ['renew', 'revoke', 'recover-owned-lease'].includes(c.operation);
  const phase =
    c.operation === 'consume-phase' &&
    [
      'evidence reconcile materialize',
      'evidence reconcile stage-proof',
      'sense bootstrap-inventory',
    ].includes(c.action_id);
  if (
    scope.effect !== 'local-write' ||
    !c.write ||
    (!owner && !phase) ||
    typeof c.plan_path !== 'string' ||
    !digest(c.plan_sha256) ||
    !digest(c.approval_id)
  )
    fail('INVOCATION_INVALID');
  return Object.freeze({
    action_id: c.action_id,
    operation: c.operation,
    approval_id: c.approval_id,
    plan_path: c.plan_path,
    plan_sha256: c.plan_sha256,
    invocation_sha256: sha({
      invocation_id: c.invocation_id,
      original_argv_sha256: c.original_argv_sha256,
    }),
    ...(c.expected_grant_sha256 !== undefined
      ? { expected_grant_sha256: c.expected_grant_sha256 }
      : {}),
    ...(c.expected_lease_sha256 !== undefined
      ? { expected_lease_sha256: c.expected_lease_sha256 }
      : {}),
  });
}
function eligible(
  target: Target,
  c: ReconciliationInvocationControls,
  identity: ReconciliationHostIdentity,
  b: ReconciliationInstallationBindings,
): boolean {
  if (
    target.repository_id !== c.repository_id ||
    target.worktree_id !== identity.worktree_id ||
    (c.plan_sha256 !== undefined && target.plan_sha256 !== c.plan_sha256) ||
    (c.approval_id !== undefined && target.approval_id !== c.approval_id)
  )
    return false;
  if (target.kind === 'proof-index')
    return (
      c.action_id === 'evidence reconcile stage-proof' &&
      c.operation === 'consume-phase' &&
      c.phases.join(',') === '03'
    );
  return (
    target.operation === c.operation &&
    target.binding_sha256 === sha(b) &&
    (target.operation !== 'consume-phase' || c.phases.includes(target.phase))
  );
}
export function reconciliationHostOperationSnapshot(
  operation: ReconciliationHostOperation,
  expectedInvocation: object,
  target: Target,
): Readonly<Record<string, unknown>> {
  const state = views.get(operation);
  if (!state || state.invocation !== expectedInvocation || scopes.getStore() !== state.scope)
    fail('OPERATION_INVALID');
  if (state.stale) fail('OPERATION_STALE');
  try {
    const { controls: c } = current(state.scope, expectedInvocation);
    if (
      (!isReconciliationHostResourceTarget(target) && !isProofIndexResourceTarget(target)) ||
      sha(target) !== sha(state.target) ||
      sha(currentBindings(c)) !== sha(state.bindings)
    )
      fail('OPERATION_STALE');
    const identity = readReconciliationHostIdentity(state.context);
    checkReconciliationClockWindow(
      state.issued,
      readReconciliationHostClock(state.context),
      'review',
    );
    if (!eligible(state.target, c, identity, state.bindings)) fail('OPERATION_STALE');
    return Object.freeze({
      target_sha256: sha(state.target),
      identity,
      binding_sha256: sha(state.bindings),
      original_argv_sha256: c.original_argv_sha256,
      action_id: c.action_id,
      invocation_id: c.invocation_id,
      initiator: c.initiator,
    });
  } catch {
    state.stale = true;
    fail('OPERATION_STALE');
  }
}
export function reconciliationHostOperation(
  request: AuthorityHostEffectRequest,
  expectedInvocation: object,
): ReconciliationHostOperation | undefined {
  const r = record(request);
  if (
    !r ||
    (r.kind !== 'reconciliation-host' && r.kind !== 'proof-index') ||
    r.symbol !== 'reconciliationHostOperation' ||
    !r.arguments ||
    typeof r.arguments !== 'object' ||
    nodeTypes.isProxy(r.arguments) ||
    !Array.isArray(r.arguments) ||
    r.arguments.length !== 1
  )
    return undefined;
  const d = Object.getOwnPropertyDescriptor(r.arguments, '0');
  if (!d || !Object.hasOwn(d, 'value') || !d.value || typeof d.value !== 'object') return undefined;
  const state = tokens.get(d.value);
  if (
    !state ||
    state.target.kind !== r.kind ||
    state.invocation !== expectedInvocation ||
    scopes.getStore() !== state.scope
  )
    return undefined;
  try {
    reconciliationHostOperationSnapshot(state.view, expectedInvocation, state.target);
    return state.view;
  } catch {
    return undefined;
  }
}
export function invokeReconciliationHostOperation<T>(
  target: Target,
  callback: (
    host: Readonly<{
      paths: ReturnType<typeof readReconciliationHostPaths>;
      identity: ReconciliationHostIdentity;
      bindings: ReconciliationInstallationBindings;
    }>,
  ) => T,
): T {
  const scope = requireScope('mutation');
  const { invocation, controls: c } = current(scope);
  if (
    pending.has(invocation) ||
    !c.write ||
    typeof callback !== 'function' ||
    (!isReconciliationHostResourceTarget(target) && !isProofIndexResourceTarget(target))
  )
    fail('OPERATION_INVALID');
  const copy = Object.freeze({ ...target }) as Target;
  pending.add(invocation);
  let context: ReconciliationHostContext | undefined;
  const token = Object.freeze({});
  let view: ReconciliationHostOperation | undefined;
  try {
    context = captureReconciliationHostContext(c.repository_root, c.repository_id);
    const actualContext = context;
    const b = currentBindings(c);
    const identity = readReconciliationHostIdentity(context);
    if (copy.kind === 'reconciliation-host' && copy.binding_sha256 !== sha(b))
      fail('OPERATION_STALE');
    if (!eligible(copy, c, identity, b)) fail('OPERATION_INVALID');
    view = Object.freeze({
      target: copy,
      action_id: c.action_id,
      invocation_id: c.invocation_id,
      original_argv_sha256: c.original_argv_sha256,
      initiator: c.initiator,
    });
    const state: OperationState = {
      stale: false,
      invocation,
      controls: c,
      scope,
      context,
      bindings: b,
      issued: readReconciliationHostClock(context),
      target: copy,
      view,
    };
    tokens.set(token, state);
    views.set(view, state);
    let applied = false;
    let result: T | undefined;
    scope.apply_effect(
      Object.freeze({
        kind: copy.kind,
        symbol: 'reconciliationHostOperation',
        arguments: Object.freeze([token]),
      }),
      () => {
        if (tokens.get(token) !== state || applied) fail('OPERATION_INVALID');
        reconciliationHostOperationSnapshot(state.view, invocation, copy);
        const host = Object.freeze({
          paths: readReconciliationHostPaths(actualContext),
          identity: readReconciliationHostIdentity(actualContext),
          bindings: b,
        });
        tokens.delete(token);
        views.delete(state.view);
        applied = true;
        result = callback(host);
        assertSynchronousResult(result);
        return result;
      },
    );
    if (!applied) fail('OPERATION_INVALID');
    return result as T;
  } finally {
    tokens.delete(token);
    if (view) views.delete(view);
    if (context) disposeReconciliationHostContext(context);
    pending.delete(invocation);
  }
}
