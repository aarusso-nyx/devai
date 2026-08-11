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

function runAudit(
  tool: 'pnpm' | 'npm',
  cwd: string,
): { ok: true; data: unknown; tool: 'pnpm' | 'npm' } | { ok: false; reason: string } {
  const args = ['audit', '--json'];
  const r = spawnSync(tool, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 60_000,
  });
  if (r.error !== undefined) {
    const err = r.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { ok: false, reason: `${tool}-not-on-path` };
    return { ok: false, reason: `${tool}-error: ${err.message}` };
  }
  // pnpm + npm audit exit with code 1 if vulnerabilities are found,
  // but the JSON is still emitted on stdout. Don't reject non-zero.
  const stdout = r.stdout ?? '';
  if (stdout.trim().length === 0) {
    return { ok: false, reason: `${tool}-empty-output` };
  }
  try {
    return { ok: true, data: JSON.parse(stdout), tool };
  } catch (e) {
    return {
      ok: false,
      reason: `${tool}-parse-error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Both pnpm and npm emit JSON with a top-level structure that
 * carries vulnerability counts. Schemas differ slightly across
 * tool + version; we look for common fields and degrade gracefully.
 */
function summarise(audit: unknown): AdvisorySummary {
  const blank: AdvisorySummary = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
  if (audit === null || typeof audit !== 'object') return blank;
  const root = audit as Record<string, unknown>;
  // pnpm audit JSON shape: { advisories: {<id>: { severity }}, metadata: { vulnerabilities: {...} } }
  const metadata = root['metadata'];
  if (metadata !== null && typeof metadata === 'object') {
    const v = (metadata as Record<string, unknown>)['vulnerabilities'];
    if (v !== null && typeof v === 'object') {
      const r = v as Record<string, unknown>;
      return {
        critical: typeof r['critical'] === 'number' ? (r['critical'] as number) : 0,
        high: typeof r['high'] === 'number' ? (r['high'] as number) : 0,
        moderate: typeof r['moderate'] === 'number' ? (r['moderate'] as number) : 0,
        low: typeof r['low'] === 'number' ? (r['low'] as number) : 0,
        info: typeof r['info'] === 'number' ? (r['info'] as number) : 0,
      };
    }
  }
  // npm-audit v2 fallback: { vulnerabilities: {<name>: { severity }} }
  const vulns = root['vulnerabilities'];
  if (vulns !== null && typeof vulns === 'object') {
    const counts = { ...blank };
    for (const v of Object.values(vulns as Record<string, unknown>)) {
      if (v === null || typeof v !== 'object') continue;
      const sev = (v as Record<string, unknown>)['severity'];
      if (sev === 'critical') counts.critical += 1;
      else if (sev === 'high') counts.high += 1;
      else if (sev === 'moderate') counts.moderate += 1;
      else if (sev === 'low') counts.low += 1;
      else if (sev === 'info') counts.info += 1;
    }
    return counts;
  }
  return blank;
}

export function senseSecurityScan(opts: SecurityScanOptions): SensorReading {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const preferred = opts.preferredTool ?? 'pnpm';
  const fallback = preferred === 'pnpm' ? 'npm' : 'pnpm';

  let result = runAudit(preferred, opts.repoRoot);
  let usedTool: 'pnpm' | 'npm' | null = null;
  if (result.ok) usedTool = result.tool;
  if (!result.ok) {
    result = runAudit(fallback, opts.repoRoot);
    if (result.ok) usedTool = result.tool;
  }

  if (!result.ok || usedTool === null) {
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
          message: `Neither pnpm nor npm available: ${(result as { reason?: string }).reason ?? 'unknown'}`,
        },
      ],
      metrics: { tools_tried: 2 },
    });
  }

  const summary = summarise(result.data);
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

  return buildSensorReading({
    sensorName: 'security-scan',
    sensorKind: 'security_scan',
    command: [usedTool, 'audit', '--json'],
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
