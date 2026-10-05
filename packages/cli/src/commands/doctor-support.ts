import { existsSync, readFileSync } from '@devai-nyx/authority';
import { join, posix } from 'node:path';
import type { AdoptionProfile } from '@devai-nyx/utils';

export const DEFAULT_REPO_ROOT = '.';
export const DEFAULT_CHAIN_RELATIVE = 'record/proofs/chain.json';

export const F1_PATHS = [
  'product',
  'law/invariants',
  'law/schemas',
  'law/adr',
  'docs/dev/operations',
  'docs/dev/security',
  'law/glossary',
] as const;

export const READING_ORDER_SOURCES = [
  'README.md',
  'law/constitution.md',
  'law/adr',
  'law/schemas',
] as const;
export const FIVE_ROLES = ['Owner', 'Architect', 'Inspector', 'Engineer', 'Auditor'] as const;

/**
 * ADR-GOV-0020: the whole of CLAUDE.md is this one line, the Claude Code import
 * of AGENTS.md, so the single contract is never copied into a second file.
 */
export const CLAUDE_AGENTS_IMPORT = '@AGENTS.md';

export interface DoctorOptions {
  readonly repoRoot?: string;
  readonly chain?: string;
  readonly human?: boolean;
  readonly probe?: string;
  /** Comma-separated list of checks to skip, e.g. "docs-governance". */
  readonly skip?: string;
}

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  /** D-112: true when the check is above the declared adoption profile — reported, never failing the run. */
  readonly advisory?: boolean;
  readonly info?: Record<string, unknown>;
  readonly errors?: readonly string[];
  /** Findings worth acting on that never fail the check, each naming its remedy (#266). */
  readonly warnings?: readonly string[];
}

export interface Report {
  readonly ok: boolean;
  /** Declared adoption profile (D-112); absent project.json key resolves to tier3. */
  readonly profile: AdoptionProfile;
  readonly checks: readonly CheckResult[];
}

/**
 * D-125: adopters whose docs substrate has legitimately relocated under a
 * binding adopter ADR declare the relocation in
 * `.devai/config/project.json`'s `docs.ia.path_overrides` — a map from the
 * canonical F1/reading-order key (a `docs/`-rooted path with the `docs/`
 * prefix stripped, e.g. `"framework/contracts"`) to the adopter's actual
 * current relative path (e.g. `"reference/contracts"`). Absent config, or
 * an absent/malformed key, resolves to `{}`, so `f1-paths-present` and
 * `agents-claude-sync` stay byte-identical to pre-D-125 behavior for every
 * adopter that hasn't declared an override.
 */
export function readPathOverrides(repoRoot: string): Record<string, string> {
  const configPath = join(repoRoot, '.devai/config/project.json');
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
      docs?: { ia?: { path_overrides?: Record<string, string> } };
    };
    return parsed.docs?.ia?.path_overrides ?? {};
  } catch {
    return {};
  }
}

/**
 * Resolves a canonical `docs/...`-rooted path through the override map.
 * Root-level filenames (no `docs/` prefix — the other four
 * `READING_ORDER_SOURCES` entries) pass through unchanged: the override
 * only covers F1-substrate relocations, not adopter substitution of the
 * root reading-order files themselves (that is a separate, adopter-local
 * ADR concern, e.g. PEC's ADR-0008).
 */
export function applyPathOverride(
  canonicalPath: string,
  overrides: Readonly<Record<string, string>>,
): string {
  if (!canonicalPath.startsWith('docs/')) return canonicalPath;
  const key = canonicalPath.slice('docs/'.length);
  const override = overrides[key];
  return override !== undefined ? `docs/${override}` : canonicalPath;
}

/** A docs path resolved through `docs.ia.path_overrides`, or the override refused for leaving `docs/`. */
export type DocsPathResolution =
  | { readonly path: string; readonly rejected?: undefined }
  | {
      readonly path?: undefined;
      readonly rejected: { readonly key: string; readonly value: string };
    };

/**
 * Resolves a canonical `docs/...` path through its longest overridden ancestor (#265): with
 * `"dev/operations": "meta/ops"`, `docs/dev/operations/workflows` resolves to
 * `docs/meta/ops/workflows`. A key naming the whole path wins over every ancestor, as in
 * {@link applyPathOverride}; ancestors match on whole segments only, so `dev/ops` never
 * relocates `docs/dev/operations`. The result is normalized, and an override that is absolute
 * or resolves outside `docs/` is refused rather than applied, so no caller reads outside the
 * repository's documentation tree. Paths outside `docs/` pass through unchanged.
 */
export function resolveDocsPathOverride(
  canonicalPath: string,
  overrides: Readonly<Record<string, string>>,
): DocsPathResolution {
  if (!canonicalPath.startsWith('docs/')) return { path: canonicalPath };
  const segments = canonicalPath.slice('docs/'.length).split('/');
  for (let length = segments.length; length > 0; length -= 1) {
    const key = segments.slice(0, length).join('/');
    const override: unknown = overrides[key];
    if (typeof override !== 'string') continue;
    const path = posix.normalize(['docs', override, ...segments.slice(length)].join('/'));
    return posix.isAbsolute(override) || (path !== 'docs' && !path.startsWith('docs/'))
      ? { rejected: { key, value: override } }
      : { path: path.replace(/\/+$/u, '') };
  }
  return { path: canonicalPath };
}

export interface CliProbe {
  readonly family: 'claude-cli' | 'codex-cli';
  readonly cli: string;
  readonly onPath: boolean;
  readonly version: string | null;
  readonly usable: boolean;
  readonly hint: string;
}

export interface CheckSpec {
  readonly name: string;
  /**
   * D-112: lowest adoption profile at which this check is binding.
   * Below it the check still runs but is reported advisory and
   * excluded from the report's `ok`. Default tier1 (always binding).
   */
  readonly minProfile?: AdoptionProfile;
  readonly run: (
    repoRoot: string,
    chainPath: string,
    skipDocsGovernance?: boolean,
  ) => CheckResult | Promise<CheckResult>;
}
