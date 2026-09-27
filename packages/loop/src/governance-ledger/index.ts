import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import { parseAdrFrontMatter } from '@devai-nyx/spec';
import { git } from './history.js';
import {
  parseGovernanceRecord,
  type GovernanceFinding,
  type GovernanceIntegrityReport,
  type ParsedGovernanceRecord,
} from './records.js';
import { closedRoundHistoryFindings, sealedHistoryFindings } from './sealed-history.js';
import { archiveImmutability } from './archive.js';
import {
  DEFAULT_RECORDS_DIR,
  DEFAULT_ROUNDS_DIR,
  markdownFiles,
  renderDecisionIndex,
  renderDecisionRecords,
  renderRoundRecords,
} from './render.js';
export { renderDecisionIndex, renderDecisionRecords, renderRoundRecords } from './render.js';

export { archiveImmutability } from './archive.js';

export { parseGovernanceRecord } from './records.js';
export type {
  GovernanceFinding,
  GovernanceIntegrityReport,
  ParsedGovernanceRecord,
} from './records.js';

// A scoped second-generation identity is matched exactly, so a record filename such as
// `ADR-GOV-0001-slug.md` cites ADR-GOV-0001; any other ADR token keeps the greedy form.
const DECISION_ID =
  /\b(?:DII-[0-9]+|ADR-[A-Z][A-Z0-9]{1,15}(?:-[A-Z][A-Z0-9]{1,15})*-[0-9]{4}(?![A-Za-z0-9])|ADR-[A-Za-z0-9-]+\b)/gu;
const SCOPED_DECISION_ID = /^ADR-[A-Z][A-Z0-9]{1,15}(?:-[A-Z][A-Z0-9]{1,15})*-[0-9]{4}$/u;
const LEGACY_DECISION_ID = /^ADR-[0-9]{3}$/u;
const ADR_VALIDATION_POLICY = 'law/policy/adr-validation.json';

interface CataloguedLegacyRecord {
  readonly reference: string;
  readonly sha256: string;
  readonly supersedes: readonly string[];
}

interface AdrValidationScope {
  /** True when the repository's ADR validation policy binds this record directory. */
  readonly applies: boolean;
  /** Catalogued pre-v2 or preserved-invalid records keyed by path relative to the record directory. */
  readonly catalog: ReadonlyMap<string, CataloguedLegacyRecord>;
  /** Legacy identities the policy declares resolvable. */
  readonly legacyReferences: ReadonlySet<string>;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/**
 * Read `law/policy/adr-validation.json`, the policy `check --only adrs` enforces. When it
 * binds the record directory, every record is judged as a second-generation record except
 * the byte-pinned entries of its exception catalog.
 */
function adrValidationScope(repoRoot: string, recordsDir: string): AdrValidationScope {
  const none: AdrValidationScope = {
    applies: false,
    catalog: new Map(),
    legacyReferences: new Set(),
  };
  const policyPath = resolve(repoRoot, ADR_VALIDATION_POLICY);
  if (!existsSync(policyPath)) return none;
  let policy: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(policyPath, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return none;
    policy = parsed as Record<string, unknown>;
  } catch {
    return none;
  }
  const scan = policy['scan'] as { root?: unknown } | undefined;
  const scanRoot = typeof scan?.root === 'string' ? scan.root : DEFAULT_RECORDS_DIR;
  if (resolve(repoRoot, scanRoot) !== recordsDir) return none;
  const catalog = new Map<string, CataloguedLegacyRecord>();
  const exceptionCatalog = policy['exception_catalog'] as { entries?: unknown } | undefined;
  for (const entry of Array.isArray(exceptionCatalog?.entries) ? exceptionCatalog.entries : []) {
    const candidate = entry as {
      path?: unknown;
      sha256?: unknown;
      legacy_record?: { reference?: unknown; supersedes?: unknown };
    };
    const reference = candidate.legacy_record?.reference;
    if (
      typeof candidate.path === 'string' &&
      typeof candidate.sha256 === 'string' &&
      typeof reference === 'string'
    ) {
      catalog.set(candidate.path, {
        reference,
        sha256: candidate.sha256,
        supersedes: stringArray(candidate.legacy_record?.supersedes),
      });
    }
  }
  const resolver = policy['semantic_resolver'] as
    { resolvable_legacy_references?: unknown } | undefined;
  const legacyReferences = new Set<string>();
  for (const entry of Array.isArray(resolver?.resolvable_legacy_references)
    ? resolver.resolvable_legacy_references
    : []) {
    const reference = (entry as { reference?: unknown }).reference;
    if (typeof reference === 'string') legacyReferences.add(reference);
  }
  return { applies: true, catalog, legacyReferences };
}

function frontmatterBlock(source: string): string {
  return /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(source)?.[1] ?? '';
}

interface DecisionEntry {
  readonly id: string;
  readonly path: string;
  /** `first` is the first-generation shape; `second` is adr-v2 or a catalogued legacy record. */
  readonly generation: 'first' | 'second';
  readonly supersedes: readonly string[];
  readonly supersededBy: string | null;
}

export function decisionRecordIntegrity(options: {
  readonly repoRoot: string;
  readonly recordsDir?: string;
}): GovernanceIntegrityReport {
  const recordsDir = resolve(options.repoRoot, options.recordsDir ?? DEFAULT_RECORDS_DIR);
  const scope = adrValidationScope(options.repoRoot, recordsDir);
  const findings: GovernanceFinding[] = [];
  const hasGitMetadata = existsSync(join(options.repoRoot, '.git'));
  const shallowState = hasGitMetadata
    ? git(options.repoRoot, ['rev-parse', '--is-shallow-repository'])
    : null;
  const historyAvailable = hasGitMetadata && shallowState !== null;
  if (!hasGitMetadata || shallowState === null) {
    findings.push({
      code: 'DECISION_HISTORY_UNAVAILABLE',
      message: 'Sealed decision history requires Git, but repository state could not be queried.',
      path: relative(options.repoRoot, recordsDir),
    });
  } else if (shallowState === 'true') {
    findings.push({
      code: 'DECISION_HISTORY_SHALLOW',
      message:
        'Sealed decision history requires a complete Git history; shallow history cannot pass.',
      path: relative(options.repoRoot, recordsDir),
    });
  }
  const records = new Map<string, DecisionEntry>();
  for (const path of markdownFiles(recordsDir)) {
    const rel = relative(options.repoRoot, path);
    const catalogued = scope.catalog.get(relative(recordsDir, path).split(sep).join('/'));
    if (catalogued !== undefined) {
      // A catalogued record is preserved byte for byte; its metadata comes from the policy.
      const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
      if (actual !== catalogued.sha256) {
        findings.push({
          code: 'DECISION_SCHEMA_INVALID',
          message: `${rel} differs from the bytes pinned by ${ADR_VALIDATION_POLICY}.`,
          path: rel,
        });
        continue;
      }
      if (records.has(catalogued.reference)) {
        findings.push({
          code: 'DECISION_ID_DUPLICATE',
          message: `${catalogued.reference} is declared by more than one record.`,
          path: rel,
        });
      }
      records.set(catalogued.reference, {
        id: catalogued.reference,
        path: rel,
        generation: 'second',
        supersedes: catalogued.supersedes,
        supersededBy: null,
      });
      continue;
    }
    let record: ParsedGovernanceRecord;
    try {
      record = parseGovernanceRecord(path);
    } catch (error) {
      findings.push({
        code: 'DECISION_FRONTMATTER_INVALID',
        message: `${rel}: ${error instanceof Error ? error.message : String(error)}`,
        path: rel,
      });
      continue;
    }
    const declaredId = String(record.frontmatter['id'] ?? '');
    const secondGeneration = scope.applies || SCOPED_DECISION_ID.test(declaredId);
    let supersedes: readonly string[];
    if (secondGeneration) {
      let frontmatter: Record<string, unknown>;
      try {
        frontmatter = parseAdrFrontMatter(frontmatterBlock(record.source));
      } catch (error) {
        findings.push({
          code: 'DECISION_FRONTMATTER_INVALID',
          message: `${rel}: ${error instanceof Error ? error.message : String(error)}`,
          path: rel,
        });
        continue;
      }
      if (!validators.adrV2(frontmatter)) {
        findings.push({
          code: 'DECISION_SCHEMA_INVALID',
          message: `${rel} does not satisfy adr-v2.schema.json.`,
          path: rel,
        });
      }
      supersedes = stringArray(frontmatter['supersedes']);
    } else {
      if (!validators.recordMeta(record.frontmatter)) {
        findings.push({
          code: 'DECISION_SCHEMA_INVALID',
          message: `${rel} does not satisfy decision-record.schema.json.`,
          path: rel,
        });
      }
      supersedes = Array.isArray(record.frontmatter['supersedes'])
        ? record.frontmatter['supersedes'].map(String)
        : [];
    }
    const id = declaredId;
    if (basename(path, '.md') !== id && !basename(path, '.md').startsWith(`${id}-`)) {
      findings.push({
        code: 'DECISION_ID_FILENAME_MISMATCH',
        message: `${rel} declares ${id || '(missing id)'}.`,
        path: rel,
      });
    }
    if (records.has(id)) {
      findings.push({
        code: 'DECISION_ID_DUPLICATE',
        message: `${id} is declared by more than one record.`,
        path: rel,
      });
    }
    const replacement = record.frontmatter['superseded_by'];
    records.set(id, {
      id,
      path: rel,
      generation: secondGeneration ? 'second' : 'first',
      supersedes,
      supersededBy: !secondGeneration && typeof replacement === 'string' ? replacement : null,
    });
    if (hasGitMetadata && historyAvailable) {
      findings.push(...sealedHistoryFindings(options.repoRoot, record));
    }
  }

  for (const [id, record] of records) {
    for (const target of record.supersedes) {
      const other = records.get(target);
      if (record.generation === 'second') {
        // Second-generation supersession is recorded forward only: the `supersedes` array
        // must resolve, and the superseded record is never required to carry a reverse link.
        if (target === id) {
          findings.push({
            code: 'DECISION_SUPERSESSION_ASYMMETRIC',
            message: `${id} supersedes itself.`,
            path: record.path,
          });
        } else if (other === undefined && !scope.legacyReferences.has(target)) {
          findings.push({
            code: 'DECISION_SUPERSESSION_ASYMMETRIC',
            message: `${id} supersedes ${target}, which resolves to no decision record.`,
            path: record.path,
          });
        }
        continue;
      }
      const reverse = other?.supersededBy === null ? [] : [other?.supersededBy];
      // Draft ADRs may cite archived source filenames in `supersedes`.
      // Reverse symmetry applies only within the live record population;
      // external provenance is resolved by archive citation checks.
      if (
        (other === undefined && LEGACY_DECISION_ID.test(target)) ||
        (other !== undefined && !reverse.includes(id))
      ) {
        findings.push({
          code: 'DECISION_SUPERSESSION_ASYMMETRIC',
          message: `${id} supersedes ${target}, but the reverse link does not resolve.`,
          path: record.path,
        });
      }
    }
    if (record.supersededBy !== null) {
      const target = record.supersededBy;
      const other = records.get(target);
      if (other === undefined || !other.supersedes.includes(id)) {
        findings.push({
          code: 'DECISION_SUPERSESSION_ASYMMETRIC',
          message: `${id} is superseded by ${target}, but the reverse link does not resolve.`,
          path: record.path,
        });
      }
    }
  }
  return { ok: findings.length === 0, findings };
}

function walkFiles(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path).flatMap((entry) => walkFiles(join(path, entry)));
}

export function decisionCitationResolution(options: {
  readonly repoRoot: string;
  readonly roots?: readonly string[];
  readonly recordsDir?: string;
}): GovernanceIntegrityReport {
  const recordsDir = resolve(options.repoRoot, options.recordsDir ?? DEFAULT_RECORDS_DIR);
  const scope = adrValidationScope(options.repoRoot, recordsDir);
  const resolved = new Set<string>(scope.legacyReferences);
  for (const path of markdownFiles(recordsDir)) {
    try {
      const id = parseGovernanceRecord(path).frontmatter['id'];
      if (typeof id === 'string') resolved.add(id);
    } catch {
      // Record-integrity reports malformed records; they cannot resolve citations.
    }
  }
  const registerPath = resolve(options.repoRoot, 'law/register/DECISIONS.md');
  if (existsSync(registerPath)) {
    const register = readFileSync(registerPath, 'utf8');
    for (const match of register.matchAll(/^### (DII-[0-9]+)\b/gmu)) {
      const id = match[1];
      if (id !== undefined) resolved.add(id);
    }
  }
  const roots = options.roots ?? ['README.md', 'law', 'product', 'docs', 'packages', 'work'];
  const strictRoots = options.roots !== undefined;
  // Scoped identities are resolved once the record directory is second-generation: bound by
  // the ADR validation policy or holding a scoped record. A first-generation tree defers them.
  const scopedResolution = scope.applies || [...resolved].some((id) => SCOPED_DECISION_ID.test(id));
  const findings: GovernanceFinding[] = [];
  for (const path of roots.flatMap((root) => walkFiles(resolve(options.repoRoot, root)))) {
    const rel = relative(options.repoRoot, path);
    if (
      rel.split(sep).some((component) => component === 'node_modules' || component === 'dist') ||
      (!strictRoots &&
        (path === recordsDir ||
          path.startsWith(recordsDir + sep) ||
          rel.startsWith('law/register/') ||
          rel.startsWith('law/adr/archive/') ||
          rel.startsWith('docs/site/versioned_docs/') ||
          rel.startsWith('docs/adopters/') ||
          rel.startsWith(['work', 'rounds', ''].join('/')) ||
          /(^|\/)(?:test|tests|fixtures)\//u.test(rel) ||
          rel.endsWith('CHANGELOG.md') ||
          rel.startsWith('packages/schemas/src/generated/'))) ||
      !/\.(?:md|ts|mts|js|mjs|json|ya?ml)$/u.test(path)
    ) {
      continue;
    }
    const body = readFileSync(path, 'utf8');
    for (const match of new Set(body.match(DECISION_ID) ?? [])) {
      if (
        !strictRoots &&
        match.startsWith('ADR-') &&
        !LEGACY_DECISION_ID.test(match) &&
        !(scopedResolution && SCOPED_DECISION_ID.test(match))
      ) {
        continue;
      }
      if (!resolved.has(match)) {
        findings.push({
          code: 'DECISION_CITATION_UNRESOLVED',
          message: `${rel} cites missing ${match}.`,
          path: rel,
        });
      }
    }
  }
  return { ok: findings.length === 0, findings };
}

export function roundRecordIntegrity(options: {
  readonly repoRoot: string;
  readonly roundsDir?: string;
}): GovernanceIntegrityReport {
  const roundsDir = resolve(options.repoRoot, options.roundsDir ?? DEFAULT_ROUNDS_DIR);
  const findings: GovernanceFinding[] = [];
  if (!existsSync(roundsDir)) return { ok: true, findings };
  for (const name of readdirSync(roundsDir).sort()) {
    const dir = join(roundsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const recordPath = join(dir, 'record.md');
    if (!existsSync(recordPath)) {
      findings.push({
        code: 'ROUND_RECORD_MISSING',
        message: `${name} has no record.md.`,
        path: relative(options.repoRoot, dir),
      });
      continue;
    }
    let record: ParsedGovernanceRecord;
    try {
      record = parseGovernanceRecord(recordPath);
    } catch {
      findings.push({
        code: 'ROUND_RECORD_SCHEMA_INVALID',
        message: `${name}/record.md has invalid frontmatter.`,
        path: relative(options.repoRoot, recordPath),
      });
      continue;
    }
    if (!validators.recordMeta(record.frontmatter)) {
      findings.push({
        code: 'ROUND_RECORD_SCHEMA_INVALID',
        message: `${name}/record.md does not satisfy round-record.schema.json.`,
        path: relative(options.repoRoot, recordPath),
      });
    }
    if (record.frontmatter['status'] === 'closed') {
      const phaseClosure = String(record.frontmatter['phase_closure'] ?? '');
      const phaseLedgerPath = join(options.repoRoot, 'record/derived/indexes/rounds.md');
      if (
        phaseClosure.length === 0 ||
        !existsSync(phaseLedgerPath) ||
        !readFileSync(phaseLedgerPath, 'utf8').includes(phaseClosure)
      ) {
        findings.push({
          code: 'ROUND_PHASE_CLOSURE_UNRESOLVED',
          message: `${name} cites missing phase closure ${phaseClosure || '(none)'}.`,
          path: relative(options.repoRoot, recordPath),
        });
      }
      const rel = relative(options.repoRoot, dir);
      findings.push(...closedRoundHistoryFindings(options.repoRoot, rel, name));
    }
  }
  return { ok: findings.length === 0, findings };
}

export const governanceLedger = {
  decisionRecordIntegrity,
  decisionCitationResolution,
  archiveImmutability,
  roundRecordIntegrity,
  renderDecisionRecords,
  renderDecisionIndex,
  renderRoundRecords,
} as const;
