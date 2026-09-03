import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../../../..');

export function readJson<T = Record<string, unknown>>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, relativePath), 'utf8')) as T;
}

export function schemaExample<T = Record<string, unknown>>(schemaName: string, index = 0): T {
  const schema = readJson<{ examples: T[] }>(`law/schemas/${schemaName}`);
  const example = schema.examples[index];
  if (example === undefined) throw new Error(`${schemaName} has no example at index ${index}`);
  return structuredClone(example);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function omitPaths<T>(value: T, paths: readonly string[]): T {
  const copy = structuredClone(value);
  for (const path of paths) {
    const segments = path.split('.');
    let cursor: unknown = copy;
    for (const segment of segments.slice(0, -1)) {
      if (cursor === null || typeof cursor !== 'object') break;
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    if (cursor !== null && typeof cursor === 'object') {
      const finalSegment = segments.at(-1);
      if (finalSegment !== undefined) Reflect.deleteProperty(cursor, finalSegment);
    }
  }
  return copy;
}

const DIGEST = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

export const EXECUTION_ARTIFACTS = [
  { kind: 'mutant-roster', path: 'mutation/mutants.json', sha256: DIGEST },
  { kind: 'per-mutant-outcome-log', path: 'mutation/outcomes.jsonl', sha256: DIGEST },
  { kind: 'runner-output', path: 'mutation/runner.json', sha256: DIGEST },
  { kind: 'score-computation', path: 'mutation/score.json', sha256: DIGEST },
  { kind: 'threshold-snapshot', path: 'mutation/thresholds.json', sha256: DIGEST },
] as const;

export type MutationDisposition = 'executed' | 'reused' | 'not-required' | 'failed' | 'unknown';

export function mutationReport(
  disposition: MutationDisposition,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = schemaExample<Record<string, unknown>>('mutation-assurance-v2.schema.json');
  if (disposition === 'not-required') return { ...base, ...overrides };

  delete base.not_required;
  base.disposition = disposition;
  base.selection = { scenario_ids: ['MUT-001'], roster_complete: false, caller_trimmed: false };

  if (disposition === 'executed' || disposition === 'reused') {
    base.verdict = 'pass';
    base.results = {
      killed: 2,
      survived: 1,
      timeout: 0,
      no_coverage: 0,
      runtime_error: 0,
      infrastructure_error: 0,
      score: (2 / 3) * 100,
    };
    base.thresholds_met = true;
    base.execution = {
      kernel_id: 'devai.kernel.mutation-assurance-v2.v1',
      artifacts: structuredClone(EXECUTION_ARTIFACTS),
      recomputed_from_artifacts: true,
      schema_assertion_establishes_pass: false,
    };
    if (disposition === 'reused') {
      base.reuse = {
        reused_from_report_id: 'MA2-fedcba9876543210',
        reused_from_digest_sha256: DIGEST,
        all_identities_match: true,
      };
    }
  } else {
    base.verdict = disposition === 'failed' ? 'fail' : 'unknown';
    base.failure = {
      class: disposition === 'failed' ? 'score-below-threshold' : 'invalid-report',
      reason_code: disposition === 'failed' ? 'score-below-threshold' : 'missing-package-report',
    };
  }

  return { ...base, ...overrides };
}
