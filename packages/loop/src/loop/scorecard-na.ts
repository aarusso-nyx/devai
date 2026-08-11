import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validators } from '@devai-nyx/schemas';

/**
 * Phase 34.B (D-91): per-repo N/A override mechanism for the F×T
 * scorecard. A repo declares which cells are degenerate for *its*
 * substrate at `.devai/config/scorecard-na.json`. The override
 * applies as an overlay AFTER global `DEGENERATE_CELLS` (Article 5)
 * and BEFORE reading-driven verdicts — so a stray SR cannot
 * silently flip an N/A carve-out.
 *
 * The mechanism is per-repo: stynx and DEVAI carry distinct carve-
 * out files reflecting their distinct substrate shapes. Adding a
 * cell to the GLOBAL `DEGENERATE_CELLS` set in `scorecard.ts` would
 * lie about adopters; this loader is the honest third path.
 */

const DEFAULT_RELATIVE_PATH = '.devai/config/scorecard-na.json';

export interface ScorecardNaEntry {
  readonly cell: string;
  readonly reason: string;
  readonly constitution_anchor?: string;
}

export interface ScorecardNaConfig {
  readonly schemaVersion: '1.0.0';
  readonly cells: readonly ScorecardNaEntry[];
}

/**
 * Resolve the default path: `<repoRoot>/.devai/config/scorecard-na.json`.
 * Caller may pass an explicit path or `undefined` (auto-resolve from cwd).
 */
export function resolveScorecardNaPath(repoRoot?: string): string {
  return join(repoRoot ?? process.cwd(), DEFAULT_RELATIVE_PATH);
}

/**
 * Read + validate the optional carve-out file. Returns `null` when
 * the file is absent — that's the explicit no-op contract for
 * adopters who don't need the override.
 *
 * Schema-invalid files hard-throw rather than silently degrade: a
 * malformed carve-out file is exactly the case the schema exists to
 * catch (typo'd cell coordinate, missing reason, etc.), and silent
 * fallback would defeat the override's auditability promise.
 */
export function loadScorecardNaConfig(path: string): ScorecardNaConfig | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `scorecard-na config at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!validators.scorecardNaConfig(parsed)) {
    throw new Error(
      `scorecard-na config at ${path} fails scorecard-na-config.schema.json: ${JSON.stringify(validators.scorecardNaConfig.errors)}`,
    );
  }
  return parsed as ScorecardNaConfig;
}

/**
 * Project a config into the `Set<'Fx:Ty'>` shape expected by
 * `computeScorecard`'s `naCells` option.
 */
export function scorecardNaCellSet(config: ScorecardNaConfig | null): ReadonlySet<string> {
  if (config === null) return new Set();
  return new Set(config.cells.map((c) => c.cell));
}
