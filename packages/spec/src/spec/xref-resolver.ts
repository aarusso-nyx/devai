/**
 * Cross-reference resolver. Given a set of F1 artifact ID maps, validates
 * any cross-reference (e.g., journey.related_invariants[i] → invariant
 * catalog).
 *
 * Per the absorbed Phase-2 validation criterion: "Cross-reference resolver handles a
 * graph of 100+ invariants with 200+ references in under 100ms." The
 * implementation is O(1) per lookup via Set, so 100k+ refs over 100k+ ids
 * resolve well under that budget.
 */

export interface IdCatalog {
  readonly invariants: ReadonlySet<string>;
  readonly journeys: ReadonlySet<string>;
  readonly glossary: ReadonlySet<string>;
}

export interface XrefError {
  readonly source_file: string;
  readonly source_id: string;
  readonly field: string;
  readonly target_id: string;
  readonly target_kind: 'invariant' | 'journey' | 'glossary';
}

export interface XrefCheck {
  readonly source_file: string;
  readonly source_id: string;
  readonly field: string;
  readonly target_id: string;
  readonly target_kind: 'invariant' | 'journey' | 'glossary';
}

export function buildCatalog(
  invariants: Iterable<string>,
  journeys: Iterable<string> = [],
  glossary: Iterable<string> = [],
): IdCatalog {
  return {
    invariants: new Set(invariants),
    journeys: new Set(journeys),
    glossary: new Set(glossary),
  };
}

export function resolveXref(catalog: IdCatalog, check: XrefCheck): XrefError | null {
  const set =
    check.target_kind === 'invariant'
      ? catalog.invariants
      : check.target_kind === 'journey'
        ? catalog.journeys
        : catalog.glossary;
  if (set.has(check.target_id)) return null;
  return {
    source_file: check.source_file,
    source_id: check.source_id,
    field: check.field,
    target_id: check.target_id,
    target_kind: check.target_kind,
  };
}

export function resolveAll(catalog: IdCatalog, checks: Iterable<XrefCheck>): readonly XrefError[] {
  const errors: XrefError[] = [];
  for (const check of checks) {
    const err = resolveXref(catalog, check);
    if (err !== null) errors.push(err);
  }
  return errors;
}

/**
 * Detect duplicate ids within a single source-file collection. The Sets
 * inside an IdCatalog naturally dedupe; this helper validates the source
 * arrays BEFORE building the catalog so collisions surface as explicit
 * errors with the conflicting filenames.
 */
export interface DuplicateError {
  readonly id: string;
  readonly files: readonly string[];
}

export function findDuplicateIds(
  entries: Iterable<{ id: string; file: string }>,
): readonly DuplicateError[] {
  const seen = new Map<string, string[]>();
  for (const e of entries) {
    const list = seen.get(e.id);
    if (list === undefined) {
      seen.set(e.id, [e.file]);
    } else {
      list.push(e.file);
    }
  }
  const dups: DuplicateError[] = [];
  for (const [id, files] of seen) {
    if (files.length > 1) dups.push({ id, files });
  }
  return dups;
}
