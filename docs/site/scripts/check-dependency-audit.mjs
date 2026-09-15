import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockfile = resolve(siteRoot, 'package-lock.json');
const waiverFile = resolve(siteRoot, 'dependency-audit-waivers.json');
const severities = new Set(['moderate', 'high', 'critical']);

function fail(message) {
  throw new Error(`DOCS_DEPENDENCY_AUDIT_${message}`);
}

function advisoryKey(advisory) {
  if (
    advisory === null ||
    typeof advisory !== 'object' ||
    typeof advisory.advisory_id !== 'string' ||
    typeof advisory.package !== 'string'
  ) {
    fail('WAIVER_INVALID');
  }
  return `${advisory.advisory_id}\u0000${advisory.package}`;
}

const [lockBytes, waiverBytes] = await Promise.all([
  readFile(lockfile),
  readFile(waiverFile, 'utf8'),
]);
const waiverDocument = JSON.parse(waiverBytes);
if (
  waiverDocument === null ||
  typeof waiverDocument !== 'object' ||
  waiverDocument.lockfile !== 'docs/site/package-lock.json' ||
  waiverDocument.lockfile_sha256 !== createHash('sha256').update(lockBytes).digest('hex') ||
  waiverDocument.baseline_release !== 'v1.4.5' ||
  !Array.isArray(waiverDocument.waivers)
) {
  fail('BASELINE_INVALID');
}

const now = Date.now();
const waivers = new Map();
for (const waiver of waiverDocument.waivers) {
  const key = advisoryKey(waiver);
  if (
    waivers.has(key) ||
    typeof waiver.reason !== 'string' ||
    waiver.reason.length === 0 ||
    waiver.approved_by !== 'OWNER' ||
    typeof waiver.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(waiver.expires_at)) ||
    Date.parse(waiver.expires_at) <= now
  ) {
    fail('WAIVER_INVALID');
  }
  waivers.set(key, waiver);
}

const audit = spawnSync('npm', ['audit', '--json'], { cwd: siteRoot, encoding: 'utf8' });
if (audit.error !== undefined || ![0, 1].includes(audit.status ?? -1)) fail('COMMAND_FAILED');
let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  fail('REPORT_INVALID');
}
if (
  report === null ||
  typeof report !== 'object' ||
  report.vulnerabilities === null ||
  typeof report.vulnerabilities !== 'object'
) {
  fail('REPORT_INVALID');
}

const observed = new Set();
for (const [packageName, vulnerability] of Object.entries(report.vulnerabilities)) {
  if (
    vulnerability === null ||
    typeof vulnerability !== 'object' ||
    !Array.isArray(vulnerability.via)
  ) {
    fail('REPORT_INVALID');
  }
  for (const via of vulnerability.via) {
    if (via === null || typeof via !== 'object' || typeof via.severity !== 'string') continue;
    if (!severities.has(via.severity)) continue;
    if (via.severity === 'critical' || typeof via.url !== 'string') fail('UNWAIVED_ADVISORY');
    const advisoryId = via.url.split('/').at(-1);
    const dependency = typeof via.dependency === 'string' ? via.dependency : packageName;
    if (advisoryId === undefined || advisoryId.length === 0) fail('REPORT_INVALID');
    const key = `${advisoryId}\u0000${dependency}`;
    if (!waivers.has(key)) fail('UNWAIVED_ADVISORY');
    observed.add(key);
  }
}

if (observed.size !== waivers.size || [...waivers.keys()].some((key) => !observed.has(key))) {
  fail('BASELINE_DRIFT');
}

console.log(
  `PASS docs dependency audit: ${String(observed.size)} OWNER-approved non-regression waivers`,
);
