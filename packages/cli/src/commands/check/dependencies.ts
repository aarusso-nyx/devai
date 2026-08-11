import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from '@devai-nyx/authority';
import type { CAC } from 'cac';
import {
  evaluateDependencySecurityResult,
  type DependencyAdvisory,
  type DependencyScannerIdentity,
  type DependencySecurityResult,
  type DependencySeverity,
  type DependencyWaiver,
} from '#runtime-core';
import { EXIT_FAIL, EXIT_PASS, EXIT_REVIEW } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';

const DEFAULT_REPO_ROOT = '.';
const DEFAULT_DATABASE_MAX_AGE_HOURS = 168;
const PNPM_LOCKFILE = 'pnpm-lock.yaml';
const NPM_LOCKFILE = 'docs/site/package-lock.json';
const PINNED_PNPM_PACKAGE_MANAGER = 'pnpm@10.0.0';
const PINNED_NPM_PACKAGE_MANAGER = 'npm@11.14.1';
const PINNED_PNPM_SCANNER = { name: 'pnpm-audit', version: '10.0.0' } as const;
const PINNED_NPM_SCANNER = { name: 'npm-audit', version: '11.14.1' } as const;
const TEST_SCANNER = { name: 'devai-test-scanner', version: '1.0.0' } as const;
const WAIVERS_PATH = '.devai/config/dependency-waivers.json';
const SEVERITIES = new Set<DependencySeverity>(['info', 'low', 'moderate', 'high', 'critical']);

type DependencyEcosystem = 'pnpm' | 'npm';

interface DependencyUniverseResult extends DependencySecurityResult {
  readonly ecosystem: DependencyEcosystem;
  readonly lockfile: string;
}

interface DependencySecurityAggregateResult extends DependencySecurityResult {
  readonly universes: readonly DependencyUniverseResult[];
}

type CheckDependenciesResult = DependencySecurityResult | DependencySecurityAggregateResult;

interface CheckDependenciesOptions {
  readonly repoRoot: string;
  readonly now?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function unavailable(message: string): DependencySecurityResult {
  return {
    schemaVersion: '1.0.0',
    status: 'unknown',
    advisories: [],
    applied_waivers: [],
    findings: [{ code: 'DEPENDENCY_SCANNER_UNAVAILABLE', message }],
    counts: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
  };
}

function invalidWaivers(message: string): DependencySecurityResult {
  return {
    schemaVersion: '1.0.0',
    status: 'fail',
    advisories: [],
    applied_waivers: [],
    findings: [{ code: 'DEPENDENCY_WAIVER_INVALID', message }],
    counts: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
  };
}

function stableId(value: Record<string, unknown>): string | undefined {
  const url = typeof value.url === 'string' ? value.url : undefined;
  const ghsa = url?.match(/GHSA-[0-9A-Za-z-]+/u)?.[0];
  if (ghsa !== undefined) return ghsa.toUpperCase();
  for (const candidate of [value.github_advisory_id, value.source, value.id]) {
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      const id = String(candidate).trim();
      if (id.length > 0) return id;
    }
  }
  return undefined;
}

function aliases(value: Record<string, unknown>, id: string): string[] {
  const result = new Set<string>();
  for (const field of [value.cves, value.aliases, value.cwe]) {
    if (Array.isArray(field)) {
      for (const alias of field)
        if (typeof alias === 'string' && alias.length > 0) result.add(alias);
    }
  }
  const url = typeof value.url === 'string' ? value.url : '';
  const ghsa = url.match(/GHSA-[0-9A-Za-z-]+/u)?.[0]?.toUpperCase();
  if (ghsa !== undefined && ghsa !== id) result.add(ghsa);
  return Array.from(result).sort();
}

function severity(value: unknown): DependencySeverity | undefined {
  return typeof value === 'string' && SEVERITIES.has(value as DependencySeverity)
    ? (value as DependencySeverity)
    : undefined;
}

function classicAdvisory(value: unknown): DependencyAdvisory | undefined {
  if (!isRecord(value)) return undefined;
  const id = stableId(value);
  const packageName = typeof value.module_name === 'string' ? value.module_name : undefined;
  const advisorySeverity = severity(value.severity);
  const affectedRange =
    typeof value.vulnerable_versions === 'string' ? value.vulnerable_versions : undefined;
  if (
    id === undefined ||
    packageName === undefined ||
    advisorySeverity === undefined ||
    affectedRange === undefined
  ) {
    return undefined;
  }
  const patched = typeof value.patched_versions === 'string' ? value.patched_versions.trim() : '';
  return {
    id,
    package: packageName,
    severity: advisorySeverity,
    affected_range: affectedRange,
    fixed_versions: patched.length > 0 && patched !== '<0.0.0' ? [patched] : [],
    aliases: aliases(value, id),
  };
}

function modernAdvisories(raw: Record<string, unknown>): DependencyAdvisory[] | undefined {
  if (!isRecord(raw.vulnerabilities)) return undefined;
  const vulnerabilities = raw.vulnerabilities;
  const output: DependencyAdvisory[] = [];
  for (const [packageKey, vulnerabilityValue] of Object.entries(vulnerabilities)) {
    if (!isRecord(vulnerabilityValue) || !Array.isArray(vulnerabilityValue.via)) return undefined;
    const packageName =
      typeof vulnerabilityValue.name === 'string' ? vulnerabilityValue.name : packageKey;
    const fallbackSeverity = severity(vulnerabilityValue.severity);
    const fallbackRange =
      typeof vulnerabilityValue.range === 'string' ? vulnerabilityValue.range : undefined;
    const fixedVersions =
      isRecord(vulnerabilityValue.fixAvailable) &&
      typeof vulnerabilityValue.fixAvailable.version === 'string'
        ? [vulnerabilityValue.fixAvailable.version]
        : [];
    for (const via of vulnerabilityValue.via) {
      if (typeof via === 'string') {
        if (!Object.hasOwn(vulnerabilities, via)) return undefined;
        continue;
      }
      if (!isRecord(via)) return undefined;
      const id = stableId(via);
      const advisorySeverity = severity(via.severity) ?? fallbackSeverity;
      const affectedRange = typeof via.range === 'string' ? via.range : fallbackRange;
      if (id === undefined || advisorySeverity === undefined || affectedRange === undefined) {
        return undefined;
      }
      output.push({
        id,
        package: typeof via.dependency === 'string' ? via.dependency : packageName,
        severity: advisorySeverity,
        affected_range: affectedRange,
        fixed_versions: fixedVersions,
        aliases: aliases(via, id),
      });
    }
  }
  return output;
}

function auditCount(raw: Record<string, unknown>): number | undefined {
  if (!isRecord(raw.metadata) || !isRecord(raw.metadata.vulnerabilities)) return undefined;
  let total = 0;
  for (const level of SEVERITIES) {
    const count = raw.metadata.vulnerabilities[level];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return undefined;
    total += count;
  }
  return total;
}

function normalizeAudit(
  raw: unknown,
  observedAt: string,
  lockfileSha256: string,
  waivers: readonly DependencyWaiver[],
  scanner: DependencyScannerIdentity,
): unknown {
  if (!isRecord(raw)) return raw;
  let advisories: DependencyAdvisory[] | undefined;
  if (isRecord(raw.advisories)) {
    const normalized = Object.values(raw.advisories).map(classicAdvisory);
    if (normalized.some((advisory) => advisory === undefined)) return raw;
    advisories = normalized as DependencyAdvisory[];
  } else {
    advisories = modernAdvisories(raw);
  }
  if (advisories === undefined) return raw;

  const unique = new Map<string, DependencyAdvisory>();
  for (const advisory of advisories) {
    const key = `${advisory.id}\u0000${advisory.package}`;
    const prior = unique.get(key);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(advisory)) return raw;
    unique.set(key, advisory);
  }
  const declaredCount = auditCount(raw);
  if (
    declaredCount === undefined ||
    (declaredCount > 0 && unique.size === 0) ||
    (declaredCount === 0 && unique.size > 0)
  ) {
    return raw;
  }

  return {
    schemaVersion: '1.0.0',
    scanner: {
      ...scanner,
      database_updated_at: observedAt,
      database_timestamp_basis: 'successful_registry_query_observed_at',
    },
    generated_at: observedAt,
    lockfile_sha256: lockfileSha256,
    advisories: Array.from(unique.values()).sort((a, b) =>
      `${a.id}\u0000${a.package}`.localeCompare(`${b.id}\u0000${b.package}`),
    ),
    waivers,
  };
}

type LoadWaiversResult =
  | { readonly ok: true; readonly waivers: readonly DependencyWaiver[] }
  | { readonly ok: false; readonly result: DependencySecurityResult };

function loadWaivers(repoRoot: string): LoadWaiversResult {
  const path = resolve(repoRoot, WAIVERS_PATH);
  if (!existsSync(path)) return { ok: true, waivers: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    return {
      ok: false,
      result: invalidWaivers(
        `cannot parse ${WAIVERS_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
  const waivers = Array.isArray(raw) ? raw : isRecord(raw) ? raw.waivers : undefined;
  if (!Array.isArray(waivers)) {
    return {
      ok: false,
      result: invalidWaivers(`${WAIVERS_PATH} must contain a waivers array`),
    };
  }
  return { ok: true, waivers: waivers as DependencyWaiver[] };
}

function underTest(environment: NodeJS.ProcessEnv): boolean {
  return environment.VITEST === 'true' || environment.NODE_ENV === 'test';
}

function evaluateFixture(
  fixturePath: string,
  lockfileDigest: string,
  now: string,
): DependencySecurityResult {
  let scannerOutput: unknown;
  try {
    scannerOutput = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
  } catch (error) {
    return unavailable(
      `dependency scanner output is unavailable or malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const normalized =
    isRecord(scannerOutput) && !('lockfile_sha256' in scannerOutput)
      ? { ...scannerOutput, lockfile_sha256: lockfileDigest }
      : scannerOutput;
  return evaluateDependencySecurityResult(normalized, {
    expectedScanner: TEST_SCANNER,
    expectedLockfileSha256: lockfileDigest,
    now,
    maxDatabaseAgeHours: DEFAULT_DATABASE_MAX_AGE_HOURS,
  });
}

function readLockfileDigest(repoRoot: string, lockfile: string): string | DependencySecurityResult {
  try {
    return sha256(readFileSync(resolve(repoRoot, lockfile)));
  } catch (error) {
    return unavailable(
      `complete dependency lockfile ${lockfile} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function asUniverse(
  ecosystem: DependencyEcosystem,
  lockfile: string,
  result: DependencySecurityResult,
): DependencyUniverseResult {
  return { ecosystem, lockfile, ...result };
}

function aggregateStatus(
  universes: readonly DependencyUniverseResult[],
): DependencySecurityResult['status'] {
  if (universes.some((universe) => universe.status === 'fail')) return 'fail';
  if (universes.some((universe) => universe.status === 'unknown')) return 'unknown';
  if (universes.some((universe) => universe.status === 'review')) return 'review';
  return 'pass';
}

function aggregateUniverses(
  universes: readonly DependencyUniverseResult[],
): DependencySecurityAggregateResult {
  const counts: Record<DependencySeverity, number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  for (const universe of universes) {
    for (const severityName of SEVERITIES) counts[severityName] += universe.counts[severityName];
  }
  return {
    schemaVersion: '1.0.0',
    status: aggregateStatus(universes),
    advisories: universes.flatMap((universe) => universe.advisories),
    applied_waivers: universes.flatMap((universe) => universe.applied_waivers),
    findings: universes.flatMap((universe) =>
      universe.findings.map((finding) => ({
        ...finding,
        message: `[${universe.ecosystem}:${universe.lockfile}] ${finding.message}`,
      })),
    ),
    counts,
    universes,
  };
}

function evaluateUniverseFixture(
  ecosystem: DependencyEcosystem,
  lockfile: string,
  fixturePath: string | undefined,
  digest: string | DependencySecurityResult,
  now: string,
): DependencyUniverseResult {
  if (typeof digest !== 'string') return asUniverse(ecosystem, lockfile, digest);
  if (fixturePath === undefined) {
    return asUniverse(
      ecosystem,
      lockfile,
      unavailable(`${ecosystem} scanner fixture is unavailable`),
    );
  }
  return asUniverse(ecosystem, lockfile, evaluateFixture(fixturePath, digest, now));
}

type ReadPackageManifestResult =
  | { readonly ok: true; readonly manifest: Record<string, unknown> }
  | { readonly ok: false; readonly result: DependencySecurityResult };

function readPackageManifest(repoRoot: string): ReadPackageManifestResult {
  try {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as unknown;
    return isRecord(manifest)
      ? { ok: true, manifest }
      : { ok: false, result: unavailable('project package manifest is not a JSON object') };
  } catch (error) {
    return {
      ok: false,
      result: unavailable(
        `project package-manager pin is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
}

function runAuditUniverse(options: {
  readonly ecosystem: DependencyEcosystem;
  readonly lockfile: string;
  readonly cwd: string;
  readonly executable: 'pnpm' | 'npm';
  readonly packageManager: string;
  readonly scanner: DependencyScannerIdentity;
  readonly auditArgs: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly observedAt: string;
  readonly lockfileDigest: string | DependencySecurityResult;
  readonly waivers: readonly DependencyWaiver[];
}): DependencyUniverseResult {
  const {
    ecosystem,
    lockfile,
    cwd,
    executable,
    packageManager,
    scanner,
    auditArgs,
    environment,
    observedAt,
    lockfileDigest,
    waivers,
  } = options;
  if (typeof lockfileDigest !== 'string') {
    return asUniverse(ecosystem, lockfile, lockfileDigest);
  }
  const processEnvironment = { ...environment, NO_COLOR: '1', FORCE_COLOR: '0' };
  try {
    const version = spawnSync(executable, ['--version'], {
      cwd,
      env: processEnvironment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (version.status !== 0 || version.stdout.trim() !== scanner.version) {
      return asUniverse(
        ecosystem,
        lockfile,
        unavailable(
          `expected ${packageManager}; received ${version.stdout.trim() || 'unavailable'}`,
        ),
      );
    }

    const audit = spawnSync(executable, auditArgs, {
      cwd,
      env: processEnvironment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (audit.status !== 0 && audit.status !== 1) {
      return asUniverse(
        ecosystem,
        lockfile,
        unavailable(`${executable} audit failed before producing a trustworthy result`),
      );
    }
    let rawAudit: unknown;
    try {
      rawAudit = JSON.parse(audit.stdout) as unknown;
    } catch (error) {
      return asUniverse(
        ecosystem,
        lockfile,
        unavailable(
          `${executable} audit returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    return asUniverse(
      ecosystem,
      lockfile,
      evaluateDependencySecurityResult(
        normalizeAudit(rawAudit, observedAt, lockfileDigest, waivers, scanner),
        {
          expectedScanner: scanner,
          expectedLockfileSha256: lockfileDigest,
          now: observedAt,
          maxDatabaseAgeHours: DEFAULT_DATABASE_MAX_AGE_HOURS,
        },
      ),
    );
  } catch (error) {
    return asUniverse(
      ecosystem,
      lockfile,
      unavailable(
        `${executable} dependency scanner process is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

/** Run both pinned complete-lockfile dependency gates. All adapter failures remain UNKNOWN. */
export function checkDependencies(options: CheckDependenciesOptions): CheckDependenciesResult {
  const environment = options.environment ?? process.env;
  const repoRoot = resolve(options.repoRoot);
  const pnpmLockfileDigest = readLockfileDigest(repoRoot, PNPM_LOCKFILE);
  const npmLockfileDigest = readLockfileDigest(repoRoot, NPM_LOCKFILE);
  const observedAt = options.now ?? environment.DEVAI_TEST_NOW ?? new Date().toISOString();

  if (underTest(environment)) {
    if (environment.DEVAI_TEST_DEPENDENCY_SCANNER_UNAVAILABLE === '1') {
      return unavailable('dependency scanner is unavailable');
    }
    const pnpmFixturePath = environment.DEVAI_TEST_PNPM_DEPENDENCY_SCAN_FIXTURE;
    const npmFixturePath = environment.DEVAI_TEST_NPM_DEPENDENCY_SCAN_FIXTURE;
    if (pnpmFixturePath !== undefined || npmFixturePath !== undefined) {
      return aggregateUniverses([
        evaluateUniverseFixture(
          'pnpm',
          PNPM_LOCKFILE,
          pnpmFixturePath,
          pnpmLockfileDigest,
          observedAt,
        ),
        evaluateUniverseFixture('npm', NPM_LOCKFILE, npmFixturePath, npmLockfileDigest, observedAt),
      ]);
    }
    const fixturePath = environment.DEVAI_TEST_DEPENDENCY_SCAN_FIXTURE;
    if (fixturePath !== undefined) {
      if (typeof pnpmLockfileDigest !== 'string') return pnpmLockfileDigest;
      return evaluateFixture(fixturePath, pnpmLockfileDigest, observedAt);
    }
  }

  const packageManifest = readPackageManifest(repoRoot);
  if (!packageManifest.ok) return packageManifest.result;
  if (packageManifest.manifest.packageManager !== PINNED_PNPM_PACKAGE_MANAGER) {
    return unavailable(`project must pin ${PINNED_PNPM_PACKAGE_MANAGER} exactly`);
  }

  const waiverLoad = loadWaivers(repoRoot);
  const waivers = waiverLoad.ok ? waiverLoad.waivers : [];
  const pnpmResult = waiverLoad.ok
    ? runAuditUniverse({
        ecosystem: 'pnpm',
        lockfile: PNPM_LOCKFILE,
        cwd: repoRoot,
        executable: 'pnpm',
        packageManager: PINNED_PNPM_PACKAGE_MANAGER,
        scanner: PINNED_PNPM_SCANNER,
        auditArgs: ['audit', '--json'],
        environment,
        observedAt,
        lockfileDigest: pnpmLockfileDigest,
        waivers,
      })
    : asUniverse('pnpm', PNPM_LOCKFILE, waiverLoad.result);
  const npmResult = waiverLoad.ok
    ? runAuditUniverse({
        ecosystem: 'npm',
        lockfile: NPM_LOCKFILE,
        cwd: resolve(repoRoot, 'docs/site'),
        executable: 'npm',
        packageManager: PINNED_NPM_PACKAGE_MANAGER,
        scanner: PINNED_NPM_SCANNER,
        auditArgs: ['audit', '--json', '--package-lock-only'],
        environment,
        observedAt,
        lockfileDigest: npmLockfileDigest,
        waivers,
      })
    : asUniverse('npm', NPM_LOCKFILE, waiverLoad.result);
  return aggregateUniverses([pnpmResult, npmResult]);
}

export const checkDependenciesCmd = defineCommand({
  name: 'check dependencies',
  description:
    'Evaluate pinned pnpm@10.0.0 and npm@11.14.1 audit output over pnpm-lock.yaml and docs/site/package-lock.json; block high/critical advisories and invalid waivers, and fail closed on unavailable, malformed, stale, or mismatched provenance.',
  authority: 'policy_firewall',
  register(cli: CAC): void {
    cli
      .command('check-dependencies', 'Run the binding dependency-security policy gate')
      .option('--repo-root <path>', `Repo root (default: ${DEFAULT_REPO_ROOT})`)
      .option('--human', 'Human-readable output')
      .action((options: { repoRoot?: string; human?: boolean }) => {
        const report = checkDependencies({ repoRoot: options.repoRoot ?? DEFAULT_REPO_ROOT });
        if (options.human === true) {
          const lines = [
            `check dependencies: ${report.status.toUpperCase()} (${String(report.advisories.length)} advisory/advisories, ${String(report.applied_waivers.length)} applied waiver(s))`,
          ];
          if ('universes' in report) {
            for (const universe of report.universes) {
              lines.push(
                `  ${universe.ecosystem}:${universe.lockfile}: ${universe.status.toUpperCase()} (${String(universe.advisories.length)} advisory/advisories)`,
              );
            }
          }
          if (report.scanner?.database_timestamp_basis !== undefined) {
            lines.push(
              `  database timestamp: ${report.scanner.database_updated_at} (${report.scanner.database_timestamp_basis})`,
            );
          }
          for (const finding of report.findings)
            lines.push(`  [${finding.code}] ${finding.message}`);
          process.stdout.write(`${lines.join('\n')}\n`);
        } else {
          process.stdout.write(`${JSON.stringify(report)}\n`);
        }
        process.exitCode =
          report.status === 'pass'
            ? EXIT_PASS
            : report.status === 'review'
              ? EXIT_REVIEW
              : EXIT_FAIL;
      });
  },
});
