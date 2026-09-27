import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import {
  KERNEL_ID,
  addSchemaErrors,
  issue,
  loadPolicy,
  markdownFiles,
  splitDocument,
  validateExceptionCatalog,
  type AdrValidationError,
  type AdrValidationPolicy,
  type AdrValidationRecord,
  type ParsedAdr,
} from './documents.js';
import {
  jcsCompare,
  jcsSorted,
  semanticResolution,
  type AdrValidationSubjectAuthority,
} from './semantic-resolution.js';
export type { AdrValidationSubjectAuthority } from './semantic-resolution.js';

export { parseAdrFrontMatter } from './documents.js';
export type { AdrValidationError, AdrValidationRecord } from './documents.js';

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
      if (
        exception.disposition === 'preserved-pre-v2-record' ||
        exception.disposition === 'preserved-invalid-accepted-record'
      ) {
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
    .map((record) => {
      const entry = catalog.get(record.catalogPath ?? '');
      return `${record.id}\u0000${record.catalogPath ?? ''}\u0000${entry?.disposition ?? ''}`;
    })
    .sort();
  const allowlistedLegacyPairs = [...resolvableLegacyReferences.values()]
    .map((entry) => `${entry.reference}\u0000${entry.path}\u0000${entry.disposition}`)
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
