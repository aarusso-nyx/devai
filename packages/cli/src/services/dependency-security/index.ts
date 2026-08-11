export type DependencySeverity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

export interface DependencyScannerIdentity {
  readonly name: string;
  readonly version: string;
}

export interface DependencyAdvisory {
  readonly id: string;
  readonly package: string;
  readonly severity: DependencySeverity;
  readonly affected_range: string;
  readonly fixed_versions: readonly string[];
  readonly aliases: readonly string[];
}

export interface DependencyWaiver {
  readonly advisory_id: string;
  readonly package: string;
  readonly reason: string;
  readonly approved_by: string;
  readonly expires_at: string;
}

export type DependencySecurityFindingCode =
  | 'DEPENDENCY_RESULT_MALFORMED'
  | 'DEPENDENCY_SCANNER_UNPINNED'
  | 'DEPENDENCY_SCANNER_UNAVAILABLE'
  | 'DEPENDENCY_LOCKFILE_MISMATCH'
  | 'DEPENDENCY_DATABASE_STALE'
  | 'DEPENDENCY_DATABASE_TIME_INVALID'
  | 'DEPENDENCY_SCAN_TIME_INVALID'
  | 'DEPENDENCY_WAIVER_INVALID'
  | 'DEPENDENCY_WAIVER_UNKNOWN'
  | 'DEPENDENCY_WAIVER_PACKAGE_MISMATCH'
  | 'DEPENDENCY_WAIVER_EXPIRED'
  | 'DEPENDENCY_ADVISORY_HIGH'
  | 'DEPENDENCY_ADVISORY_CRITICAL'
  | 'DEPENDENCY_ADVISORY_REVIEW';

export interface DependencySecurityFinding {
  readonly code: DependencySecurityFindingCode;
  readonly message: string;
  readonly advisory_id?: string;
  readonly package?: string;
  readonly severity?: DependencySeverity;
}

export interface DependencySecurityResult {
  readonly schemaVersion: '1.0.0';
  readonly status: 'pass' | 'review' | 'fail' | 'unknown';
  readonly scanner?: DependencyScannerIdentity & {
    readonly database_updated_at: string;
    readonly database_timestamp_basis?: 'successful_registry_query_observed_at';
  };
  readonly generated_at?: string;
  readonly lockfile_sha256?: string;
  readonly advisories: readonly DependencyAdvisory[];
  readonly applied_waivers: readonly DependencyWaiver[];
  readonly findings: readonly DependencySecurityFinding[];
  readonly counts: Readonly<Record<DependencySeverity, number>>;
}

export interface EvaluateDependencySecurityOptions {
  readonly expectedScanner: DependencyScannerIdentity;
  readonly expectedLockfileSha256: string;
  readonly now: string;
  readonly maxDatabaseAgeHours: number;
}

const SHA256 = /^[a-f0-9]{64}$/;
const SEVERITIES = new Set<DependencySeverity>(['info', 'low', 'moderate', 'high', 'critical']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function parseAdvisory(value: unknown): DependencyAdvisory | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== 'string' ||
    value.id.trim().length === 0 ||
    typeof value.package !== 'string' ||
    value.package.trim().length === 0 ||
    typeof value.severity !== 'string' ||
    !SEVERITIES.has(value.severity as DependencySeverity) ||
    typeof value.affected_range !== 'string' ||
    !isStringArray(value.fixed_versions) ||
    !isStringArray(value.aliases)
  ) {
    return undefined;
  }
  return {
    id: value.id,
    package: value.package,
    severity: value.severity as DependencySeverity,
    affected_range: value.affected_range,
    fixed_versions: value.fixed_versions,
    aliases: value.aliases,
  };
}

function parseWaiver(value: unknown): DependencyWaiver | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.advisory_id !== 'string' ||
    value.advisory_id.trim().length === 0 ||
    typeof value.package !== 'string' ||
    value.package.trim().length === 0 ||
    typeof value.reason !== 'string' ||
    value.reason.trim().length === 0 ||
    typeof value.approved_by !== 'string' ||
    value.approved_by.trim().length === 0 ||
    !isTimestamp(value.expires_at)
  ) {
    return undefined;
  }
  return {
    advisory_id: value.advisory_id,
    package: value.package,
    reason: value.reason,
    approved_by: value.approved_by,
    expires_at: value.expires_at,
  };
}

function emptyCounts(): Record<DependencySeverity, number> {
  return { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
}

function malformed(message: string): DependencySecurityResult {
  return {
    schemaVersion: '1.0.0',
    status: 'unknown',
    advisories: [],
    applied_waivers: [],
    findings: [{ code: 'DEPENDENCY_RESULT_MALFORMED', message }],
    counts: emptyCounts(),
  };
}

/**
 * Evaluate one already-normalized dependency scan without network or host effects.
 *
 * Provenance failures are UNKNOWN because the scan cannot be trusted. Advisory
 * and waiver policy violations are FAIL because their inputs are trusted but do
 * not satisfy the binding policy. Low/moderate findings remain REVIEW unless an
 * exact, valid waiver accepts them.
 */
export function evaluateDependencySecurityResult(
  scannerOutput: unknown,
  options: EvaluateDependencySecurityOptions,
): DependencySecurityResult {
  if (
    !isRecord(scannerOutput) ||
    scannerOutput.schemaVersion !== '1.0.0' ||
    !isRecord(scannerOutput.scanner) ||
    typeof scannerOutput.scanner.name !== 'string' ||
    typeof scannerOutput.scanner.version !== 'string' ||
    !isTimestamp(scannerOutput.scanner.database_updated_at) ||
    (scannerOutput.scanner.database_timestamp_basis !== undefined &&
      scannerOutput.scanner.database_timestamp_basis !== 'successful_registry_query_observed_at') ||
    !isTimestamp(scannerOutput.generated_at) ||
    typeof scannerOutput.lockfile_sha256 !== 'string' ||
    !SHA256.test(scannerOutput.lockfile_sha256) ||
    !Array.isArray(scannerOutput.advisories) ||
    (scannerOutput.waivers !== undefined && !Array.isArray(scannerOutput.waivers))
  ) {
    return malformed('scanner output does not match the normalized dependency result contract');
  }

  const advisories = scannerOutput.advisories.map(parseAdvisory);
  if (advisories.some((advisory) => advisory === undefined)) {
    return malformed('one or more advisories are malformed');
  }
  const typedAdvisories = advisories as DependencyAdvisory[];
  if (
    new Set(typedAdvisories.map((advisory) => `${advisory.id}\u0000${advisory.package}`)).size !==
    typedAdvisories.length
  ) {
    return malformed('advisory identifier and package pairs must be unique');
  }
  const rawWaivers = scannerOutput.waivers ?? [];
  const waivers = rawWaivers.map(parseWaiver);

  const scanner = {
    name: scannerOutput.scanner.name,
    version: scannerOutput.scanner.version,
    database_updated_at: scannerOutput.scanner.database_updated_at,
    ...(scannerOutput.scanner.database_timestamp_basis ===
      'successful_registry_query_observed_at' && {
      database_timestamp_basis: 'successful_registry_query_observed_at' as const,
    }),
  };
  const base = {
    schemaVersion: '1.0.0' as const,
    scanner,
    generated_at: scannerOutput.generated_at,
    lockfile_sha256: scannerOutput.lockfile_sha256,
    advisories: typedAdvisories,
  };
  const counts = emptyCounts();
  for (const advisory of typedAdvisories) counts[advisory.severity] += 1;

  if (
    scanner.name !== options.expectedScanner.name ||
    scanner.version !== options.expectedScanner.version
  ) {
    return {
      ...base,
      status: 'unknown',
      applied_waivers: [],
      findings: [
        {
          code: 'DEPENDENCY_SCANNER_UNPINNED',
          message: `expected scanner ${options.expectedScanner.name}@${options.expectedScanner.version}, received ${scanner.name}@${scanner.version}`,
        },
      ],
      counts,
    };
  }
  if (
    !SHA256.test(options.expectedLockfileSha256) ||
    scannerOutput.lockfile_sha256 !== options.expectedLockfileSha256
  ) {
    return {
      ...base,
      status: 'unknown',
      applied_waivers: [],
      findings: [
        {
          code: 'DEPENDENCY_LOCKFILE_MISMATCH',
          message: 'scan lockfile digest does not match the complete evaluated lockfile',
        },
      ],
      counts,
    };
  }

  const now = Date.parse(options.now);
  const databaseUpdatedAt = Date.parse(scanner.database_updated_at);
  const generatedAt = Date.parse(scannerOutput.generated_at);
  if (!Number.isFinite(now) || !Number.isFinite(options.maxDatabaseAgeHours)) {
    return malformed('evaluation time or database freshness bound is invalid');
  }
  const databaseAgeHours = (now - databaseUpdatedAt) / 3_600_000;
  if (generatedAt > now || generatedAt < databaseUpdatedAt) {
    return {
      ...base,
      status: 'unknown',
      applied_waivers: [],
      findings: [
        {
          code: 'DEPENDENCY_SCAN_TIME_INVALID',
          message: 'scan generation time is outside the database-observation and evaluation window',
        },
      ],
      counts,
    };
  }
  if (databaseAgeHours < 0) {
    return {
      ...base,
      status: 'unknown',
      applied_waivers: [],
      findings: [
        {
          code: 'DEPENDENCY_DATABASE_TIME_INVALID',
          message: 'advisory database timestamp is in the future',
        },
      ],
      counts,
    };
  }
  if (databaseAgeHours > options.maxDatabaseAgeHours) {
    return {
      ...base,
      status: 'unknown',
      applied_waivers: [],
      findings: [
        {
          code: 'DEPENDENCY_DATABASE_STALE',
          message: `advisory database is older than ${String(options.maxDatabaseAgeHours)} hours`,
        },
      ],
      counts,
    };
  }

  if (waivers.some((waiver) => waiver === undefined)) {
    return {
      ...base,
      status: 'fail',
      applied_waivers: [],
      findings: [
        {
          code: 'DEPENDENCY_WAIVER_INVALID',
          message:
            'one or more waivers lack an exact advisory, package, reason, approver, or expiry',
        },
      ],
      counts,
    };
  }

  const typedWaivers = waivers as DependencyWaiver[];
  const advisoryByKey = new Map(
    typedAdvisories.map((advisory) => [`${advisory.id}\u0000${advisory.package}`, advisory]),
  );
  const waiverFindings: DependencySecurityFinding[] = [];
  const appliedWaivers: DependencyWaiver[] = [];
  const waivedKeys = new Set<string>();
  for (const waiver of typedWaivers) {
    const advisory = advisoryByKey.get(`${waiver.advisory_id}\u0000${waiver.package}`);
    if (advisory === undefined) {
      const sameId = typedAdvisories.find((candidate) => candidate.id === waiver.advisory_id);
      if (sameId !== undefined) {
        waiverFindings.push({
          code: 'DEPENDENCY_WAIVER_PACKAGE_MISMATCH',
          message: `waiver package ${waiver.package} does not match advisory package ${sameId.package}`,
          advisory_id: waiver.advisory_id,
          package: waiver.package,
        });
        continue;
      }
      waiverFindings.push({
        code: 'DEPENDENCY_WAIVER_UNKNOWN',
        message: `waiver references unknown advisory ${waiver.advisory_id}`,
        advisory_id: waiver.advisory_id,
        package: waiver.package,
      });
      continue;
    }
    if (Date.parse(waiver.expires_at) <= now) {
      waiverFindings.push({
        code: 'DEPENDENCY_WAIVER_EXPIRED',
        message: `waiver for ${waiver.advisory_id} expired at ${waiver.expires_at}`,
        advisory_id: waiver.advisory_id,
        package: waiver.package,
      });
      continue;
    }
    const key = `${waiver.advisory_id}\u0000${waiver.package}`;
    if (waivedKeys.has(key)) {
      waiverFindings.push({
        code: 'DEPENDENCY_WAIVER_INVALID',
        message: `duplicate waiver for ${waiver.advisory_id} and ${waiver.package}`,
        advisory_id: waiver.advisory_id,
        package: waiver.package,
      });
      continue;
    }
    waivedKeys.add(key);
    appliedWaivers.push(waiver);
  }
  if (waiverFindings.length > 0) {
    return {
      ...base,
      status: 'fail',
      applied_waivers: appliedWaivers,
      findings: waiverFindings,
      counts,
    };
  }

  const findings: DependencySecurityFinding[] = [];
  for (const advisory of typedAdvisories) {
    if (waivedKeys.has(`${advisory.id}\u0000${advisory.package}`)) continue;
    if (advisory.severity === 'critical') {
      findings.push({
        code: 'DEPENDENCY_ADVISORY_CRITICAL',
        message: `critical advisory ${advisory.id} affects ${advisory.package}`,
        advisory_id: advisory.id,
        package: advisory.package,
        severity: advisory.severity,
      });
    } else if (advisory.severity === 'high') {
      findings.push({
        code: 'DEPENDENCY_ADVISORY_HIGH',
        message: `high advisory ${advisory.id} affects ${advisory.package}`,
        advisory_id: advisory.id,
        package: advisory.package,
        severity: advisory.severity,
      });
    } else {
      findings.push({
        code: 'DEPENDENCY_ADVISORY_REVIEW',
        message: `${advisory.severity} advisory ${advisory.id} affects ${advisory.package}`,
        advisory_id: advisory.id,
        package: advisory.package,
        severity: advisory.severity,
      });
    }
  }

  const status = findings.some(
    (finding) =>
      finding.code === 'DEPENDENCY_ADVISORY_HIGH' ||
      finding.code === 'DEPENDENCY_ADVISORY_CRITICAL',
  )
    ? 'fail'
    : findings.length > 0
      ? 'review'
      : 'pass';

  return {
    ...base,
    status,
    applied_waivers: appliedWaivers,
    findings,
    counts,
  };
}
