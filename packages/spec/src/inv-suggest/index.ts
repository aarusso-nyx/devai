import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from '@devai-nyx/authority';
import { dirname, join, relative } from 'node:path';
import { validators } from '@devai-nyx/schemas';

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

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateUlid(): string {
  let id = '';
  let t = Date.now();
  for (let i = 0; i < 10; i++) {
    id = (CROCKFORD[t & 31] ?? '0') + id;
    t = Math.floor(t / 32);
  }
  const r = randomBytes(16);
  for (let i = 0; i < 16; i++) {
    id += CROCKFORD[(r[i] ?? 0) & 31] ?? '0';
  }
  return id;
}

function newCandidateId(): string {
  return `INV-CANDIDATE-${generateUlid()}`;
}

export interface SuggestOptions {
  readonly repoRoot: string;
  readonly outDir?: string;
  /** Skip persistence — used by tests / dry runs. */
  readonly dryRun?: boolean;
  /** Override default sensor body paths. */
  readonly coverageBodyPath?: string;
  readonly dataHandlingBodyPath?: string;
  readonly depGraphBodyPath?: string;
  readonly rbacBodyPath?: string;
  readonly now?: string;
}

export interface SuggestSummary {
  total: number;
  by_category: Record<InvCandidateCategory, number>;
  unread_inputs: string[];
}

export interface SuggestResult {
  candidates: InvCandidate[];
  summary: SuggestSummary;
  written_files: string[];
}

const DEFAULT_COVERAGE = '.devai/state/sensors/inventory_coverage/coverage-matrix.json';
const DEFAULT_DATA_HANDLING = '.devai/state/sensors/inventory_data_handling/data-model-pii.json';
const DEFAULT_DEP_GRAPH = '.devai/state/sensors/inventory_dep_graph/dep-graph.json';
const DEFAULT_RBAC = '.devai/state/sensors/inventory_rbac/rbac.json';
const DEFAULT_OUT_DIR = '.devai/state/inv-candidates';

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function packageOf(filePath: string): string | null {
  // Extract a "package" identifier from a repo-relative path.
  // packages/spec/src/foo.ts → packages/spec
  // src/foo.ts → src
  // apps/api/src/x.ts → apps/api
  const m = filePath.match(/^(packages\/[^/]+|apps\/[^/]+|src)/);
  return m === null ? null : (m[1] ?? null);
}

function isInternalImport(target: string): boolean {
  return /\/(internal|_internal|private|lib\/internal)\//.test(target);
}

function emitCandidate(c: InvCandidate, now: string): InvCandidate {
  // Re-stamp generated_at to ensure the supplied `now` wins on a
  // dry-run / fixed-clock test path.
  return { ...c, generated_at: now };
}

export function suggestInvariants(opts: SuggestOptions): SuggestResult {
  const now = opts.now ?? new Date().toISOString();
  const candidates: InvCandidate[] = [];
  const unread: string[] = [];
  const byCategory: Record<InvCandidateCategory, number> = {
    unmapped_route: 0,
    unmapped_endpoint: 0,
    unbound_endpoint: 0,
    unlabeled_pii_column: 0,
    forbidden_edge: 0,
  };

  const coveragePath = opts.coverageBodyPath ?? join(opts.repoRoot, DEFAULT_COVERAGE);
  const dataHandlingPath = opts.dataHandlingBodyPath ?? join(opts.repoRoot, DEFAULT_DATA_HANDLING);
  const depGraphPath = opts.depGraphBodyPath ?? join(opts.repoRoot, DEFAULT_DEP_GRAPH);
  const rbacPath = opts.rbacBodyPath ?? join(opts.repoRoot, DEFAULT_RBAC);

  // 1. coverage → unmapped routes + unmapped endpoints
  if (!existsSync(coveragePath)) {
    unread.push(relative(opts.repoRoot, coveragePath));
  } else {
    const cov = readJson<{
      unmapped?: { routes?: readonly string[]; endpoints?: readonly string[] };
    }>(coveragePath);
    if (cov !== null) {
      for (const id of cov.unmapped?.routes ?? []) {
        candidates.push(
          emitCandidate(
            {
              schemaVersion: '1.0.0',
              id: newCandidateId(),
              generated_at: now,
              category: 'unmapped_route',
              source_sensor: 'inventory_coverage',
              confidence: 'high',
              target: { kind: 'route', identifier: id },
              suggested_invariant: {
                title: `Frontend route ${id} must be claimed by ≥1 use-case`,
                statement: `Route ${id} appears in the routes inventory but is not covered by any use-case in the coverage matrix. Author a use-case that claims this route, or remove the route if it is dead UI.`,
                domain_suggestion: 'INVENTORY',
                severity_suggestion: 'gate',
                measurable_via_suggestion: ['sense coverage', 'sense routes'],
                rationale:
                  'Unmapped routes are user-facing flows with no traceable specification. Closing the gap is a precondition to release promotion (INV-INVENTORY-001).',
              },
              related_invariants: ['INV-INVENTORY-001'],
              status: 'proposed',
              tags: ['phase-17-E', 'brownfield', 'coverage'],
            },
            now,
          ),
        );
        byCategory.unmapped_route += 1;
      }
      for (const id of cov.unmapped?.endpoints ?? []) {
        candidates.push(
          emitCandidate(
            {
              schemaVersion: '1.0.0',
              id: newCandidateId(),
              generated_at: now,
              category: 'unmapped_endpoint',
              source_sensor: 'inventory_coverage',
              confidence: 'high',
              target: { kind: 'endpoint', identifier: id },
              suggested_invariant: {
                title: `Backend endpoint ${id} must be claimed by ≥1 use-case`,
                statement: `Endpoint ${id} appears in the api inventory but is not covered by any use-case in the coverage matrix. Author a use-case that claims this endpoint, or remove the endpoint if it is dead API.`,
                domain_suggestion: 'INVENTORY',
                severity_suggestion: 'gate',
                measurable_via_suggestion: ['sense coverage', 'sense api'],
                rationale:
                  'Unmapped endpoints are API surfaces with no traceable specification. Closing the gap is a precondition to release promotion (INV-INVENTORY-001).',
              },
              related_invariants: ['INV-INVENTORY-001'],
              status: 'proposed',
              tags: ['phase-17-E', 'brownfield', 'coverage'],
            },
            now,
          ),
        );
        byCategory.unmapped_endpoint += 1;
      }
    }
  }

  // 2. data-handling → unlabeled PII columns
  if (!existsSync(dataHandlingPath)) {
    unread.push(relative(opts.repoRoot, dataHandlingPath));
  } else {
    const dh = readJson<{
      tables?: ReadonlyArray<{
        name: string;
        columns: ReadonlyArray<{
          name: string;
          pii_class?: string;
          legal_basis?: string;
          retention?: string;
        }>;
        evidence?: readonly InvCandidateEvidence[];
      }>;
    }>(dataHandlingPath);
    if (dh !== null) {
      for (const table of dh.tables ?? []) {
        for (const col of table.columns) {
          if (col.pii_class === undefined || col.pii_class === '') continue;
          const missingBasis = col.legal_basis === undefined || col.legal_basis === '';
          const missingRetention = col.retention === undefined || col.retention === '';
          if (!missingBasis && !missingRetention) continue;
          const missing: string[] = [];
          if (missingBasis) missing.push('legal_basis');
          if (missingRetention) missing.push('retention');
          candidates.push(
            emitCandidate(
              {
                schemaVersion: '1.0.0',
                id: newCandidateId(),
                generated_at: now,
                category: 'unlabeled_pii_column',
                source_sensor: 'inventory_data_handling',
                confidence: 'high',
                target: {
                  kind: 'column',
                  identifier: `${table.name}.${col.name}`,
                  ...(table.evidence !== undefined && { evidence: [...table.evidence] }),
                },
                suggested_invariant: {
                  title: `Column ${table.name}.${col.name} (${col.pii_class}) must have ${missing.join(' + ')}`,
                  statement: `Column ${table.name}.${col.name} is classified as ${col.pii_class} PII but is missing: ${missing.join(', ')}. Per INV-INVENTORY-002, every PII-flagged column MUST declare both legal_basis and retention before release.`,
                  domain_suggestion: 'INVENTORY',
                  severity_suggestion: 'hard-fail',
                  measurable_via_suggestion: ['sense data-handling', 'sense data-model'],
                  rationale:
                    'Unlabeled PII handling is a regulatory exposure (LGPD / GDPR / HIPAA / CCPA). INV-INVENTORY-002 makes this a hard-fail gate; this candidate names the exact column that needs curation.',
                },
                related_invariants: ['INV-INVENTORY-002'],
                status: 'proposed',
                tags: ['phase-17-E', 'brownfield', 'pii', col.pii_class],
              },
              now,
            ),
          );
          byCategory.unlabeled_pii_column += 1;
        }
      }
    }
  }

  // 3. dep-graph → forbidden cross-package internal-subpath edges
  if (!existsSync(depGraphPath)) {
    unread.push(relative(opts.repoRoot, depGraphPath));
  } else {
    const dg = readJson<{ graph?: Record<string, readonly string[]> }>(depGraphPath);
    if (dg !== null && dg.graph !== undefined) {
      for (const [from, tos] of Object.entries(dg.graph)) {
        const fromPkg = packageOf(from);
        for (const to of tos) {
          if (!isInternalImport(to)) continue;
          const toPkg = packageOf(to);
          if (fromPkg === null || toPkg === null) continue;
          if (fromPkg === toPkg) continue; // same-package internal access is allowed
          candidates.push(
            emitCandidate(
              {
                schemaVersion: '1.0.0',
                id: newCandidateId(),
                generated_at: now,
                category: 'forbidden_edge',
                source_sensor: 'inventory_dep_graph',
                confidence: 'high',
                target: {
                  kind: 'edge',
                  identifier: `${from} -> ${to}`,
                  evidence: [{ path: from, startLine: 1, endLine: 1 }],
                },
                suggested_invariant: {
                  title: `Cross-package internal import: ${fromPkg} → ${toPkg}/internal`,
                  statement: `${from} imports from ${to}, crossing a package boundary into a peer's internal subpath. Per INV-INVENTORY-004, this is forbidden: either expose the dependency through the peer's public entry, or move the consumer into the peer package.`,
                  domain_suggestion: 'INVENTORY',
                  severity_suggestion: 'hard-fail',
                  measurable_via_suggestion: ['sense dep-graph'],
                  rationale:
                    'Cross-package internal-subpath coupling is a layering violation that compounds with every dependent change. INV-INVENTORY-004 hard-fails the edge; this candidate names the exact import pair.',
                },
                related_invariants: ['INV-INVENTORY-004'],
                status: 'proposed',
                tags: ['phase-17-E', 'brownfield', 'layering'],
              },
              now,
            ),
          );
          byCategory.forbidden_edge += 1;
        }
      }
    }
  }

  // 4. rbac → unbound endpoints (no @UseGuards / @Roles in api-map).
  // Phase 17's gap-4 fix populated rbac.unmapped.endpointsWithoutRole
  // by walking the api-map's auth.guards / auth.roles per endpoint.
  // Here we lift each entry into a candidate; INV-INVENTORY-003 is the
  // gate the Architect curates these into.
  if (!existsSync(rbacPath)) {
    unread.push(relative(opts.repoRoot, rbacPath));
  } else {
    const rb = readJson<{
      unmapped?: { endpointsWithoutRole?: readonly string[] };
    }>(rbacPath);
    for (const epId of rb?.unmapped?.endpointsWithoutRole ?? []) {
      candidates.push(
        emitCandidate(
          {
            schemaVersion: '1.0.0',
            id: newCandidateId(),
            generated_at: now,
            category: 'unbound_endpoint',
            source_sensor: 'inventory_rbac',
            confidence: 'high',
            target: { kind: 'endpoint', identifier: epId },
            suggested_invariant: {
              title: `Endpoint ${epId} has no role binding`,
              statement: `Endpoint ${epId} appears in the api-map but has no @UseGuards / @Roles declarations and no entry in rbac.bindings.endpointBindings. Per INV-INVENTORY-003, every endpoint MUST either declare a role binding OR carry an explicit auth.required=false claim before release.`,
              domain_suggestion: 'INVENTORY',
              severity_suggestion: 'gate',
              measurable_via_suggestion: ['sense api', 'sense rbac'],
              rationale:
                'Default-deny policy: an endpoint with no declared auth is a discovery gap. Either bind a role (write a guard) OR explicitly mark the endpoint public — ambiguity is not.',
            },
            related_invariants: ['INV-INVENTORY-003'],
            status: 'proposed',
            tags: ['phase-17-E', 'brownfield', 'rbac', 'authorization'],
          },
          now,
        ),
      );
      byCategory.unbound_endpoint += 1;
    }
  }

  // Validate each candidate against the schema. A constructed
  // candidate that fails validation is a programming defect.
  for (const c of candidates) {
    const ok = validators.invCandidate(c);
    if (!ok) {
      throw new Error(
        `inv-suggest: constructed candidate fails inv-candidate.schema.json: ${JSON.stringify(validators.invCandidate.errors)}`,
      );
    }
  }

  // Persist
  const writtenFiles: string[] = [];
  if (opts.dryRun !== true && candidates.length > 0) {
    const outDir = opts.outDir ?? join(opts.repoRoot, DEFAULT_OUT_DIR);
    mkdirSync(outDir, { recursive: true });
    for (const c of candidates) {
      const file = join(outDir, `${c.id}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(c, null, 2) + '\n');
      writtenFiles.push(file);
    }
  }

  return {
    candidates,
    summary: {
      total: candidates.length,
      by_category: byCategory,
      unread_inputs: unread,
    },
    written_files: writtenFiles,
  };
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
      )
    : null;
  const rbac = existsSync(rbacPath)
    ? readJson<{ endpointsWithoutRole?: readonly { id?: string }[] }>(rbacPath)
    : null;
  const dh = existsSync(dataHandlingPath)
    ? readJson<{
        pii?: readonly {
          table?: string;
          column?: string;
          legal_basis?: unknown;
          retention?: unknown;
        }[];
      }>(dataHandlingPath)
    : null;
  const dg = existsSync(depGraphPath)
    ? readJson<{ forbiddenEdges?: readonly { from?: string; to?: string }[] }>(depGraphPath)
    : null;

  const unmappedRoutes = new Set(cov?.unmapped?.routes ?? []);
  const unmappedEndpoints = new Set(cov?.unmapped?.endpoints ?? []);
  const unboundEndpoints = new Set(
    (rbac?.endpointsWithoutRole ?? [])
      .map((e) => e.id)
      .filter((s): s is string => typeof s === 'string'),
  );
  const unlabeledCols = new Set(
    (dh?.pii ?? [])
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
    (dg?.forbiddenEdges ?? []).map((e) => `${e.from ?? ''} -> ${e.to ?? ''}`),
  );

  let entries: string[];
  try {
    entries = readdirSync(outDir);
  } catch {
    return { scanned: 0, stale: 0, kept: 0, evidence: [], evidence_log_path: null };
  }
  const candidates = entries.filter((e) => e.startsWith('INV-CANDIDATE-') && e.endsWith('.json'));

  const evidence: GcStaleEvidence[] = [];
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
    if (parsed === null) {
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
    if (opts.dryRun !== true) {
      try {
        unlinkSync(fullPath);
      } catch {
        /* skip */
      }
    }
  }

  let evidenceLogPath: string | null = null;
  if (evidence.length > 0 && opts.dryRun !== true) {
    evidenceLogPath = join(outDir, 'gc-evidence.jsonl');
    const block = evidence.map((e) => JSON.stringify(e)).join('\n') + '\n';
    try {
      appendFileSync(evidenceLogPath, block);
    } catch {
      /* skip */
    }
  }

  return {
    scanned: candidates.length,
    stale,
    kept,
    evidence,
    evidence_log_path: evidenceLogPath,
  };
}
