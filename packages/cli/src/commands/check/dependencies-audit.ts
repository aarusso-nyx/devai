import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  DependencyAdvisory,
  DependencyScannerIdentity,
  DependencySecurityResult,
  DependencySeverity,
  DependencyWaiver,
} from '#runtime-core';

const WAIVERS_PATH = '.devai/config/dependency-waivers.json';
export const SEVERITIES = new Set<DependencySeverity>([
  'info',
  'low',
  'moderate',
  'high',
  'critical',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidWaivers(message: string): DependencySecurityResult {
  return {
    schemaVersion: '1.0.0',
    status: 'fail',
    advisories: [],
    applied_waivers: [],
    findings: [{ code: 'DEPENDENCY_WAIVER_INVALID', message }],
    counts: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
  };
}

function stableId(value: Record<string, unknown>): string | undefined {
  const url = typeof value.url === 'string' ? value.url : undefined;
  const ghsa = url?.match(/GHSA-[0-9A-Za-z-]+/u)?.[0];
  if (ghsa !== undefined) return ghsa.toUpperCase();
  for (const candidate of [value.github_advisory_id, value.source, value.id]) {
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      const id = String(candidate).trim();
      if (id.length > 0) return id;
    }
  }
  return undefined;
}

function aliases(value: Record<string, unknown>, id: string): string[] {
  const result = new Set<string>();
  for (const field of [value.cves, value.aliases, value.cwe]) {
    if (Array.isArray(field)) {
      for (const alias of field)
        if (typeof alias === 'string' && alias.length > 0) result.add(alias);
    }
  }
  const url = typeof value.url === 'string' ? value.url : '';
  const ghsa = url.match(/GHSA-[0-9A-Za-z-]+/u)?.[0]?.toUpperCase();
  if (ghsa !== undefined && ghsa !== id) result.add(ghsa);
  return Array.from(result).sort();
}

function severity(value: unknown): DependencySeverity | undefined {
  return typeof value === 'string' && SEVERITIES.has(value as DependencySeverity)
    ? (value as DependencySeverity)
    : undefined;
}

function classicAdvisory(value: unknown): DependencyAdvisory | undefined {
  if (!isRecord(value)) return undefined;
  const id = stableId(value);
  const packageName = typeof value.module_name === 'string' ? value.module_name : undefined;
  const advisorySeverity = severity(value.severity);
  const affectedRange =
    typeof value.vulnerable_versions === 'string' ? value.vulnerable_versions : undefined;
  if (
    id === undefined ||
    packageName === undefined ||
    advisorySeverity === undefined ||
    affectedRange === undefined
  ) {
    return undefined;
  }
  const patched = typeof value.patched_versions === 'string' ? value.patched_versions.trim() : '';
  return {
    id,
    package: packageName,
    severity: advisorySeverity,
    affected_range: affectedRange,
    fixed_versions: patched.length > 0 && patched !== '<0.0.0' ? [patched] : [],
    aliases: aliases(value, id),
  };
}

function modernAdvisories(raw: Record<string, unknown>): DependencyAdvisory[] | undefined {
  if (!isRecord(raw.vulnerabilities)) return undefined;
  const vulnerabilities = raw.vulnerabilities;
  const output: DependencyAdvisory[] = [];
  for (const [packageKey, vulnerabilityValue] of Object.entries(vulnerabilities)) {
    if (!isRecord(vulnerabilityValue) || !Array.isArray(vulnerabilityValue.via)) return undefined;
    const packageName =
      typeof vulnerabilityValue.name === 'string' ? vulnerabilityValue.name : packageKey;
    const fallbackSeverity = severity(vulnerabilityValue.severity);
    const fallbackRange =
      typeof vulnerabilityValue.range === 'string' ? vulnerabilityValue.range : undefined;
    const fixedVersions =
      isRecord(vulnerabilityValue.fixAvailable) &&
      typeof vulnerabilityValue.fixAvailable.version === 'string'
        ? [vulnerabilityValue.fixAvailable.version]
        : [];
    for (const via of vulnerabilityValue.via) {
      if (typeof via === 'string') {
        if (!Object.hasOwn(vulnerabilities, via)) return undefined;
        continue;
      }
      if (!isRecord(via)) return undefined;
      const id = stableId(via);
      const advisorySeverity = severity(via.severity) ?? fallbackSeverity;
      const affectedRange = typeof via.range === 'string' ? via.range : fallbackRange;
      if (id === undefined || advisorySeverity === undefined || affectedRange === undefined) {
        return undefined;
      }
      output.push({
        id,
        package: typeof via.dependency === 'string' ? via.dependency : packageName,
        severity: advisorySeverity,
        affected_range: affectedRange,
        fixed_versions: fixedVersions,
        aliases: aliases(via, id),
      });
    }
  }
  return output;
}

function auditCount(raw: Record<string, unknown>): number | undefined {
  if (!isRecord(raw.metadata) || !isRecord(raw.metadata.vulnerabilities)) return undefined;
  let total = 0;
  for (const level of SEVERITIES) {
    const count = raw.metadata.vulnerabilities[level];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return undefined;
    total += count;
  }
  return total;
}

export function normalizeAudit(
  raw: unknown,
  observedAt: string,
  lockfileSha256: string,
  waivers: readonly DependencyWaiver[],
  scanner: DependencyScannerIdentity,
): unknown {
  if (!isRecord(raw)) return raw;
  let advisories: DependencyAdvisory[] | undefined;
  if (isRecord(raw.advisories)) {
    const normalized = Object.values(raw.advisories).map(classicAdvisory);
    if (normalized.some((advisory) => advisory === undefined)) return raw;
    advisories = normalized as DependencyAdvisory[];
  } else {
    advisories = modernAdvisories(raw);
  }
  if (advisories === undefined) return raw;

  const unique = new Map<string, DependencyAdvisory>();
  for (const advisory of advisories) {
    const key = `${advisory.id}\u0000${advisory.package}`;
    const prior = unique.get(key);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(advisory)) return raw;
    unique.set(key, advisory);
  }
  const declaredCount = auditCount(raw);
  if (
    declaredCount === undefined ||
    (declaredCount > 0 && unique.size === 0) ||
    (declaredCount === 0 && unique.size > 0)
  ) {
    return raw;
  }

  return {
    schemaVersion: '1.0.0',
    scanner: {
      ...scanner,
      database_updated_at: observedAt,
      database_timestamp_basis: 'successful_registry_query_observed_at',
    },
    generated_at: observedAt,
    lockfile_sha256: lockfileSha256,
    advisories: Array.from(unique.values()).sort((a, b) =>
      `${a.id}\u0000${a.package}`.localeCompare(`${b.id}\u0000${b.package}`),
    ),
    waivers,
  };
}

type LoadWaiversResult =
  | { readonly ok: true; readonly waivers: readonly DependencyWaiver[] }
  | { readonly ok: false; readonly result: DependencySecurityResult };

export function loadWaivers(repoRoot: string): LoadWaiversResult {
  const path = resolve(repoRoot, WAIVERS_PATH);
  if (!existsSync(path)) return { ok: true, waivers: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    return {
      ok: false,
      result: invalidWaivers(
        `cannot parse ${WAIVERS_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
  const waivers = Array.isArray(raw) ? raw : isRecord(raw) ? raw.waivers : undefined;
  if (!Array.isArray(waivers)) {
    return {
      ok: false,
      result: invalidWaivers(`${WAIVERS_PATH} must contain a waivers array`),
    };
  }
  return { ok: true, waivers: waivers as DependencyWaiver[] };
}
