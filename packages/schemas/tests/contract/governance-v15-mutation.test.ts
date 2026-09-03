import { describe, expect, it } from 'vitest';
import { getValidator } from '../../src/index.js';
import { canonicalJson, mutationReport, readJson, sha256 } from '../fixtures/governance-v15.js';

type Json = Record<string, unknown>;

function aggregate(
  expectedPackages: readonly string[],
  reports: Readonly<Record<string, Json>>,
): 'pass' | 'fail' | 'unknown' | 'not-applicable' {
  const values: Json[] = [];
  for (const name of expectedPackages) {
    const report = reports[name];
    if (report === undefined) return 'unknown';
    values.push(report);
  }
  if (values.some((report) => report.verdict === 'fail')) return 'fail';
  if (values.some((report) => report.verdict === 'unknown')) return 'unknown';
  if (values.every((report) => report.disposition === 'not-required')) return 'not-applicable';
  return 'pass';
}

function binary64Score(results: Json): number | undefined {
  const fields = [
    'killed',
    'survived',
    'timeout',
    'no_coverage',
    'runtime_error',
    'infrastructure_error',
  ] as const;
  if (fields.some((field) => !Number.isSafeInteger(results[field]) || Number(results[field]) < 0)) {
    return undefined;
  }
  const detected = Number(results.killed) + Number(results.timeout);
  const scored = detected + Number(results.survived) + Number(results.no_coverage);
  return scored === 0 ? 100 : (detected / scored) * 100;
}

function scoreIsSemanticallyExact(report: Json): boolean {
  const results = report.results as Json;
  const recomputed = binary64Score(results);
  return (
    recomputed !== undefined &&
    !Object.is(results.score, -0) &&
    Object.is(results.score, recomputed)
  );
}

function artifactDigestsMatch(
  report: Json,
  artifactBytes: Readonly<Record<string, string>>,
): boolean {
  const execution = report.execution as Json;
  const artifacts = execution.artifacts as Json[];
  return artifacts.every((artifact) => {
    const path = artifact.path;
    if (typeof path !== 'string') return false;
    const bytes = artifactBytes[path];
    return bytes !== undefined && sha256(bytes) === artifact.sha256;
  });
}

describe('mutation assurance v2 evidence matrix', () => {
  const validate = getValidator('mutation-assurance-v2.schema.json');

  it.each([
    ['all-fresh', { core: mutationReport('executed'), cli: mutationReport('executed') }],
    ['all-reused', { core: mutationReport('reused'), cli: mutationReport('reused') }],
    [
      'mixed',
      {
        core: mutationReport('executed'),
        cli: mutationReport('reused'),
        docs: mutationReport('not-required'),
      },
    ],
  ])('accepts independently explicit %s package dispositions', (_name, reports) => {
    for (const report of Object.values(reports)) expect(validate(report)).toBe(true);
    expect(aggregate(Object.keys(reports), reports)).toBe('pass');
  });

  it('preserves failed, missing, and unknown package outcomes in the aggregate', () => {
    expect(
      aggregate(['core', 'cli'], {
        core: mutationReport('executed'),
        cli: mutationReport('failed'),
      }),
    ).toBe('fail');
    expect(aggregate(['core', 'cli'], { core: mutationReport('executed') })).toBe('unknown');
    expect(
      aggregate(['core', 'cli'], {
        core: mutationReport('executed'),
        cli: mutationReport('unknown'),
      }),
    ).toBe('unknown');
  });

  it('rejects invalid semantic metadata, corrupt digest syntax, and unknown schema versions', () => {
    const reused = mutationReport('reused');
    const reuse = reused.reuse as Json;
    const identity = reused.identity as Json;
    const source = identity.source as Json;
    for (const invalid of [
      { ...reused, reuse: { ...reuse, all_identities_match: false } },
      { ...reused, identity: { ...identity, source: { ...source, digest_sha256: 'corrupt' } } },
      { ...reused, schemaVersion: '3.0.0' },
      { ...reused, selection: { scenario_ids: [], roster_complete: false, caller_trimmed: true } },
    ]) {
      expect(validate(invalid)).toBe(false);
    }
  });

  it('distinguishes not-required from pass and refuses empty passing selections', () => {
    const notRequired = mutationReport('not-required');
    expect(notRequired).toMatchObject({ disposition: 'not-required', verdict: 'not-applicable' });
    expect(validate({ ...notRequired, verdict: 'pass' })).toBe(false);

    const executed = mutationReport('executed');
    expect(
      validate({
        ...executed,
        selection: { scenario_ids: [], roster_complete: false, caller_trimmed: false },
      }),
    ).toBe(false);
  });

  it('recomputes scores with exact ordered binary64 operations and SameValue comparison', () => {
    const report = mutationReport('executed');
    const results = report.results as Json;
    const score = binary64Score(results);
    expect(score).toBe(66.66666666666666);
    expect(Object.is(results.score, score)).toBe(true);
    expect(Object.is(-0, 0)).toBe(false);

    expect(scoreIsSemanticallyExact(report)).toBe(true);
    expect(scoreIsSemanticallyExact({ ...report, results: { ...results, score: -0 } })).toBe(false);
    expect(
      scoreIsSemanticallyExact({ ...report, results: { ...results, score: 66.66666666666667 } }),
    ).toBe(false);

    expect(binary64Score({ ...results, killed: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined();
    expect(binary64Score({ ...results, killed: -1 })).toBeUndefined();
  });

  it('requires artifact content digests and all reuse identities to match semantically', () => {
    const fresh = mutationReport('executed');
    const artifacts = ((fresh.execution as Json).artifacts as Json[]).map((entry) =>
      String(entry.path),
    );
    const artifactBytes = Object.fromEntries(artifacts.map((path) => [path, 'test']));
    expect(artifactDigestsMatch(fresh, artifactBytes)).toBe(true);

    const execution = fresh.execution as Json;
    const executionArtifacts = execution.artifacts as Json[];
    const corrupt = {
      ...fresh,
      execution: {
        ...execution,
        artifacts: [
          { ...executionArtifacts[0], sha256: 'a'.repeat(64) },
          ...executionArtifacts.slice(1),
        ],
      },
    };
    expect(validate(corrupt)).toBe(true);
    expect(artifactDigestsMatch(corrupt, artifactBytes)).toBe(false);

    const reused = mutationReport('reused');
    expect(canonicalJson(reused.identity)).toBe(canonicalJson(fresh.identity));
    expect(canonicalJson({ ...(reused.identity as Json), source: { changed: true } })).not.toBe(
      canonicalJson(fresh.identity),
    );
  });

  it('freezes every identity input that invalidates reuse', () => {
    const policy = readJson<{
      required_identity_bindings: string[];
    }>('law/policy/mutation-assurance-v2.json');
    expect(policy.required_identity_bindings).toEqual([
      'candidate',
      'source',
      'test',
      'config',
      'toolchain',
      'roster',
      'threshold',
      'sanitizer',
      'orchestration',
      'lockfile',
    ]);
  });
});
