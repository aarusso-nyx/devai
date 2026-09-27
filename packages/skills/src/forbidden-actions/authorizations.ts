import { validateAdrs } from '@devai-nyx/spec';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
