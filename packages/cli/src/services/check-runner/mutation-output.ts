import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const CONFIG_PATTERN = /^stryker\.(?:conf|config)\.(?:cjs|js|json|mjs|ts)$/u;

type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function thresholds(policy: JsonObject, packageName: string, literalOverride?: number) {
  if (literalOverride !== undefined) {
    return {
      break: literalOverride,
      high: literalOverride,
      low: Math.max(60, literalOverride - 10),
    };
  }
  const perPackage = object(policy['perPackage']) ? policy['perPackage'] : {};
  const packagePolicy = object(perPackage[packageName]) ? perPackage[packageName] : {};
  const defaults = object(policy['defaults']) ? policy['defaults'] : {};
  const policies = object(policy['policies']) ? policy['policies'] : {};
  const mutationPolicies = object(policies['mutation']) ? policies['mutation'] : {};
  const override = packagePolicy['mutation'];
  if (typeof override === 'number') {
    return { break: override, high: override, low: Math.max(60, override - 10) };
  }
  const policyName = override ?? defaults['mutation'] ?? 'default';
  if (typeof policyName !== 'string') throw new Error('CHECK_MUTATION_POLICY_INVALID');
  const selected = mutationPolicies[policyName];
  if (typeof selected === 'number') {
    return { break: selected, high: selected, low: Math.max(60, selected - 10) };
  }
  if (object(selected) && typeof selected['break'] === 'number') {
    const breakThreshold = selected['break'];
    return {
      break: breakThreshold,
      high: typeof selected['high'] === 'number' ? selected['high'] : breakThreshold,
      low:
        typeof selected['low'] === 'number' ? selected['low'] : Math.max(60, breakThreshold - 10),
    };
  }
  throw new Error(`CHECK_MUTATION_POLICY_UNKNOWN: ${policyName} for ${packageName}`);
}

export function resolveMutationOutputContract(
  repoRoot: string,
  contract: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (contract['kind'] !== 'mutation-report-set-discovery-v1') return contract;
  const workspaceRoots = contract['workspaceRoots'];
  const testPolicyPath = contract['testPolicyPath'];
  const artifactRoot = contract['artifactRoot'];
  const summaryPath = contract['summaryPath'];
  if (
    !Array.isArray(workspaceRoots) ||
    workspaceRoots.length === 0 ||
    workspaceRoots.some((root) => typeof root !== 'string' || root === '') ||
    new Set(workspaceRoots).size !== workspaceRoots.length ||
    typeof testPolicyPath !== 'string' ||
    typeof artifactRoot !== 'string' ||
    typeof summaryPath !== 'string' ||
    summaryPath !== `${artifactRoot}/summary.json`
  ) {
    throw new Error('CHECK_MUTATION_OUTPUT_CONTRACT_INVALID');
  }
  const policy = JSON.parse(readFileSync(resolve(repoRoot, testPolicyPath), 'utf8')) as JsonObject;
  const packages: Array<{
    packageName: string;
    workspace: string;
    resultPath: string;
    reportPath: string;
    thresholds: Readonly<{ break: number; high: number; low: number }>;
  }> = [];
  for (const workspaceRoot of workspaceRoots as string[]) {
    const absoluteRoot = resolve(repoRoot, workspaceRoot);
    if (!existsSync(absoluteRoot))
      throw new Error(`CHECK_MUTATION_WORKSPACE_MISSING: ${workspaceRoot}`);
    for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageDir = resolve(absoluteRoot, entry.name);
      const manifestPath = resolve(packageDir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as JsonObject;
      const scripts = object(manifest['scripts']) ? manifest['scripts'] : {};
      const configs = readdirSync(packageDir).filter((file) => CONFIG_PATTERN.test(file));
      if (
        configs.length > 1 ||
        (configs.length === 1) !== (typeof scripts['stryker'] === 'string')
      ) {
        throw new Error(`CHECK_MUTATION_ROSTER_MISMATCH: ${relative(repoRoot, packageDir)}`);
      }
      if (configs.length === 0) continue;
      const packageName = manifest['name'];
      if (typeof packageName !== 'string' || !packageName.startsWith('@')) {
        throw new Error(`CHECK_MUTATION_PACKAGE_NAME_INVALID: ${relative(repoRoot, packageDir)}`);
      }
      const workspace = relative(repoRoot, packageDir).split('\\').join('/');
      const configSource = readFileSync(resolve(packageDir, configs[0] ?? ''), 'utf8');
      const literalMatches = [...configSource.matchAll(/\bthreshold\s*:\s*(\d+(?:\.\d+)?)/gu)];
      if (literalMatches.length > 1) {
        throw new Error(`CHECK_MUTATION_THRESHOLD_AMBIGUOUS: ${workspace}`);
      }
      const literalThreshold =
        literalMatches[0]?.[1] === undefined ? undefined : Number(literalMatches[0][1]);
      const stem = workspace.replaceAll('/', '-');
      packages.push({
        packageName,
        workspace,
        resultPath: `${artifactRoot}/${stem}.result.json`,
        reportPath: `${artifactRoot}/${stem}.stryker.json`,
        thresholds: thresholds(policy, packageName, literalThreshold),
      });
    }
  }
  packages.sort((left, right) => left.packageName.localeCompare(right.packageName));
  if (
    packages.length === 0 ||
    new Set(packages.map((entry) => entry.packageName)).size !== packages.length
  ) {
    throw new Error('CHECK_MUTATION_ROSTER_EMPTY_OR_DUPLICATED');
  }
  return {
    kind: 'mutation-report-set-v1',
    expectedPackageCount: packages.length,
    summaryPath,
    packages,
    paths: [summaryPath, ...packages.flatMap((entry) => [entry.resultPath, entry.reportPath])],
  };
}
