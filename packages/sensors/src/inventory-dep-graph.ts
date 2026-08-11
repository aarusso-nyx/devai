import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { join, relative, resolve as pathResolve, dirname } from 'node:path';
import ts from 'typescript';
import { validators } from '@devai-nyx/schemas';
import { buildSensorReading, type SensorReading, type SensorStatus } from './sensor-reading.js';
import { DEFAULT_IGNORE_DIRS, parseSource, walkTs } from './inventory-walker.js';

/**
 * Inventory sensor: TypeScript dependency graph (REDOX-DepGraph, Phase 17.C1).
 *
 * Walks TS source under repoRoot, parses each file's import / re-export
 * specifiers, and emits an adjacency-list graph conforming to
 * `dep-graph.schema.json` (absorbed in Phase 17.B).
 *
 * Distinct from `the shared inventory helper/dependency-graph` (which produces
 * an edge-list + canonical hash for the F4 inventory). They share intent
 * but diverge in output shape and lifecycle: this sensor emits a tier-L0
 * `SensorReading` for the scorecard + a body file under
 * `record/proofs/sensors/inventory_dep_graph/` for downstream gates.
 *
 * Per Constitution Article 17 (sensor adapter uniformity); per D-57.
 */

export interface InventoryDepGraphOptions {
  readonly repoRoot: string;
  /** Directory under repoRoot to scan (default: repoRoot itself). */
  readonly scanDir?: string;
  /** Directories to ignore during traversal (default: node_modules / dist / generated / .git / coverage / .devai). */
  readonly ignoreDirs?: ReadonlySet<string>;
  /** Override the body-file location (default: <repoRoot>/record/proofs/sensors/inventory_dep_graph/dep-graph.json). */
  readonly bodyPath?: string;
  /** False for pure observation callers that must not materialize canonical state. */
  readonly persistBody?: boolean;
  readonly now?: string;
}

export interface DepGraphBody {
  readonly graph: Record<string, readonly string[]>;
}

export interface InventoryDepGraphResult {
  readonly reading: SensorReading;
  readonly body: DepGraphBody;
  readonly bodyPath: string | null;
}

function importSpecifier(node: ts.Statement): string | null {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isExportDeclaration(node) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  return null;
}

/**
 * Build the adjacency-list body. Local imports are stored as repo-relative
 * paths with .js → .ts rewriting (TS imports name the emitted .js but the
 * source is .ts). External imports are stored verbatim (e.g. 'node:fs',
 * '@devai-nyx/utils', 'pg').
 */
function buildBody(repoRoot: string, files: readonly string[]): DepGraphBody {
  const graph: Record<string, string[]> = {};
  for (const file of files) {
    const sf = parseSource(file);
    if (sf === null) continue;
    const fromRel = relative(repoRoot, file);
    const targets: string[] = graph[fromRel] ?? [];
    for (const stmt of sf.statements) {
      const spec = importSpecifier(stmt);
      if (spec === null) continue;
      let target: string;
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const resolved = pathResolve(dirname(file), spec).replace(/\.js$/, '.ts');
        target = relative(repoRoot, resolved);
      } else {
        target = spec;
      }
      if (!targets.includes(target)) targets.push(target);
    }
    targets.sort();
    graph[fromRel] = targets;
  }
  // Sort keys for deterministic emission.
  const sorted: Record<string, string[]> = {};
  for (const k of Object.keys(graph).sort()) {
    const v = graph[k];
    if (v !== undefined) sorted[k] = v;
  }
  return { graph: sorted };
}

export function senseInventoryDepGraph(opts: InventoryDepGraphOptions): InventoryDepGraphResult {
  const t0 = Date.now();
  const ignoreDirs = opts.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const scanDir = opts.scanDir ?? opts.repoRoot;
  const findings: Array<{
    readonly severity: 'info' | 'warning' | 'error' | 'critical';
    readonly code: string;
    readonly message: string;
  }> = [];

  let body: DepGraphBody;
  let status: SensorStatus = 'pass';
  let bodyPath: string | null = null;

  try {
    const files = walkTs(scanDir, ignoreDirs);
    body = buildBody(opts.repoRoot, files);
  } catch (err) {
    status = 'error';
    findings.push({
      severity: 'critical',
      code: 'DEP_GRAPH_EXTRACTION_FAILED',
      message: err instanceof Error ? err.message : String(err),
    });
    body = { graph: {} };
  }

  // Schema-validate the body against dep-graph.schema.json (Article 32).
  const ok = validators.depGraph(body);
  if (!ok) {
    status = 'error';
    findings.push({
      severity: 'critical',
      code: 'DEP_GRAPH_SCHEMA_INVALID',
      message: `body fails dep-graph.schema.json: ${JSON.stringify(validators.depGraph.errors)}`,
    });
  }

  if (status === 'pass' && opts.persistBody !== false) {
    const defaultPath = join(
      opts.repoRoot,
      'record/proofs/sensors/inventory_dep_graph/dep-graph.json',
    );
    bodyPath = opts.bodyPath ?? defaultPath;
    try {
      mkdirSync(dirname(bodyPath), { recursive: true });
      writeFileSync(bodyPath, JSON.stringify(body, null, 2) + '\n');
    } catch (err) {
      status = 'error';
      bodyPath = null;
      findings.push({
        severity: 'critical',
        code: 'DEP_GRAPH_WRITE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const nodeCount = Object.keys(body.graph).length;
  const edgeCount = Object.values(body.graph).reduce((acc, arr) => acc + arr.length, 0);

  const reading = buildSensorReading({
    sensorName: 'inventory:dep-graph',
    sensorKind: 'inventory_dep_graph',
    sensorVersion: '1.0.0',
    command: ['devai', 'sense', 'dep-graph', '--repo-root', opts.repoRoot],
    status,
    deterministic: true,
    tier: 'L0',
    duration_ms: Date.now() - t0,
    ...(opts.now !== undefined && { timestamp: opts.now }),
    ...(findings.length > 0 && { findings }),
    metrics: { node_count: nodeCount, edge_count: edgeCount },
    ...(bodyPath !== null && { evidence_path: bodyPath }),
  });

  return { reading, body, bodyPath };
}
