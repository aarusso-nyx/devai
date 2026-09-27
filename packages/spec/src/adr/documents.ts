import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';

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

export const KERNEL_ID = 'devai.kernel.adr-supersession-resolution.v3' as const;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u;

export interface AdrValidationPolicy {
  readonly scan: Readonly<{ root: string }>;
  readonly body: Readonly<{ required_sections: readonly string[] }>;
  readonly semantic_resolver: Readonly<{
    kernel_id: string;
    mandatory: boolean;
    resolvable_legacy_references: readonly Readonly<{
      reference: string;
      path: string;
      disposition: 'preserved-pre-v2-record' | 'preserved-invalid-accepted-record';
    }>[];
  }>;
  readonly exception_catalog: Readonly<{
    catalog_digest_sha256: string;
    entries: readonly Readonly<{
      path: string;
      sha256: string;
      disposition: 'non-record' | 'preserved-pre-v2-record' | 'preserved-invalid-accepted-record';
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
          | 'adr_id-frontmatter'
          | 'v2-record-missing-required-section';
        supersedes: readonly string[];
        affected_rules: readonly string[];
      }>;
    }>[];
  }>;
}

export interface ParsedAdr {
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
    // Frontmatter keys are data. Create an own property before assignment so
    // __proto__ cannot alter the prototype or hide a field from schema validation.
    Object.defineProperty(result, key, {
      value: undefined,
      writable: true,
      enumerable: true,
      configurable: true,
    });
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

export function issue(
  errors: AdrValidationError[],
  code: string,
  file: string,
  message: string,
  pointer?: string,
): void {
  errors.push({ code, file, message, ...(pointer === undefined ? {} : { pointer }) });
}

export function loadPolicy(
  path: string,
  errors: AdrValidationError[],
): AdrValidationPolicy | undefined {
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

export function markdownFiles(root: string, errors: AdrValidationError[]): string[] {
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

export function splitDocument(
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

export function validateExceptionCatalog(
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

export function addSchemaErrors(
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
