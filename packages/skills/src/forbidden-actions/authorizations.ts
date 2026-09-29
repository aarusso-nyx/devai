import { getValidator, type SchemaName } from '@devai-nyx/schemas';
import { validateAdrs } from '@devai-nyx/spec';
import { canonicalJson } from '@devai-nyx/utils';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ForbiddenActionEntry, ForbiddenMaintenanceExemption } from './catalog.js';

export interface ForbiddenActionAuthorization {
  readonly forbidden_id: string;
  readonly commit: string;
  readonly authorized_by: 'Owner';
  readonly reason: string;
}

export interface ForbiddenActionAuthorizationSummary {
  readonly path: string;
  readonly declared: number;
  readonly applied: readonly string[];
  readonly unused: readonly string[];
}

type AuthorizationLoadResult =
  | { readonly ok: true; readonly receipts: readonly ForbiddenActionAuthorization[] }
  | { readonly ok: false; readonly message: string };

export function loadForbiddenAuthorizations(
  path: string,
  validIds: ReadonlySet<string>,
): AuthorizationLoadResult {
  if (!existsSync(path)) return { ok: true, receipts: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, message: 'authorization receipt bytes are malformed' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'authorization receipt root must be an object' };
  }
  const root = parsed as Record<string, unknown>;
  const allowedRootKeys = new Set(['$schema', 'schemaVersion', 'authorizations']);
  if (
    Object.keys(root).some((key) => !allowedRootKeys.has(key)) ||
    (root.$schema !== undefined && typeof root.$schema !== 'string')
  ) {
    return { ok: false, message: 'authorization receipt root contains an unknown field' };
  }
  if (root.schemaVersion !== '1.0.0' || !Array.isArray(root.authorizations)) {
    return {
      ok: false,
      message: 'authorization receipts require schemaVersion 1.0.0 and an authorizations array',
    };
  }
  const receipts: ForbiddenActionAuthorization[] = [];
  const keys = new Set<string>();
  for (const value of root.authorizations) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, message: 'every authorization receipt must be an object' };
    }
    const receipt = value as Record<string, unknown>;
    const allowedKeys = new Set(['forbidden_id', 'commit', 'authorized_by', 'reason']);
    if (Object.keys(receipt).some((key) => !allowedKeys.has(key))) {
      return { ok: false, message: 'authorization receipts contain an unknown field' };
    }
    const forbiddenId = receipt.forbidden_id;
    const commit = receipt.commit;
    const authorizedBy = receipt.authorized_by;
    const reason = receipt.reason;
    if (typeof forbiddenId !== 'string' || !validIds.has(forbiddenId)) {
      return { ok: false, message: 'authorization receipt names an unknown forbidden action' };
    }
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) {
      return { ok: false, message: 'authorization receipt commit must be a full lowercase SHA' };
    }
    if (authorizedBy !== 'Owner') {
      return { ok: false, message: 'authorization receipt has an invalid human authority' };
    }
    if (typeof reason !== 'string' || reason.trim().length < 8) {
      return { ok: false, message: 'authorization receipt reason is missing or too short' };
    }
    const key = `${forbiddenId}@${commit}`;
    if (keys.has(key)) {
      return { ok: false, message: 'authorization receipts contain a duplicate action and commit' };
    }
    keys.add(key);
    receipts.push({
      forbidden_id: forbiddenId,
      commit,
      authorized_by: authorizedBy,
      reason,
    });
  }
  return { ok: true, receipts };
}

export function activeAdrAffectedRules(repoRoot: string): ReadonlySet<string> {
  const adrDir = join(repoRoot, 'law', 'adr');
  if (!existsSync(adrDir)) return new Set();
  const validation = validateAdrs({ adrsDir: adrDir });
  if (!validation.ok || !validation.semantic_resolution_performed) return new Set();
  const affected = new Set<string>();
  for (const adr of validation.adrs) {
    for (const rule of adr.effective_affected_rules) {
      if (!rule.startsWith('/') && !rule.split('/').includes('..')) affected.add(rule);
    }
  }
  return affected;
}

/** A declared exemption the scanner can enforce: one top-level collection, append-only. */
export interface AppendOnlyMaintenanceExemption {
  readonly path: string;
  readonly schemaName: string;
  readonly collectionKey: string;
}

/**
 * ADR-GOV-0022: read the append-only maintenance exemptions declared on a policy
 * entry. A malformed declaration grants nothing, so the scanner keeps its finding.
 */
export function appendOnlyMaintenanceExemptions(
  entry: ForbiddenActionEntry | undefined,
): readonly AppendOnlyMaintenanceExemption[] {
  const declared: unknown = entry?.maintenance_exemptions;
  if (!Array.isArray(declared)) return [];
  const exemptions: AppendOnlyMaintenanceExemption[] = [];
  for (const value of declared as unknown[]) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const exemption = value as Partial<Record<keyof ForbiddenMaintenanceExemption, unknown>>;
    const { path, schema, change, collection } = exemption;
    if (
      change !== 'append-only' ||
      typeof path !== 'string' ||
      path.length === 0 ||
      path.startsWith('/') ||
      path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
      typeof schema !== 'string' ||
      !schema.endsWith('.schema.json') ||
      typeof collection !== 'string' ||
      !/^\/[^/~]+$/u.test(collection)
    ) {
      continue;
    }
    exemptions.push({ path, schemaName: basename(schema), collectionKey: collection.slice(1) });
  }
  return exemptions;
}

type RegistryDocument = Record<string, unknown>;

function parseRegistryDocument(bytes: string): RegistryDocument | undefined {
  try {
    const parsed: unknown = JSON.parse(bytes);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as RegistryDocument)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify one registry change as append-only maintenance. The child must validate
 * against the runtime's bundled schema (never a schema read from the commit tree),
 * every root member other than the collection must equal the parent's, and the
 * parent collection must equal the child's leading elements in order by canonical
 * JSON. An absent parent (an added file or a root commit) is an empty collection.
 */
export function isAppendOnlyMaintenance(
  exemption: AppendOnlyMaintenanceExemption,
  parentBytes: string | undefined,
  childBytes: string,
): boolean {
  const child = parseRegistryDocument(childBytes);
  if (child === undefined) return false;
  let valid: boolean;
  try {
    valid = getValidator(exemption.schemaName as SchemaName)(child) === true;
  } catch {
    return false;
  }
  if (!valid) return false;
  const childCollection = child[exemption.collectionKey];
  if (!Array.isArray(childCollection)) return false;
  if (parentBytes === undefined) return true;
  const parent = parseRegistryDocument(parentBytes);
  if (parent === undefined) return false;
  const parentCollection = parent[exemption.collectionKey];
  if (!Array.isArray(parentCollection) || parentCollection.length > childCollection.length) {
    return false;
  }
  const withoutCollection = (document: RegistryDocument) =>
    Object.fromEntries(Object.entries(document).filter(([key]) => key !== exemption.collectionKey));
  if (!isDeepStrictEqual(withoutCollection(parent), withoutCollection(child))) return false;
  return parentCollection.every(
    (element, index) => canonicalJson(element) === canonicalJson(childCollection[index]),
  );
}
