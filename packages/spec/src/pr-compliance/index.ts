/**
 * `Inv-Compliance:` PR trailer parser and gate. Every PR that materially
 * implements an invariant cites the rule IDs in a trailer:
 *
 *     Inv-Compliance: INV-DEVAI-002, INV-AUTH-001
 *
 * The gate validates:
 *   1. The trailer is present (when --required is set).
 *   2. Each cited id matches the INV- pattern.
 *   3. Each cited id exists in the invariant catalog.
 *   4. (Future / Batch 10+) Each cited rule's `scope.code_areas` overlaps
 *      with the PR diff surfaces. Not enforced in this batch — needs
 *      git diff integration.
 */

const TRAILER_RE = /^[Ii]nv-[Cc]ompliance:\s*(.+?)\s*$/m;
const ID_RE = /^INV-[A-Z][A-Z0-9]{1,15}-[0-9]{3}$/;

export interface PrComplianceFinding {
  /** 'missing-trailer' | 'malformed-id' | 'unknown-id' | 'empty-trailer' */
  readonly code: 'missing-trailer' | 'malformed-id' | 'unknown-id' | 'empty-trailer';
  readonly message: string;
  readonly invariant_id?: string;
}

export interface PrComplianceResult {
  readonly ok: boolean;
  readonly cited_ids: readonly string[];
  readonly findings: readonly PrComplianceFinding[];
}

export interface PrComplianceCheckOptions {
  /** Raw PR body text. */
  readonly body: string;
  /** Invariant ids known to exist; skipped check if absent. */
  readonly invariant_ids?: ReadonlySet<string>;
  /** Treat missing trailer as a finding. Default true. */
  readonly required?: boolean;
}

/**
 * Parse the trailer (if any) and validate cited ids.
 */
export function checkPrCompliance(opts: PrComplianceCheckOptions): PrComplianceResult {
  const findings: PrComplianceFinding[] = [];
  const required = opts.required !== false;
  const match = TRAILER_RE.exec(opts.body);
  if (match === null) {
    if (required) {
      findings.push({
        code: 'missing-trailer',
        message:
          'PR body must contain an `Inv-Compliance:` trailer listing the invariants this change implements',
      });
    }
    return { ok: findings.length === 0, cited_ids: [], findings };
  }
  const raw = match[1] ?? '';
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    findings.push({
      code: 'empty-trailer',
      message: '`Inv-Compliance:` trailer is present but empty',
    });
    return { ok: false, cited_ids: [], findings };
  }
  const seen = new Set<string>();
  const cited: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue; // dedupe
    seen.add(id);
    cited.push(id);
    if (!ID_RE.test(id)) {
      findings.push({
        code: 'malformed-id',
        invariant_id: id,
        message: `cited id '${id}' does not match ^INV-<DOMAIN>-NNN$`,
      });
      continue;
    }
    if (opts.invariant_ids !== undefined && !opts.invariant_ids.has(id)) {
      findings.push({
        code: 'unknown-id',
        invariant_id: id,
        message: `cited id '${id}' is not in the invariant catalog`,
      });
    }
  }
  return { ok: findings.length === 0, cited_ids: cited, findings };
}
