import { readFileSync } from 'node:fs';
import { buildSensorReading, type SensorKind, type SensorStatus } from './sensor-reading.js';

/**
 * Runtime-probe sensor family (Phase 11.A, D-39).
 *
 * Three kinds — api, auth, data — share the same charter shape and
 * execution loop. The driver differentiates by SensorKind:
 *   - runtime_probe_api:  HTTP-based assertions against base_url
 *   - runtime_probe_auth: same HTTP machinery, exercises RBAC / auth
 *   - runtime_probe_data: SQL-based assertions against a connection
 *
 * Phase-11.A MVP shipped a fetch-based HTTP driver for api + auth
 * with a sketched data-kind. The data-kind driver is now real:
 * `packages/sensors/src/runtime-probe-data.ts` opens a single
 * `pg.Client` per charter run, executes each step's `query`, and
 * matches the result-set against `expect.{row_count,contains,absent}`
 * with `charter.side_effects.policy` enforcement (read-only rejects
 * non-SELECT; idempotent_writes permits it). All three kinds —
 * api / auth / data — now run through the same charter shape and
 * execution loop, differentiated only by SensorKind.
 *
 * Each charter run produces an arbiter summary: per-probe verdicts
 * aggregated into one overall status, packaged as a SensorReading
 * conformant to sensor-reading.schema.json.
 *
 * The charter is *read*; the runtime is *probed*; the arbiter
 * *summarizes*. The arbiter must not invent evidence and must not
 * rewrite semantics — it only classifies observed outcomes
 * against the charter's `expect` clauses.
 */

export interface RuntimeProbeCredential {
  readonly name: string;
  readonly role: string;
  readonly secret_ref?: string;
}

export interface RuntimeProbeExpect {
  readonly status?: number;
  readonly row_count?: number;
  readonly contains?: readonly string[];
  readonly absent?: readonly string[];
  readonly invariant?: string;
}

export interface RuntimeProbeStep {
  readonly pid: string;
  readonly name: string;
  readonly method?: string;
  readonly path?: string;
  readonly query?: string;
  readonly as_credential?: string;
  readonly body?: unknown;
  readonly expect: RuntimeProbeExpect;
}

export interface RuntimeProbeCharter {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly kind: 'api' | 'auth' | 'data';
  readonly mission: string;
  readonly target: {
    readonly base_url: string;
    readonly environment?: 'dev' | 'staging' | 'stage' | 'prod' | 'preview' | 'other';
    readonly deployed_artifact_ref?: string;
  };
  readonly threat_model?: string;
  readonly in_scope_invariants?: readonly string[];
  readonly allowed_credentials?: readonly RuntimeProbeCredential[];
  readonly probes: readonly RuntimeProbeStep[];
  readonly side_effects?: {
    readonly policy?: 'read-only' | 'idempotent_writes' | 'destructive_with_isolation';
    readonly isolation_note?: string;
  };
}

export interface ProbeOutcome {
  readonly pid: string;
  readonly name: string;
  readonly verdict: 'pass' | 'fail' | 'review' | 'error' | 'skipped';
  readonly observed_status?: number;
  readonly observed_body_excerpt?: string;
  readonly failed_expectations: readonly string[];
  readonly duration_ms: number;
  readonly invariant?: string;
}

export interface ArbiterSummary {
  readonly verdict: SensorStatus;
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
  readonly review: number;
  readonly error: number;
  readonly skipped: number;
  readonly outcomes: readonly ProbeOutcome[];
}

function kindToSensorKind(k: RuntimeProbeCharter['kind']): SensorKind {
  switch (k) {
    case 'api':
      return 'runtime_probe_api';
    case 'auth':
      return 'runtime_probe_auth';
    case 'data':
      return 'runtime_probe_data';
  }
}

function resolveCredentialHeader(
  charter: RuntimeProbeCharter,
  asName: string | undefined,
): Record<string, string> {
  if (asName === undefined) return {};
  const cred = (charter.allowed_credentials ?? []).find((c) => c.name === asName);
  if (cred === undefined) return {};
  // MVP: secret_ref is interpreted as an env-var name. Vault / SSM
  // adapters land later. Missing env value → empty header (probe
  // proceeds without auth, which usually shows up as 401).
  if (cred.secret_ref !== undefined) {
    const v = process.env[cred.secret_ref];
    if (typeof v === 'string' && v.length > 0) {
      return { authorization: `Bearer ${v}` };
    }
  }
  return {};
}

async function runHttpProbe(
  charter: RuntimeProbeCharter,
  step: RuntimeProbeStep,
): Promise<ProbeOutcome> {
  const t0 = Date.now();
  const method = (step.method ?? 'GET').toUpperCase();
  const url = new URL(step.path ?? '/', charter.target.base_url).toString();
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...resolveCredentialHeader(charter, step.as_credential),
  };
  const failed: string[] = [];
  let observedStatus: number | undefined;
  let bodyExcerpt = '';
  try {
    const init: RequestInit = { method, headers };
    if (step.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      init.body = JSON.stringify(step.body);
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(url, init);
    observedStatus = res.status;
    const text = await res.text().catch(() => '');
    bodyExcerpt = text.slice(0, 2048);
    if (step.expect.status !== undefined && step.expect.status !== res.status) {
      failed.push(`status: expected ${String(step.expect.status)}, got ${String(res.status)}`);
    }
    for (const sub of step.expect.contains ?? []) {
      if (!bodyExcerpt.includes(sub)) failed.push(`contains: '${sub}' not found in response`);
    }
    for (const sub of step.expect.absent ?? []) {
      if (bodyExcerpt.includes(sub)) failed.push(`absent: '${sub}' MUST NOT appear in response`);
    }
  } catch (err) {
    return {
      pid: step.pid,
      name: step.name,
      verdict: 'error',
      failed_expectations: [
        `probe execution error: ${err instanceof Error ? err.message : String(err)}`,
      ],
      duration_ms: Date.now() - t0,
      ...(step.expect.invariant !== undefined && { invariant: step.expect.invariant }),
    };
  }
  const verdict: ProbeOutcome['verdict'] = failed.length === 0 ? 'pass' : 'fail';
  return {
    pid: step.pid,
    name: step.name,
    verdict,
    ...(observedStatus !== undefined && { observed_status: observedStatus }),
    observed_body_excerpt: bodyExcerpt,
    failed_expectations: failed,
    duration_ms: Date.now() - t0,
    ...(step.expect.invariant !== undefined && { invariant: step.expect.invariant }),
  };
}

function aggregate(outcomes: readonly ProbeOutcome[]): ArbiterSummary {
  const counts = { pass: 0, fail: 0, review: 0, error: 0, skipped: 0 };
  for (const o of outcomes) counts[o.verdict] += 1;
  let verdict: SensorStatus;
  if (counts.error > 0) verdict = 'error';
  else if (counts.fail > 0) verdict = 'fail';
  else if (counts.review > 0) verdict = 'review';
  else if (counts.skipped === outcomes.length) verdict = 'skipped';
  else verdict = 'pass';
  return {
    verdict,
    total: outcomes.length,
    ...counts,
    outcomes,
  };
}

export interface ExecuteRuntimeProbeOptions {
  readonly charter: RuntimeProbeCharter;
  /** Skip network execution; produce a skipped-arbiter summary. Tests use this. */
  readonly dryRun?: boolean;
  readonly now?: string;
}

/**
 * Execute a runtime-probe charter and produce a SensorReading.
 * api + auth use the HTTP driver. data kind currently returns
 * skipped outcomes pending DB-driver wire-up.
 */
export async function executeRuntimeProbe(
  opts: ExecuteRuntimeProbeOptions,
): Promise<{ summary: ArbiterSummary; reading: ReturnType<typeof buildSensorReading> }> {
  const { charter } = opts;
  const outcomes: ProbeOutcome[] = [];
  if (opts.dryRun === true) {
    for (const p of charter.probes) {
      outcomes.push({
        pid: p.pid,
        name: p.name,
        verdict: 'skipped',
        failed_expectations: [],
        duration_ms: 0,
        ...(p.expect.invariant !== undefined && { invariant: p.expect.invariant }),
      });
    }
  } else if (charter.kind === 'api' || charter.kind === 'auth') {
    for (const p of charter.probes) {
      outcomes.push(await runHttpProbe(charter, p));
    }
  } else {
    // data kind — pg-backed driver. Lives in a separate module so
    // its `pg` import only resolves when this branch fires (api/auth
    // probes don't pay the load cost).
    const { runDataProbeBatch } = await import('./runtime-probe-data.js');
    outcomes.push(...(await runDataProbeBatch(charter)));
  }
  const summary = aggregate(outcomes);
  const reading = buildSensorReading({
    sensorName: `runtime-probe:${charter.kind}:${charter.id}`,
    sensorKind: kindToSensorKind(charter.kind),
    sensorVersion: '1.0.0',
    command: ['devai', `sense`, `runtime-${charter.kind}`, '--charter', charter.id],
    status: summary.verdict,
    deterministic: false,
    ...(opts.now !== undefined && { timestamp: opts.now }),
    duration_ms: outcomes.reduce((acc, o) => acc + o.duration_ms, 0),
    findings: summary.outcomes
      .filter((o) => o.verdict === 'fail' || o.verdict === 'error')
      .flatMap((o) =>
        o.failed_expectations.map((m) => ({
          severity: 'error' as const,
          code: o.verdict === 'error' ? 'PROBE_ERROR' : 'EXPECT_FAILED',
          message: `[${o.pid}] ${o.name}: ${m}`,
          ...(o.invariant !== undefined && { invariant_id: o.invariant }),
        })),
      ),
    metrics: {
      probes_total: summary.total,
      probes_pass: summary.pass,
      probes_fail: summary.fail,
      probes_review: summary.review,
      probes_error: summary.error,
      probes_skipped: summary.skipped,
    },
  });
  return { summary, reading };
}

/** Read + parse a charter JSON file. Throws on parse failure. */
export function loadCharter(path: string): RuntimeProbeCharter {
  const text = readFileSync(path, 'utf8');
  const parsed = JSON.parse(text) as unknown;
  return parsed as RuntimeProbeCharter;
}
