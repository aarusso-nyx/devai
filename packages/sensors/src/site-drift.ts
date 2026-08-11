import { spawnSync } from '@devai-nyx/authority';
import { buildSensorReading, type SensorFinding, type SensorReading } from './sensor-reading.js';

export interface SiteDriftOptions {
  readonly repoRoot: string;
  readonly now?: string;
}

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly status: number | null;
}

const PUBLISHED_SECTIONS = [
  'docs/start/',
  'docs/theory/',
  'docs/roles/',
  'docs/adopters/',
  'docs/reference/',
  'docs/dev/',
  'law/',
  'product/',
  'work/rounds/',
  'record/proofs/',
] as const;

const DEFAULT_ROOT_INPUTS = [
  'README.md',
  'law/constitution.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'SECURITY.md',
] as const;

const PACKAGE_TAG = /^(?:@[^@/]+\/[^@]+@|v?)\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const PUBLICATION_MESSAGE = /^docs: publish from ([0-9a-f]{40})$/;

function git(repoRoot: string, args: readonly string[]): GitResult {
  const result = spawnSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    status: result.status,
  };
}

function isAncestor(repoRoot: string, ancestor: string, descendant: string): boolean {
  return git(repoRoot, ['merge-base', '--is-ancestor', ancestor, descendant]).ok;
}

function readCommitFile(repoRoot: string, commit: string, path: string): string | undefined {
  const result = git(repoRoot, ['show', `${commit}:${path}`]);
  return result.ok ? result.stdout : undefined;
}

function packageManifestPaths(repoRoot: string, commit: string): readonly string[] {
  const result = git(repoRoot, ['ls-tree', '-r', '--name-only', commit]);
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .filter((path) => path === 'package.json' || /^packages\/[^/]+\/package\.json$/.test(path))
    .sort();
}

function packageVersion(repoRoot: string, commit: string, path: string): string | undefined {
  const body = readCommitFile(repoRoot, commit, path);
  if (body === undefined) return undefined;
  try {
    const parsed = JSON.parse(body) as { readonly version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function changedPackageVersions(
  repoRoot: string,
  publishedSource: string,
  head: string,
): readonly string[] {
  const paths = new Set([
    ...packageManifestPaths(repoRoot, publishedSource),
    ...packageManifestPaths(repoRoot, head),
  ]);
  return [...paths].filter(
    (path) =>
      packageVersion(repoRoot, publishedSource, path) !== packageVersion(repoRoot, head, path),
  );
}

function releaseTagsAfter(
  repoRoot: string,
  publishedSource: string,
  head: string,
): readonly string[] {
  const tags = git(repoRoot, ['tag', '--list']);
  if (!tags.ok || tags.stdout.length === 0) return [];
  return tags.stdout
    .split('\n')
    .filter((tag) => PACKAGE_TAG.test(tag))
    .filter((tag) => {
      const target = git(repoRoot, ['rev-parse', '--verify', `${tag}^{commit}`]);
      return (
        target.ok &&
        target.stdout !== publishedSource &&
        isAncestor(repoRoot, publishedSource, target.stdout) &&
        isAncestor(repoRoot, target.stdout, head)
      );
    })
    .sort();
}

function touchedPaths(repoRoot: string, publishedSource: string, head: string): readonly string[] {
  const result = git(repoRoot, [
    'log',
    '--format=',
    '--name-only',
    '--diff-filter=ACDMRTUXB',
    `${publishedSource}..${head}`,
  ]);
  if (!result.ok || result.stdout.length === 0) return [];
  return [...new Set(result.stdout.split('\n').filter((path) => path.length > 0))].sort();
}

function rootInputs(repoRoot: string, head: string): ReadonlySet<string> {
  const inputs = new Set<string>(DEFAULT_ROOT_INPUTS);
  inputs.add('docs/_ia/categories.json');
  const manifest = readCommitFile(repoRoot, head, 'docs/_ia/categories.json');
  if (manifest === undefined) return inputs;
  try {
    const parsed = JSON.parse(manifest) as {
      readonly rootFileAllowlist?: ReadonlyArray<{ readonly source?: unknown }>;
    };
    for (const entry of parsed.rootFileAllowlist ?? []) {
      if (typeof entry.source === 'string') inputs.add(entry.source);
    }
  } catch {
    // A malformed IA manifest is separately governed by the renderer gate.
    // Keep the deterministic default allowlist so this sensor can still
    // classify repository-versus-deployment drift.
  }
  return inputs;
}

function isPublishedInput(path: string, roots: ReadonlySet<string>): boolean {
  return (
    roots.has(path) ||
    path.startsWith('docs/site/') ||
    PUBLISHED_SECTIONS.some((section) => path.startsWith(section))
  );
}

function unknownReading(
  opts: SiteDriftOptions,
  code: string,
  message: string,
  metrics: Readonly<Record<string, number | string | boolean>> = {},
): SensorReading {
  return buildSensorReading({
    sensorName: 'site-drift',
    sensorKind: 'site_drift',
    command: ['devai', 'sense', 'site', 'drift'],
    status: 'unknown',
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings: [{ severity: 'warning', code, message }],
    metrics,
  });
}

/**
 * Observe the relationship between the local source history and the locally
 * fetched gh-pages tip. The sensor deliberately performs no fetch: remote
 * availability and live Pages verification belong to the W13 Auditor path.
 */
export function senseSiteDrift(opts: SiteDriftOptions): SensorReading {
  const head = git(opts.repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!head.ok) {
    return unknownReading(opts, 'SITE_DRIFT_HEAD_UNAVAILABLE', 'Repository HEAD is unavailable.');
  }

  const publishedTip = git(opts.repoRoot, [
    'rev-parse',
    '--verify',
    'refs/remotes/origin/gh-pages^{commit}',
  ]);
  if (!publishedTip.ok) {
    return unknownReading(
      opts,
      'SITE_DRIFT_PROVENANCE_UNAVAILABLE',
      'Local refs/remotes/origin/gh-pages is unavailable; fetch or live verification is required.',
      { repository_head: head.stdout },
    );
  }

  const message = git(opts.repoRoot, ['show', '-s', '--format=%B', publishedTip.stdout]);
  const matched = message.ok ? PUBLICATION_MESSAGE.exec(message.stdout) : null;
  if (matched === null) {
    return unknownReading(
      opts,
      'SITE_DRIFT_PROVENANCE_MALFORMED',
      'The gh-pages tip message must be exactly "docs: publish from <40-hex-sha>".',
      { repository_head: head.stdout, published_tip: publishedTip.stdout },
    );
  }

  const publishedSource = matched[1] ?? '';
  const source = git(opts.repoRoot, ['rev-parse', '--verify', `${publishedSource}^{commit}`]);
  if (!source.ok) {
    return unknownReading(
      opts,
      'SITE_DRIFT_SOURCE_UNREACHABLE',
      `Published source ${publishedSource} is not reachable from local objects.`,
      { repository_head: head.stdout, published_tip: publishedTip.stdout },
    );
  }
  if (!isAncestor(opts.repoRoot, publishedSource, head.stdout)) {
    return unknownReading(
      opts,
      'SITE_DRIFT_SOURCE_NON_ANCESTRAL',
      `Published source ${publishedSource} is not an ancestor of repository HEAD.`,
      {
        repository_head: head.stdout,
        published_tip: publishedTip.stdout,
        published_source: publishedSource,
      },
    );
  }

  const versionDrift = changedPackageVersions(opts.repoRoot, publishedSource, head.stdout);
  const releaseTags = releaseTagsAfter(opts.repoRoot, publishedSource, head.stdout);
  const touched = touchedPaths(opts.repoRoot, publishedSource, head.stdout);
  const publishedInputs = touched.filter((path) =>
    isPublishedInput(path, rootInputs(opts.repoRoot, head.stdout)),
  );
  const findings: SensorFinding[] = [];

  for (const path of versionDrift) {
    findings.push({
      severity: 'error',
      code: 'SITE_DRIFT_PACKAGE_VERSION',
      message: `${path} has a different package version than the published source.`,
      file: path,
    });
  }
  for (const tag of releaseTags) {
    findings.push({
      severity: 'error',
      code: 'SITE_DRIFT_PACKAGE_RELEASE',
      message: `Package release tag ${tag} follows the published source.`,
    });
  }
  for (const path of publishedInputs) {
    findings.push({
      severity: 'warning',
      code: 'SITE_DRIFT_PUBLISHED_INPUT',
      message: `${path} changed after the published source.`,
      file: path,
    });
  }

  const status =
    versionDrift.length > 0 || releaseTags.length > 0
      ? 'fail'
      : publishedInputs.length > 0
        ? 'review'
        : 'pass';

  return buildSensorReading({
    sensorName: 'site-drift',
    sensorKind: 'site_drift',
    command: ['devai', 'sense', 'site', 'drift'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      repository_head: head.stdout,
      published_tip: publishedTip.stdout,
      published_source: publishedSource,
      changed_path_count: touched.length,
      published_input_count: publishedInputs.length,
      package_version_drift_count: versionDrift.length,
      package_release_count: releaseTags.length,
    },
  });
}
