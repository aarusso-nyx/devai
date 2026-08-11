import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { validators } from '@devai-nyx/schemas';

/**
 * Validates ADR markdown files under law/adr/:
 *  1. Front-matter (YAML between two `---` lines at file head) parses
 *     and conforms to adr.schema.json.
 *  2. Filename matches the record id pattern: ADR-NNN-slug.md.
 *  3. Body contains the mandatory sections (Status, Context, Decision,
 *     Consequences, Alternatives Considered, Affected Rules).
 *  4. Sequential numbering across the directory (no gaps).
 */

export interface AdrValidationError {
  readonly file: string;
  readonly pointer?: string;
  readonly message: string;
}

export interface AdrValidationResult {
  readonly ok: boolean;
  readonly files_scanned: number;
  readonly errors: readonly AdrValidationError[];
  readonly adrs: ReadonlyArray<{
    readonly file: string;
    /** Stable output key sourced from frontmatter `id`. */
    readonly adr_id: string;
    readonly title: string;
    readonly status: string;
    readonly date: string;
  }>;
}

const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
/**
 * Each entry is a regex matching the section heading. We allow both
 * singular and plural where conventions vary ("Decision" / "Decisions"
 * are both common in ADR style guides).
 */
const MANDATORY_SECTIONS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'Status', re: /^##\s+Status\b/m },
  { label: 'Context', re: /^##\s+Context\b/m },
  { label: 'Decision(s)', re: /^##\s+Decisions?\b/m },
  { label: 'Consequences', re: /^##\s+Consequences\b/m },
  { label: 'Alternatives Considered', re: /^##\s+Alternatives\s+Considered\b/m },
  { label: 'Affected Rules', re: /^##\s+Affected\s+Rules\b/m },
];

/**
 * Minimal YAML-front-matter parser. Handles only the subset used by
 * ADRs: scalar fields, simple string arrays (`[a, b]` or `- a` block),
 * comment lines. Strictly enough for the ADR schema.
 */
export function parseAdrFrontMatter(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (m === null) {
      i++;
      continue;
    }
    const key = m[1] ?? '';
    const value = m[2] ?? '';
    if (value === '') {
      // Block array follows: lines starting with `- `.
      const arr: string[] = [];
      i++;
      while (i < lines.length && /^\s*-\s+/.test(lines[i] ?? '')) {
        arr.push((lines[i] ?? '').replace(/^\s*-\s+/, '').trim());
        i++;
      }
      out[key] = arr;
      continue;
    }
    // Inline array `[a, b, c]`.
    if (/^\[.*\]$/.test(value.trim())) {
      const inner = value.trim().slice(1, -1).trim();
      out[key] =
        inner === '' ? [] : inner.split(/[;,]/u).map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    } else {
      out[key] = value.trim().replace(/^['"]|['"]$/g, '');
    }
    i++;
  }
  return out;
}

export interface ValidateAdrsOptions {
  readonly adrsDir: string;
}

export function validateAdrs(opts: ValidateAdrsOptions): AdrValidationResult {
  const errors: AdrValidationError[] = [];
  const adrs: Array<{
    file: string;
    adr_id: string;
    title: string;
    status: string;
    date: string;
    n: number;
  }> = [];

  if (!existsSync(opts.adrsDir)) {
    return { ok: true, files_scanned: 0, errors, adrs };
  }

  let entries: string[];
  try {
    entries = readdirSync(opts.adrsDir);
  } catch (err) {
    return {
      ok: false,
      files_scanned: 0,
      errors: [
        {
          file: opts.adrsDir,
          message: `cannot read directory: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      adrs,
    };
  }

  const adrFiles = entries
    .filter((n) => /^ADR-[0-9]{3,}-.+\.md$/.test(n))
    .map((n) => join(opts.adrsDir, n));

  for (const file of adrFiles) {
    let body: string;
    try {
      body = readFileSync(file, 'utf8');
    } catch (err) {
      errors.push({
        file,
        message: `cannot read: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    const m = FRONT_MATTER_RE.exec(body);
    if (m === null) {
      errors.push({ file, message: 'ADR is missing YAML front-matter delimited by `---` lines' });
      continue;
    }
    const fmText = m[1] ?? '';
    const bodyText = m[2] ?? '';
    const fm = parseAdrFrontMatter(fmText);
    // Body diagnostics are independent of frontmatter validity. A malformed
    // imported record must not suppress missing-section findings.
    for (const { label, re } of MANDATORY_SECTIONS) {
      if (!re.test(bodyText)) {
        errors.push({
          file,
          message: `body missing mandatory section '## ${label}'`,
        });
      }
    }
    const ok = validators.adr(fm);
    if (!ok) {
      for (const e of validators.adr.errors ?? []) {
        errors.push({
          file,
          pointer: e.instancePath || undefined,
          message: `${e.message ?? 'schema violation'} (${e.keyword})`,
        });
      }
      continue;
    }
    const record = fm as {
      id: string;
      title: string;
      status: string;
      date: string;
    };

    // Filename consistency.
    const expectedPrefix = `${record.id}-`;
    if (!basename(file).startsWith(expectedPrefix)) {
      errors.push({
        file,
        message: `filename '${basename(file)}' does not start with id '${record.id}-'`,
      });
    }

    const idMatch = /^ADR-([0-9]+)$/.exec(record.id);
    const n = idMatch !== null ? Number(idMatch[1]) : -1;
    adrs.push({
      file,
      adr_id: record.id,
      title: record.title,
      status: record.status,
      date: record.date,
      n,
    });
  }

  // Sequential numbering: when N ADRs exist, they should be
  // ADR-001..ADR-NNN with no gaps.
  const numbers = adrs
    .map((a) => a.n)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  for (let i = 0; i < numbers.length; i++) {
    if (numbers[i] !== i + 1) {
      errors.push({
        file: opts.adrsDir,
        message: `ADR numbering gap: expected ADR-${String(i + 1).padStart(3, '0')}, found ADR-${String(numbers[i]).padStart(3, '0')}`,
      });
      break;
    }
  }

  return {
    ok: errors.length === 0,
    files_scanned: adrFiles.length,
    errors,
    adrs: adrs.map((a) => ({
      file: a.file,
      adr_id: a.adr_id,
      title: a.title,
      status: a.status,
      date: a.date,
    })),
  };
}
