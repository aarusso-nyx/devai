import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';

export interface AdrValidationError {
  readonly code?: string;
  readonly file: string;
  readonly pointer?: string;
  readonly message: string;
}

export interface AdrValidationRecord {
  readonly file: string;
  readonly adr_id: string;
  readonly title: string;
  readonly status: string;
  readonly date: string | null;
  readonly format: 'v2' | 'legacy-catalog';
  readonly supersedes: readonly string[];
  readonly affected_rules: readonly string[];
  readonly effective_affected_rules: readonly string[];
  readonly effective: boolean;
}

export interface AdrValidationSubjectAuthority {
  readonly subject: string;
  readonly lineage_members: readonly string[];
  readonly effective_head: string;
}

export interface AdrValidationResult {
  readonly ok: boolean;
  readonly kernel_id: 'devai.kernel.adr-supersession-resolution.v3';
  readonly semantic_resolution_performed: boolean;
  readonly files_scanned: number;
  readonly errors: readonly AdrValidationError[];
  readonly adrs: readonly AdrValidationRecord[];
  readonly effective_authorities: readonly string[];
  readonly subject_authorities: readonly AdrValidationSubjectAuthority[];
}

const KERNEL_ID = 'devai.kernel.adr-supersession-resolution.v3' as const;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u;
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:\//u;
const GLOB_CHARACTERS = ['*', '?', '[', ']', '{', '}'] as const;

interface AdrValidationPolicy {
  readonly scan: Readonly<{ root: string }>;
  readonly body: Readonly<{ required_sections: readonly string[] }>;
  readonly semantic_resolver: Readonly<{
    kernel_id: string;
    mandatory: boolean;
    resolvable_legacy_references: readonly Readonly<{
      reference: string;
      path: string;
      disposition: 'preserved-pre-v2-record';
    }>[];
  }>;
  readonly exception_catalog: Readonly<{
    catalog_digest_sha256: string;
    entries: readonly Readonly<{
      path: string;
      sha256: string;
      disposition: 'non-record' | 'preserved-pre-v2-record';
      reason: string;
      legacy_record?: Readonly<{
        reference: string;
        title: string;
        status: string;
        date: string | null;
        source_format:
          | 'numeric-id-frontmatter'
          | 'date-id-frontmatter'
          | 'scoped-id-frontmatter'
          | 'no-frontmatter'
          | 'adr_id-frontmatter';
        supersedes: readonly string[];
        affected_rules: readonly string[];
      }>;
    }>[];
  }>;
}

interface ParsedAdr {
  readonly file: string;
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly date: string | null;
  readonly format: AdrValidationRecord['format'];
  readonly supersedes: readonly string[];
  readonly affectedRules: readonly string[];
  readonly catalogPath?: string;
}

/** Parse the deliberately small YAML subset used by ADR frontmatter. */
export function parseAdrFrontMatter(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/u);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '' || line.trim().startsWith('#')) {
      index += 1;
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/u.exec(line);
    if (match === null) throw new Error(`unparseable frontmatter line ${String(index + 1)}`);
    const key = match[1] ?? '';
    if (Object.hasOwn(result, key)) throw new Error(`duplicate frontmatter key '${key}'`);
    const value = match[2] ?? '';
    if (value === '') {
      const members: string[] = [];
      index += 1;
      while (index < lines.length && /^\s*-\s+/u.test(lines[index] ?? '')) {
        members.push((lines[index] ?? '').replace(/^\s*-\s+/u, '').trim());
        index += 1;
      }
      result[key] = members;
      continue;
    }
    if (/^\[.*\]$/u.test(value.trim())) {
      const members = value.trim().slice(1, -1).trim();
      result[key] =
        members === ''
          ? []
          : members.split(',').map((member) => member.trim().replace(/^['"]|['"]$/gu, ''));
    } else {
      result[key] = value.trim().replace(/^['"]|['"]$/gu, '');
    }
    index += 1;
  }
  return result;
}

export interface ValidateAdrsOptions {
  readonly adrsDir: string;
  readonly policyPath?: string;
}

function digest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function jcsCompare(left: unknown, right: unknown): number {
  return Buffer.compare(Buffer.from(canonicalJson(left)), Buffer.from(canonicalJson(right)));
}

function jcsSorted(values: Iterable<string>): string[] {
  return [...values].sort(jcsCompare);
}

function validAffectedRuleSubject(subject: string): boolean {
  const segments = subject.split('/');
  const codePoints = [...subject].length;
  return (
    codePoints >= 1 &&
    codePoints <= 200 &&
    subject.normalize('NFC') === subject &&
    !subject.startsWith('/') &&
    !WINDOWS_DRIVE_ABSOLUTE.test(subject) &&
    !subject.includes('\\') &&
    !subject.includes('\u0000') &&
    !GLOB_CHARACTERS.some((character) => subject.includes(character)) &&
    !segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  );
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function issue(
  errors: AdrValidationError[],
  code: string,
  file: string,
  message: string,
  pointer?: string,
): void {
  errors.push({ code, file, message, ...(pointer === undefined ? {} : { pointer }) });
}

function loadPolicy(path: string, errors: AdrValidationError[]): AdrValidationPolicy | undefined {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      issue(
        errors,
        'adr-semantic-resolution-not-performed',
        path,
        stat.isSymbolicLink()
          ? 'symlinked ADR validation policy is forbidden'
          : 'ADR validation policy is not a regular file',
      );
      return undefined;
    }
  } catch (error) {
    issue(
      errors,
      'adr-semantic-resolution-not-performed',
      path,
      `cannot inspect validation policy: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  let policy: unknown;
  try {
    policy = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    issue(
      errors,
      'adr-semantic-resolution-not-performed',
      path,
      `cannot load validation policy: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  if (!validators.adrValidationPolicy(policy)) {
    for (const error of validators.adrValidationPolicy.errors ?? []) {
      issue(
        errors,
        'adr-semantic-resolution-not-performed',
        path,
        `${error.message ?? 'schema violation'} (${error.keyword})`,
        error.instancePath || undefined,
      );
    }
    return undefined;
  }
  const resolved = policy as AdrValidationPolicy;
  if (resolved.semantic_resolver.kernel_id !== KERNEL_ID || !resolved.semantic_resolver.mandatory) {
    issue(
      errors,
      'adr-semantic-resolution-not-performed',
      path,
      `mandatory ${KERNEL_ID} policy is absent`,
    );
    return undefined;
  }
  return resolved;
}

function markdownFiles(root: string, errors: AdrValidationError[]): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      issue(
        errors,
        'adr-semantic-resolution-not-performed',
        directory,
        `cannot read directory: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch (error) {
        issue(
          errors,
          'adr-semantic-resolution-not-performed',
          path,
          `cannot inspect entry: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (stat.isSymbolicLink()) {
        if (/\.md$/iu.test(entry.name)) {
          files.push(path);
          issue(
            errors,
            'adr-semantic-resolution-not-performed',
            path,
            'symlinked ADR is forbidden',
          );
        }
      } else if (stat.isDirectory()) visit(path);
      else if (stat.isFile() && /\.md$/iu.test(entry.name)) files.push(path);
    }
  };
  visit(root);
  return files;
}

function splitDocument(
  file: string,
  source: string,
  errors: AdrValidationError[],
): { readonly frontmatter: Record<string, unknown>; readonly body: string } | undefined {
  const match = FRONTMATTER.exec(source);
  if (match === null) {
    issue(errors, 'adr-semantic-resolution-not-performed', file, 'missing YAML frontmatter');
    return undefined;
  }
  try {
    return { frontmatter: parseAdrFrontMatter(match[1] ?? ''), body: match[2] ?? '' };
  } catch (error) {
    issue(
      errors,
      'adr-semantic-resolution-not-performed',
      file,
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

function validateExceptionCatalog(
  policy: AdrValidationPolicy,
  policyPath: string,
  errors: AdrValidationError[],
): ReadonlyMap<string, AdrValidationPolicy['exception_catalog']['entries'][number]> {
  const entries = [...policy.exception_catalog.entries].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  );
  if (canonicalSha256(entries) !== policy.exception_catalog.catalog_digest_sha256) {
    issue(errors, 'adr-superseded-record-edited', policyPath, 'exception catalog digest mismatch');
  }
  const result = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    if (result.has(entry.path)) {
      issue(errors, 'adr-duplicate-id', policyPath, `duplicate exception path '${entry.path}'`);
    }
    result.set(entry.path, entry);
  }
  return result;
}

function addSchemaErrors(
  errors: AdrValidationError[],
  file: string,
  schemaErrors: typeof validators.adrV2.errors,
): void {
  for (const error of schemaErrors ?? []) {
    issue(
      errors,
      'adr-semantic-resolution-not-performed',
      file,
      `${error.message ?? 'schema violation'} (${error.keyword})`,
      error.instancePath || undefined,
    );
  }
}

interface AdrSemanticResolution {
  readonly effectiveSubjectsById: ReadonlyMap<string, ReadonlySet<string>>;
  readonly subjectAuthorities: readonly AdrValidationSubjectAuthority[];
}

function noAdrAuthority(): AdrSemanticResolution {
  return { effectiveSubjectsById: new Map(), subjectAuthorities: [] };
}

function semanticResolution(
  records: readonly ParsedAdr[],
  resolvableLegacyReferences: ReadonlyMap<
    string,
    AdrValidationPolicy['semantic_resolver']['resolvable_legacy_references'][number]
  >,
  errors: AdrValidationError[],
): AdrSemanticResolution {
  if (errors.length > 0) return noAdrAuthority();

  for (const record of records) {
    if (record.status === 'accepted' && record.affectedRules.length === 0) {
      issue(
        errors,
        'adr-affected-rule-subject-invalid',
        record.file,
        `${record.id} has no affected-rule subject`,
      );
    }
    if (new Set(record.affectedRules).size !== record.affectedRules.length) {
      issue(
        errors,
        'adr-affected-rule-subject-invalid',
        record.file,
        `${record.id} has duplicate affected-rule subjects`,
      );
    }
    for (const subject of record.affectedRules) {
      if (!validAffectedRuleSubject(subject)) {
        issue(
          errors,
          'adr-affected-rule-subject-invalid',
          record.file,
          `${record.id} has invalid affected-rule subject '${subject}'`,
        );
      }
    }
  }
  if (errors.length > 0) return noAdrAuthority();

  const byId = new Map<string, ParsedAdr>();
  for (const record of records) {
    if (byId.has(record.id)) {
      issue(errors, 'adr-duplicate-id', record.file, `duplicate ADR identity '${record.id}'`);
    } else byId.set(record.id, record);
  }
  if (errors.length > 0) return noAdrAuthority();

  const globalTargets = new Map<string, Set<string>>();
  for (const record of records) {
    globalTargets.set(record.id, new Set());
    for (const target of record.supersedes) {
      if (target === record.id) {
        issue(
          errors,
          'adr-self-supersedes-reference',
          record.file,
          `${record.id} supersedes itself`,
        );
        continue;
      }
      const targetRecord = byId.get(target);
      if (targetRecord === undefined) {
        issue(
          errors,
          /^(?:ADR-[0-9]{3,}|LEGACY:)/u.test(target)
            ? 'adr-uncatalogued-legacy-reference'
            : 'adr-unresolved-supersedes-reference',
          record.file,
          `${record.id} supersedes unresolved identity '${target}'`,
        );
        continue;
      }
      if (targetRecord.format === 'legacy-catalog') {
        const allowed = resolvableLegacyReferences.get(target);
        if (
          allowed === undefined ||
          targetRecord.catalogPath !== allowed.path ||
          allowed.disposition !== 'preserved-pre-v2-record'
        ) {
          issue(
            errors,
            'adr-uncatalogued-legacy-reference',
            record.file,
            `${record.id} supersedes uncatalogued legacy identity '${target}'`,
          );
          continue;
        }
      }
      globalTargets.get(record.id)?.add(target);
    }
  }
  if (errors.length > 0) return noAdrAuthority();

  // Supersession history must be acyclic before authority is projected by subject.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const detectCycle = (id: string): boolean => {
    if (visiting.has(id)) {
      issue(errors, 'adr-supersession-cycle', byId.get(id)?.file ?? id, `cycle includes '${id}'`);
      return true;
    }
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const target of jcsSorted(globalTargets.get(id) ?? [])) {
      if (detectCycle(target)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const id of jcsSorted(byId.keys())) {
    if (detectCycle(id)) return noAdrAuthority();
  }

  interface SubjectGraph {
    readonly nodes: Set<string>;
    readonly targetsBySuccessor: Map<string, Set<string>>;
    readonly adjacency: Map<string, Set<string>>;
  }
  const graphBySubject = new Map<string, SubjectGraph>();
  const ensureSubjectGraph = (subject: string): SubjectGraph => {
    const existing = graphBySubject.get(subject);
    if (existing !== undefined) return existing;
    const graph: SubjectGraph = {
      nodes: new Set(),
      targetsBySuccessor: new Map(),
      adjacency: new Map(),
    };
    graphBySubject.set(subject, graph);
    return graph;
  };
  for (const record of records) {
    if (record.status !== 'accepted') continue;
    for (const subject of record.affectedRules) {
      const graph = ensureSubjectGraph(subject);
      graph.nodes.add(record.id);
      graph.adjacency.set(record.id, graph.adjacency.get(record.id) ?? new Set());
    }
  }
  for (const successor of records) {
    if (successor.status !== 'accepted') continue;
    const successorSubjects = new Set(successor.affectedRules);
    for (const targetId of globalTargets.get(successor.id) ?? []) {
      const target = byId.get(targetId);
      if (target?.status !== 'accepted') continue;
      for (const subject of target.affectedRules) {
        if (!successorSubjects.has(subject)) continue;
        const graph = ensureSubjectGraph(subject);
        const targets = graph.targetsBySuccessor.get(successor.id) ?? new Set<string>();
        targets.add(target.id);
        graph.targetsBySuccessor.set(successor.id, targets);
        graph.adjacency.get(successor.id)?.add(target.id);
        graph.adjacency.get(target.id)?.add(successor.id);
      }
    }
  }

  const effectiveSubjectsById = new Map<string, Set<string>>();
  const subjectAuthorities: AdrValidationSubjectAuthority[] = [];
  for (const subject of jcsSorted(graphBySubject.keys())) {
    const graph = graphBySubject.get(subject);
    if (graph === undefined) continue;
    const componentVisited = new Set<string>();
    for (const seed of jcsSorted(graph.nodes)) {
      if (componentVisited.has(seed)) continue;
      const component = new Set<string>();
      const pending = [seed];
      while (pending.length > 0) {
        const current = pending.pop();
        if (current === undefined || component.has(current)) continue;
        component.add(current);
        componentVisited.add(current);
        pending.push(...jcsSorted(graph.adjacency.get(current) ?? []));
      }
      const members = jcsSorted(component);
      const superseded = new Set<string>();
      const directSuccessors = new Map<string, Set<string>>();
      for (const successorId of members) {
        for (const targetId of graph.targetsBySuccessor.get(successorId) ?? []) {
          if (!component.has(targetId)) continue;
          superseded.add(targetId);
          const successors = directSuccessors.get(targetId) ?? new Set<string>();
          successors.add(successorId);
          directSuccessors.set(targetId, successors);
        }
      }
      const heads = members.filter((member) => !superseded.has(member));
      for (const targetId of jcsSorted(directSuccessors.keys())) {
        const effectiveDirectSuccessors = jcsSorted(
          [...(directSuccessors.get(targetId) ?? [])].filter((id) => heads.includes(id)),
        );
        if (effectiveDirectSuccessors.length > 1) {
          issue(
            errors,
            'adr-multiple-accepted-direct-successors',
            byId.get(targetId)?.file ?? targetId,
            `${targetId} has conflicting effective accepted successors for '${subject}': ${effectiveDirectSuccessors.join(', ')}`,
          );
          return noAdrAuthority();
        }
      }
      if (heads.length !== 1) {
        issue(
          errors,
          'adr-multiple-effective-accepted-heads',
          byId.get(seed)?.file ?? seed,
          `subject lineage '${subject}' has ${String(heads.length)} effective accepted heads: ${heads.join(', ')}`,
        );
        return noAdrAuthority();
      }
      const head = heads[0];
      if (head === undefined) return noAdrAuthority();
      const effectiveSubjects = effectiveSubjectsById.get(head) ?? new Set<string>();
      effectiveSubjects.add(subject);
      effectiveSubjectsById.set(head, effectiveSubjects);
      subjectAuthorities.push({
        subject,
        lineage_members: members,
        effective_head: head,
      });
    }
  }
  subjectAuthorities.sort((left, right) => {
    const bySubject = jcsCompare(left.subject, right.subject);
    return bySubject === 0 ? jcsCompare(left.lineage_members, right.lineage_members) : bySubject;
  });
  return { effectiveSubjectsById, subjectAuthorities };
}

export function validateAdrs(options: ValidateAdrsOptions): AdrValidationResult {
  const errors: AdrValidationError[] = [];
  const policyPath =
    options.policyPath ?? join(dirname(options.adrsDir), 'policy', 'adr-validation.json');
  const empty = (filesScanned = 0): AdrValidationResult => ({
    ok: false,
    kernel_id: KERNEL_ID,
    semantic_resolution_performed: false,
    files_scanned: filesScanned,
    errors,
    adrs: [],
    effective_authorities: [],
    subject_authorities: [],
  });
  const policy = loadPolicy(policyPath, errors);
  if (policy === undefined) return empty();
  const policyBoundAdrsDir = resolve(dirname(policyPath), '..', '..', policy.scan.root);
  if (resolve(options.adrsDir) !== policyBoundAdrsDir) {
    issue(
      errors,
      'adr-semantic-resolution-not-performed',
      options.adrsDir,
      `ADR root does not match policy scan root '${policy.scan.root}'`,
    );
    return empty();
  }
  if (!existsSync(options.adrsDir)) {
    issue(errors, 'adr-semantic-resolution-not-performed', options.adrsDir, 'ADR root is absent');
    return empty();
  }
  try {
    const stat = lstatSync(options.adrsDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      issue(
        errors,
        'adr-semantic-resolution-not-performed',
        options.adrsDir,
        stat.isSymbolicLink() ? 'symlinked ADR root is forbidden' : 'ADR root is not a directory',
      );
      return empty();
    }
  } catch (error) {
    issue(
      errors,
      'adr-semantic-resolution-not-performed',
      options.adrsDir,
      `cannot inspect ADR root: ${error instanceof Error ? error.message : String(error)}`,
    );
    return empty();
  }

  const catalog = validateExceptionCatalog(policy, policyPath, errors);
  const files = markdownFiles(options.adrsDir, errors);
  const seenCatalog = new Set<string>();
  const parsedRecords: ParsedAdr[] = [];
  for (const file of files) {
    if (
      errors.some((error) => error.file === file && error.message === 'symlinked ADR is forbidden')
    ) {
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch (error) {
      issue(
        errors,
        'adr-semantic-resolution-not-performed',
        file,
        `cannot read ADR: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const relativePath = portableRelative(options.adrsDir, file);
    const exception = catalog.get(relativePath);
    if (exception !== undefined) {
      seenCatalog.add(relativePath);
      if (digest(bytes) !== exception.sha256) {
        issue(errors, 'adr-superseded-record-edited', file, 'catalogued bytes differ');
        continue;
      }
      if (exception.disposition === 'preserved-pre-v2-record') {
        const legacy = exception.legacy_record;
        if (legacy === undefined) {
          issue(
            errors,
            'adr-legacy-catalog-metadata-invalid',
            file,
            'preserved legacy ADR is missing catalog-supplied metadata',
          );
          continue;
        }
        parsedRecords.push({
          file,
          id: legacy.reference,
          title: legacy.title,
          status: legacy.status,
          date: legacy.date,
          format: 'legacy-catalog',
          supersedes: legacy.supersedes,
          affectedRules: legacy.affected_rules,
          catalogPath: relativePath,
        });
      }
      continue;
    }

    const document = splitDocument(file, bytes.toString('utf8'), errors);
    if (document === undefined) continue;
    for (const section of policy.body.required_sections) {
      const escaped = section.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      if (!new RegExp(`^##[ \\t]+${escaped}[ \\t]*\\r?$`, 'mu').test(document.body)) {
        issue(
          errors,
          'adr-semantic-resolution-not-performed',
          file,
          `missing section '## ${section}'`,
        );
      }
    }
    if (!validators.adrV2(document.frontmatter)) {
      addSchemaErrors(errors, file, validators.adrV2.errors);
      continue;
    }
    const record = document.frontmatter as {
      readonly id: string;
      readonly title: string;
      readonly status: string;
      readonly date: string;
      readonly supersedes: readonly string[];
      readonly affected_rules: readonly string[];
    };
    if (!basename(file).startsWith(`${record.id}-`)) {
      issue(
        errors,
        'adr-semantic-resolution-not-performed',
        file,
        'filename does not bind declared id',
      );
    }
    parsedRecords.push({
      file,
      id: record.id,
      title: record.title,
      status: record.status,
      date: record.date,
      format: 'v2',
      supersedes: record.supersedes,
      affectedRules: record.affected_rules,
    });
  }
  for (const catalogPath of catalog.keys()) {
    if (!seenCatalog.has(catalogPath)) {
      issue(
        errors,
        'adr-superseded-record-edited',
        join(options.adrsDir, catalogPath),
        'catalogued exception is absent',
      );
    }
  }

  const resolvableLegacyReferences = new Map<
    string,
    AdrValidationPolicy['semantic_resolver']['resolvable_legacy_references'][number]
  >();
  for (const entry of policy.semantic_resolver.resolvable_legacy_references) {
    if (resolvableLegacyReferences.has(entry.reference)) {
      issue(
        errors,
        'adr-legacy-reference-allowlist-mismatch',
        policyPath,
        `duplicate legacy reference '${entry.reference}'`,
      );
    }
    resolvableLegacyReferences.set(entry.reference, entry);
  }
  const materializedLegacyPairs = parsedRecords
    .filter((record) => record.format === 'legacy-catalog')
    .map((record) => `${record.id}\u0000${record.catalogPath ?? ''}`)
    .sort();
  const allowlistedLegacyPairs = [...resolvableLegacyReferences.values()]
    .map((entry) => `${entry.reference}\u0000${entry.path}`)
    .sort();
  if (
    materializedLegacyPairs.length !== allowlistedLegacyPairs.length ||
    materializedLegacyPairs.some((pair, index) => pair !== allowlistedLegacyPairs[index])
  ) {
    issue(
      errors,
      'adr-legacy-reference-allowlist-mismatch',
      policyPath,
      'legacy catalog metadata and resolvable reference allowlist are not an exact bijection',
    );
  }
  const resolution = semanticResolution(parsedRecords, resolvableLegacyReferences, errors);
  const authorityEstablished = errors.length === 0;
  const adrs = parsedRecords
    .map((record): AdrValidationRecord => ({
      file: record.file,
      adr_id: record.id,
      title: record.title,
      status: record.status,
      date: record.date,
      format: record.format,
      supersedes: record.supersedes,
      affected_rules: record.affectedRules,
      effective_affected_rules: authorityEstablished
        ? jcsSorted(resolution.effectiveSubjectsById.get(record.id) ?? [])
        : [],
      effective:
        authorityEstablished && (resolution.effectiveSubjectsById.get(record.id)?.size ?? 0) > 0,
    }))
    .sort((left, right) => jcsCompare(left.adr_id, right.adr_id));
  const subjectAuthorities = authorityEstablished ? resolution.subjectAuthorities : [];
  const effectiveAuthorities = authorityEstablished
    ? jcsSorted(new Set(subjectAuthorities.map((entry) => entry.effective_head)))
    : [];
  return {
    ok: authorityEstablished,
    kernel_id: KERNEL_ID,
    semantic_resolution_performed: true,
    files_scanned: files.length,
    errors,
    adrs,
    effective_authorities: effectiveAuthorities,
    subject_authorities: subjectAuthorities,
  };
}
