import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: harness security (F5 × T6). Phase 26.J (closes
 * D-77 sub-batch 26.J). Parses GitHub Actions workflow files under
 * `.github/workflows/*.yml{,.yaml}` and reports security signals:
 *
 *   - `uses: owner/repo@<ref>` lines whose ref is NOT a 40-char SHA
 *     (a moving tag/branch — supply-chain risk).
 *   - `on: pull_request_target:` combined with `actions/checkout`
 *     (the canonical pwn-request CVE pattern).
 *   - Absence of `permissions:` block (defaults to read-write for
 *     legacy repos).
 *
 * Status semantics:
 *   - PASS: no findings.
 *   - REVIEW: any non-critical finding (unpinned action, missing
 *     permissions block).
 *   - FAIL: at least one critical finding (pull_request_target +
 *     checkout, the pwn-request CVE pattern).
 *
 * The sensor uses a simple line scanner — adopting a YAML parser
 * would add a dep but only marginal precision (the patterns we
 * check are line-anchored). The scanner is intentionally
 * conservative: missed signals are acceptable, false positives are
 * not. Adopters can suppress per-workflow via comments if needed
 * (future pack-config); the Phase 26 cut keeps the surface minimal.
 */

export interface HarnessSecurityOptions {
  readonly repoRoot: string;
  /** Default: `.github/workflows`. */
  readonly workflowDir?: string;
  readonly now?: string;
}

const SHA_RE = /^[a-f0-9]{40}$/;
// `uses: owner/repo@ref` (block list), permissive of leading whitespace.
const USES_RE = /^\s*-?\s*uses:\s*([^\s@'"]+)@([^\s'"]+)/;

import type { Stats } from 'node:fs';

function safeStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function listYamlFiles(dir: string): string[] {
  const st = safeStat(dir);
  if (st === null || !st.isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => join(dir, f))
    .sort();
}

interface WorkflowFindings {
  readonly file: string;
  readonly unpinnedActions: ReadonlyArray<{ readonly line: number; readonly ref: string }>;
  readonly missingPermissionsBlock: boolean;
  readonly pullRequestTargetWithCheckout: boolean;
}

function scanWorkflow(content: string): Omit<WorkflowFindings, 'file'> {
  const lines = content.split('\n');
  const unpinned: Array<{ line: number; ref: string }> = [];
  let hasPermissionsBlock = false;
  let hasPullRequestTarget = false;
  let hasCheckout = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] ?? '';
    const m = ln.match(USES_RE);
    if (m !== null) {
      const owner = m[1] ?? '';
      const ref = m[2] ?? '';
      // Local actions like `./.github/actions/foo` are fine (no `@`).
      if (owner.length > 0 && !owner.startsWith('./') && !SHA_RE.test(ref)) {
        unpinned.push({ line: i + 1, ref: `${owner}@${ref}` });
      }
      if (owner === 'actions/checkout') hasCheckout = true;
    }
    if (/^\s*permissions:/.test(ln)) hasPermissionsBlock = true;
    if (/^\s*pull_request_target\s*:/.test(ln) || /^\s*-\s*pull_request_target\s*$/.test(ln)) {
      hasPullRequestTarget = true;
    }
  }
  return {
    unpinnedActions: unpinned,
    missingPermissionsBlock: !hasPermissionsBlock,
    pullRequestTargetWithCheckout: hasPullRequestTarget && hasCheckout,
  };
}

export function senseHarnessSecurity(opts: HarnessSecurityOptions): {
  reading: SensorReading;
  perFile: readonly WorkflowFindings[];
} {
  const dir = isAbsolute(opts.workflowDir ?? '.github/workflows')
    ? (opts.workflowDir ?? '.github/workflows')
    : resolve(opts.repoRoot, opts.workflowDir ?? '.github/workflows');
  const files = listYamlFiles(dir);

  const perFile: WorkflowFindings[] = [];
  const findings: SensorFinding[] = [];
  let unpinnedCount = 0;
  let missingPermissionsCount = 0;
  let pwnRequestCount = 0;

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const scan = scanWorkflow(content);
    const rel = file.replace(`${opts.repoRoot}/`, '');
    perFile.push({ file: rel, ...scan });
    for (const u of scan.unpinnedActions) {
      unpinnedCount += 1;
      findings.push({
        severity: 'warning',
        code: 'HARNESS_SECURITY_UNPINNED_ACTION',
        message: `Action used without SHA pin: ${u.ref}`,
        file: rel,
        line: u.line,
      });
    }
    if (scan.missingPermissionsBlock) {
      missingPermissionsCount += 1;
      findings.push({
        severity: 'warning',
        code: 'HARNESS_SECURITY_MISSING_PERMISSIONS',
        message: `Workflow has no top-level permissions block (defaults to repo-wide write).`,
        file: rel,
      });
    }
    if (scan.pullRequestTargetWithCheckout) {
      pwnRequestCount += 1;
      findings.push({
        severity: 'critical',
        code: 'HARNESS_SECURITY_PWN_REQUEST_PATTERN',
        message: `pull_request_target + actions/checkout in same workflow: pwn-request CVE pattern.`,
        file: rel,
      });
    }
  }

  let status: SensorStatus;
  if (files.length === 0) {
    // No workflows to scan; treat as REVIEW (the harness substrate
    // is absent) — adopters running zero CI is a discipline signal,
    // not a security pass.
    status = 'review';
    findings.push({
      severity: 'info',
      code: 'HARNESS_SECURITY_NO_WORKFLOWS',
      message: `No workflows found at ${dir}.`,
    });
  } else if (pwnRequestCount > 0) {
    status = 'fail';
  } else if (unpinnedCount > 0 || missingPermissionsCount > 0) {
    status = 'review';
  } else {
    status = 'pass';
  }

  const reading = buildSensorReading({
    sensorName: 'harness-security',
    sensorKind: 'harness_security',
    command: ['devai', 'sense-harness-security'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      workflow_count: files.length,
      unpinned_action_count: unpinnedCount,
      missing_permissions_block_count: missingPermissionsCount,
      pwn_request_count: pwnRequestCount,
    },
  });
  return { reading, perFile };
}
