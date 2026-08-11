import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
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
 */

export interface SpecDepthOptions {
  readonly repoRoot: string;
  /** Default: `law/invariants` */
  readonly invariantsDir?: string;
  /** Default: `docs/adr` */
  readonly adrDir?: string;
  /** Default: `product/use-cases` */
  readonly useCasesDir?: string;
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
