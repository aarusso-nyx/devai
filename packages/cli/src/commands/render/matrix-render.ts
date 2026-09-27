import {
  type Status,
  buildMatrix,
  type StrictCheckOpts,
  type StrictViolation,
  type TestResult,
  type Cell,
} from './matrix-build.js';

function statusGlyph(status: Status | 'na'): string {
  switch (status) {
    case 'pass':
      return 'PASS';
    case 'fail':
      return 'FAIL';
    case 'error':
      return 'ERR';
    case 'skipped':
      return 'SKIP';
    case 'flaky':
      return 'FLAKY';
    case 'na':
      return 'N/A';
  }
}

export function checkStrict(
  matrix: ReturnType<typeof buildMatrix>,
  opts: StrictCheckOpts,
): StrictViolation[] {
  const violations: StrictViolation[] = [];
  const { config, thresholds, results } = opts;

  // Build a lookup: scope → tier → latest result
  const byCell = new Map<string, TestResult>();
  for (const r of results) {
    const scope = r.scope ?? r.repo ?? '(unknown)';
    const key = `${scope}\x00${r.tier}`;
    const existing = byCell.get(key);
    if (existing === undefined || r.timestamp > existing.timestamp) {
      byCell.set(key, r);
    }
  }

  const maxAgeMs = (thresholds?.freshness?.default_max_age_hours ?? 168) * 60 * 60 * 1000;
  const now = Date.now();

  // The matrix only includes tiers that had results or na_overrides.
  // For strict mode, we must also check config-required tiers that are
  // entirely absent from the matrix (no result AND no na_override).
  const configTiers = config?.tiers;
  const naOverrides = config?.na_overrides ?? [];
  const allRequiredTiers =
    configTiers !== undefined && configTiers.length > 0 ? configTiers : matrix.tiers;

  for (const scope of matrix.scopes) {
    const row = matrix.grid.get(scope) as Map<string, Cell>;
    for (const tier of allRequiredTiers) {
      // Historical mutation rows are informational; hardening never gates DEVAI.
      if (tier === 'mutation') continue;
      const cell = row.get(tier);

      // Tier is completely absent from the matrix for this scope.
      if (cell === undefined) {
        const naOverride = naOverrides.some((o) => o.scope === scope && o.tier === tier);
        if (!naOverride) {
          violations.push({ scope, tier, reason: 'missing: no test-result record found' });
        }
        continue;
      }

      // N/A cells are declared intentional — not a violation.
      if (cell.status === 'na') {
        const naOverride = naOverrides.some((o) => o.scope === scope && o.tier === tier);
        if (naOverride) continue;
        // na without an override: missing record.
        violations.push({ scope, tier, reason: 'missing: no test-result record found' });
        continue;
      }

      const result = byCell.get(`${scope}\x00${tier}`);
      if (result === undefined) {
        violations.push({ scope, tier, reason: 'missing: no test-result record found' });
        continue;
      }

      // Staleness check.
      const recordTime = new Date(result.timestamp).getTime();
      if (!isNaN(recordTime) && now - recordTime > maxAgeMs) {
        const ageH = ((now - recordTime) / 3_600_000).toFixed(1);
        const limitH = String(thresholds?.freshness?.default_max_age_hours ?? 168);
        violations.push({
          scope,
          tier,
          reason: `stale: record is ${ageH}h old (limit ${limitH}h)`,
        });
      }

      // Status check.
      if (result.status === 'fail' || result.status === 'error') {
        violations.push({ scope, tier, reason: `status: ${result.status}` });
      }

      // Threshold checks.
      if (thresholds !== undefined) {
        const m = result.metrics;
        if (tier === 'coverage' && m?.coverage_pct?.lines !== undefined) {
          const req = thresholds.coverage?.lines;
          if (req !== undefined && m.coverage_pct.lines < req) {
            violations.push({
              scope,
              tier,
              reason: `below threshold: coverage ${m.coverage_pct.lines.toFixed(1)}% < required ${req.toFixed(1)}%`,
            });
          }
        }
      }
    }
  }

  return violations;
}

export function renderMarkdown(m: ReturnType<typeof buildMatrix>): string {
  if (m.scopes.length === 0) {
    return '# Test matrix\n\n_No test-result records found._\n';
  }
  const lines: string[] = ['# Test matrix', ''];
  lines.push('| Scope | ' + m.tiers.join(' | ') + ' |');
  lines.push('|---' + '|---'.repeat(m.tiers.length) + '|');
  for (const scope of m.scopes) {
    const row = m.grid.get(scope) as Map<string, Cell>;
    const cells = m.tiers.map((t) => {
      const c = row.get(t) as Cell;
      const g = statusGlyph(c.status);
      return c.extra !== undefined ? `${g} ${c.extra}` : g;
    });
    lines.push(`| ${scope} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export function renderHtml(m: ReturnType<typeof buildMatrix>): string {
  const cellClass = (s: Status | 'na'): string => `cell cell-${s}`;
  const head =
    '<!doctype html><meta charset="utf-8"><title>Test matrix</title><style>' +
    'body{font-family:sans-serif;margin:2rem;}' +
    'table{border-collapse:collapse;}' +
    'th,td{border:1px solid #ccc;padding:.4em .7em;text-align:left;}' +
    '.cell-pass{background:#dfd;}.cell-fail{background:#fdd;}' +
    '.cell-error{background:#fbb;}.cell-skipped,.cell-na{background:#eee;color:#777;}' +
    '.cell-flaky{background:#fed;}' +
    '</style>';
  if (m.scopes.length === 0) {
    return `${head}<h1>Test matrix</h1><p><em>No test-result records found.</em></p>`;
  }
  const headerRow = '<tr><th>Scope</th>' + m.tiers.map((t) => `<th>${t}</th>`).join('') + '</tr>';
  const bodyRows = m.scopes
    .map((scope) => {
      const row = m.grid.get(scope) as Map<string, Cell>;
      const cells = m.tiers
        .map((t) => {
          const c = row.get(t) as Cell;
          const label =
            c.extra !== undefined ? `${statusGlyph(c.status)} ${c.extra}` : statusGlyph(c.status);
          return `<td class="${cellClass(c.status)}">${label}</td>`;
        })
        .join('');
      return `<tr><th>${scope}</th>${cells}</tr>`;
    })
    .join('');
  return `${head}<h1>Test matrix</h1><table>${headerRow}${bodyRows}</table>`;
}
