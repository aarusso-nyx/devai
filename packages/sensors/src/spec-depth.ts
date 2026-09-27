import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: spec depth (F1 × T2). Phase 26.B (closes D-77
 * sub-batch 26.B). Walks the three authored-spec dirs and emits a
 * per-component depth metric (ADRs + invariants + use-cases referencing
 * each component declared in the invariant population's
 * `scope.components[]`).
 *
 * Status semantics:
 *   - PASS: total invariants ≥ 1 AND total ADRs ≥ 1 (the two
 *     load-bearing spec kinds; use-cases are bonus).
 *   - REVIEW: at least one of {invariants, ADRs} present but the other
 *     absent (incomplete spec coverage).
 *   - FAIL: zero invariants AND zero ADRs (no authored spec substrate at
 *     all — likely indicates the adopter has not yet adopted the F1
 *     authoring discipline).
 *
 * Findings: one per component that has zero invariants (REVIEW
 * severity), surfaced so adopters can see *which* components lack spec
 * depth, not just an aggregate count.
 *
 * Dangling setpoints (ADR-SCR-0004 IA-005): an invariant id referenced by
 * `law/trace.json`, `law/targets/*.json`, or `law/security/*.json` that has
 * no record under the invariants directory is a removed setpoint. Each one
 * is an error finding naming the id and the referencing file, and the
 * reading is FAIL whatever the counts say.
 */

export interface SpecDepthOptions {
  readonly repoRoot: string;
  /** Default: `law/invariants` */
  readonly invariantsDir?: string;
  /** Default: `docs/meta/adr` */
  readonly adrDir?: string;
  /** Default: `product/use-cases` */
  readonly useCasesDir?: string;
  /** Default: `law/trace.json` */
  readonly tracePath?: string;
  /** Default: `law/targets` */
  readonly targetsDir?: string;
  /** Default: `law/security` */
  readonly securityDir?: string;
  readonly now?: string;
}

export interface SpecDepthBody {
  readonly invariant_count: number;
  readonly adr_count: number;
  readonly use_case_count: number;
  readonly components: ReadonlyArray<{
    readonly name: string;
    readonly invariant_count: number;
  }>;
}

function absDir(repoRoot: string, dir: string): string {
  return isAbsolute(dir) ? dir : resolve(repoRoot, dir);
}

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listFiles(dir: string, extLower: string): string[] {
  if (!dirExists(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(extLower))
    .map((f) => join(dir, f));
}

/** Read invariants and tally components mentioned in `scope.components[]`. */
function walkInvariantComponents(invariantsDir: string): Map<string, number> {
  const tally = new Map<string, number>();
  for (const file of listFiles(invariantsDir, '.json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const scope = (parsed as { scope?: unknown }).scope;
    if (typeof scope !== 'object' || scope === null) continue;
    const components = (scope as { components?: unknown }).components;
    if (!Array.isArray(components)) continue;
    for (const c of components) {
      if (typeof c !== 'string' || c.length === 0) continue;
      tally.set(c, (tally.get(c) ?? 0) + 1);
    }
  }
  return tally;
}

/** Invariant ids declared by the records under `invariantsDir` (the `id` field). */
function recordedInvariantIds(invariantsDir: string): Set<string> {
  const ids = new Set<string>();
  for (const file of listFiles(invariantsDir, '.json')) {
    try {
      const id = (JSON.parse(readFileSync(file, 'utf8')) as { id?: unknown }).id;
      if (typeof id === 'string' && id.length > 0) ids.add(id);
    } catch {
      // An unreadable record is the invariant validator's finding, not this sensor's.
    }
  }
  return ids;
}

const INVARIANT_ID_RE = /^INV-[A-Z][A-Z0-9]*-\d{3,}$/;

/** Collect the ids a record references through any `invariants` or `invariant_ids` array. */
function collectReferencedIds(value: unknown, sink: Set<string>, key?: string): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (
        (key === 'invariants' || key === 'invariant_ids') &&
        typeof item === 'string' &&
        INVARIANT_ID_RE.test(item)
      ) {
        sink.add(item);
      } else if (key === 'invariants' && typeof item === 'object' && item !== null) {
        const id = (item as { id?: unknown }).id;
        if (typeof id === 'string' && INVARIANT_ID_RE.test(id)) sink.add(id);
        collectReferencedIds(item, sink);
      } else {
        collectReferencedIds(item, sink);
      }
    }
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [childKey, child] of Object.entries(value)) {
    collectReferencedIds(child, sink, childKey);
  }
}

/** Invariant ids referenced by the trace, target, and security records, per file. */
function referencedInvariantIds(
  repoRoot: string,
  files: readonly string[],
): ReadonlyArray<{ readonly file: string; readonly ids: ReadonlySet<string> }> {
  const out: Array<{ file: string; ids: Set<string> }> = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const ids = new Set<string>();
    collectReferencedIds(parsed, ids);
    if (ids.size > 0) out.push({ file: relative(repoRoot, file).split(sep).join('/'), ids });
  }
  return out;
}

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function senseSpecDepth(opts: SpecDepthOptions): {
  reading: SensorReading;
  body: SpecDepthBody;
} {
  const invariantsDir = absDir(opts.repoRoot, opts.invariantsDir ?? 'law/invariants');
  const adrDir = absDir(opts.repoRoot, opts.adrDir ?? 'docs/meta/adr');
  const useCasesDir = absDir(opts.repoRoot, opts.useCasesDir ?? 'product/use-cases');

  const invariantFiles = listFiles(invariantsDir, '.json');
  const adrFiles = listFiles(adrDir, '.md').filter((f) => !/readme\.md$/i.test(f));
  const useCaseFiles = [
    ...listFiles(useCasesDir, '.json'),
    ...listFiles(useCasesDir, '.md').filter((f) => !/readme\.md$/i.test(f)),
  ];

  const invariantCount = invariantFiles.length;
  const adrCount = adrFiles.length;
  const useCaseCount = useCaseFiles.length;

  const componentTally = walkInvariantComponents(invariantsDir);

  const tracePath = absDir(opts.repoRoot, opts.tracePath ?? 'law/trace.json');
  const referencingFiles = [
    ...(fileExists(tracePath) ? [tracePath] : []),
    ...listFiles(absDir(opts.repoRoot, opts.targetsDir ?? 'law/targets'), '.json').sort(),
    ...listFiles(absDir(opts.repoRoot, opts.securityDir ?? 'law/security'), '.json').sort(),
  ];
  const recordedIds = recordedInvariantIds(invariantsDir);
  const dangling: SensorFinding[] = [];
  for (const { file, ids } of referencedInvariantIds(opts.repoRoot, referencingFiles)) {
    for (const id of [...ids].sort()) {
      if (recordedIds.has(id)) continue;
      dangling.push({
        severity: 'error',
        code: 'SPEC_DEPTH_DANGLING_INVARIANT',
        message: `${file} references invariant ${id}, which has no record under ${invariantsDir}.`,
        file,
      });
    }
  }
  const components = Array.from(componentTally.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, invariant_count]) => ({ name, invariant_count }));

  const findings: SensorFinding[] = [];
  let status: SensorStatus;
  if (invariantCount === 0 && adrCount === 0) {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'SPEC_DEPTH_NO_AUTHORED_SPEC',
      message: `No authored spec substrate found: 0 invariants at ${invariantsDir}, 0 ADRs at ${adrDir}.`,
    });
  } else if (invariantCount === 0 || adrCount === 0) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'SPEC_DEPTH_PARTIAL',
      message: `Spec coverage incomplete: ${String(invariantCount)} invariants, ${String(adrCount)} ADRs. Both should be ≥ 1.`,
    });
  } else {
    status = 'pass';
  }
  if (dangling.length > 0) {
    status = 'fail';
    findings.push(...dangling);
  }

  const body: SpecDepthBody = {
    invariant_count: invariantCount,
    adr_count: adrCount,
    use_case_count: useCaseCount,
    components,
  };

  const command = ['devai', 'sense-spec-depth'];
  const reading = buildSensorReading({
    sensorName: 'spec-depth',
    sensorKind: 'spec_depth',
    command,
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      invariant_count: invariantCount,
      adr_count: adrCount,
      use_case_count: useCaseCount,
      component_count: components.length,
    },
  });
  return { reading, body };
}
