import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: spec security coverage (F1 × T6). Phase 27.C.
 * Three presence checks per the design note at
 * docs/theory/architecture/sensors/spec_security_coverage.md.
 */

export interface SpecSecurityCoverageOptions {
  readonly repoRoot: string;
  readonly invariantsDir?: string;
  readonly threatModelGlobs?: readonly string[];
  readonly piiRegistryTable?: string;
  readonly piiMigrationsGlobs?: readonly string[];
  readonly now?: string;
}

const DEFAULT_INVARIANTS_DIR = 'law/invariants';
const DEFAULT_THREAT_MODEL_GLOBS = ['docs/meta/security'];
const DEFAULT_PII_TABLE = 'core.pii_map';

function abs(repoRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}

function safeStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function walkFiles(dir: string, sink: string[], ext?: string): void {
  const st = safeStat(dir);
  if (st === null) return;
  if (st.isFile()) {
    if (ext === undefined || dir.toLowerCase().endsWith(ext)) sink.push(dir);
    return;
  }
  if (!st.isDirectory()) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    walkFiles(join(dir, entry), sink, ext);
  }
}

function findThreatModel(repoRoot: string, securityDirs: readonly string[]): string | null {
  for (const d of securityDirs) {
    const dir = abs(repoRoot, d);
    const st = safeStat(dir);
    if (st === null || !st.isDirectory()) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (/^threat[-_]?model.*\.md$/i.test(entry)) return join(dir, entry);
    }
  }
  return null;
}

function findPiiRegistry(
  repoRoot: string,
  migGlobs: readonly string[],
  table: string,
): string | null {
  const sqlFiles: string[] = [];
  for (const g of migGlobs) {
    // Treat patterns as path prefixes (strip trailing /**/*.sql etc.).
    const prefix = g
      .replace(/\/\*\*\/\*\.sql$/, '')
      .replace(/\/\*\.sql$/, '')
      .replace(/\/\*\*$/, '');
    walkFiles(abs(repoRoot, prefix === '' ? '.' : prefix), sqlFiles, '.sql');
  }
  const needleLower = `insert into ${table.toLowerCase()}`;
  for (const f of sqlFiles) {
    let content: string;
    try {
      content = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (content.toLowerCase().includes(needleLower)) return f;
  }
  return null;
}

interface InvariantRecord {
  readonly id?: string;
  readonly domain?: string;
}

function findRbacInvariant(repoRoot: string, invariantsDir: string): string | null {
  const dir = abs(repoRoot, invariantsDir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let parsed: InvariantRecord | null = null;
    try {
      parsed = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as InvariantRecord;
    } catch {
      continue;
    }
    if (parsed.domain === 'RBAC') return join(dir, entry);
  }
  return null;
}

export function senseSpecSecurityCoverage(opts: SpecSecurityCoverageOptions): SensorReading {
  const securityDirs = opts.threatModelGlobs ?? DEFAULT_THREAT_MODEL_GLOBS;
  const migGlobs = opts.piiMigrationsGlobs ?? [
    'migrations',
    'apps/api/migrations',
    'reference/api/migrations',
  ];
  const piiTable = opts.piiRegistryTable ?? DEFAULT_PII_TABLE;
  const invariantsDir = opts.invariantsDir ?? DEFAULT_INVARIANTS_DIR;

  const threatModel = findThreatModel(opts.repoRoot, securityDirs);
  const piiRegistry = findPiiRegistry(opts.repoRoot, migGlobs, piiTable);
  const rbacInvariant = findRbacInvariant(opts.repoRoot, invariantsDir);

  const findings: SensorFinding[] = [];
  if (threatModel === null) {
    findings.push({
      severity: 'warning',
      code: 'SPEC_SECURITY_NO_THREAT_MODEL',
      message: `No threat-model document found under: ${securityDirs.join(', ')}`,
    });
  }
  if (piiRegistry === null) {
    findings.push({
      severity: 'warning',
      code: 'SPEC_SECURITY_NO_PII_REGISTRY',
      message: `No \`INSERT INTO ${piiTable}\` row found across migration dirs: ${migGlobs.join(', ')}`,
    });
  }
  if (rbacInvariant === null) {
    findings.push({
      severity: 'warning',
      code: 'SPEC_SECURITY_NO_RBAC_INVARIANT',
      message: 'No invariant with domain="RBAC" found.',
    });
  }

  const presentCount = [threatModel, piiRegistry, rbacInvariant].filter((v) => v !== null).length;
  let status: SensorStatus;
  if (presentCount === 3) status = 'pass';
  else if (presentCount === 0) status = 'fail';
  else status = 'review';

  return buildSensorReading({
    sensorName: 'spec-security-coverage',
    sensorKind: 'spec_security_coverage',
    command: ['devai', 'sense-spec-security-coverage'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      threat_model_present: threatModel !== null ? 1 : 0,
      pii_registry_present: piiRegistry !== null ? 1 : 0,
      rbac_invariant_present: rbacInvariant !== null ? 1 : 0,
      signals_present: presentCount,
    },
  });
}
