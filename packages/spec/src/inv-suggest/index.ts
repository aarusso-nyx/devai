import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { dirname, join, relative } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import {
  DEFAULT_COVERAGE,
  DEFAULT_DATA_HANDLING,
  DEFAULT_DEP_GRAPH,
  DEFAULT_OUT_DIR,
  DEFAULT_RBAC,
  readJson,
} from './inventory-inputs.js';
import {
  isInternalImport,
  packageOf,
  type InvCandidate,
  type InvCandidateCategory,
  type InvCandidateEvidence,
} from './gc-stale.js';
export { gcStaleInvariantCandidates } from './gc-stale.js';
export type {
  GcStaleEvidence,
  GcStaleOptions,
  GcStaleResult,
  InvCandidate,
  InvCandidateCategory,
  InvCandidateEvidence,
  InvCandidateSourceSensor,
  InvCandidateSuggestedInvariant,
  InvCandidateTarget,
} from './gc-stale.js';

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
    }>(coveragePath, 'coverage');
    if (cov === null) unread.push(relative(opts.repoRoot, coveragePath));
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
    }>(dataHandlingPath, 'data-handling');
    if (dh === null) unread.push(relative(opts.repoRoot, dataHandlingPath));
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
    const dg = readJson<{ graph?: Record<string, readonly string[]> }>(depGraphPath, 'dep-graph');
    if (dg === null) unread.push(relative(opts.repoRoot, depGraphPath));
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
    }>(rbacPath, 'rbac');
    if (rb === null) unread.push(relative(opts.repoRoot, rbacPath));
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
