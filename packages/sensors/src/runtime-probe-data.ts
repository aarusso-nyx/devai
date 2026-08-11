import { Client } from 'pg';
import type { ProbeOutcome, RuntimeProbeCharter, RuntimeProbeStep } from './runtime-probe.js';

/**
 * Data-kind runtime probe driver (closes T3.1 / known-tech-debt entry).
 *
 * Probes a Postgres-shaped target declared by `charter.target.base_url`
 * (treated as a connection string for this kind). Each step's
 * `query` is executed; the result-set is matched against the step's
 * `expect.row_count`, `expect.contains`, and `expect.absent` clauses.
 *
 * Credential resolution: `as_credential` looks up `charter.allowed_credentials[]`
 * by name. The credential's `secret_ref` is read as an environment
 * variable; the value is treated as the connection-string password
 * placeholder. If absent, falls back to the charter's base_url as-is.
 *
 * Side-effects policy (charter.side_effects.policy):
 *   - read-only (default): any non-SELECT query produces error verdict
 *   - idempotent_writes: writes allowed; each is flagged for review
 *   - destructive_with_isolation: writes allowed; isolation_note required
 *
 * The driver opens one connection per charter run (not per probe).
 * Connection failure → error verdict on every probe with the error
 * surfaced in failed_expectations. Per-probe execution failure
 * (bad SQL, missing table) → error verdict on that probe only;
 * subsequent probes continue.
 */

const SELECT_PATTERN = /^\s*(SELECT|WITH|EXPLAIN|SHOW)\b/i;

interface QueryRow {
  readonly [column: string]: unknown;
}

function isReadOnly(charter: RuntimeProbeCharter): boolean {
  return (charter.side_effects?.policy ?? 'read-only') === 'read-only';
}

function applyCredential(charter: RuntimeProbeCharter, asName: string | undefined): string {
  if (asName === undefined) return charter.target.base_url;
  const cred = (charter.allowed_credentials ?? []).find((c) => c.name === asName);
  if (cred?.secret_ref === undefined) return charter.target.base_url;
  const password = process.env[cred.secret_ref];
  if (typeof password !== 'string' || password.length === 0) return charter.target.base_url;
  // If the base_url has a `:password@` placeholder, substitute. Otherwise
  // the connection string is taken as-is (the password came baked-in).
  try {
    const u = new URL(charter.target.base_url);
    if (u.username.length > 0 && u.password === '') {
      u.password = password;
      return u.toString();
    }
  } catch {
    // base_url isn't URL-shaped; pg's connection-string parser is more
    // permissive. Pass through.
  }
  return charter.target.base_url;
}

function rowsAsText(rows: readonly QueryRow[]): string {
  return JSON.stringify(rows);
}

function evaluateExpectations(step: RuntimeProbeStep, rows: readonly QueryRow[]): string[] {
  const failed: string[] = [];
  if (step.expect.row_count !== undefined && rows.length !== step.expect.row_count) {
    failed.push(`row_count: expected ${String(step.expect.row_count)}, got ${String(rows.length)}`);
  }
  const text = rowsAsText(rows);
  for (const sub of step.expect.contains ?? []) {
    if (!text.includes(sub)) failed.push(`contains: '${sub}' not found in result rows`);
  }
  for (const sub of step.expect.absent ?? []) {
    if (text.includes(sub)) failed.push(`absent: '${sub}' MUST NOT appear in result rows`);
  }
  return failed;
}

async function runOneDataProbe(
  client: Client,
  charter: RuntimeProbeCharter,
  step: RuntimeProbeStep,
): Promise<ProbeOutcome> {
  const t0 = Date.now();
  if (step.query === undefined || step.query.length === 0) {
    return {
      pid: step.pid,
      name: step.name,
      verdict: 'error',
      failed_expectations: ['data-kind probe requires a non-empty `query` field'],
      duration_ms: Date.now() - t0,
      ...(step.expect.invariant !== undefined && { invariant: step.expect.invariant }),
    };
  }
  if (isReadOnly(charter) && !SELECT_PATTERN.test(step.query)) {
    return {
      pid: step.pid,
      name: step.name,
      verdict: 'error',
      failed_expectations: [
        `read-only policy: only SELECT/WITH/EXPLAIN/SHOW queries are permitted; got: ${step.query.slice(0, 80)}…`,
      ],
      duration_ms: Date.now() - t0,
      ...(step.expect.invariant !== undefined && { invariant: step.expect.invariant }),
    };
  }
  try {
    const result = await client.query<QueryRow>(step.query);
    const rows = result.rows;
    const failed = evaluateExpectations(step, rows);
    const verdict: ProbeOutcome['verdict'] = failed.length === 0 ? 'pass' : 'fail';
    return {
      pid: step.pid,
      name: step.name,
      verdict,
      observed_body_excerpt: rowsAsText(rows).slice(0, 2048),
      failed_expectations: failed,
      duration_ms: Date.now() - t0,
      ...(step.expect.invariant !== undefined && { invariant: step.expect.invariant }),
    };
  } catch (err) {
    return {
      pid: step.pid,
      name: step.name,
      verdict: 'error',
      failed_expectations: [
        `query execution error: ${err instanceof Error ? err.message : String(err)}`,
      ],
      duration_ms: Date.now() - t0,
      ...(step.expect.invariant !== undefined && { invariant: step.expect.invariant }),
    };
  }
}

/**
 * Execute all probes in a charter against a single connection.
 * Connection failure produces `error` outcomes for every probe so
 * the caller sees a uniform per-probe report.
 */
export async function runDataProbeBatch(
  charter: RuntimeProbeCharter,
): Promise<readonly ProbeOutcome[]> {
  // Resolve the connection string once. If multiple probes use
  // different credentials, the first probe's credential wins for
  // the shared connection. (Mixing creds inside one charter is
  // unusual for data kind; if needed, split into multiple charters.)
  const firstCred = charter.probes.find((p) => p.as_credential !== undefined)?.as_credential;
  const connStr = applyCredential(charter, firstCred);
  const client = new Client({ connectionString: connStr });
  try {
    await client.connect();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return charter.probes.map((p) => ({
      pid: p.pid,
      name: p.name,
      verdict: 'error' as const,
      failed_expectations: [`pg connect failed: ${msg}`],
      duration_ms: 0,
      ...(p.expect.invariant !== undefined && { invariant: p.expect.invariant }),
    }));
  }
  try {
    const outcomes: ProbeOutcome[] = [];
    for (const step of charter.probes) {
      outcomes.push(await runOneDataProbe(client, charter, step));
    }
    return outcomes;
  } finally {
    await client.end().catch(() => {
      // best-effort
    });
  }
}
