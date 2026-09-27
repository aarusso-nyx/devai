import {
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  appendFileSync,
} from '@devai-nyx/authority';
import { join } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import {
  DEFAULT_COVERAGE,
  DEFAULT_DATA_HANDLING,
  DEFAULT_DEP_GRAPH,
  DEFAULT_OUT_DIR,
  DEFAULT_RBAC,
  readJson,
} from './inventory-inputs.js';

/**
 * Phase 17.E (D-57): the inventory → invariant-candidate bridge.
 *
 * Reads sensor bodies under `.devai/state/sensors/inventory_*` and
 * emits INV-CANDIDATE-<ulid>.json records under
 * `.devai/state/inv-candidates/`. Each candidate flags one of:
 *
 *   unmapped_route       — route id in coverage-matrix.unmapped.routes
 *   unmapped_endpoint    — endpoint id in coverage-matrix.unmapped.endpoints
 *   unbound_endpoint     — endpoint id in rbac.unmapped.endpointsWithoutRole
 *                          (populated by inventory_rbac from api-map's
 *                          @UseGuards / @Roles — Phase 17 gap-4 fix)
 *   unlabeled_pii_column — column has pii_class but missing legal_basis or retention
 *   forbidden_edge       — dep-graph edge crosses packages into peer's internal/
 *
 * The Architect curates the candidates and graduates them into
 * law/invariants/INV-CLIENT-*.json files. This is the
 * cold-start seam D-57 names as the dominant brownfield value.
 */

export type InvCandidateCategory =
  | 'unmapped_route'
  | 'unmapped_endpoint'
  | 'unbound_endpoint'
  | 'unlabeled_pii_column'
  | 'forbidden_edge';

export type InvCandidateSourceSensor =
  | 'inventory_api'
  | 'inventory_routes'
  | 'inventory_coverage'
  | 'inventory_rbac'
  | 'inventory_data_handling'
  | 'inventory_dep_graph';

export interface InvCandidateEvidence {
  path: string;
  startLine: number;
  endLine: number;
}

export interface InvCandidateTarget {
  kind: 'endpoint' | 'route' | 'column' | 'edge' | 'table';
  identifier: string;
  evidence?: InvCandidateEvidence[];
}

export interface InvCandidateSuggestedInvariant {
  title: string;
  statement: string;
  domain_suggestion?: string;
  severity_suggestion: 'constitutional' | 'hard-fail' | 'gate' | 'warn' | 'advisory';
  measurable_via_suggestion?: string[];
  rationale?: string;
}

export interface InvCandidate {
  schemaVersion: '1.0.0';
  id: string;
  generated_at: string;
  category: InvCandidateCategory;
  source_sensor: InvCandidateSourceSensor;
  confidence: 'low' | 'medium' | 'high';
  target: InvCandidateTarget;
  suggested_invariant: InvCandidateSuggestedInvariant;
  related_invariants?: string[];
  status: 'proposed' | 'accepted' | 'rejected' | 'converted';
  tags?: string[];
}

export function packageOf(filePath: string): string | null {
  // Extract a "package" identifier from a repo-relative path.
  // packages/spec/src/foo.ts → packages/spec
  // src/foo.ts → src
  // apps/api/src/x.ts → apps/api
  const m = filePath.match(/^(packages\/[^/]+|apps\/[^/]+|src)/);
  return m === null ? null : (m[1] ?? null);
}

export function isInternalImport(target: string): boolean {
  return /\/(internal|_internal|private|lib\/internal)\//.test(target);
}

// ---------------------------------------------------------------
// Phase 29.H (closes R-3): inv-suggest --gc-stale
// ---------------------------------------------------------------

export interface GcStaleOptions {
  readonly repoRoot: string;
  readonly outDir?: string;
  readonly coverageBodyPath?: string;
  readonly dataHandlingBodyPath?: string;
  readonly depGraphBodyPath?: string;
  readonly rbacBodyPath?: string;
  readonly now?: string;
  /** If true, do not delete files; just report what would be gc'd. */
  readonly dryRun?: boolean;
}

export interface GcStaleEvidence {
  readonly candidate_id: string;
  readonly category: InvCandidateCategory;
  readonly target_identifier: string;
  readonly gc_reason: string;
  readonly gc_timestamp: string;
}

export interface GcStaleResult {
  readonly scanned: number;
  readonly stale: number;
  readonly kept: number;
  readonly evidence: readonly GcStaleEvidence[];
  readonly evidence_log_path: string | null;
}

/**
 * Phase 29.H (closes R-3): garbage-collect stale invariant
 * candidates. For each persisted INV-CANDIDATE-*.json, check
 * whether `target.identifier` still appears in the relevant
 * inventory body's unmapped/unbound/unlabeled list:
 *
 *   unmapped_route / unmapped_endpoint → coverage-matrix.unmapped.*
 *   unbound_endpoint                   → rbac.endpointsWithoutRole
 *   unlabeled_pii_column               → data-model-pii (columns
 *                                        missing legal_basis or retention)
 *   forbidden_edge                     → dep-graph forbidden edges
 *
 * If the candidate's target is no longer surfaced by the current
 * inventory, it has been "claimed" — append a gc_evidence record
 * to `<outDir>/gc-evidence.jsonl` and delete the file.
 *
 * If the relevant inventory body doesn't exist, we can't decide
 * staleness; keep the candidate (preserves audit-trail).
 */
export function gcStaleInvariantCandidates(opts: GcStaleOptions): GcStaleResult {
  const now = opts.now ?? new Date().toISOString();
  const outDir = opts.outDir ?? join(opts.repoRoot, DEFAULT_OUT_DIR);
  if (!existsSync(outDir)) {
    return { scanned: 0, stale: 0, kept: 0, evidence: [], evidence_log_path: null };
  }
  const coveragePath = opts.coverageBodyPath ?? join(opts.repoRoot, DEFAULT_COVERAGE);
  const dataHandlingPath = opts.dataHandlingBodyPath ?? join(opts.repoRoot, DEFAULT_DATA_HANDLING);
  const depGraphPath = opts.depGraphBodyPath ?? join(opts.repoRoot, DEFAULT_DEP_GRAPH);
  const rbacPath = opts.rbacBodyPath ?? join(opts.repoRoot, DEFAULT_RBAC);

  const cov = existsSync(coveragePath)
    ? readJson<{ unmapped?: { routes?: readonly string[]; endpoints?: readonly string[] } }>(
        coveragePath,
        'coverage',
      )
    : null;
  const rbac = existsSync(rbacPath)
    ? readJson<{
        unmapped?: { endpointsWithoutRole?: readonly string[] };
        endpointsWithoutRole?: readonly { id?: string }[];
      }>(rbacPath, 'rbac')
    : null;
  const dh = existsSync(dataHandlingPath)
    ? readJson<{
        tables?: readonly {
          name: string;
          columns: readonly {
            name: string;
            pii_class?: string;
            legal_basis?: string;
            retention?: string;
          }[];
        }[];
        pii?: readonly {
          table?: string;
          column?: string;
          legal_basis?: unknown;
          retention?: unknown;
        }[];
      }>(dataHandlingPath, 'data-handling')
    : null;
  const dg = existsSync(depGraphPath)
    ? readJson<{
        graph?: Record<string, readonly string[]>;
        forbiddenEdges?: readonly { from?: string; to?: string }[];
      }>(depGraphPath, 'dep-graph')
    : null;

  const unmappedRoutes = new Set(cov?.unmapped?.routes ?? []);
  const unmappedEndpoints = new Set(cov?.unmapped?.endpoints ?? []);
  const unboundEndpoints = new Set(
    rbac?.unmapped?.endpointsWithoutRole ??
      (rbac?.endpointsWithoutRole ?? [])
        .map((e) => e.id)
        .filter((s): s is string => typeof s === 'string'),
  );
  const unlabeledCols = new Set(
    dh?.tables !== undefined
      ? dh.tables.flatMap((table) =>
          table.columns
            .filter(
              (column) =>
                column.pii_class !== undefined &&
                column.pii_class !== '' &&
                (!column.legal_basis || !column.retention),
            )
            .map((column) => `${table.name}.${column.name}`),
        )
      : (dh?.pii ?? [])
          .filter(
            (c) =>
              c.legal_basis === undefined ||
              c.legal_basis === null ||
              c.retention === undefined ||
              c.retention === null,
          )
          .map((c) => `${c.table ?? ''}.${c.column ?? ''}`),
  );
  const forbiddenEdges = new Set(
    dg?.graph !== undefined
      ? Object.entries(dg.graph).flatMap(([from, targets]) =>
          targets
            .filter(
              (to) =>
                isInternalImport(to) &&
                packageOf(from) !== null &&
                packageOf(to) !== null &&
                packageOf(from) !== packageOf(to),
            )
            .map((to) => `${from} -> ${to}`),
        )
      : (dg?.forbiddenEdges ?? []).map((e) => `${e.from ?? ''} -> ${e.to ?? ''}`),
  );

  let entries: string[];
  try {
    entries = readdirSync(outDir);
  } catch {
    return { scanned: 0, stale: 0, kept: 0, evidence: [], evidence_log_path: null };
  }
  const candidates = entries.filter((e) => e.startsWith('INV-CANDIDATE-') && e.endsWith('.json'));

  const evidence: GcStaleEvidence[] = [];
  const staleFiles: string[] = [];
  let stale = 0;
  let kept = 0;
  for (const file of candidates) {
    const fullPath = join(outDir, file);
    let parsed: InvCandidate | null = null;
    try {
      parsed = JSON.parse(readFileSync(fullPath, 'utf8')) as InvCandidate;
    } catch {
      kept += 1;
      continue;
    }
    if (parsed === null || !validators.invCandidate(parsed)) {
      kept += 1;
      continue;
    }

    const id = parsed.target?.identifier ?? '';
    let stillSurfaced: boolean;
    let bodyAvailable: boolean;
    switch (parsed.category) {
      case 'unmapped_route':
        stillSurfaced = unmappedRoutes.has(id);
        bodyAvailable = cov !== null;
        break;
      case 'unmapped_endpoint':
        stillSurfaced = unmappedEndpoints.has(id);
        bodyAvailable = cov !== null;
        break;
      case 'unbound_endpoint':
        stillSurfaced = unboundEndpoints.has(id);
        bodyAvailable = rbac !== null;
        break;
      case 'unlabeled_pii_column':
        stillSurfaced = unlabeledCols.has(id);
        bodyAvailable = dh !== null;
        break;
      case 'forbidden_edge':
        stillSurfaced = forbiddenEdges.has(id);
        bodyAvailable = dg !== null;
        break;
      default:
        stillSurfaced = true;
        bodyAvailable = false;
    }

    if (!bodyAvailable) {
      kept += 1;
      continue;
    }
    if (stillSurfaced) {
      kept += 1;
      continue;
    }

    // Stale — target no longer surfaced by the relevant inventory.
    stale += 1;
    evidence.push({
      candidate_id: parsed.id,
      category: parsed.category,
      target_identifier: id,
      gc_reason: 'target no longer surfaced by inventory body',
      gc_timestamp: now,
    });
    staleFiles.push(fullPath);
  }

  let evidenceLogPath: string | null = null;
  if (evidence.length > 0 && opts.dryRun !== true) {
    evidenceLogPath = join(outDir, 'gc-evidence.jsonl');
    const block = evidence.map((e) => JSON.stringify(e)).join('\n') + '\n';
    // Preserve the evidence of the staleness decision before any destructive effect.
    // Propagate failures: callers must reconcile a partial deletion, never report success.
    appendFileSync(evidenceLogPath, block);
    for (const file of staleFiles) unlinkSync(file);
  }

  return {
    scanned: candidates.length,
    stale,
    kept,
    evidence,
    evidence_log_path: evidenceLogPath,
  };
}
