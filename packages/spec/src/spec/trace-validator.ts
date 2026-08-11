import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import { validateRepositoryTarget } from '@devai-nyx/utils';
import type { SpecValidationError, SpecValidationResult } from './types.js';

export interface ValidateTraceOptions {
  /** Single-file path to trace.json (typically law/trace.json). */
  readonly tracePath: string;
  readonly invariantIds: ReadonlySet<string>;
  readonly repoRoot?: string;
}

export interface TraceResult extends SpecValidationResult {
  readonly trace_invariants_count: number;
}

interface TraceFile {
  readonly invariants: ReadonlyArray<{
    readonly id: string;
    readonly tests: ReadonlyArray<{ readonly path: string }>;
  }>;
}

export function validateTrace(opts: ValidateTraceOptions): TraceResult {
  const errors: SpecValidationError[] = [];
  const file = opts.tracePath;

  if (!existsSync(file)) {
    // Trace is required only when invariants exist. If invariants exist but
    // trace doesn't, surface as an error. If neither exists, this is fine
    // (Phase-2 self-application: F1 skeleton without populated trace).
    if (opts.invariantIds.size > 0) {
      errors.push({
        file,
        message: `trace file missing but ${String(opts.invariantIds.size)} invariants are defined`,
      });
    }
    return { ok: errors.length === 0, errors, files_scanned: 0, trace_invariants_count: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push({ file, message: `JSON parse error: ${msg}` });
    return { ok: false, errors, files_scanned: 1, trace_invariants_count: 0 };
  }

  const repoRoot = opts.repoRoot ?? resolve(dirname(file), '..');
  const parsedEntries =
    typeof parsed === 'object' &&
    parsed !== null &&
    'invariants' in parsed &&
    Array.isArray((parsed as { invariants?: unknown }).invariants)
      ? (parsed as { invariants: unknown[] }).invariants
      : [];
  for (const [i, rawEntry] of parsedEntries.entries()) {
    if (
      typeof rawEntry !== 'object' ||
      rawEntry === null ||
      !('tests' in rawEntry) ||
      !Array.isArray((rawEntry as { tests?: unknown }).tests)
    ) {
      continue;
    }
    for (const [j, rawTest] of (rawEntry as { tests: unknown[] }).tests.entries()) {
      if (
        typeof rawTest !== 'object' ||
        rawTest === null ||
        !('path' in rawTest) ||
        typeof (rawTest as { path?: unknown }).path !== 'string'
      ) {
        continue;
      }
      const path = (rawTest as { path: string }).path;
      if (!validateRepositoryTarget(repoRoot, path, 'test').ok) {
        errors.push({
          file,
          pointer: `/invariants/${String(i)}/tests/${String(j)}/path`,
          message: `trace path '${path}' is not a contained executable test file`,
        });
      }
    }
  }

  const ok = validators.trace(parsed);
  if (!ok) {
    for (const e of validators.trace.errors ?? []) {
      errors.push({
        file,
        pointer: e.instancePath || undefined,
        message: `${e.message ?? 'schema violation'} (${e.keyword})`,
      });
    }
    return { ok: false, errors, files_scanned: 1, trace_invariants_count: 0 };
  }
  const trace = parsed as TraceFile;

  for (const [i, entry] of trace.invariants.entries()) {
    if (!opts.invariantIds.has(entry.id)) {
      errors.push({
        file,
        pointer: `/invariants/${String(i)}/id`,
        message: `trace references unknown invariant '${entry.id}'`,
      });
    }
  }

  // Coverage: every defined invariant should appear in trace (warning-level
  // check, surfaced as error for Phase-2 minimum; revisit if too noisy).
  const tracedIds = new Set(trace.invariants.map((e) => e.id));
  for (const id of opts.invariantIds) {
    if (!tracedIds.has(id)) {
      errors.push({
        file,
        message: `invariant '${id}' has no trace entry`,
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    files_scanned: 1,
    trace_invariants_count: trace.invariants.length,
  };
}
