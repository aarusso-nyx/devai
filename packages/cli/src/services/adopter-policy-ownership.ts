/**
 * The ownership matrix of `init bind --adopter-policy` (ADR-CFG-0002).
 *
 * Every `project.json` key or nested block the adopter-policy bind projects from
 * `law/policy/devai-adoption.json` is named here once, and docs/adopters/install.md
 * states the same rows. An owned row the source declares replaces the current value
 * as a whole; a retirable row the source no longer declares is removed from the
 * projection. A key this matrix does not name is an adopter declaration: the bind
 * never reads it from the source and carries it through unchanged.
 */

type JsonObject = Record<string, unknown>;

export interface AdopterPolicyOwnershipRow {
  /** JSON pointer of the owned row in `.devai/config/project.json`. */
  readonly pointer: string;
  /** Path of the row in the adopter policy source; null for machine-stamped rows. */
  readonly source: readonly string[] | null;
  /**
   * What the bind does when the source does not declare the row:
   * `retire` removes it, `keep` leaves the current value (schema-required scalar),
   * `stamp` writes the installed framework version on every bind.
   */
  readonly absent: 'retire' | 'keep' | 'stamp';
}

export const ADOPTER_POLICY_OWNERSHIP_MATRIX: readonly AdopterPolicyOwnershipRow[] = [
  { pointer: '/project_type', source: ['project', 'project_type'], absent: 'keep' },
  { pointer: '/repo', source: ['project', 'repo'], absent: 'retire' },
  { pointer: '/docs', source: ['project', 'docs'], absent: 'retire' },
  { pointer: '/docs/ia', source: ['project', 'docs', 'ia'], absent: 'retire' },
  { pointer: '/ci_economy', source: ['ci_economy'], absent: 'retire' },
  {
    pointer: '/ci_economy/local_evidence',
    source: ['ci_economy', 'local_evidence'],
    absent: 'retire',
  },
  { pointer: '/ci_economy/attested_rc', source: ['ci_economy', 'attested_rc'], absent: 'retire' },
  { pointer: '/devai_version', source: null, absent: 'stamp' },
];

/** Pointers that may appear in a receipt's `retired_keys`. */
export const RETIRABLE_OWNED_POINTERS: readonly string[] = ADOPTER_POLICY_OWNERSHIP_MATRIX.filter(
  (row) => row.absent === 'retire',
).map((row) => row.pointer);

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function segments(pointer: string): string[] {
  return pointer.split('/').slice(1);
}

function lookup(document: unknown, path: readonly string[]): unknown {
  let cursor: unknown = document;
  for (const key of path) {
    if (!isObject(cursor) || !Object.hasOwn(cursor, key)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/** Top-level rows: the unit of whole replacement in project.json. */
const TOP_LEVEL_ROWS = ADOPTER_POLICY_OWNERSHIP_MATRIX.filter(
  (row) => segments(row.pointer).length === 1,
);

/**
 * Project the owned rows of the adopter policy over the current project.json.
 * Keys outside the matrix keep their value and position; owned keys keep their
 * position when replaced and are appended when newly declared.
 */
export function projectOwnedProjectConfig(input: {
  readonly policy: JsonObject;
  readonly currentProject: JsonObject;
  readonly frameworkVersion: string;
}): { readonly project: JsonObject; readonly retired_keys: readonly string[] } {
  const retiredTopLevel = new Set<string>();
  const replacements: JsonObject = {};
  for (const row of TOP_LEVEL_ROWS) {
    const [key] = segments(row.pointer) as [string];
    if (row.absent === 'stamp') {
      replacements[key] = input.frameworkVersion;
      continue;
    }
    const declared = lookup(input.policy, row.source ?? []);
    if (declared !== undefined) replacements[key] = structuredClone(declared);
    else if (row.absent === 'retire') retiredTopLevel.add(key);
  }
  const project: JsonObject = {
    ...Object.fromEntries(
      Object.entries(input.currentProject).filter(([key]) => !retiredTopLevel.has(key)),
    ),
    ...replacements,
  };

  // Report each retired row once, by the outermost row that left the projection.
  const retired: string[] = [];
  for (const row of ADOPTER_POLICY_OWNERSHIP_MATRIX) {
    if (row.absent !== 'retire') continue;
    if (lookup(input.currentProject, segments(row.pointer)) === undefined) continue;
    if (lookup(input.policy, row.source ?? []) !== undefined) continue;
    if (retired.some((outer) => row.pointer.startsWith(`${outer}/`))) continue;
    retired.push(row.pointer);
  }
  return { project, retired_keys: retired };
}
