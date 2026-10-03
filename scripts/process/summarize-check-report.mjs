#!/usr/bin/env node
// #248: the check runner prints its report as one JSON line, which the GitHub log does not
// show usefully. This prints each node that did not pass, with its reason and the tail of its
// diagnostic output, so a failed gate names the failing node without a local reproduction.
// It reads the report only and never changes the gate result.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const TAIL_LINES = 40;
const [reportPath] = process.argv.slice(2);
if (reportPath === undefined) {
  process.stderr.write('usage: summarize-check-report.mjs <report.json>\n');
  process.exit(2);
}

/** The runner report, whether printed bare or inside the CLI result envelope. */
function runnerReport(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return undefined;
  if (Array.isArray(value.execution) || Array.isArray(value.blocked)) return value;
  for (const child of Object.values(value)) {
    const found = runnerReport(child, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function lastJsonDocument(text) {
  for (const line of text.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      // A partial line is not the report; keep looking.
    }
  }
  return undefined;
}

function tail(path) {
  const absolute = isAbsolute(path) ? path : resolve(path);
  if (!existsSync(absolute)) return [];
  return readFileSync(absolute, 'utf8').trimEnd().split('\n').slice(-TAIL_LINES);
}

const text = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
const report = runnerReport(lastJsonDocument(text));
if (report === undefined) {
  process.stdout.write(`check report: no runner report in ${reportPath}\n`);
  process.exit(0);
}

const failed = (report.execution ?? []).filter((task) => task.outcome !== 'PASS');
const blocked = report.blocked ?? [];
process.stdout.write(
  `check report: exit ${String(report.exitCode)}, ${String(failed.length)} node(s) not passing, ${String(blocked.length)} blocked\n`,
);
for (const task of failed) {
  process.stdout.write(
    `\n::group::${task.nodeId} — ${String(task.outcome)} (${task.disposition}, exit ${String(task.exitCode ?? '-')})\n`,
  );
  process.stdout.write(`reason: ${task.reason}\n`);
  for (const line of task.remediation ?? []) process.stdout.write(`remediation: ${line}\n`);
  if (task.diagnosticPath !== undefined) {
    process.stdout.write(`diagnostic: ${task.diagnosticPath}\n`);
    for (const line of tail(task.diagnosticPath)) process.stdout.write(`  ${line}\n`);
  }
  process.stdout.write('::endgroup::\n');
}
for (const node of blocked) {
  process.stdout.write(`\nblocked: ${node.nodeId} — ${node.reason}\n`);
  for (const line of node.remediation ?? []) process.stdout.write(`remediation: ${line}\n`);
}
