import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Stack-adapter pack resolver.
 *
 * Walks examples/redox-pack-X (and any additional seed dirs) for
 * stack-adapter.json manifests, evaluates each pack's detect signals
 * against the adopter repo, and returns the highest-priority match.
 *
 * Detect-signal evaluation uses OR semantics:
 *   file_present          — repo-relative file exists
 *   dir_present           — repo-relative directory exists
 *   package_dep_present   — package.json dependencies / devDependencies
 *   composer_dep_present  — composer.json require / require-dev
 *   gemfile_dep_present   — Gemfile contains a matching gem line
 *
 * A pack matches when ANY signal hits. When multiple packs match,
 * the highest detect.priority wins; ties surface as an ambiguity
 * (resolver returns the first by id and notes the tie in the result).
 */

export interface StackAdapterDetectSignal {
  readonly kind:
    | 'file_present'
    | 'dir_present'
    | 'package_dep_present'
    | 'composer_dep_present'
    | 'gemfile_dep_present';
  readonly path?: string;
  readonly package?: string;
  readonly weight?: number;
}

export interface StackAdapterPack {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly stack: {
    readonly backend: string;
    readonly frontend: string;
    readonly db: string;
    readonly cloud?: string;
  };
  readonly detect: {
    readonly signals: readonly StackAdapterDetectSignal[];
    readonly priority?: number;
  };
  readonly extractor_params?: Readonly<Record<string, unknown>>;
  readonly seed_invariants?: readonly string[];
  readonly tags?: readonly string[];
  readonly notes?: string;
  /** Populated by findStackAdapterPacks: absolute path the pack was loaded from. */
  readonly _packDir?: string;
}

export interface FindPacksOptions {
  /**
   * Repo root for relative resolution of bundled examples/redox-pack-*.
   * The resolver looks under <repoRoot>/examples/ for canonical
   * packs and also walks any additional directories supplied below.
   */
  readonly repoRoot: string;
  /**
   * Additional directories to scan for stack-adapter.json manifests.
   * Each path is treated as the pack directory itself (not its parent).
   * Used by callers that provide additional pack roots.
   */
  readonly additionalDirs?: readonly string[];
}

/**
 * Walks examples/redox-pack-X under repoRoot and any additional dirs;
 * returns each parseable stack-adapter.json body with its
 * directory path set in _packDir.
 */
export function findStackAdapterPacks(opts: FindPacksOptions): StackAdapterPack[] {
  const out: StackAdapterPack[] = [];
  const examplesDir = join(opts.repoRoot, 'examples');
  if (existsSync(examplesDir)) {
    let entries: readonly string[];
    try {
      entries = readdirSync(examplesDir);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (!name.startsWith('redox-pack-')) continue;
      const dir = join(examplesDir, name);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(dir);
      } catch {
        continue;
      }
      if (!s.isDirectory()) continue;
      const manifest = join(dir, 'stack-adapter.json');
      if (!existsSync(manifest)) continue;
      const pack = tryParse(manifest, dir);
      if (pack !== null) out.push(pack);
    }
  }
  for (const dir of opts.additionalDirs ?? []) {
    const manifest = join(dir, 'stack-adapter.json');
    if (!existsSync(manifest)) continue;
    const pack = tryParse(manifest, dir);
    if (pack !== null) out.push(pack);
  }
  return out;
}

function tryParse(path: string, dir: string): StackAdapterPack | null {
  try {
    const body = JSON.parse(readFileSync(path, 'utf8')) as StackAdapterPack;
    return { ...body, _packDir: dir };
  } catch {
    return null;
  }
}

export interface MatchResult {
  readonly pack: StackAdapterPack;
  readonly matched_signals: readonly StackAdapterDetectSignal[];
  readonly priority: number;
}

export interface EvaluateOptions {
  readonly pack: StackAdapterPack;
  readonly adopterRoot: string;
}

/**
 * Evaluate a pack's detect.signals against an adopter repo. Returns
 * the list of signals that matched. OR semantics: any single hit
 * counts as a match (presence-based).
 */
export function evaluateDetectSignals(opts: EvaluateOptions): readonly StackAdapterDetectSignal[] {
  const hits: StackAdapterDetectSignal[] = [];
  for (const sig of opts.pack.detect.signals) {
    if (signalMatches(sig, opts.adopterRoot)) hits.push(sig);
  }
  return hits;
}

function signalMatches(sig: StackAdapterDetectSignal, root: string): boolean {
  switch (sig.kind) {
    case 'file_present':
    case 'dir_present': {
      if (sig.path === undefined) return false;
      const full = join(root, sig.path);
      if (!existsSync(full)) return false;
      try {
        const s = statSync(full);
        return sig.kind === 'dir_present' ? s.isDirectory() : s.isFile();
      } catch {
        return false;
      }
    }
    case 'package_dep_present':
      return depPresent(join(root, 'package.json'), sig.package, [
        'dependencies',
        'devDependencies',
      ]);
    case 'composer_dep_present':
      return depPresent(join(root, 'composer.json'), sig.package, ['require', 'require-dev']);
    case 'gemfile_dep_present':
      return gemPresent(join(root, 'Gemfile'), sig.package);
    default:
      return false;
  }
}

function depPresent(
  manifestPath: string,
  pkg: string | undefined,
  keys: readonly string[],
): boolean {
  if (pkg === undefined) return false;
  if (!existsSync(manifestPath)) return false;
  try {
    const body = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    for (const k of keys) {
      const deps = body[k];
      if (typeof deps !== 'object' || deps === null) continue;
      if (Object.prototype.hasOwnProperty.call(deps, pkg)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function gemPresent(gemfilePath: string, pkg: string | undefined): boolean {
  if (pkg === undefined) return false;
  if (!existsSync(gemfilePath)) return false;
  try {
    const text = readFileSync(gemfilePath, 'utf8');
    // Escape regex metachars in pkg by replacing each via a character
    // class (no template literal — the earlier version read the inner
    // dollar-brace as an interpolation marker and broke parsing).
    const escaped = pkg.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    const re = new RegExp('^\\s*gem\\s+[\'"]' + escaped + '[\'"]', 'm');
    return re.test(text);
  } catch {
    return false;
  }
}

export interface ResolveOptions {
  readonly repoRoot: string;
  /**
   * The adopter repo to evaluate signals against. Defaults to
   * repoRoot — useful for self-introspection. Pass a different
   * path when DEVAI is hosted and detecting an adopter elsewhere.
   */
  readonly adopterRoot?: string;
  readonly additionalDirs?: readonly string[];
  /** Force a specific pack by id (skips auto-detect). */
  readonly explicitId?: string;
}

export interface ResolveResult {
  /** The matched pack, or null when no candidate hit. */
  readonly matched: StackAdapterPack | null;
  /** Every pack that had at least one signal hit (sorted by priority desc, id asc). */
  readonly candidates: readonly MatchResult[];
  /** True when ≥2 candidates share the top priority. */
  readonly ambiguous: boolean;
}

/**
 * Resolve the best-fit explicitly configured stack-adapter pack for an adopter root, then return
 * the per-sensor parameter subset declared by that pack for the
 * supplied `sensorKind` (`inventory_api`, `inventory_routes`,
 * `inventory_data_model`, etc.). Returns null when no pack matches.
 * Returns an empty params object when the pack matches but declares
 * no params for the requested sensor kind (legitimate; e.g. the
 * coverage sensor is framework-agnostic and packs typically omit it).
 *
 * `packsRoot` is explicit; the installed package never searches sibling repositories.
 */
export interface ResolveSensorParamsOptions {
  readonly packsRoot?: string;
  readonly adopterRoot: string;
  readonly sensorKind: string;
  readonly additionalDirs?: readonly string[];
  readonly explicitId?: string;
}

export interface SensorParamsResolution {
  readonly pack: StackAdapterPack;
  readonly params: Readonly<Record<string, unknown>>;
}

export function resolveSensorParams(
  opts: ResolveSensorParamsOptions,
): SensorParamsResolution | null {
  const packsRoot = opts.packsRoot;
  if (packsRoot === undefined) return null;
  const result = resolveStackAdapterPack({
    repoRoot: packsRoot,
    adopterRoot: opts.adopterRoot,
    ...(opts.additionalDirs !== undefined && { additionalDirs: opts.additionalDirs }),
    ...(opts.explicitId !== undefined && { explicitId: opts.explicitId }),
  });
  if (result.matched === null) return null;
  const allParams = (result.matched.extractor_params ?? {}) as Record<string, unknown>;
  const subset = allParams[opts.sensorKind];
  const params: Record<string, unknown> =
    typeof subset === 'object' && subset !== null ? (subset as Record<string, unknown>) : {};
  return { pack: result.matched, params };
}

export function resolveStackAdapterPack(opts: ResolveOptions): ResolveResult {
  const adopterRoot = opts.adopterRoot ?? opts.repoRoot;
  const packs = findStackAdapterPacks({
    repoRoot: opts.repoRoot,
    ...(opts.additionalDirs !== undefined && { additionalDirs: opts.additionalDirs }),
  });

  if (opts.explicitId !== undefined) {
    const forced = packs.find((p) => p.id === opts.explicitId);
    if (forced === undefined) return { matched: null, candidates: [], ambiguous: false };
    return {
      matched: forced,
      candidates: [{ pack: forced, matched_signals: [], priority: forced.detect.priority ?? 50 }],
      ambiguous: false,
    };
  }

  const candidates: MatchResult[] = [];
  for (const pack of packs) {
    const hits = evaluateDetectSignals({ pack, adopterRoot });
    if (hits.length === 0) continue;
    candidates.push({
      pack,
      matched_signals: hits,
      priority: pack.detect.priority ?? 50,
    });
  }

  // Sort: signal-hit count desc (more-specific match wins), then by
  // declared priority desc as a tiebreaker, then by id asc for a
  // deterministic final ordering. Hit-count primacy means a pack
  // whose specific signals fired beats a pack with a higher
  // advertised priority that only matched baseline (shared) signals
  // — the right outcome for the laravel-postgres-X family where
  // the variants share Laravel signals and disambiguate on the
  // frontend-specific ones.
  candidates.sort((a, b) => {
    if (a.matched_signals.length !== b.matched_signals.length) {
      return b.matched_signals.length - a.matched_signals.length;
    }
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.pack.id < b.pack.id ? -1 : a.pack.id > b.pack.id ? 1 : 0;
  });

  const top = candidates[0];
  if (top === undefined) {
    return { matched: null, candidates: [], ambiguous: false };
  }
  const tied = candidates.filter(
    (c) => c.matched_signals.length === top.matched_signals.length && c.priority === top.priority,
  );
  return {
    matched: top.pack,
    candidates,
    ambiguous: tied.length > 1,
  };
}
