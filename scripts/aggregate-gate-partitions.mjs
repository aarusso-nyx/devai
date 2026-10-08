#!/usr/bin/env node
// ADR-CHK-0007 rule 11: the required gate result over the two partition jobs. It reads the
// include and exclude reports and the jobs' results, runs no check node, and passes only when
// both jobs succeeded and the reports cover the one plan with exactly one owned PASS entry
// per planned node.
//
// Usage:
//   node scripts/aggregate-gate-partitions.mjs --include-report <path> --exclude-report <path> \
//     --include-result <success|failure|cancelled|skipped> --exclude-result <same>
// A report path is a report file, or a directory (a downloaded artifact) holding exactly one.
// Stdout is one JSON line, { ok, findings: [{ code, detail }] }.
// Exit codes: 0 pass, 1 aggregate failure, 2 usage error.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RESULTS = new Set(['success', 'failure', 'cancelled', 'skipped']);
const OWNED_DISPOSITIONS = new Set(['executed', 'reused', 'aborted', 'blocked-environment']);
const ROLES = new Set(['owned', 'prerequisite', 'partitioned-out']);

/** The runner report, printed bare or inside the CLI result envelope. */
export function runnerReport(value, depth = 0) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || depth > 4) {
    return undefined;
  }
  if (Array.isArray(value.execution) && value.plan !== undefined) return value;
  for (const child of Object.values(value)) {
    const found = runnerReport(child, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function plannedIds(report) {
  return Array.isArray(report?.plan?.tasks) ? report.plan.tasks.map((task) => task?.nodeId) : [];
}

/**
 * Pure aggregation. `include` and `exclude` are runner reports (undefined when missing);
 * the results are the partition jobs' results. Returns { ok, findings }.
 */
export function aggregateGatePartitions({ include, exclude, includeResult, excludeResult }) {
  const findings = [];
  const add = (code, detail) => findings.push({ code, detail });
  for (const [side, result] of [
    ['include', includeResult],
    ['exclude', excludeResult],
  ]) {
    if (result !== 'success')
      add('PARTITION_JOB_NOT_SUCCESS', `${side} job result ${String(result)}`);
  }
  const reports = { include, exclude };
  for (const side of ['include', 'exclude']) {
    if (reports[side] === undefined) add('PARTITION_REPORT_MISSING', `${side} report`);
  }
  if (include === undefined || exclude === undefined) return { ok: false, findings };

  for (const side of ['include', 'exclude']) {
    const mode = reports[side]?.partition?.mode;
    if (mode !== side)
      add('PARTITION_REPORT_MISMATCH', `${side} report has partition mode ${String(mode)}`);
  }
  const same = (label, read) => {
    const left = JSON.stringify(read(include));
    const right = JSON.stringify(read(exclude));
    if (left === undefined || left !== right) {
      add('PARTITION_REPORT_MISMATCH', `${label} differs: ${String(left)} vs ${String(right)}`);
    }
  };
  same('candidate', (report) => report.plan?.repository?.commit);
  same('base', (report) => report.plan?.baseCommit ?? null);
  same('descriptor digest', (report) => report.plan?.descriptorDigest);
  same('task-policy digest', (report) => report.plan?.taskPolicyDigest);
  same('planned node set', (report) => plannedIds(report));
  same('partition nodes', (report) => report.partition?.nodes);

  const planned = plannedIds(include);
  const entriesBySide = {};
  for (const side of ['include', 'exclude']) {
    const execution = Array.isArray(reports[side].execution) ? reports[side].execution : [];
    const ids = execution.map((entry) => entry?.nodeId);
    if (JSON.stringify(ids) !== JSON.stringify(planned)) {
      add(
        'PARTITION_ENTRY_SHAPE',
        `${side} report does not hold one entry per planned node in plan order`,
      );
    }
    for (const entry of execution) {
      if (!ROLES.has(entry?.partition)) {
        add(
          'PARTITION_ENTRY_SHAPE',
          `${side} ${String(entry?.nodeId)} has partition ${String(entry?.partition)}`,
        );
      } else if (
        entry.partition === 'partitioned-out' &&
        (entry.disposition !== 'partitioned-out' ||
          entry.outcome !== 'SKIPPED' ||
          entry.reason !== 'partitioned-out')
      ) {
        add(
          'PARTITION_ENTRY_SHAPE',
          `${side} ${entry.nodeId} is partitioned-out with a run disposition`,
        );
      } else if (
        entry.partition !== 'partitioned-out' &&
        !OWNED_DISPOSITIONS.has(entry.disposition)
      ) {
        add(
          'PARTITION_ENTRY_SHAPE',
          `${side} ${entry.nodeId} has disposition ${String(entry.disposition)}`,
        );
      }
    }
    entriesBySide[side] = new Map(execution.map((entry) => [entry?.nodeId, entry]));
  }

  for (const nodeId of planned) {
    const owned = ['include', 'exclude']
      .map((side) => entriesBySide[side].get(nodeId))
      .filter((entry) => entry?.partition === 'owned');
    if (owned.length === 0) {
      add('PARTITION_OWNED_ZERO', `${nodeId} has no owned entry`);
      continue;
    }
    if (owned.length > 1) {
      add('PARTITION_OWNED_TWICE', `${nodeId} is owned by both reports`);
      continue;
    }
    const [entry] = owned;
    if (
      entry.outcome !== 'PASS' ||
      (entry.disposition !== 'executed' && entry.disposition !== 'reused')
    ) {
      add(
        'PARTITION_OWNED_NOT_PASS',
        `${nodeId} owned entry is ${String(entry.disposition)} ${String(entry.outcome)} (${String(entry.reason)})`,
      );
    }
  }
  return { ok: findings.length === 0, findings };
}

/** One report from a file, or from a directory holding exactly one `.json` file. */
function loadReport(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return { missing: true };
  let file = absolute;
  if (statSync(absolute).isDirectory()) {
    const candidates = readdirSync(absolute).filter((name) => name.endsWith('.json'));
    if (candidates.length === 0) return { missing: true };
    if (candidates.length > 1) return { extra: candidates };
    file = join(absolute, candidates[0]);
  }
  const text = readFileSync(file, 'utf8');
  for (const line of text.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const report = runnerReport(JSON.parse(trimmed));
      if (report !== undefined) return { report };
    } catch {
      // Not the report line.
    }
  }
  return { missing: true };
}

function parseArguments(argv) {
  const values = {};
  const flags = {
    '--include-report': 'includeReport',
    '--exclude-report': 'excludeReport',
    '--include-result': 'includeResult',
    '--exclude-result': 'excludeResult',
  };
  for (let index = 0; index < argv.length; index += 2) {
    const key = flags[argv[index]];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || values[key] !== undefined) return undefined;
    values[key] = value;
  }
  if (Object.keys(values).length !== 4) return undefined;
  if (!RESULTS.has(values.includeResult) || !RESULTS.has(values.excludeResult)) return undefined;
  return values;
}

function main(argv) {
  const args = parseArguments(argv);
  if (args === undefined) {
    process.stderr.write(
      'usage: aggregate-gate-partitions.mjs --include-report <path> --exclude-report <path> ' +
        '--include-result <success|failure|cancelled|skipped> --exclude-result <success|failure|cancelled|skipped>\n',
    );
    return 2;
  }
  const extra = [];
  const load = (side, path) => {
    const loaded = loadReport(path);
    if (loaded.extra !== undefined)
      extra.push({ code: 'PARTITION_EXTRA_REPORT', detail: `${side}: ${loaded.extra.join(', ')}` });
    return loaded.report;
  };
  const include = load('include', args.includeReport);
  const exclude = load('exclude', args.excludeReport);
  const aggregate = aggregateGatePartitions({
    include,
    exclude,
    includeResult: args.includeResult,
    excludeResult: args.excludeResult,
  });
  const findings = [...extra, ...aggregate.findings];
  const ok = findings.length === 0;
  process.stdout.write(`${JSON.stringify({ ok, findings })}\n`);
  return ok ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
