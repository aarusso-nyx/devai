import { existsSync, readFileSync } from 'node:fs';
import { CANONICAL_FORBIDDEN_ACTIONS, type ForbiddenActionEntry } from './catalog.js';
import { hasValidPatterns } from './patterns.js';
export { scanForbiddenActions } from './scan.js';
export type { ForbiddenActionFinding, ScanForbiddenOptions, ScanForbiddenResult } from './scan.js';

export type {
  ForbiddenActionAuthorization,
  ForbiddenActionAuthorizationSummary,
} from './authorizations.js';

export { CANONICAL_FORBIDDEN_ACTIONS } from './catalog.js';
export type { ForbiddenActionEntry } from './catalog.js';

export interface ForbiddenActionWaiver {
  readonly id: string;
  readonly reason: string;
}

export function loadForbiddenRegistry(path: string): ForbiddenActionEntry[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { actions?: ForbiddenActionEntry[] };
    return parsed.actions ?? [];
  } catch {
    return [];
  }
}

export function loadForbiddenWaivers(path: string): ForbiddenActionWaiver[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { waivers?: unknown };
    if (!Array.isArray(parsed.waivers)) return [];
    return parsed.waivers.filter((value): value is ForbiddenActionWaiver => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const waiver = value as Record<string, unknown>;
      return (
        typeof waiver['id'] === 'string' &&
        /^FORBID-[A-Z][A-Z0-9_-]*$/.test(waiver['id']) &&
        typeof waiver['reason'] === 'string' &&
        [...waiver['reason']].length >= 8 &&
        Object.keys(waiver).every((key) => key === 'id' || key === 'reason')
      );
    });
  } catch {
    return [];
  }
}

export interface ForbiddenCoverageResult {
  readonly canonical_total: number;
  readonly present: readonly string[];
  readonly waived: readonly ForbiddenActionWaiver[];
  /** Canonical ids absent from `actions` AND absent from `waivers` — the real gap. */
  readonly unwaived_missing: readonly string[];
  readonly ok: boolean;
}

/**
 * D-123 (item 6): compares a repo's actual registry against
 * `CANONICAL_FORBIDDEN_ACTIONS`. A canonical id can be absent for two
 * reasons: it was silently dropped (a gap `devai check
 * forbidden-actions` should surface), or it was explicitly waived
 * with a reason (a repo's own governed choice, not a gap). Extending
 * the registry with client-specific entries never affects this check
 * — only the canonical set's own coverage is measured.
 */
export function checkForbiddenRegistryCoverage(registryPath: string): ForbiddenCoverageResult {
  const registry = loadForbiddenRegistry(registryPath);
  const waivers = loadForbiddenWaivers(registryPath);
  const presentIds = new Set(
    registry
      .filter(
        (entry) =>
          hasValidPatterns(entry.detect_patterns, true) &&
          hasValidPatterns(entry.allowed_change_line_patterns, false),
      )
      .map((entry) => entry.id),
  );
  const waivedIds = new Set(waivers.map((w) => w.id));
  const present = CANONICAL_FORBIDDEN_ACTIONS.filter((e) => presentIds.has(e.id)).map((e) => e.id);
  const unwaivedMissing = CANONICAL_FORBIDDEN_ACTIONS.filter(
    (e) => !presentIds.has(e.id) && !waivedIds.has(e.id),
  ).map((e) => e.id);
  const waived = waivers.filter((w) => CANONICAL_FORBIDDEN_ACTIONS.some((e) => e.id === w.id));
  return {
    canonical_total: CANONICAL_FORBIDDEN_ACTIONS.length,
    present,
    waived,
    unwaived_missing: unwaivedMissing,
    ok: unwaivedMissing.length === 0,
  };
}
