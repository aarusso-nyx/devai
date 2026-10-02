import { spawnSync } from '@devai-nyx/authority';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: security scan (F2 × T6). Phase 30.G (closes S-1).
 *
 * Wraps adopter package-manager audit:
 * - `pnpm audit --json` (preferred per D-85 ambiguous-decision lock)
 * - falls back to `npm audit --json` if pnpm not available
 * - emits `status: unknown` with reason `no-audit-tool` if neither
 *   is present (the standard graceful-degradation contract per
 *   INV-DEVAI-012 from Phase 30 lane C)
 *
 * Parses the audit output, sums vulnerabilities by severity, and
 * grades against pack-configurable thresholds.
 */

export interface SecurityScanOptions {
  readonly repoRoot: string;
  readonly thresholds?: { readonly passMaxHigh: number; readonly reviewMaxHigh: number };
  readonly preferredTool?: 'pnpm' | 'npm';
  readonly now?: string;
}

const DEFAULT_THRESHOLDS = { passMaxHigh: 0, reviewMaxHigh: 5 } as const;

interface AdvisorySummary {
  readonly critical: number;
  readonly high: number;
  readonly moderate: number;
  readonly low: number;
  readonly info: number;
}

const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info'] as const;
type AuditTool = 'pnpm' | 'npm';
type AuditResult =
  | { ok: true; summary: AdvisorySummary; tool: AuditTool; exitCode: number }
  | { ok: false; reason: string; detail?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSeverity(value: unknown): value is (typeof SEVERITIES)[number] {
  return SEVERITIES.some((severity) => severity === value);
}

function total(summary: AdvisorySummary): number {
  return SEVERITIES.reduce((sum, severity) => sum + summary[severity], 0);
}

/** Validate evidence before grading; absence is never a zero population. */
function summarise(audit: unknown): AdvisorySummary {
  if (!isRecord(audit) || Object.hasOwn(audit, 'error')) {
    throw new Error('audit is not a completed report');
  }
  const counts = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
  const metadata = audit['metadata'];
  const reported = isRecord(metadata) ? metadata['vulnerabilities'] : undefined;
  let summary: AdvisorySummary | undefined;
  if (isRecord(reported)) {
    for (const severity of SEVERITIES) {
      const count = reported[severity];
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
        throw new Error(`invalid or missing ${severity} count`);
      }
      counts[severity] = count;
    }
    if (!Number.isSafeInteger(total(counts))) throw new Error('invalid total count');
    if (Object.hasOwn(reported, 'total') && reported['total'] !== total(counts)) {
      throw new Error('inconsistent total count');
    }
    summary = counts;
  } else if (Array.isArray(reported)) {
    throw new Error('severity summary must be an object');
  }

  // npm audit v2 uses a package-keyed map. Validate every member even when
  // metadata exists, so malformed or contradictory evidence cannot be hidden.
  if (Object.hasOwn(audit, 'vulnerabilities')) {
    const vulnerabilities = audit['vulnerabilities'];
    if (!isRecord(vulnerabilities)) throw new Error('invalid npm vulnerability map');
    const npmCounts = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
    for (const member of Object.values(vulnerabilities)) {
      if (!isRecord(member) || !isSeverity(member['severity'])) {
        throw new Error('invalid npm vulnerability member');
      }
      npmCounts[member['severity']] += 1;
    }
    const metadataSummary = summary;
    if (
      metadataSummary !== undefined &&
      SEVERITIES.some((s) => metadataSummary[s] !== npmCounts[s])
    ) {
      throw new Error('metadata and npm population disagree');
    }
    summary = npmCounts;
  }
  if (summary === undefined) throw new Error('missing complete audit population');

  // pnpm metadata counts findings, which can exceed the number of advisory
  // entries. Every declared advisory must still be represented in the summary.
  if (Object.hasOwn(audit, 'advisories')) {
    const advisories = audit['advisories'];
    if (!isRecord(advisories)) throw new Error('invalid pnpm advisory map');
    const minimum = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
    for (const member of Object.values(advisories)) {
      if (!isRecord(member) || !isSeverity(member['severity'])) {
        throw new Error('invalid pnpm advisory member');
      }
      minimum[member['severity']] += 1;
    }
    if (SEVERITIES.some((s) => summary[s] < minimum[s])) {
      throw new Error('metadata omits declared pnpm advisories');
    }
  }
  return summary;
}

function runAudit(tool: AuditTool, cwd: string): AuditResult {
  const args = ['audit', '--json'];
  try {
    const r = spawnSync(tool, args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env },
      timeout: 60_000,
    });
    if (r.error !== undefined) {
      const err = r.error as NodeJS.ErrnoException;
      return {
        ok: false,
        reason: err.code === 'ENOENT' ? `${tool}-not-on-path` : `${tool}-error: ${err.message}`,
        detail: err.message,
      };
    }
    if (r.signal !== null && r.signal !== undefined) {
      return { ok: false, reason: `${tool}-signal: ${r.signal}` };
    }
    if (r.status !== 0 && r.status !== 1) {
      return { ok: false, reason: `${tool}-incomplete-exit: ${String(r.status)}` };
    }
    const stdout = r.stdout ?? '';
    if (stdout.trim().length === 0) return { ok: false, reason: `${tool}-empty-output` };
    let audit: unknown;
    try {
      audit = JSON.parse(stdout) as unknown;
    } catch (e) {
      return {
        ok: false,
        reason: `${tool}-parse-error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const summary = summarise(audit);
    // A completed default audit exits 1 for findings and 0 for a clean report.
    // Other exits, or a contradictory status, are failures to observe.
    if ((r.status === 1) !== total(summary) > 0) {
      return { ok: false, reason: `${tool}-incoherent-exit: ${String(r.status)}` };
    }
    return { ok: true, summary, tool, exitCode: r.status };
  } catch (e) {
    return {
      ok: false,
      reason: `${tool}-invalid-evidence: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function failedAuditFinding(result: Extract<AuditResult, { ok: false }>): SensorFinding {
  return {
    severity: 'info',
    code: 'SECURITY_SCAN_PREFERRED_AUDIT_FAILED',
    message: `${result.reason}${result.detail === undefined ? '' : `: ${result.detail}`}`,
  };
}

export function senseSecurityScan(opts: SecurityScanOptions): SensorReading {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const preferred = opts.preferredTool ?? 'pnpm';
  const fallback = preferred === 'pnpm' ? 'npm' : 'pnpm';

  const preferredResult = runAudit(preferred, opts.repoRoot);
  const result = preferredResult.ok ? preferredResult : runAudit(fallback, opts.repoRoot);

  if (!result.ok) {
    return buildSensorReading({
      sensorName: 'security-scan',
      sensorKind: 'security_scan',
      command: [preferred, 'audit', '--json'],
      status: 'unknown',
      deterministic: false,
      tier: 'L0',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'info',
          code: 'SECURITY_SCAN_NO_AUDIT_TOOL',
          message: `Neither pnpm nor npm available: ${result.reason}`,
        },
        ...(!preferredResult.ok ? [failedAuditFinding(preferredResult)] : []),
      ],
      metrics: { tools_tried: 2 },
    });
  }

  const usedTool = result.tool;
  const summary = result.summary;
  const totalVulns =
    summary.critical + summary.high + summary.moderate + summary.low + summary.info;
  let status: SensorStatus;
  const findings: SensorFinding[] = [];
  if (summary.critical > 0) {
    status = 'fail';
    findings.push({
      severity: 'critical',
      code: 'SECURITY_SCAN_CRITICAL_VULN',
      message: `${String(summary.critical)} critical vulnerabilit${summary.critical === 1 ? 'y' : 'ies'} detected.`,
    });
  } else if (summary.high > thresholds.reviewMaxHigh) {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'SECURITY_SCAN_HIGH_OVER_THRESHOLD',
      message: `${String(summary.high)} high-severity vulnerabilities exceed REVIEW threshold ${String(thresholds.reviewMaxHigh)}.`,
    });
  } else if (summary.high > thresholds.passMaxHigh) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'SECURITY_SCAN_HIGH_PRESENT',
      message: `${String(summary.high)} high-severity vulnerabilit${summary.high === 1 ? 'y' : 'ies'} (above PASS threshold ${String(thresholds.passMaxHigh)}).`,
    });
  } else {
    status = 'pass';
  }

  if (!preferredResult.ok) findings.push(failedAuditFinding(preferredResult));

  return buildSensorReading({
    sensorName: 'security-scan',
    sensorKind: 'security_scan',
    command: [usedTool, 'audit', '--json'],
    exit_code: result.exitCode,
    status,
    deterministic: false,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      tool: usedTool,
      total_vulnerabilities: totalVulns,
      critical: summary.critical,
      high: summary.high,
      moderate: summary.moderate,
      low: summary.low,
      info: summary.info,
      pass_max_high: thresholds.passMaxHigh,
      review_max_high: thresholds.reviewMaxHigh,
    },
  });
}
