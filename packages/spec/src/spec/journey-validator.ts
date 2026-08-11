import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parsers } from '@devai-nyx/schemas';
import { listSpecFiles } from './file-walker.js';
import type { SpecValidationError, SpecValidationResult } from './types.js';
import { findDuplicateIds, type XrefCheck } from './xref-resolver.js';

export interface ValidateJourneysOptions {
  readonly journeysDir: string;
  /** ID catalog used to resolve `related_invariants`. */
  readonly invariantIds: ReadonlySet<string>;
}

export interface ValidatedJourney {
  readonly id: string;
  readonly file: string;
  readonly related_invariants: readonly string[];
}

export interface JourneysResult extends SpecValidationResult {
  readonly journeys: readonly ValidatedJourney[];
  readonly xrefs: readonly XrefCheck[];
}

interface JourneyAcceptanceCriterion {
  readonly id: string;
  readonly statement: string;
  readonly measurable_via?: readonly string[];
}

interface JourneyRecord {
  readonly id: string;
  readonly related_invariants: readonly string[];
  readonly acceptance_criteria: readonly JourneyAcceptanceCriterion[];
}

export function validateJourneys(opts: ValidateJourneysOptions): JourneysResult {
  const files = listSpecFiles(opts.journeysDir, 'JNY-');
  const errors: SpecValidationError[] = [];
  const loaded: Array<{ file: string; record: JourneyRecord }> = [];
  const xrefs: XrefCheck[] = [];

  for (const file of files) {
    const parsed = parsers.journey.safeParseJson<JourneyRecord>(readFileSync(file, 'utf8'));
    if (!parsed.ok && parsed.error.kind === 'json-syntax') {
      errors.push({ file, message: `JSON parse error: ${parsed.error.message}` });
      continue;
    }
    if (!parsed.ok) {
      for (const e of parsed.error.issues) {
        errors.push({
          file,
          pointer: e.instancePath || undefined,
          message: `${e.message ?? 'schema violation'} (${e.keyword})`,
        });
      }
      continue;
    }
    const record: JourneyRecord = parsed.value;

    const expectedName = `${record.id}.json`;
    if (basename(file) !== expectedName) {
      errors.push({
        file,
        message: `filename '${basename(file)}' does not match id '${record.id}' (expected ${expectedName})`,
      });
    }

    // Cross-references → invariant catalog: related_invariants[*].
    for (const [i, target] of record.related_invariants.entries()) {
      xrefs.push({
        source_file: file,
        source_id: record.id,
        field: `/related_invariants/${String(i)}`,
        target_id: target,
        target_kind: 'invariant',
      });
      if (!opts.invariantIds.has(target)) {
        errors.push({
          file,
          pointer: `/related_invariants/${String(i)}`,
          message: `related_invariants[${String(i)}] '${target}' does not exist in the invariant catalog`,
        });
      }
    }

    // Cross-references → invariant catalog: acceptance_criteria[*].measurable_via[*].
    for (const [i, ac] of record.acceptance_criteria.entries()) {
      for (const [j, target] of (ac.measurable_via ?? []).entries()) {
        xrefs.push({
          source_file: file,
          source_id: record.id,
          field: `/acceptance_criteria/${String(i)}/measurable_via/${String(j)}`,
          target_id: target,
          target_kind: 'invariant',
        });
        if (!opts.invariantIds.has(target)) {
          errors.push({
            file,
            pointer: `/acceptance_criteria/${String(i)}/measurable_via/${String(j)}`,
            message: `acceptance_criteria[${String(i)}].measurable_via[${String(j)}] '${target}' does not exist in the invariant catalog`,
          });
        }
      }
    }

    loaded.push({ file, record });
  }

  const dups = findDuplicateIds(loaded.map((l) => ({ id: l.record.id, file: l.file })));
  for (const d of dups) {
    errors.push({
      file: d.files.join(' | '),
      message: `duplicate journey id '${d.id}' across files: ${d.files.join(', ')}`,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    files_scanned: files.length,
    journeys: loaded.map((l) => ({
      id: l.record.id,
      file: l.file,
      related_invariants: l.record.related_invariants,
    })),
    xrefs,
  };
}
