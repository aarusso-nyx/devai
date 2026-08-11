import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * `inv-override` in-source annotation scanner. The annotation format:
 *
 *   // inv-override: INV-XX-NNN
 *   // reason: <one sentence>
 *   // ticket: ENG-1234
 *   // expires: 2026-Q4   (or 2026-12-31)
 *   // approver: @handle
 *   // adr: ADR-001       (optional)
 *
 * Constitutional + hard-fail invariants are NOT overridable — the
 * scanner reports those as errors. Expired overrides are also errors.
 * Malformed annotations (missing required fields, bad date format,
 * unknown invariant id) are reported per-finding so the caller can
 * surface them in CI output.
 */

export interface InvOverrideRecord {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly invariant_id: string;
  readonly file: string;
  readonly line: number;
  readonly reason: string;
  readonly ticket: string;
  readonly expires: string;
  readonly approver: string;
  readonly adr?: string;
  readonly detected_at: string;
}

export interface InvOverrideScanFinding {
  /** 'malformed' | 'expired' | 'unknown-invariant' | 'severity-forbids' */
  readonly code: 'malformed' | 'expired' | 'unknown-invariant' | 'severity-forbids';
  readonly file: string;
  readonly line: number;
  readonly invariant_id?: string;
  readonly message: string;
}

export interface InvOverrideScanResult {
  readonly overrides: readonly InvOverrideRecord[];
  readonly findings: readonly InvOverrideScanFinding[];
}

export interface ScanOptions {
  readonly repoRoot: string;
  /** Roots to scan; defaults to ['packages']. */
  readonly roots?: readonly string[];
  /** Invariant catalog for severity + existence checks. Skip checks if absent. */
  readonly invariants?: ReadonlyMap<string, { readonly severity: string }>;
  /** ISO timestamp used to compare against `expires`. Default: now. */
  readonly now?: Date;
  /** File extensions to scan. Default: ts, tsx, js, jsx, mjs, cjs. */
  readonly extensions?: readonly string[];
}

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const DEFAULT_ROOTS = ['packages'];
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  '.vitest-cache',
  '.devai',
]);
const NON_OVERRIDABLE: ReadonlySet<string> = new Set(['constitutional', 'hard-fail']);

const HEADER_RE = /^\s*\/\/\s*inv-override:\s*(INV-[A-Za-z0-9-]+)\s*$/;
const FIELD_RE = /^\s*\/\/\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.+?)\s*$/;
const EXPIRES_RE = /^[0-9]{4}-(Q[1-4]|(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01]))$/;
const TICKET_RE = /^[A-Z][A-Z0-9_-]*[-#][A-Za-z0-9]+$/;
const APPROVER_RE = /^@[A-Za-z0-9_-]+$/;
const ADR_RE = /^ADR-/;

function recordId(invariantId: string, file: string, line: number, reason: string): string {
  const digest = createHash('sha256')
    .update(`${invariantId}|${file}|${String(line)}|${reason}`)
    .digest('hex');
  return `OVR-${digest.slice(0, 16)}`;
}

function expiresIsPast(expires: string, now: Date): boolean {
  const ym = /^([0-9]{4})-Q([1-4])$/.exec(expires);
  if (ym !== null) {
    const year = Number(ym[1]);
    const q = Number(ym[2]);
    // End of quarter: Q1 → Mar 31, Q2 → Jun 30, Q3 → Sep 30, Q4 → Dec 31.
    const monthEnd = q * 3 - 1; // 2, 5, 8, 11
    const dayEnd = [31, 30, 30, 31][q - 1] ?? 31;
    const end = new Date(Date.UTC(year, monthEnd, dayEnd, 23, 59, 59));
    return now > end;
  }
  const dm = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(expires);
  if (dm !== null) {
    const end = new Date(Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), 23, 59, 59));
    return now > end;
  }
  return true; // malformed treated as past
}

/**
 * Parse an annotation block starting at a given line. Returns null when
 * the line does not begin an `inv-override` block. On structural
 * problems, returns a finding instead of a record.
 */
function parseBlockAt(
  fileRel: string,
  lines: readonly string[],
  startIdx: number,
): { record: InvOverrideRecord | null; finding: InvOverrideScanFinding | null } {
  const header = HEADER_RE.exec(lines[startIdx] ?? '');
  if (header === null) return { record: null, finding: null };
  const invariantId = header[1] ?? '';
  // Collect subsequent contiguous comment lines that match FIELD_RE.
  const fields: Record<string, string> = {};
  let i = startIdx + 1;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const m = FIELD_RE.exec(line);
    if (m === null) break;
    fields[m[1] ?? ''] = m[2] ?? '';
    i++;
  }
  const required = ['reason', 'ticket', 'expires', 'approver'] as const;
  const missing = required.filter((k) => fields[k] === undefined || fields[k] === '');
  if (missing.length > 0) {
    return {
      record: null,
      finding: {
        code: 'malformed',
        file: fileRel,
        line: startIdx + 1,
        invariant_id: invariantId,
        message: `inv-override missing required field(s): ${missing.join(', ')}`,
      },
    };
  }
  // The `missing` check above guarantees these are defined; the
  // `?? ''` keeps the strict-mode compiler happy without a non-null
  // assertion (forbidden by lint).
  const reason = fields.reason ?? '';
  const ticket = fields.ticket ?? '';
  const expires = fields.expires ?? '';
  const approver = fields.approver ?? '';
  const adr = fields.adr;
  if (!EXPIRES_RE.test(expires)) {
    return {
      record: null,
      finding: {
        code: 'malformed',
        file: fileRel,
        line: startIdx + 1,
        invariant_id: invariantId,
        message: `inv-override expires '${expires}' must match YYYY-Q[1-4] or YYYY-MM-DD`,
      },
    };
  }
  if (!APPROVER_RE.test(approver)) {
    return {
      record: null,
      finding: {
        code: 'malformed',
        file: fileRel,
        line: startIdx + 1,
        invariant_id: invariantId,
        message: `inv-override approver '${approver}' must match ^@[A-Za-z0-9_-]+$`,
      },
    };
  }
  if (!TICKET_RE.test(ticket)) {
    return {
      record: null,
      finding: {
        code: 'malformed',
        file: fileRel,
        line: startIdx + 1,
        invariant_id: invariantId,
        message: `inv-override ticket '${ticket}' must look like ENG-1234 or GH-#42`,
      },
    };
  }
  if (adr !== undefined && adr !== '' && !ADR_RE.test(adr)) {
    return {
      record: null,
      finding: {
        code: 'malformed',
        file: fileRel,
        line: startIdx + 1,
        invariant_id: invariantId,
        message: `inv-override adr '${adr}' must match ^ADR-`,
      },
    };
  }
  const record: InvOverrideRecord = {
    schemaVersion: '1.0.0',
    id: recordId(invariantId, fileRel, startIdx + 1, reason),
    invariant_id: invariantId,
    file: fileRel,
    line: startIdx + 1,
    reason,
    ticket,
    expires,
    approver,
    detected_at: new Date().toISOString(),
    ...(adr !== undefined && adr !== '' && { adr }),
  };
  return { record, finding: null };
}

function walk(dir: string, exts: ReadonlySet<string>, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, exts, out);
      continue;
    }
    if (!st.isFile()) continue;
    const dot = name.lastIndexOf('.');
    const ext = dot === -1 ? '' : name.slice(dot);
    if (exts.has(ext)) out.push(full);
  }
}

export function scanInvOverrides(opts: ScanOptions): InvOverrideScanResult {
  const overrides: InvOverrideRecord[] = [];
  const findings: InvOverrideScanFinding[] = [];
  const exts = new Set(opts.extensions ?? DEFAULT_EXTENSIONS);
  const roots = opts.roots ?? DEFAULT_ROOTS;
  const now = opts.now ?? new Date();

  const allFiles: string[] = [];
  for (const r of roots) {
    const abs = join(opts.repoRoot, r);
    if (!existsSync(abs)) continue;
    walk(abs, exts, allFiles);
  }
  for (const abs of allFiles) {
    let body: string;
    try {
      body = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (!body.includes('inv-override:')) continue; // fast path
    const fileRel = relative(opts.repoRoot, abs);
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!HEADER_RE.test(lines[i] ?? '')) continue;
      const { record, finding } = parseBlockAt(fileRel, lines, i);
      if (finding !== null) {
        findings.push(finding);
        continue;
      }
      if (record === null) continue;
      // Expired?
      if (expiresIsPast(record.expires, now)) {
        findings.push({
          code: 'expired',
          file: record.file,
          line: record.line,
          invariant_id: record.invariant_id,
          message: `inv-override expired on ${record.expires}`,
        });
        continue;
      }
      // Invariant existence + severity check (when catalog supplied).
      if (opts.invariants !== undefined) {
        const inv = opts.invariants.get(record.invariant_id);
        if (inv === undefined) {
          findings.push({
            code: 'unknown-invariant',
            file: record.file,
            line: record.line,
            invariant_id: record.invariant_id,
            message: `inv-override references unknown invariant id`,
          });
          continue;
        }
        if (NON_OVERRIDABLE.has(inv.severity)) {
          findings.push({
            code: 'severity-forbids',
            file: record.file,
            line: record.line,
            invariant_id: record.invariant_id,
            message: `invariant severity '${inv.severity}' forbids override; amendment required`,
          });
          continue;
        }
      }
      overrides.push(record);
    }
  }
  return { overrides, findings };
}
