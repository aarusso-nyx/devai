import type { AuthorityContext, AuthorityPolicyProvenance, HumanPrincipal } from '../types.js';

// Dynamic validated documents are deliberately accessed through their compiled runtime views.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRecord = Record<string, any>;
export type FailureCategory = 'usage-error' | 'refused' | 'dependency-error';
export type AuthorityFailure = Readonly<{
  ok: false;
  category: FailureCategory;
  code: string;
  reasons: readonly string[];
}>;
export type AuthoritySuccess<T> = Readonly<{ ok: true; value: T }>;
export type AuthorityResult<T> = AuthoritySuccess<T> | AuthorityFailure;

export function deepFreeze<T>(value: T): T {
  if (ArrayBuffer.isView(value)) return value;
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as AnyRecord)) deepFreeze(item);
  }
  return value;
}

export function success<T>(value: T): AuthoritySuccess<T> {
  return deepFreeze({ ok: true as const, value });
}

export function failure(category: FailureCategory, code: string, reason = code): AuthorityFailure {
  return deepFreeze({ ok: false as const, category, code, reasons: [reason] });
}

export function isRecord(value: unknown): value is AnyRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => equal(value, b[index]))
    );
  }
  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) return false;
    const left = Object.keys(a).sort();
    const right = Object.keys(b).sort();
    return (
      left.length === right.length &&
      left.every((key, index) => key === right[index] && equal(a[key], b[key]))
    );
  }
  return false;
}

export function validInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export interface DeclarationRecord {
  action_id: string;
  action_effect: string;
  invocation_id: string;
  dry_run: boolean;
  repository_id: string;
  policy: AuthorityPolicyProvenance;
  constitution: unknown;
  package: unknown;
  consent: AnyRecord;
  principal: HumanPrincipal;
  action_contract: unknown;
  used: boolean;
}

export interface ContextRecord {
  action_id: string;
  action_effect: string;
  invocation_id: string;
  repository_id: string;
  policy: AuthorityPolicyProvenance;
  consent: AnyRecord;
  context: AuthorityContext | null;
  subject: unknown;
  closed: boolean;
}

export interface MaterializationRecord {
  action_id: string;
  invocation_id: string;
  repository_id: string;
  target_operation: string;
  consent: AnyRecord;
  principal: HumanPrincipal;
  context_receipt: object;
  package: unknown;
  constitution: unknown;
  immutableCore: unknown;
  additiveExtensions: unknown;
  used: boolean;
}

export interface ResolutionRecord {
  owner: object;
  policy: unknown;
  policy_digest: string;
  query_digest: string;
  target_id: string;
  query: AnyRecord;
  context_receipt: object;
  outcome: 'allow' | 'deny';
}

export interface DecisionReceiptRecord {
  owner: object;
  subject: unknown;
  subject_digest: string;
  invocation_id: string;
  adapter_id: string;
  context_digest: string;
  decision: AnyRecord;
  expires_at: number;
  used: boolean;
}

export interface IssuerState {
  issuer: object;
  issuer_id: string;
  issuer_version: string;
  invocation_id: string;
  canonicalSha256: (value: unknown) => string;
  randomId: () => string;
  now: () => string;
  ttl: number;
  closed: boolean;
  declarations: WeakMap<object, DeclarationRecord>;
  contexts: WeakMap<object, ContextRecord>;
  materializations: WeakMap<object, MaterializationRecord>;
  decisions: WeakMap<object, DecisionReceiptRecord>;
  activeContexts: Set<object>;
}

const issuers = new WeakMap<object, IssuerState>();
export const declarationOwners = new WeakMap<object, IssuerState>();
export const contextOwners = new WeakMap<object, IssuerState>();
export const materializationOwners = new WeakMap<object, IssuerState>();
export const resolutionRecords = new WeakMap<object, ResolutionRecord>();
export const decisionOwners = new WeakMap<object, IssuerState>();

export function registerIssuer(issuer: object, state: IssuerState): void {
  issuers.set(issuer, state);
}

export function issuerState(value: unknown): IssuerState | undefined {
  return value !== null && typeof value === 'object' ? issuers.get(value) : undefined;
}

export function opaque(): object {
  return deepFreeze(Object.create(null) as object);
}

export function issueContext(state: IssuerState, record: ContextRecord): object {
  const receipt = opaque();
  state.contexts.set(receipt, record);
  state.activeContexts.add(receipt);
  contextOwners.set(receipt, state);
  return receipt;
}

export function closeContext(state: IssuerState, receipt: object): void {
  const record = state.contexts.get(receipt);
  if (record) record.closed = true;
  state.activeContexts.delete(receipt);
}

export function actionDocument(registry: unknown, actionId: string): AnyRecord | undefined {
  if (!isRecord(registry) || typeof registry.get !== 'function') return undefined;
  const document = registry.get(actionId);
  if (!isRecord(document) || !isRecord(document.view)) return undefined;
  return document;
}
