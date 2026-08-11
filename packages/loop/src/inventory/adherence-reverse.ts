/**
 * Reverse-direction adherence audit.
 *
 * Forward visibility (canonical, already shipped via `spec validate-trace`):
 *   RTD invariant → test → test file → code area.
 *
 * Reverse visibility (this module): start from a plant surface
 * discovered by the inventory subsystem (route, module, component,
 * dependency), and ask whether any invariant in trace.json's
 * `code_areas` globs claims that surface's source file. Surfaces
 * with no claim are "orphans" — they're plant surfaces that aren't
 * backed by any documented invariant, and become triage candidates
 * for the Architect.
 *
 * The audit is non-blocking by default. Callers may set strict=true
 * to convert orphan-counts to a hard-fail exit.
 */

export interface TraceInvariantEntry {
  readonly id: string;
  readonly code_areas?: readonly string[];
}

export interface TraceShape {
  readonly invariants: readonly TraceInvariantEntry[];
}

export interface PlantSurface {
  readonly kind: 'route' | 'module' | 'component' | 'dependency';
  readonly id: string;
  readonly file: string;
}

export interface InventoryShape {
  readonly routes?: ReadonlyArray<{ readonly id?: string; readonly file?: string }>;
  readonly modules?: ReadonlyArray<{ readonly id?: string; readonly file?: string }>;
  readonly components?: ReadonlyArray<{ readonly id?: string; readonly file?: string }>;
  readonly dependency_graph?: ReadonlyArray<{ readonly id?: string; readonly file?: string }>;
}

export interface AdherenceClaim {
  readonly surface: PlantSurface;
  readonly claimed_by: readonly string[];
}

export interface ReverseAdherenceReport {
  readonly counts: {
    readonly total: number;
    readonly claimed: number;
    readonly orphan: number;
  };
  readonly by_kind: Record<'route' | 'module' | 'component' | 'dependency', number>;
  readonly orphans: readonly PlantSurface[];
  readonly adopted: readonly AdherenceClaim[];
}

/**
 * Translate a glob like packages-slash-star-star or src-slash-auth-slash-star-star into a
 * RegExp matched against a forward-slash repo-relative path.
 *
 * Supported tokens: literal segments, `*` (any chars except slash),
 * `**` (any chars including slash), `?` (single char except slash).
 * Other glob features (character classes, alternation) are not
 * supported; they have no need in trace.json's code_areas which is
 * an audit-trail field, not a sophisticated file matcher.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c !== undefined && /[.+^$|()[\]{}\\]/.test(c)) {
      re += '\\' + c;
    } else if (c !== undefined) {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

export interface ComputeReverseAdherenceOptions {
  readonly inventory: InventoryShape;
  readonly trace: TraceShape;
  /** Surface kinds to include. Default: all four. */
  readonly include?: ReadonlyArray<'route' | 'module' | 'component' | 'dependency'>;
}

/**
 * Aggregate plant surfaces from the inventory and check each
 * against the trace's invariant.code_areas globs.
 */
export function computeReverseAdherence(
  opts: ComputeReverseAdherenceOptions,
): ReverseAdherenceReport {
  const include = new Set(opts.include ?? ['route', 'module', 'component', 'dependency']);
  const surfaces: PlantSurface[] = [];
  if (include.has('route')) {
    for (const r of opts.inventory.routes ?? []) {
      if (r.id !== undefined && r.file !== undefined) {
        surfaces.push({ kind: 'route', id: r.id, file: normalizePath(r.file) });
      }
    }
  }
  if (include.has('module')) {
    for (const m of opts.inventory.modules ?? []) {
      if (m.id !== undefined && m.file !== undefined) {
        surfaces.push({ kind: 'module', id: m.id, file: normalizePath(m.file) });
      }
    }
  }
  if (include.has('component')) {
    for (const c of opts.inventory.components ?? []) {
      if (c.id !== undefined && c.file !== undefined) {
        surfaces.push({ kind: 'component', id: c.id, file: normalizePath(c.file) });
      }
    }
  }
  if (include.has('dependency')) {
    for (const d of opts.inventory.dependency_graph ?? []) {
      if (d.id !== undefined && d.file !== undefined) {
        surfaces.push({ kind: 'dependency', id: d.id, file: normalizePath(d.file) });
      }
    }
  }

  // Pre-compile globs into (invariantId, regex) pairs.
  const claims: Array<{ id: string; re: RegExp }> = [];
  for (const inv of opts.trace.invariants) {
    for (const area of inv.code_areas ?? []) {
      claims.push({ id: inv.id, re: globToRegExp(area) });
    }
  }

  const adopted: AdherenceClaim[] = [];
  const orphans: PlantSurface[] = [];
  for (const s of surfaces) {
    const matchers = claims.filter((c) => c.re.test(s.file));
    if (matchers.length === 0) {
      orphans.push(s);
    } else {
      // Dedupe invariant ids in case multiple globs from the same
      // invariant match.
      const ids = Array.from(new Set(matchers.map((m) => m.id))).sort();
      adopted.push({ surface: s, claimed_by: ids });
    }
  }

  return {
    counts: {
      total: surfaces.length,
      claimed: adopted.length,
      orphan: orphans.length,
    },
    by_kind: {
      route: surfaces.filter((s) => s.kind === 'route').length,
      module: surfaces.filter((s) => s.kind === 'module').length,
      component: surfaces.filter((s) => s.kind === 'component').length,
      dependency: surfaces.filter((s) => s.kind === 'dependency').length,
    },
    orphans,
    adopted,
  };
}
