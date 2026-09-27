import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import { readProcessSync } from '@devai-nyx/authority';
import { parseAdrFrontMatter } from '@devai-nyx/spec';

export interface GovernanceFinding {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface GovernanceIntegrityReport {
  readonly ok: boolean;
  readonly findings: readonly GovernanceFinding[];
}

export interface ParsedGovernanceRecord {
  readonly path: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly source: string;
}

interface ArchiveManifest {
  readonly files?: readonly {
    readonly path?: unknown;
    readonly sha256?: unknown;
  }[];
}

// A scoped second-generation identity is matched exactly, so a record filename such as
// `ADR-GOV-0001-slug.md` cites ADR-GOV-0001; any other ADR token keeps the greedy form.
const DECISION_ID =
  /\b(?:DII-[0-9]+|ADR-[A-Z][A-Z0-9]{1,15}(?:-[A-Z][A-Z0-9]{1,15})*-[0-9]{4}(?![A-Za-z0-9])|ADR-[A-Za-z0-9-]+\b)/gu;
const SCOPED_DECISION_ID = /^ADR-[A-Z][A-Z0-9]{1,15}(?:-[A-Z][A-Z0-9]{1,15})*-[0-9]{4}$/u;
const LEGACY_DECISION_ID = /^ADR-[0-9]{3}$/u;
const DEFAULT_RECORDS_DIR = 'law/adr';
const ADR_VALIDATION_POLICY = 'law/policy/adr-validation.json';
const DEFAULT_ROUNDS_DIR = 'work/rounds';
const DEFAULT_ARCHIVE_DIR = 'law/adr/archive';

function scalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === '[]') return [];
  if (trimmed === '{}') return {};
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      // Generated inline arrays use JSON quoting, including embedded separators.
      return JSON.parse(trimmed) as unknown;
    } catch {
      // Retain the existing bare-word and semicolon-separated YAML subset.
    }
    const inner = trimmed.slice(1, -1).trim();
    return inner.length === 0 ? [] : inner.split(/[;,]/u).map((item) => scalar(item));
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    if (trimmed.startsWith('"')) {
      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        // Non-JSON quoted forms retain the existing subset interpretation.
      }
    }
    return trimmed.slice(1, -1);
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?[0-9]+$/u.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseYamlSubset(source: string): Record<string, unknown> {
  const lines = source
    .split('\n')
    .map((raw) => ({
      raw,
      indent: raw.length - raw.trimStart().length,
      text: raw.trim(),
    }))
    .filter((line) => line.text.length > 0 && !line.text.startsWith('#'));

  function parseObject(start: number, indent: number): [Record<string, unknown>, number] {
    const result = Object.create(null) as Record<string, unknown>;
    let index = start;
    while (index < lines.length) {
      const line = lines[index];
      if (line === undefined || line.indent < indent) break;
      if (line.indent > indent || line.text.startsWith('- ')) break;
      const colon = line.text.indexOf(':');
      if (colon < 1) {
        index += 1;
        continue;
      }
      const key = line.text.slice(0, colon).trim();
      const value = line.text.slice(colon + 1).trim();
      if (value.length > 0) {
        result[key] = scalar(value);
        index += 1;
        continue;
      }
      const next = lines[index + 1];
      if (next === undefined || next.indent <= indent) {
        result[key] = {};
        index += 1;
      } else if (next.text.startsWith('- ')) {
        const [items, nextIndex] = parseArray(index + 1, next.indent);
        result[key] = items;
        index = nextIndex;
      } else {
        const [child, nextIndex] = parseObject(index + 1, next.indent);
        result[key] = child;
        index = nextIndex;
      }
    }
    return [result, index];
  }

  function parseArray(start: number, indent: number): [unknown[], number] {
    const result: unknown[] = [];
    let index = start;
    while (index < lines.length) {
      const line = lines[index];
      if (line === undefined || line.indent < indent) break;
      if (line.indent !== indent || !line.text.startsWith('- ')) break;
      const item = line.text.slice(2).trim();
      if (item.includes(':')) {
        const colon = item.indexOf(':');
        const object = Object.create(null) as Record<string, unknown>;
        object[item.slice(0, colon).trim()] = scalar(item.slice(colon + 1).trim());
        index += 1;
        while (index < lines.length) {
          const nested = lines[index];
          if (nested === undefined || nested.indent <= indent) break;
          const nestedColon = nested.text.indexOf(':');
          if (nestedColon < 1) {
            index += 1;
            continue;
          }
          const key = nested.text.slice(0, nestedColon).trim();
          const value = nested.text.slice(nestedColon + 1).trim();
          if (value.length > 0) {
            object[key] = scalar(value);
            index += 1;
          } else {
            const after = lines[index + 1];
            if (after === undefined || after.indent <= nested.indent) {
              object[key] = {};
              index += 1;
            } else if (after.text.startsWith('- ')) {
              const [items, nextIndex] = parseArray(index + 1, after.indent);
              object[key] = items;
              index = nextIndex;
            } else {
              const [child, nextIndex] = parseObject(index + 1, after.indent);
              object[key] = child;
              index = nextIndex;
            }
          }
        }
        result.push(object);
      } else {
        result.push(scalar(item));
        index += 1;
      }
    }
    return [result, index];
  }

  return parseObject(0, lines[0]?.indent ?? 0)[0];
}

export function parseGovernanceRecord(path: string): ParsedGovernanceRecord {
  const source = readFileSync(path, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?/u.exec(source);
  if (match === null) {
    throw new Error('frontmatter is required');
  }
  return {
    path,
    frontmatter: parseYamlSubset(match[1] ?? ''),
    body: source.slice(match[0].length),
    source,
  };
}

function markdownFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name !== 'README.md' && name !== 'codex-pre-v1.md')
    .map((name) => join(dir, name))
    .sort((left, right) =>
      basename(left).localeCompare(basename(right), undefined, { numeric: true }),
    );
}

function git(repoRoot: string, args: readonly string[], trim = true): string | null {
  const result = readProcessSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? (trim ? result.stdout.trim() : result.stdout) : null;
}

function gitFile(repoRoot: string, commit: string, path: string): string | null {
  return git(repoRoot, ['show', `${commit}:${path}`], false);
}

interface HistoricalPath {
  readonly commit: string;
  readonly path: string;
}

function recordHistory(repoRoot: string, path: string): HistoricalPath[] | null {
  const output = git(repoRoot, [
    'log',
    '--follow',
    '--find-renames=1%',
    '--format=%H',
    '--name-status',
    '--',
    path,
  ]);
  if (output === null) return null;
  const entries: HistoricalPath[] = [];
  let commit: string | undefined;
  for (const line of output.split('\n').map((value) => value.trim())) {
    if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(line)) {
      commit = line;
    } else if (line.length > 0 && commit !== undefined) {
      const fields = line.split('\t');
      const status = fields[0] ?? '';
      const copied = status.startsWith('C');
      const historicalPath = status.startsWith('R') || copied ? fields[2] : fields[1];
      if (historicalPath === undefined) continue;
      entries.push({ commit, path: historicalPath });
      commit = undefined;
      // `--follow` traverses both renames and sufficiently similar copies. A rename is
      // the same record and must retain its seal; a copy starts a distinct record whose
      // source history must not be inherited.
      if (copied) break;
    }
  }
  return entries.reverse();
}

function normalizedSealedFrontmatter(record: ParsedGovernanceRecord): string {
  const { status: _lifecycle, superseded_by: _replacement, ...rest } = record.frontmatter;
  return JSON.stringify(rest);
}

function replacementId(record: ParsedGovernanceRecord): string | null {
  const value = record.frontmatter['superseded_by'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sealedTransitionAllowed(
  before: ParsedGovernanceRecord,
  after: ParsedGovernanceRecord,
): boolean {
  const beforeStatus = String(before.frontmatter['status']);
  const afterStatus = String(after.frontmatter['status']);
  const beforeReplacement = replacementId(before);
  const afterReplacement = replacementId(after);

  if (beforeStatus === 'active') {
    if (afterStatus === 'active') return afterReplacement === beforeReplacement;
    if (afterStatus === 'superseded') {
      return beforeReplacement === null && afterReplacement !== null;
    }
    return false;
  }
  return (
    beforeStatus === 'superseded' &&
    afterStatus === beforeStatus &&
    afterReplacement === beforeReplacement
  );
}

function sealedHistoryFindings(
  repoRoot: string,
  record: ParsedGovernanceRecord,
): GovernanceFinding[] {
  const rel = relative(repoRoot, record.path);
  const history = recordHistory(repoRoot, rel);
  if (history === null || history.length === 0) {
    return [
      {
        code: 'DECISION_HISTORY_UNAVAILABLE',
        message: `${rel} history could not be enumerated completely.`,
        path: rel,
      },
    ];
  }
  let sealed: ParsedGovernanceRecord | undefined;
  let sealIndex = -1;
  for (const [index, entry] of history.entries()) {
    const source = gitFile(repoRoot, entry.commit, entry.path);
    if (source === null) {
      return [
        {
          code: 'DECISION_HISTORY_UNAVAILABLE',
          message: `${rel} revision ${entry.commit}:${entry.path} could not be read.`,
          path: rel,
        },
      ];
    }
    try {
      const candidate = parseRecordSource(entry.path, source);
      if (
        validators.recordMeta(candidate.frontmatter) &&
        ['active', 'superseded'].includes(String(candidate.frontmatter['status']))
      ) {
        sealed = candidate;
        sealIndex = index;
        break;
      }
    } catch {
      // A schema-invalid revision cannot establish the sealing boundary.
    }
  }
  if (sealed === undefined || sealIndex < 0) return [];
  const originalSeal = sealed;
  let lockedMutationObserved = false;
  const priorTerminalStates: string[] = [];
  // Validate the exact inspected bytes as the final revision, even before commit.
  const laterHistory: { commit: string | null; path: string }[] = [
    ...history.slice(sealIndex + 1),
    { commit: null, path: record.path },
  ];
  for (const [laterIndex, entry] of laterHistory.entries()) {
    const laterSource =
      entry.commit === null ? record.source : gitFile(repoRoot, entry.commit, entry.path);
    if (laterSource === null) {
      return [
        {
          code: 'DECISION_HISTORY_UNAVAILABLE',
          message: `${rel} revision ${entry.commit}:${entry.path} could not be read.`,
          path: rel,
        },
      ];
    }
    let later: ParsedGovernanceRecord;
    try {
      later = parseRecordSource(entry.path, laterSource);
    } catch (error) {
      return [
        {
          code: 'DECISION_HISTORY_PARSE_INVALID',
          message: `${rel} has malformed post-seal history at ${entry.commit}: ${error instanceof Error ? error.message : String(error)}.`,
          path: rel,
        },
      ];
    }
    if (
      later.body !== sealed.body ||
      normalizedSealedFrontmatter(later) !== normalizedSealedFrontmatter(sealed) ||
      !sealedTransitionAllowed(sealed, later)
    ) {
      lockedMutationObserved = true;
    }
    if (
      laterIndex < laterHistory.length - 1 &&
      String(later.frontmatter['status']) === 'superseded'
    ) {
      priorTerminalStates.push(
        `${String(later.frontmatter['status'])}:${replacementId(later) ?? ''}`,
      );
    }
    sealed = later;
  }
  if (lockedMutationObserved) {
    const bytesAndStableFieldsRestored =
      sealed.body === originalSeal.body &&
      normalizedSealedFrontmatter(sealed) === normalizedSealedFrontmatter(originalSeal);
    const fullyRestored =
      bytesAndStableFieldsRestored &&
      String(sealed.frontmatter['status']) === String(originalSeal.frontmatter['status']) &&
      replacementId(sealed) === replacementId(originalSeal);
    const finalTerminalState = `${String(sealed.frontmatter['status'])}:${replacementId(sealed) ?? ''}`;
    const restoredThroughTerminalTransition =
      String(originalSeal.frontmatter['status']) === 'active' &&
      priorTerminalStates.every((state) => state === finalTerminalState) &&
      String(sealed.frontmatter['status']) === 'superseded' &&
      bytesAndStableFieldsRestored &&
      sealedTransitionAllowed(originalSeal, sealed);
    if (!fullyRestored && !restoredThroughTerminalTransition) {
      return [
        {
          code: 'DECISION_LOCKED_BODY_MUTATED',
          message: `${rel} changed after its sealing commit; only a canonical terminal lifecycle transition is allowed.`,
          path: rel,
        },
      ];
    }
  }
  return [];
}

function parseRecordSource(path: string, source: string): ParsedGovernanceRecord {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?/u.exec(source);
  if (match === null) throw new Error('frontmatter is required');
  return {
    path,
    frontmatter: parseYamlSubset(match[1] ?? ''),
    body: source.slice(match[0].length),
    source,
  };
}

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

export function archiveImmutability(options: {
  readonly repoRoot: string;
  readonly archiveDir?: string;
}): GovernanceIntegrityReport {
  const archiveDir = resolve(options.repoRoot, options.archiveDir ?? DEFAULT_ARCHIVE_DIR);
  const manifestPath = join(archiveDir, 'MANIFEST.json');
  const archiveStat = lstatSync(archiveDir, { throwIfNoEntry: false });
  if (archiveStat === undefined) return { ok: true, findings: [] };
  if (!archiveStat.isDirectory())
    return {
      ok: false,
      findings: [
        {
          code: 'ARCHIVE_MANIFEST_INVALID',
          message: 'Archive root must be a directory, not a link.',
          path: relative(options.repoRoot, archiveDir),
        },
      ],
    };
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      findings: [
        {
          code: 'ARCHIVE_MANIFEST_MISSING',
          message: `${relative(options.repoRoot, archiveDir)} has no MANIFEST.json.`,
          path: relative(options.repoRoot, archiveDir),
        },
      ],
    };
  }
  let manifest: ArchiveManifest;
  try {
    if (!lstatSync(manifestPath).isFile()) throw new Error('manifest is not a regular file');
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ArchiveManifest;
    if (
      manifest === null ||
      typeof manifest !== 'object' ||
      Array.isArray(manifest) ||
      !Array.isArray(manifest.files)
    )
      throw new Error('manifest files array is required');
  } catch {
    return {
      ok: false,
      findings: [
        {
          code: 'ARCHIVE_MANIFEST_INVALID',
          message: 'MANIFEST.json must be a regular JSON file containing a files array.',
          path: relative(options.repoRoot, manifestPath),
        },
      ],
    };
  }
  const findings: GovernanceFinding[] = [];
  const declared = new Set<string>();
  const inventory = new Map<string, string>();
  const scan = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) scan(path);
      else if (stat.isFile()) inventory.set(relative(archiveDir, path).split(sep).join('/'), path);
      else
        findings.push({
          code: 'ARCHIVE_FILE_UNSAFE',
          message: 'Archive members must not be links or special files.',
          path: relative(options.repoRoot, path),
        });
    }
  };
  scan(archiveDir);
  for (const entry of manifest.files ?? []) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.path !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
      /[\\\p{Cc}]/u.test(entry.path) ||
      /^[A-Za-z]:/u.test(entry.path) ||
      !entry.path
        .split('/')
        .every((part: string) => part !== '' && part !== '.' && part !== '..') ||
      entry.path === 'MANIFEST.json' ||
      declared.has(entry.path)
    ) {
      findings.push({
        code: 'ARCHIVE_MANIFEST_INVALID',
        message:
          'Every manifest entry requires a unique canonical member path and lowercase SHA-256.',
        path: relative(options.repoRoot, manifestPath),
      });
      continue;
    }
    declared.add(entry.path);
    const path = inventory.get(entry.path);
    if (path === undefined) {
      findings.push({
        code: 'ARCHIVE_FILE_MISSING',
        message: `${entry.path} is declared but absent.`,
        path: relative(options.repoRoot, join(archiveDir, entry.path)),
      });
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (actual !== entry.sha256) {
      findings.push({
        code: 'ARCHIVE_HASH_MISMATCH',
        message: `${entry.path} does not match its frozen SHA-256.`,
        path: relative(options.repoRoot, path),
      });
    }
  }
  for (const [rel, path] of inventory) {
    if (rel !== 'MANIFEST.json' && !declared.has(rel)) {
      findings.push({
        code: 'ARCHIVE_FILE_UNDECLARED',
        message: `${rel} is not pinned by MANIFEST.json.`,
        path: relative(options.repoRoot, path),
      });
    }
  }
  return { ok: findings.length === 0, findings };
}

function closedRoundHistoryFindings(
  repoRoot: string,
  rel: string,
  name: string,
): readonly GovernanceFinding[] {
  const unavailable = (): readonly GovernanceFinding[] => [
    {
      code: 'ROUND_HISTORY_UNAVAILABLE',
      message: `${name} closed history could not be verified completely.`,
      path: rel,
    },
  ];
  const history = git(repoRoot, ['log', '--format=%H', '--reverse', '--', rel]);
  if (history === null || history.length === 0) return unavailable();
  let sealedTree: string | undefined;
  for (const commit of history.split('\n').filter(Boolean)) {
    const tree = git(repoRoot, ['rev-parse', `${commit}:${rel}`]);
    if (tree === null) return unavailable();
    if (sealedTree !== undefined) {
      if (tree !== sealedTree) {
        return [
          {
            code: 'ROUND_ARCHIVE_MUTATED',
            message: `${name} changed after its first closed commit.`,
            path: rel,
          },
        ];
      }
      continue;
    }
    const recordPath = `${rel}/record.md`;
    const population = git(repoRoot, ['ls-tree', '--name-only', commit, '--', recordPath]);
    if (population === null) return unavailable();
    if (population.length === 0) continue; // Working scaffold before a record exists.
    const source = gitFile(repoRoot, commit, recordPath);
    if (source === null) return unavailable();
    let record: ParsedGovernanceRecord;
    try {
      record = parseRecordSource(recordPath, source);
    } catch {
      return unavailable();
    }
    if (record.frontmatter['status'] === 'closed') sealedTree = tree;
  }
  return sealedTree === undefined ? unavailable() : [];
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

export function renderDecisionRecords(options: {
  readonly repoRoot: string;
  readonly recordsDir?: string;
}): string {
  const recordsDir = resolve(options.repoRoot, options.recordsDir ?? DEFAULT_RECORDS_DIR);
  const bodies = markdownFiles(recordsDir).map((path) => parseGovernanceRecord(path).body);
  return [
    '# Design Decisions',
    '',
    '<!-- generated from canonical records; do not edit -->',
    '',
    ...bodies,
  ].join('\n');
}

function markdownTableText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, '<br>');
}

export function renderDecisionIndex(options: {
  readonly repoRoot: string;
  readonly recordsDir?: string;
}): string {
  const recordsDir = resolve(options.repoRoot, options.recordsDir ?? DEFAULT_RECORDS_DIR);
  const rows = markdownFiles(recordsDir).map((path) => {
    const record = parseGovernanceRecord(path);
    return [
      String(record.frontmatter['id'] ?? ''),
      String(record.frontmatter['title'] ?? ''),
      String(record.frontmatter['status'] ?? ''),
      String(record.frontmatter['round'] ?? ''),
      String(record.frontmatter['date'] ?? ''),
      encodeURIComponent(basename(path)).replace(/[()]/g, (character) =>
        character === '(' ? '%28' : '%29',
      ),
    ];
  });
  return [
    '# Governance decision records',
    '',
    '<!-- generated from canonical record frontmatter; do not edit -->',
    '',
    '| ID | Title | Status | Round | Date |',
    '|---|---|---|---|---|',
    ...rows.map(
      ([id = '', title = '', status = '', round = '', date = '', filename]) =>
        `| [${markdownTableText(id)}](./${filename}) | ${[title, status, round, date].map(markdownTableText).join(' | ')} |`,
    ),
    '',
  ].join('\n');
}

export function renderRoundRecords(options: {
  readonly repoRoot: string;
  readonly roundsDir?: string;
}): string {
  const roundsDir = resolve(options.repoRoot, options.roundsDir ?? DEFAULT_ROUNDS_DIR);
  if (!existsSync(roundsDir)) return '# Governed Rounds\n';
  const bodies = readdirSync(roundsDir)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((name) => join(roundsDir, name, 'record.md'))
    .filter(existsSync)
    .map((path) => parseGovernanceRecord(path).body);
  return [
    '# Governed Rounds',
    '',
    '<!-- generated from sealed round records -->',
    '',
    ...bodies,
  ].join('\n');
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
