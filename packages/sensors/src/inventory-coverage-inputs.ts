import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import type { DeclaredSurfaces } from './declared-surfaces.js';
import { DIRECT_BODY_DIRECTORY, REGENERATED_BODY_DIRECTORY } from './inventory-body-inputs.js';
import type { SensorReading } from './sensor-reading.js';

/**
 * Inventory sensor: coverage matrix (REDOX-CoverageMatrix, Phase 17.C4).
 *
 * Meta-sensor. Consumes api-map (from sense api) + routes-inventory
 * (from sense routes) bodies and assembles a coverage-matrix body
 * conforming to coverage-matrix.schema.json (Phase 17.B):
 *
 *   - routes[]:    flat list of route IDs from routes-inventory
 *   - endpoints[]: flat list of endpoint IDs from api-map (constructed
 *                  as "METHOD path" when the api-map endpoint has no
 *                  explicit id)
 *   - useCases[]:  empty in 17.C4 (LLM-assisted use-case inference is
 *                  deferred to a documentation recipe or a later
 *                  sub-batch); seeded as []
 *   - links[]:     empty for the same reason — a Triad requires a
 *                  use-case to bind to. Path-shaped matches between
 *                  routes and endpoints are surfaced in metrics
 *                  (inferred_path_match_count) but NOT as triads.
 *   - unmapped:    every route and every endpoint, since links[] is
 *                  empty. This is the honest signal: the brownfield
 *                  adoption has surface inventoried but no use-case
 *                  ↔ surface mapping yet.
 *
 * INV-INVENTORY-001 (Phase 17.D, "every route/endpoint covered by ≥1
 * use-case", severity gate) hard-fails on a non-empty unmapped set.
 * The Architect closes that gap by authoring use-cases (manual or via
 * 17.F SKILL writers) and re-running this sensor.
 *
 * Per Constitution Article 17 (sensor adapter uniformity); per D-57.
 */

interface ApiMapEndpointShape {
  readonly id?: string;
  readonly method: string;
  readonly path: string;
}

export interface RoutesInventoryShape {
  readonly framework: string;
  readonly routes: ReadonlyArray<{ readonly id: string; readonly path: string }>;
}

export interface ApiMapShape {
  readonly endpoints: readonly ApiMapEndpointShape[];
}

export interface InventoryCoverageOptions {
  readonly repoRoot: string;
  /**
   * Declared plant surfaces (ADR-SCR-0003). Omitted: every surface is presumed present.
   * With http absent the api-map and routes bodies are not demanded; with actions
   * present the action registry is measured against its use-case links.
   */
  readonly surfaces?: DeclaredSurfaces;
  /**
   * The api-map body. Omitted: the regenerated state body, then the direct default
   * (`resolveBodyInput`, #382). `null`: no api-map input at all.
   */
  readonly apiMapPath?: string | null;
  /** The routes body. Omitted: resolved by `resolveRoutesPath`. `null`: no routes input. */
  readonly routesPath?: string | null;
  readonly bodyPath?: string;
  /** False for pure observation callers that must not materialize canonical state. */
  readonly persistBody?: boolean;
  readonly now?: string;
  /**
   * Framework selector for the routes body. When `routesPath` is absent,
   * the sensor resolves `routes-${framework}.json` exactly.
   */
  readonly framework?: string;
  /**
   * Directory under repoRoot to walk
   * for use-case files (default `product/use-cases`). Each
   * `*.json` file under this directory is parsed as a UseCases
   * record (per `use-cases.schema.json`) and its steps' `refs`
   * are projected into the coverage matrix's `links[]` triads
   * (one triad per route × endpoint combination per step).
   *
   * Adopters without authored use-cases: no behaviour change.
   * The walker silently skips a missing directory and the
   * matrix `links[]` stays empty (REVIEW status, current pre-22.H
   * semantics preserved).
   */
  readonly useCasesDir?: string;
  /**
   * Whether an absolute input path may be read. A body, use-case file or registry it
   * refuses, such as one git ignores, reads as absent. Omitted: every input is read.
   */
  readonly admitFile?: (absolutePath: string) => boolean;
}

interface UseCasesStep {
  readonly action: string;
  readonly refs?: {
    readonly routeIds?: readonly string[];
    readonly endpointIds?: readonly string[];
  };
}

interface UseCasesCase {
  readonly id?: string;
  readonly title?: string;
  readonly mainFlow?: readonly UseCasesStep[];
  readonly alternateFlows?: ReadonlyArray<{
    readonly steps?: readonly UseCasesStep[];
  }>;
}

interface UseCasesShape {
  readonly cases?: readonly UseCasesCase[];
}

export interface InventoryCoverageResult {
  readonly reading: SensorReading;
  readonly body: unknown;
  readonly bodyPath: string | null;
}

export function endpointId(e: ApiMapEndpointShape): string {
  return e.id ?? `${e.method} ${e.path}`;
}

/**
 * Path-pattern match: convert `/foo/:id` and `/foo/{id}` into a
 * regex matching `/foo/<any>`. Used to detect when a frontend
 * route is talking to a specific backend endpoint, even without
 * use-case-level traceability.
 */
function pathPattern(p: string): RegExp {
  const escaped = p
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z_][\w]*)/g, '[^/]+')
    .replace(/\\\{([A-Za-z_][\w]*)\\\}/g, '[^/]+');
  return new RegExp('^' + escaped + '$');
}

/**
 * Walk a use-cases directory and
 * return the parsed records. Files that fail JSON parsing or
 * use-cases-schema validation are skipped with a finding (not
 * a hard fail — an adopter's authoring may be in progress).
 *
 * Returns the loaded cases plus per-file diagnostics for the
 * caller to surface in the SensorReading's findings.
 */
interface LoadedUseCases {
  readonly cases: readonly UseCasesCase[];
  readonly fileCount: number;
  readonly findings: ReadonlyArray<{
    readonly severity: 'info' | 'warning' | 'error';
    readonly code: string;
    readonly message: string;
  }>;
}

export function loadUseCasesFromDir(
  absDir: string,
  admit: (absolutePath: string) => boolean = () => true,
): LoadedUseCases {
  const findings: Array<{ severity: 'info' | 'warning' | 'error'; code: string; message: string }> =
    [];
  const cases: UseCasesCase[] = [];
  let fileCount = 0;
  if (!existsSync(absDir)) {
    return { cases, fileCount: 0, findings };
  }
  try {
    if (!statSync(absDir).isDirectory()) {
      return { cases, fileCount: 0, findings };
    }
  } catch {
    return { cases, fileCount: 0, findings };
  }
  let entries: readonly string[];
  try {
    entries = readdirSync(absDir)
      .filter((n) => n.endsWith('.json') && admit(join(absDir, n)))
      .sort();
  } catch (err) {
    findings.push({
      severity: 'error',
      code: 'COVERAGE_USE_CASES_DIR_UNREADABLE',
      message: `could not read use-cases dir ${absDir}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { cases, fileCount: 0, findings };
  }
  for (const filename of entries) {
    const filePath = join(absDir, filename);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (err) {
      findings.push({
        severity: 'warning',
        code: 'COVERAGE_USE_CASES_PARSE_FAILED',
        message: `failed to parse ${filename}: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (!validators.useCases(parsed)) {
      findings.push({
        severity: 'warning',
        code: 'COVERAGE_USE_CASES_SCHEMA_INVALID',
        message: `${filename} fails use-cases.schema.json: ${JSON.stringify(validators.useCases.errors)}`,
      });
      continue;
    }
    fileCount += 1;
    const body = parsed as UseCasesShape;
    for (const c of body.cases ?? []) {
      cases.push(c);
    }
  }
  return { cases, fileCount, findings };
}

type SynthesizedLink = {
  routeId: string | null;
  endpointId: string | null;
  useCaseId: string;
  linkKind: 'paired' | 'route-only' | 'endpoint-only';
  inferred?: boolean;
};

/**
 * From a
 * list of UseCases, synthesize `coverage-matrix.links[]` triads.
 * Walks every step in `mainFlow` + `alternateFlows.steps`. Three
 * cardinalities are emitted, each tagged with `linkKind`:
 *
 *   - `paired`        — step has both `refs.routeIds` and
 *                       `refs.endpointIds`; emit one triad per
 *                       (route, endpoint) cross-product.
 *   - `route-only`    — step has only `refs.routeIds` (e.g. UI
 *                       navigation step with no API call); emit one
 *                       triad per route with `endpointId: null`.
 *   - `endpoint-only` — step has only `refs.endpointIds` (e.g.
 *                       background job, system-to-system call); emit
 *                       one triad per endpoint with `routeId: null`.
 *
 * Pre-23.C, this synthesizer required BOTH axes on a step and
 * silently dropped single-axis refs. Stynx's `INV-COVERAGE-001`
 * surfaced as a historically recorded set of unmapped routes and
 * endpoints. Many of those step refs only declared endpoints and were
 * silently ignored. Post-23.C, single-axis steps produce links and
 * the violation count drops proportionally. The measured historical
 * prior counts are not part of the runtime result.
 *
 * De-duplication: the same (linkKind, routeId, endpointId, useCaseId)
 * 4-tuple may appear in multiple steps; the synthesizer emits each
 * unique tuple at most once. The first occurrence wins; order across
 * the input use-case files is stable (the loader walks dir entries
 * sorted).
 *
 * Defensive: refs to unknown route/endpoint ids (typos in authored
 * use-cases) are silently dropped before emission.
 */
export function synthesizeLinks(
  cases: readonly UseCasesCase[],
  validRouteIds: ReadonlySet<string>,
  validEndpointIds: ReadonlySet<string>,
): readonly SynthesizedLink[] {
  const seen = new Set<string>();
  const out: SynthesizedLink[] = [];
  for (const c of cases) {
    const useCaseId = c.id;
    if (useCaseId === undefined || useCaseId.length === 0) continue;
    const steps: UseCasesStep[] = [...(c.mainFlow ?? [])];
    for (const alt of c.alternateFlows ?? []) {
      steps.push(...(alt.steps ?? []));
    }
    for (const step of steps) {
      const rawRouteIds = step.refs?.routeIds ?? [];
      const rawEndpointIds = step.refs?.endpointIds ?? [];
      const routeIds = rawRouteIds.filter((id) => validRouteIds.has(id));
      const endpointIds = rawEndpointIds.filter((id) => validEndpointIds.has(id));
      if (routeIds.length > 0 && endpointIds.length > 0) {
        for (const routeId of routeIds) {
          for (const endpointId of endpointIds) {
            const key = `paired|${routeId}|${endpointId}|${useCaseId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ routeId, endpointId, useCaseId, linkKind: 'paired' });
          }
        }
      } else if (routeIds.length > 0) {
        for (const routeId of routeIds) {
          const key = `route-only|${routeId}||${useCaseId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ routeId, endpointId: null, useCaseId, linkKind: 'route-only' });
        }
      } else if (endpointIds.length > 0) {
        for (const endpointId of endpointIds) {
          const key = `endpoint-only||${endpointId}|${useCaseId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ routeId: null, endpointId, useCaseId, linkKind: 'endpoint-only' });
        }
      }
      // steps with neither axis set: skipped (the step is not a
      // claim against the inventoried surface).
    }
  }
  return out;
}

export function countInferredMatches(
  routes: RoutesInventoryShape['routes'],
  endpoints: readonly ApiMapEndpointShape[],
): number {
  // For each route, see if any endpoint path-shape-matches. This is
  // not a traceability triad (no use-case anchor), but it surfaces a
  // structural signal: "this route probably calls this endpoint."
  let n = 0;
  const endpointPatterns = endpoints.map((e) => ({ pattern: pathPattern(e.path), endpoint: e }));
  for (const r of routes) {
    for (const ep of endpointPatterns) {
      if (ep.pattern.test(r.path)) {
        n += 1;
        break;
      }
    }
  }
  return n;
}

export type RoutesPathResolution =
  | { readonly kind: 'resolved'; readonly path: string }
  | {
      readonly kind: 'missing';
      /** The direct-default directory; empty when the caller named no input. */
      readonly directory: string;
    }
  | {
      readonly kind: 'ambiguous';
      readonly directory: string;
      readonly candidates: readonly string[];
    };

/** The repository-relative directories a routes body is looked up in, in order (#382). */
export const ROUTES_BODY_DIRECTORIES: readonly string[] = [
  join(REGENERATED_BODY_DIRECTORY, 'inventory_routes'),
  join(DIRECT_BODY_DIRECTORY, 'inventory_routes'),
];

const ROUTES_BODY_NAME = /^routes-[^.]+\.json$/;

/**
 * Resolve exactly one current routes-inventory body without guessing a framework. An
 * explicit path wins and `null` names no input. Otherwise each directory is consulted in
 * turn (the regenerated state body, then the direct sensor default): with a framework,
 * `routes-<framework>.json`; without one, the single `routes-*.json` the directory holds.
 * Two or more candidates are ambiguous and never guessed between; the next directory is
 * consulted only when a directory holds none. With a framework and no body anywhere, the
 * last directory's path is resolved, so the consumer reports it missing there.
 */
export function resolveRoutesPath(
  repoRoot: string,
  explicit: string | null | undefined,
  framework: string | undefined,
  admit: (absolutePath: string) => boolean = () => true,
  directories: readonly string[] = ROUTES_BODY_DIRECTORIES,
): RoutesPathResolution {
  if (explicit === null) return { kind: 'missing', directory: '' };
  if (explicit !== undefined) return { kind: 'resolved', path: explicit };
  const searched = directories.map((directory) => join(repoRoot, directory));
  for (const dir of searched) {
    if (framework !== undefined) {
      const path = join(dir, `routes-${framework}.json`);
      if (existsSync(path) && admit(path)) return { kind: 'resolved', path };
      continue;
    }
    if (!existsSync(dir)) continue;
    let candidates: string[];
    try {
      candidates = readdirSync(dir)
        .filter((name) => ROUTES_BODY_NAME.test(name) && admit(join(dir, name)))
        .sort();
    } catch {
      continue;
    }
    if (candidates.length === 1) {
      return { kind: 'resolved', path: join(dir, candidates[0] as string) };
    }
    if (candidates.length > 1) return { kind: 'ambiguous', directory: dir, candidates };
  }
  const last = searched[searched.length - 1] ?? repoRoot;
  if (framework !== undefined) {
    return { kind: 'resolved', path: join(last, `routes-${framework}.json`) };
  }
  return { kind: 'missing', directory: last };
}
