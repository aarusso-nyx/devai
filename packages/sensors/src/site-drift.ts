import { spawnSync } from '@devai-nyx/authority';
import { invokeGhJson } from './harness/gh-api.js';
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

// ADR-SCR-0005 IA-005 and ADR-AUT-0002: read the provenance the publication path
// journals through the GitHub deployments API for environment
// devai-pages-publication, instead of inventing a commit message. The two
// read-only `gh api` GET argv below are the exact shapes the authority broker
// admits (templates gh-api-pages-deployments and gh-api-pages-deployment-statuses).
const JOURNAL_REPOSITORY = 'aarusso-nyx/devai';
const JOURNAL_ENVIRONMENT = 'devai-pages-publication';
const JOURNAL_TASK = 'devai:pages-publication';
const JOURNAL_DEPLOYMENTS_PATH = `/repos/${JOURNAL_REPOSITORY}/deployments?environment=${JOURNAL_ENVIRONMENT}&per_page=100`;
const VERIFIED_STATUS = /^devai-pages:verified:[A-Za-z0-9_-]{1,100}$/;

function journalStatusesPath(deploymentId: number): string {
  return `/repos/${JOURNAL_REPOSITORY}/deployments/${deploymentId}/statuses?per_page=100`;
}

interface JournalDeployment {
  readonly id?: unknown;
  readonly sha?: unknown;
  readonly environment?: unknown;
  readonly task?: unknown;
  readonly payload?: {
    readonly kind?: unknown;
    readonly schemaVersion?: unknown;
    readonly identity?: {
      readonly repository?: unknown;
      readonly commit?: unknown;
      readonly tag?: unknown;
    };
  };
}

interface JournalStatus {
  readonly id?: unknown;
  readonly state?: unknown;
  readonly environment?: unknown;
  readonly description?: unknown;
}

type ProvenanceResult =
  | { readonly ok: true; readonly commit: string; readonly tag: string; readonly intentId: string }
  | {
      readonly ok: false;
      readonly adapterRequired: boolean;
      readonly argv: readonly string[];
      readonly reason: string;
    };
type ProvenanceFailure = Extract<ProvenanceResult, { readonly ok: false }>;

/** Journal outcomes that are a reading (REVIEW), not a missing prerequisite. */
const JOURNAL_REVIEW_REASONS: ReadonlySet<string> = new Set([
  'journal-not-verified',
  'journal-no-matching-intent',
]);

/**
 * Reads the published-source commit the Pages publication path already
 * journals through GitHub deployment metadata (see
 * scripts/process/github-pages-journal.mjs), instead of requiring a
 * gh-pages branch commit message. Performs no writes.
 */
function readJournalProvenance(repoRoot: string): ProvenanceResult {
  const listArgv = ['api', JOURNAL_DEPLOYMENTS_PATH];
  let deployments: readonly JournalDeployment[];
  try {
    const result = invokeGhJson<JournalDeployment[]>({ cwd: repoRoot, args: listArgv });
    if (!result.ok)
      return { ok: false, adapterRequired: false, argv: listArgv, reason: result.reason };
    if (!Array.isArray(result.data))
      return { ok: false, adapterRequired: false, argv: listArgv, reason: 'gh-response-not-array' };
    deployments = result.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      adapterRequired: message === 'AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED',
      argv: listArgv,
      reason: message,
    };
  }

  // An empty journal holds no verified deployment at all.
  if (deployments.length === 0)
    return { ok: false, adapterRequired: false, argv: listArgv, reason: 'journal-not-verified' };
  const intents = deployments.filter(
    (deployment) =>
      deployment.environment === JOURNAL_ENVIRONMENT &&
      deployment.task === JOURNAL_TASK &&
      deployment.payload?.kind === 'devai-pages-publication-intent' &&
      deployment.payload.identity?.repository === JOURNAL_REPOSITORY,
  );
  if (intents.length === 0)
    return {
      ok: false,
      adapterRequired: false,
      argv: listArgv,
      reason: 'journal-no-matching-intent',
    };

  // An intent for the declared repository whose record is malformed (for example a payload
  // commit that differs from the deployment sha) is a provenance defect, not an absent intent.
  const candidates = intents
    .filter(
      (
        deployment,
      ): deployment is JournalDeployment & {
        readonly id: number;
        readonly payload: {
          readonly identity: { readonly commit: string; readonly tag: string };
        };
      } =>
        typeof deployment.id === 'number' &&
        deployment.payload?.schemaVersion === '1.0.0' &&
        typeof deployment.payload.identity?.commit === 'string' &&
        /^[0-9a-f]{40}$/.test(deployment.payload.identity.commit) &&
        deployment.payload.identity.commit === deployment.sha &&
        typeof deployment.payload.identity.tag === 'string',
    )
    .sort((a, b) => b.id - a.id);
  const latest = candidates[0];
  if (latest === undefined)
    return {
      ok: false,
      adapterRequired: false,
      argv: listArgv,
      reason: 'journal-intent-invalid',
    };

  const statusesArgv = ['api', journalStatusesPath(latest.id)];
  let statuses: readonly JournalStatus[];
  try {
    const result = invokeGhJson<JournalStatus[]>({ cwd: repoRoot, args: statusesArgv });
    if (!result.ok)
      return { ok: false, adapterRequired: false, argv: statusesArgv, reason: result.reason };
    if (!Array.isArray(result.data))
      return {
        ok: false,
        adapterRequired: false,
        argv: statusesArgv,
        reason: 'gh-response-not-array',
      };
    statuses = result.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      adapterRequired: message === 'AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED',
      argv: statusesArgv,
      reason: message,
    };
  }

  const verified = statuses
    .filter(
      (status): status is JournalStatus & { readonly id: number } =>
        typeof status.id === 'number' &&
        status.environment === JOURNAL_ENVIRONMENT &&
        status.state === 'success' &&
        typeof status.description === 'string' &&
        VERIFIED_STATUS.test(status.description),
    )
    .sort((a, b) => b.id - a.id)[0];
  if (verified === undefined)
    return {
      ok: false,
      adapterRequired: false,
      argv: statusesArgv,
      reason: 'journal-not-verified',
    };

  return {
    ok: true,
    commit: latest.payload.identity.commit,
    tag: latest.payload.identity.tag,
    intentId: String(latest.id),
  };
}

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
  // `rev-parse --symbolic --tags` lists the tag names through a git verb the authority
  // broker admits as a read; `git tag --list` is not an admitted read shape.
  const tags = git(repoRoot, ['rev-parse', '--symbolic', '--tags']);
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

  function adapterRequiredReading(
    provenance: ProvenanceFailure,
    extraMetrics: Readonly<Record<string, string>>,
  ): SensorReading {
    return unknownReading(
      opts,
      'SITE_DRIFT_PROVENANCE_ADAPTER_REQUIRED',
      `A read-only "gh ${provenance.argv.join(' ')}" call is required to verify the Pages ` +
        'publication provenance journaled for environment devai-pages-publication, but the ' +
        'authority broker has not admitted it (AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED). ' +
        'The broker must admit this exact read-only argv shape before this sensor can verify ' +
        'provenance from the journal.',
      { repository_head: head.stdout, ...extraMetrics },
    );
  }

  function journalReviewReading(
    provenance: ProvenanceFailure,
    extraMetrics: Readonly<Record<string, string>>,
  ): SensorReading {
    const notVerified = provenance.reason === 'journal-not-verified';
    return buildSensorReading({
      sensorName: 'site-drift',
      sensorKind: 'site_drift',
      command: ['devai', 'sense', 'site', 'drift'],
      status: 'review',
      deterministic: true,
      tier: 'L0',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'warning',
          code: notVerified ? 'SITE_DRIFT_JOURNAL_NOT_VERIFIED' : 'SITE_DRIFT_JOURNAL_NO_INTENT',
          message: notVerified
            ? 'The Pages publication journal holds no verified deployment for environment ' +
              `devai-pages-publication (journal-not-verified), read through "gh ${provenance.argv.join(' ')}".`
            : 'The Pages publication journal holds no publication intent for the declared ' +
              `repository ${JOURNAL_REPOSITORY} (journal-no-matching-intent), read through ` +
              `"gh ${provenance.argv.join(' ')}".`,
        },
      ],
      metrics: { repository_head: head.stdout, ...extraMetrics },
    });
  }

  let publishedSource: string;
  let provenanceMetrics: Readonly<Record<string, string>>;

  const tipMessage = publishedTip.ok
    ? git(opts.repoRoot, ['show', '-s', '--format=%B', publishedTip.stdout])
    : undefined;
  const tipMatch = tipMessage?.ok === true ? PUBLICATION_MESSAGE.exec(tipMessage.stdout) : null;
  const tipSource = tipMatch?.[1];

  if (tipSource !== undefined) {
    // ADR-AUT-0002 IA-004: a well-formed tip is compared with the last verified identity
    // the journal records; a tip that differs from it reads FAIL. When the journal yields
    // no verified identity the tip's own provenance stands, as before the journal read.
    const journal = readJournalProvenance(opts.repoRoot);
    if (journal.ok && journal.commit !== tipSource) {
      return buildSensorReading({
        sensorName: 'site-drift',
        sensorKind: 'site_drift',
        command: ['devai', 'sense', 'site', 'drift'],
        status: 'fail',
        deterministic: true,
        tier: 'L0',
        ...(opts.now !== undefined && { timestamp: opts.now }),
        findings: [
          {
            severity: 'error',
            code: 'SITE_DRIFT_TIP_NOT_VERIFIED',
            message:
              `The local gh-pages tip publishes ${tipSource}, but the last verified ` +
              `publication identity in the journal is ${journal.commit} (intent ${journal.intentId}).`,
          },
        ],
        metrics: {
          repository_head: head.stdout,
          published_tip: publishedTip.stdout,
          published_tip_source: tipSource,
          published_source_provenance: 'journal',
          journal_intent_id: journal.intentId,
          published_source: journal.commit,
        },
      });
    }
    publishedSource = tipSource;
    provenanceMetrics = {
      published_tip: publishedTip.stdout,
      ...(journal.ok && { journal_intent_id: journal.intentId }),
    };
  } else {
    const tipMetrics: Readonly<Record<string, string>> = publishedTip.ok
      ? { published_tip: publishedTip.stdout }
      : {};
    const journal = readJournalProvenance(opts.repoRoot);
    if (journal.ok) {
      publishedSource = journal.commit;
      provenanceMetrics = {
        published_source_provenance: 'journal',
        journal_intent_id: journal.intentId,
      };
    } else if (journal.adapterRequired) {
      return adapterRequiredReading(journal, tipMetrics);
    } else if (JOURNAL_REVIEW_REASONS.has(journal.reason)) {
      return journalReviewReading(journal, tipMetrics);
    } else if (!publishedTip.ok) {
      return unknownReading(
        opts,
        'SITE_DRIFT_PROVENANCE_UNAVAILABLE',
        'Local refs/remotes/origin/gh-pages is unavailable; fetch or live verification is required.',
        { repository_head: head.stdout },
      );
    } else {
      return unknownReading(
        opts,
        'SITE_DRIFT_PROVENANCE_MALFORMED',
        'The gh-pages tip message must be exactly "docs: publish from <40-hex-sha>".',
        { repository_head: head.stdout, published_tip: publishedTip.stdout },
      );
    }
  }

  const source = git(opts.repoRoot, ['rev-parse', '--verify', `${publishedSource}^{commit}`]);
  if (!source.ok) {
    return unknownReading(
      opts,
      'SITE_DRIFT_SOURCE_UNREACHABLE',
      `Published source ${publishedSource} is not reachable from local objects.`,
      { repository_head: head.stdout, ...provenanceMetrics },
    );
  }
  if (!isAncestor(opts.repoRoot, publishedSource, head.stdout)) {
    return unknownReading(
      opts,
      'SITE_DRIFT_SOURCE_NON_ANCESTRAL',
      `Published source ${publishedSource} is not an ancestor of repository HEAD.`,
      {
        repository_head: head.stdout,
        ...provenanceMetrics,
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
      ...provenanceMetrics,
      published_source: publishedSource,
      changed_path_count: touched.length,
      published_input_count: publishedInputs.length,
      package_version_drift_count: versionDrift.length,
      package_release_count: releaseTags.length,
    },
  });
}
