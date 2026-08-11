import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import { listSpecFiles } from './file-walker.js';
import type { SpecValidationError, SpecValidationResult } from './types.js';
import { findDuplicateIds } from './xref-resolver.js';

export interface ValidateGlossaryOptions {
  readonly glossaryDir: string;
  readonly invariantIds: ReadonlySet<string>;
}

export interface ValidatedGlossaryEntry {
  readonly id: string;
  readonly term: string;
  readonly file: string;
}

export interface GlossaryResult extends SpecValidationResult {
  readonly entries: readonly ValidatedGlossaryEntry[];
}

interface GlossaryRecord {
  readonly id: string;
  readonly term: string;
  readonly related_invariants?: readonly string[];
  readonly see_also?: readonly string[];
}

export function validateGlossary(opts: ValidateGlossaryOptions): GlossaryResult {
  const files = listSpecFiles(opts.glossaryDir, 'GE-');
  const errors: SpecValidationError[] = [];
  const loaded: Array<{ file: string; record: GlossaryRecord }> = [];

  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ file, message: `JSON parse error: ${msg}` });
      continue;
    }
    const ok = validators.glossaryEntry(parsed);
    if (!ok) {
      for (const e of validators.glossaryEntry.errors ?? []) {
        errors.push({
          file,
          pointer: e.instancePath || undefined,
          message: `${e.message ?? 'schema violation'} (${e.keyword})`,
        });
      }
      continue;
    }
    const record = parsed as GlossaryRecord;

    const expectedName = `${record.id}.json`;
    if (basename(file) !== expectedName) {
      errors.push({
        file,
        message: `filename '${basename(file)}' does not match id '${record.id}' (expected ${expectedName})`,
      });
    }

    // related_invariants xref.
    for (const [i, target] of (record.related_invariants ?? []).entries()) {
      if (!opts.invariantIds.has(target)) {
        errors.push({
          file,
          pointer: `/related_invariants/${String(i)}`,
          message: `related_invariants[${String(i)}] '${target}' does not exist in the invariant catalog`,
        });
      }
    }

    loaded.push({ file, record });
  }

  // Duplicate ids across files.
  const idDups = findDuplicateIds(loaded.map((l) => ({ id: l.record.id, file: l.file })));
  for (const d of idDups) {
    errors.push({
      file: d.files.join(' | '),
      message: `duplicate glossary id '${d.id}' across files: ${d.files.join(', ')}`,
    });
  }

  // Duplicate terms (case-insensitive). Per Constitution Article 13-ish
  // discipline and the Phase-2 criterion ("checks for duplicate terms").
  const termDups = findDuplicateIds(
    loaded.map((l) => ({ id: l.record.term.toLowerCase(), file: l.file })),
  );
  for (const d of termDups) {
    errors.push({
      file: d.files.join(' | '),
      message: `duplicate glossary term (case-insensitive) '${d.id}' across files: ${d.files.join(', ')}`,
    });
  }

  // see_also pointing at glossary entries (catalog of own ids).
  const glossaryIds = new Set(loaded.map((l) => l.record.id));
  for (const { file, record } of loaded) {
    for (const [i, target] of (record.see_also ?? []).entries()) {
      // see_also can target any GE-* id; literal validation against catalog.
      if (/^GE-/.test(target) && !glossaryIds.has(target)) {
        errors.push({
          file,
          pointer: `/see_also/${String(i)}`,
          message: `see_also[${String(i)}] '${target}' does not exist in the glossary catalog`,
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    files_scanned: files.length,
    entries: loaded.map((l) => ({ id: l.record.id, term: l.record.term, file: l.file })),
  };
}
