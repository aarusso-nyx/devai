import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { validators } from '@devai-nyx/schemas';

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
  readonly date: string;
  readonly format: 'v2' | 'legacy-catalog';
  readonly supersedes: readonly string[];
  readonly affected_rules: readonly string[];
  readonly effective: boolean;
}

export interface AdrValidationResult {
  readonly ok: boolean;
  readonly kernel_id: 'devai.kernel.adr-supersession-resolution.v1';
  readonly semantic_resolution_performed: boolean;
  readonly files_scanned: number;
  readonly errors: readonly AdrValidationError[];
  readonly adrs: readonly AdrValidationRecord[];
  readonly effective_authorities: readonly string[];
}

const KERNEL_ID = 'devai.kernel.adr-supersession-resolution.v1' as const;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u;

interface AdrValidationPolicy {
  readonly scan: Readonly<{ root: string }>;
  readonly body: Readonly<{ required_sections: readonly string[] }>;
  readonly semantic_resolver: Readonly<{ kernel_id: string; mandatory: boolean }>;
  readonly exception_catalog: Readonly<{
    catalog_digest_sha256: string;
    entries: readonly Readonly<{
      path: string;
      sha256: string;
      disposition: 'non-record' | 'preserved-pre-v2-record';
    }>[];
  }>;
}

interface ParsedAdr {
  readonly file: string;
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly date: string;
  readonly format: AdrValidationRecord['format'];
  readonly supersedes: readonly string[];
  readonly affectedRules: readonly string[];
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
  const canonical = entries.map((entry) => `${entry.path} ${entry.sha256}\n`).join('');
  if (digest(canonical) !== policy.exception_catalog.catalog_digest_sha256) {
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

function semanticResolution(
  records: readonly ParsedAdr[],
  errors: AdrValidationError[],
): ReadonlySet<string> {
  const byId = new Map<string, ParsedAdr>();
  for (const record of records) {
    if (byId.has(record.id)) {
      issue(errors, 'adr-duplicate-id', record.file, `duplicate ADR identity '${record.id}'`);
    } else byId.set(record.id, record);
  }

  const successors = new Map<string, string[]>();
  const adjacency = new Map<string, Set<string>>();
  for (const record of records) {
    adjacency.set(record.id, adjacency.get(record.id) ?? new Set());
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
          /^ADR-[0-9]{3,}$/u.test(target)
            ? 'adr-uncatalogued-legacy-reference'
            : 'adr-unresolved-supersedes-reference',
          record.file,
          `${record.id} supersedes unresolved identity '${target}'`,
        );
        continue;
      }
      successors.set(target, [...(successors.get(target) ?? []), record.id]);
      adjacency.get(record.id)?.add(target);
      adjacency.get(target)?.add(record.id);
    }
  }

  for (const [target, sourceIds] of successors) {
    const accepted = sourceIds.filter((id) => byId.get(id)?.status === 'accepted');
    if (accepted.length > 1) {
      issue(
        errors,
        'adr-multiple-accepted-direct-successors',
        byId.get(target)?.file ?? target,
        `${target} has conflicting accepted successors: ${accepted.join(', ')}`,
      );
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const detectCycle = (id: string): void => {
    if (visiting.has(id)) {
      issue(errors, 'adr-supersession-cycle', byId.get(id)?.file ?? id, `cycle includes '${id}'`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of byId.get(id)?.supersedes ?? []) {
      if (byId.has(target)) detectCycle(target);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) detectCycle(id);

  const supersededByAccepted = new Set<string>();
  const markTargets = (id: string): void => {
    for (const target of byId.get(id)?.supersedes ?? []) {
      if (!byId.has(target) || supersededByAccepted.has(target)) continue;
      supersededByAccepted.add(target);
      markTargets(target);
    }
  };
  for (const record of records) {
    if (record.status === 'accepted') markTargets(record.id);
  }
  const effective = new Set(
    records
      .filter((record) => record.status === 'accepted' && !supersededByAccepted.has(record.id))
      .map((record) => record.id),
  );

  const componentVisited = new Set<string>();
  for (const id of byId.keys()) {
    if (componentVisited.has(id)) continue;
    const component = new Set<string>();
    const pending = [id];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || component.has(current)) continue;
      component.add(current);
      componentVisited.add(current);
      pending.push(...(adjacency.get(current) ?? []));
    }
    const heads = [...component].filter((member) => effective.has(member));
    if (heads.length > 1) {
      issue(
        errors,
        'adr-multiple-effective-accepted-heads',
        byId.get(id)?.file ?? id,
        `supersession lineage has multiple effective accepted heads: ${heads.join(', ')}`,
      );
    }
  }
  return effective;
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
  });
  const policy = loadPolicy(policyPath, errors);
  if (policy === undefined) return empty();
  if (!existsSync(options.adrsDir)) {
    issue(errors, 'adr-semantic-resolution-not-performed', options.adrsDir, 'ADR root is absent');
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
        const document = splitDocument(file, bytes.toString('utf8'), errors);
        const id = document?.frontmatter.id;
        if (typeof id !== 'string' || !/^ADR-[0-9]{3,}$/u.test(id)) {
          issue(
            errors,
            'adr-uncatalogued-legacy-reference',
            file,
            'legacy ADR identity is unreadable',
          );
          continue;
        }
        parsedRecords.push({
          file,
          id,
          title: String(document?.frontmatter.title ?? ''),
          status: String(document?.frontmatter.status ?? ''),
          date: String(document?.frontmatter.date ?? ''),
          format: 'legacy-catalog',
          supersedes: [],
          affectedRules: [],
        });
      }
      continue;
    }

    const document = splitDocument(file, bytes.toString('utf8'), errors);
    if (document === undefined) continue;
    for (const section of policy.body.required_sections) {
      const escaped = section.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      if (!new RegExp(`^##\\s+${escaped}(?:\\s|$)`, 'mu').test(document.body)) {
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

  const effective = semanticResolution(parsedRecords, errors);
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
      effective: effective.has(record.id),
    }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.file), Buffer.from(right.file)));
  return {
    ok: errors.length === 0,
    kernel_id: KERNEL_ID,
    semantic_resolution_performed: true,
    files_scanned: files.length,
    errors,
    adrs,
    effective_authorities: [...effective].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    ),
  };
}
