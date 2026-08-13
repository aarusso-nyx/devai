import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validators } from '@devai-nyx/schemas';
import { createAuthorityDecisionIssuer } from '@devai-nyx/authority';
import {
  mkdirSync,
  renameSync,
  rmSync,
  spawnSync,
  writeFileSync,
  type AuthorityHostEffectRequest,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { regenerateInventory } from '@devai-nyx/loop';
import { assessScorecard, computeScorecard, loadScorecardFailureMaxAgeMs } from '@devai-nyx/loop';
import { loadScorecardNaConfig, resolveScorecardNaPath, scorecardNaCellSet } from '@devai-nyx/loop';
import { loadReadingsFromDir } from '@devai-nyx/loop';
import { compileBacklogObservation as compileBacklog } from '../operations/backlog.js';

type JsonRecord = Record<string, unknown>;

export interface PostMergeAuditorOptions {
  readonly repoRoot: string;
  readonly hostReceiptPath: string;
  readonly now?: string;
  readonly injectFailure?: boolean;
  readonly devaiVersion?: string;
}

export interface PostMergeAuditorResult {
  readonly status: 'completed' | 'replayed' | 'busy';
  readonly merge_sha: string;
  readonly processed: readonly string[];
  readonly worktree: string;
  readonly cadence: {
    readonly installed_checkout: 'persistent';
    readonly remote_host: 'unknown';
  };
}

export interface AuditObservationResult {
  readonly status: 'completed' | 'replayed';
  readonly at: string;
  readonly readiness_promoting: false;
  readonly observation_root: string;
  readonly artifacts: readonly Readonly<{ path: string; sha256: string }>[];
}

const FULL_SHA = /^[0-9a-f]{40}$/u;
const RECEIPT_MAX_AGE_MS = 5 * 60 * 1000;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function installedConstitution(root: string): string {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const path = [
    join(root, '.devai/pin/constitution.md'),
    join(root, 'law/constitution.md'),
    join(root, '.devai/constitution.md'),
    join(packageRoot, 'dist/law/constitution.md'),
  ].find((candidate) => existsSync(candidate));
  if (path === undefined) throw new Error('HOST_RECEIPT_CONSTITUTION_UNAVAILABLE');
  return readFileSync(path, 'utf8');
}

function canonicalSha256(value: unknown): string {
  const canonical = (input: unknown): string => {
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    if (isRecord(input)) {
      return `{${Object.keys(input)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(input);
  };
  return sha256(canonical(value));
}

/**
 * Run the post-merge observation engine against the repository's exact current
 * HEAD without requiring a host receipt. This is the explicit Auditor facade;
 * it never promotes readiness and refuses an abbreviated or non-current SHA.
 */
export async function runAuditObservation(opts: {
  readonly repoRoot: string;
  readonly at: string;
}): Promise<AuditObservationResult> {
  const repoRoot = realpathSync(resolve(opts.repoRoot));
  if (!FULL_SHA.test(opts.at)) throw new Error('AUDIT_OBSERVE_FULL_SHA_REQUIRED');
  const head = gitText(repoRoot, ['rev-parse', 'HEAD'], 'AUDIT_OBSERVE_HEAD_UNAVAILABLE');
  if (head !== opts.at) throw new Error('AUDIT_OBSERVE_EXACT_HEAD_REQUIRED');
  const timestamp = gitText(
    repoRoot,
    ['show', '-s', '--format=%cI', opts.at],
    'AUDIT_OBSERVE_TIMESTAMP_UNAVAILABLE',
  );
  const stateRoot = join(repoRoot, '.devai/state/audit-observations');
  const targetRoot = join(stateRoot, opts.at);
  const stagingRoot = join(stateRoot, `${opts.at}.tmp-${process.pid.toString()}`);
  rmSync(stagingRoot, { recursive: true, force: true });
  await writeBundle(
    repoRoot,
    stateRoot,
    opts.at,
    timestamp,
    null,
    null,
    false,
    `${opts.at}.tmp-${process.pid.toString()}`,
  );
  const generatedRoot = stagingRoot;
  const generatedDigest = canonicalSha256(
    Object.fromEntries(
      [...OBSERVATION_ARTIFACT_NAMES, 'status'].map((name) => [
        name,
        JSON.parse(readFileSync(join(generatedRoot, `${name}.json`), 'utf8')) as unknown,
      ]),
    ),
  );
  let status: 'completed' | 'replayed' = 'completed';
  if (existsSync(targetRoot)) {
    const existingDigest = canonicalSha256(
      Object.fromEntries(
        [...OBSERVATION_ARTIFACT_NAMES, 'status'].map((name) => [
          name,
          JSON.parse(readFileSync(join(targetRoot, `${name}.json`), 'utf8')) as unknown,
        ]),
      ),
    );
    rmSync(generatedRoot, { recursive: true, force: true });
    if (existingDigest !== generatedDigest) throw new Error('AUDIT_OBSERVE_REPLAY_DRIFT');
    status = 'replayed';
  } else {
    mkdirSync(dirname(targetRoot), { recursive: true });
    renameSync(generatedRoot, targetRoot);
  }
  const artifacts = [...OBSERVATION_ARTIFACT_NAMES, 'status'].map((name) => {
    const path = join(targetRoot, `${name}.json`);
    return {
      path: relative(repoRoot, path).split(sep).join('/'),
      sha256: sha256(readFileSync(path)),
    };
  });
  return {
    status,
    at: opts.at,
    readiness_promoting: false,
    observation_root: relative(repoRoot, targetRoot).split(sep).join('/'),
    artifacts,
  };
}

function hmacValid(value: JsonRecord, key: Buffer): boolean {
  const signature = value['signature_hmac_sha256'];
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/u.test(signature)) return false;
  const { signature_hmac_sha256: _signature, ...unsigned } = value;
  const expected = createHmac('sha256', key).update(JSON.stringify(unsigned)).digest();
  return timingSafeEqual(Buffer.from(signature, 'hex'), expected);
}

function readJson(
  path: string,
  code: string,
): { readonly value: JsonRecord; readonly raw: Buffer } {
  try {
    const raw = readFileSync(path);
    const value: unknown = JSON.parse(raw.toString('utf8'));
    if (!isRecord(value)) throw new Error('not an object');
    return { value, raw };
  } catch {
    throw new Error(code);
  }
}

function git(repoRoot: string, args: readonly string[]) {
  return spawnSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'DEVAI Auditor',
      GIT_AUTHOR_EMAIL: 'aarusso@nyxk.com.br',
      GIT_COMMITTER_NAME: 'DEVAI Auditor',
      GIT_COMMITTER_EMAIL: 'aarusso@nyxk.com.br',
    },
  });
}

function gitText(repoRoot: string, args: readonly string[], code: string): string {
  const result = git(repoRoot, args);
  if (result.status !== 0) throw new Error(code);
  return result.stdout.trim();
}

function exactRepository(value: unknown, repoRoot: string): boolean {
  return typeof value === 'string' && resolve(value) === realpathSync(repoRoot);
}

function gitAdministrationRoot(repoRoot: string): string {
  const marker = join(repoRoot, '.git');
  if (!existsSync(marker)) throw new Error('HOST_RECEIPT_UNVERIFIED');
  if (lstatSync(marker).isDirectory()) return realpathSync(marker);
  if (!lstatSync(marker).isFile()) throw new Error('HOST_RECEIPT_UNVERIFIED');
  const pointer = /^gitdir:\s*(.+)\s*$/u.exec(readFileSync(marker, 'utf8').trim())?.[1];
  if (pointer === undefined) throw new Error('HOST_RECEIPT_UNVERIFIED');
  return realpathSync(resolve(repoRoot, pointer));
}

export interface VerifiedPostMergeHostReceipt {
  readonly mergeSha: string;
  readonly baselineSha: string;
}

export function verifyPostMergeHostReceipt(
  opts: PostMergeAuditorOptions,
): VerifiedPostMergeHostReceipt {
  const root = realpathSync(resolve(opts.repoRoot));
  if (!opts.hostReceiptPath) throw new Error('HOST_RECEIPT_MISSING');
  if (!existsSync(opts.hostReceiptPath)) throw new Error('HOST_RECEIPT_MISSING');
  const { value: receipt } = readJson(opts.hostReceiptPath, 'HOST_RECEIPT_INVALID');
  const gitAdminRoot = gitAdministrationRoot(root);
  const runtimeRoot = join(gitAdminRoot, 'devai');
  const keyPath = join(runtimeRoot, 'post-merge.key');
  const attestationPath = join(root, '.devai/config/post-merge-host-adapter.json');
  if (!existsSync(keyPath) || !existsSync(attestationPath)) {
    throw new Error('HOST_RECEIPT_UNVERIFIED');
  }
  const key = readFileSync(keyPath);
  const { value: attestation, raw: attestationRaw } = readJson(
    attestationPath,
    'HOST_RECEIPT_UNVERIFIED',
  );
  if (!hmacValid(attestation, key) || !hmacValid(receipt, key)) {
    throw new Error('HOST_RECEIPT_UNVERIFIED');
  }
  if (
    !exactRepository(receipt['repository'], root) ||
    !exactRepository(attestation['repository'], root) ||
    receipt['repository_id'] !== attestation['repository_id'] ||
    receipt['adapter_id'] !== attestation['adapter_id']
  ) {
    throw new Error('HOST_RECEIPT_REPOSITORY_MISMATCH');
  }
  const mergeSha = receipt['merge_sha'];
  const baselineSha = attestation['installed_at_head'];
  if (
    typeof mergeSha !== 'string' ||
    !FULL_SHA.test(mergeSha) ||
    typeof baselineSha !== 'string' ||
    !FULL_SHA.test(baselineSha)
  ) {
    throw new Error('HOST_RECEIPT_INVALID');
  }
  const now = Date.parse(opts.now ?? new Date().toISOString());
  const issuedAt = Date.parse(String(receipt['issued_at']));
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(issuedAt) ||
    issuedAt > now + 30_000 ||
    now - issuedAt > RECEIPT_MAX_AGE_MS
  ) {
    throw new Error('HOST_RECEIPT_STALE');
  }
  const hookPath = attestation['hook_path'];
  if (
    typeof hookPath !== 'string' ||
    !existsSync(hookPath) ||
    sha256(readFileSync(hookPath)) !== attestation['hook_digest_sha256'] ||
    sha256(key) !== attestation['key_digest_sha256'] ||
    sha256(attestationRaw) !== receipt['attestation_digest_sha256'] ||
    receipt['hook_digest_sha256'] !== attestation['hook_digest_sha256']
  ) {
    throw new Error('HOST_RECEIPT_STALE');
  }
  const policyPath = join(root, '.devai/config/authority-policy.json');
  const expectedPolicy = existsSync(policyPath) ? sha256(readFileSync(policyPath)) : null;
  if (attestation['policy_digest_sha256'] !== expectedPolicy) {
    throw new Error('HOST_RECEIPT_STALE');
  }
  const packageBinding = attestation['package_binding'];
  if (
    !isRecord(packageBinding) ||
    packageBinding['name'] !== '@aarusso-nyx/devai' ||
    typeof opts.devaiVersion !== 'string' ||
    packageBinding['version'] !== opts.devaiVersion ||
    attestation['constitution_digest_sha256'] !== sha256(installedConstitution(root))
  ) {
    throw new Error('HOST_RECEIPT_STALE');
  }
  const head = gitText(root, ['rev-parse', 'HEAD'], 'HOST_RECEIPT_MERGE_MISMATCH');
  if (head !== mergeSha) throw new Error('HOST_RECEIPT_MERGE_MISMATCH');
  const parents = gitText(
    root,
    ['rev-list', '--parents', '-n', '1', mergeSha],
    'HOST_RECEIPT_INVALID',
  )
    .split(/\s+/u)
    .filter(Boolean);
  if (parents.length < 3) throw new Error('HOST_RECEIPT_NOT_A_MERGE');
  const baselineReachable = git(root, ['merge-base', '--is-ancestor', baselineSha, mergeSha]);
  if (baselineReachable.status !== 0) throw new Error('HOST_RECEIPT_MERGE_MISMATCH');
  return { mergeSha, baselineSha };
}

function contained(path: string, root: string): boolean {
  const absolute = resolve(path);
  return absolute === root || absolute.startsWith(`${root}${sep}`);
}

export function createPostMergeHostScope(
  repoRoot: string,
  mergeSha: string,
): { readonly scope: AuthorityHostEffectScope; readonly dispose: () => void } {
  const invocationId = `post-merge-${mergeSha}-${randomUUID()}`;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'devai-post-merge-host-adapter',
    issuer_version: '1.0.0',
    invocation_id: invocationId,
    canonicalSha256,
    randomId: randomUUID,
    now: () => new Date().toISOString(),
    receipt_ttl_ms: 30_000,
  });
  const worktreeRoot = join(repoRoot, '.devai/worktrees/auditor-post-merge');
  const worktreesRoot = dirname(worktreeRoot);
  const runtimeRoot = join(repoRoot, '.git/devai');
  const applyEffect = (request: AuthorityHostEffectRequest, apply: () => unknown): unknown => {
    if (request.kind === 'filesystem') {
      const candidates =
        request.symbol === 'renameSync'
          ? [request.arguments[0], request.arguments[1]]
          : [request.arguments[0]];
      if (
        candidates.some(
          (candidate) =>
            typeof candidate !== 'string' ||
            (!contained(candidate, worktreeRoot) &&
              resolve(candidate) !== worktreesRoot &&
              !contained(candidate, runtimeRoot)),
        )
      ) {
        throw new Error('POST_MERGE_EFFECT_OUT_OF_SCOPE');
      }
      return apply();
    }
    const executable = request.arguments[0];
    const args = request.arguments[1];
    if (basename(String(executable)) !== 'git' || !Array.isArray(args)) {
      throw new Error('POST_MERGE_PROCESS_FORBIDDEN');
    }
    const command = String(args[0]);
    const auditPathPattern = /^work\/audit\/post-merge\/[0-9a-f]{40}$/u;
    const exactAuditMutation =
      (command === 'add' &&
        args.length === 3 &&
        args[1] === '--' &&
        typeof args[2] === 'string' &&
        auditPathPattern.test(args[2])) ||
      (command === 'commit' &&
        args.length === 3 &&
        args[1] === '-m' &&
        typeof args[2] === 'string' &&
        /^audit\(post-merge\): observe [0-9a-f]{40}$/u.test(args[2])) ||
      (command === 'update-ref' &&
        args.length === 3 &&
        typeof args[1] === 'string' &&
        /^refs\/devai\/post-merge\/[0-9a-f]{40}$/u.test(args[1]) &&
        args[2] === 'HEAD');
    const exactAuditRead =
      command === 'show' &&
      args.length === 2 &&
      typeof args[1] === 'string' &&
      new RegExp(
        `^refs/devai/post-merge/([0-9a-f]{40}):work/audit/post-merge/\\1/(?:inventory|scorecard|backlog|assessment|status)\\.json$`,
        'u',
      ).test(args[1]);
    if (
      !['worktree', 'checkout', 'rev-list', 'rev-parse', 'merge-base', 'status'].includes(
        command,
      ) &&
      !exactAuditMutation &&
      !exactAuditRead
    ) {
      throw new Error('POST_MERGE_PROCESS_FORBIDDEN');
    }
    if (command === 'worktree' && args[1] !== 'add') {
      throw new Error('POST_MERGE_PROCESS_FORBIDDEN');
    }
    return apply();
  };
  return {
    scope: Object.freeze({
      action_id: 'round close',
      invocation_id: invocationId,
      effect: 'harness-write',
      receipt_store: issuer,
      apply_effect: applyEffect,
    }),
    dispose: () => {
      issuer.dispose();
    },
  };
}

function observationErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]+$/u.test(message) ? message : 'POST_MERGE_OBSERVATION_FAILED';
}

const OBSERVATION_ARTIFACT_NAMES = ['inventory', 'scorecard', 'backlog', 'assessment'] as const;

function validateCompletedObservation(
  mergeSha: string,
  read: (name: string) => string,
): string | null {
  try {
    const status: unknown = JSON.parse(read('status'));
    if (!isRecord(status)) return null;
    const observationDigest = status['observation_digest_sha256'];
    const previousDigest = status['previous_observation_digest_sha256'];
    const artifactDigest = status['artifact_digest_sha256'];
    if (
      status['schemaVersion'] !== '1.0.0' ||
      status['merge_sha'] !== mergeSha ||
      status['status'] !== 'completed' ||
      status['readiness_promoting'] !== false ||
      typeof status['generated_at'] !== 'string' ||
      !Number.isFinite(Date.parse(status['generated_at'])) ||
      (previousDigest !== null &&
        (typeof previousDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(previousDigest))) ||
      typeof artifactDigest !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(artifactDigest) ||
      typeof observationDigest !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(observationDigest)
    ) {
      return null;
    }
    const { observation_digest_sha256: _observationDigest, ...unsignedStatus } = status;
    if (canonicalSha256(unsignedStatus) !== observationDigest) return null;
    const artifacts = Object.fromEntries(
      OBSERVATION_ARTIFACT_NAMES.map((name) => {
        const value: unknown = JSON.parse(read(name));
        if (!isRecord(value)) throw new Error('invalid artifact');
        return [name, value];
      }),
    ) as Record<(typeof OBSERVATION_ARTIFACT_NAMES)[number], JsonRecord>;
    if (
      !validators.inventory(artifacts.inventory) ||
      !validators.scorecard(artifacts.scorecard) ||
      !validators.assessment(artifacts.assessment) ||
      canonicalSha256(artifacts) !== artifactDigest
    ) {
      return null;
    }
    return observationDigest;
  } catch {
    return null;
  }
}

function completedObservationDigest(stateRoot: string, mergeSha: string): string | null {
  const bundleRoot = join(stateRoot, mergeSha);
  const statusPath = join(bundleRoot, 'status.json');
  if (!existsSync(statusPath)) return null;
  return validateCompletedObservation(mergeSha, (name) =>
    readFileSync(join(bundleRoot, `${name}.json`), 'utf8'),
  );
}

function completedAuditObservationDigest(worktreeRoot: string, mergeSha: string): string | null {
  const ref = `refs/devai/post-merge/${mergeSha}`;
  return validateCompletedObservation(mergeSha, (name) =>
    gitText(
      worktreeRoot,
      ['show', `${ref}:work/audit/post-merge/${mergeSha}/${name}.json`],
      'POST_MERGE_AUDIT_BUNDLE_MISSING',
    ),
  );
}

function archiveIncompleteObservation(stateRoot: string, mergeSha: string): void {
  const bundleRoot = join(stateRoot, mergeSha);
  if (!existsSync(bundleRoot)) return;
  const statusPath = join(bundleRoot, 'status.json');
  const attemptDigest = existsSync(statusPath)
    ? sha256(readFileSync(statusPath))
    : sha256(readdirSync(bundleRoot).sort().join('\n'));
  const historyRoot = join(stateRoot, 'attempt-history', mergeSha);
  mkdirSync(historyRoot, { recursive: true });
  let sequence = 1;
  let archived = join(historyRoot, attemptDigest);
  while (existsSync(archived)) {
    sequence += 1;
    archived = join(historyRoot, `${attemptDigest}-${String(sequence)}`);
  }
  renameSync(bundleRoot, archived);
}

async function compileBacklogObservation(
  _worktreeRoot: string,
  scorecard: unknown,
  _timestamp: string,
): Promise<JsonRecord> {
  return compileBacklog(scorecard);
}

function backlogDelta(current: JsonRecord, previous: JsonRecord | null): JsonRecord {
  const items = Array.isArray(current['items']) ? current['items'].filter(isRecord) : [];
  const priorItems = Array.isArray(previous?.['items']) ? previous.items.filter(isRecord) : [];
  const currentIds = new Set(items.map((item) => String(item['id'])));
  const priorIds = new Set(priorItems.map((item) => String(item['id'])));
  return {
    additions: items.filter((item) => !priorIds.has(String(item['id']))),
    completions: priorItems.filter((item) => !currentIds.has(String(item['id']))),
  };
}

async function writeBundle(
  worktreeRoot: string,
  stateRoot: string,
  mergeSha: string,
  timestamp: string,
  previousMergeSha: string | null,
  previousDigest: string | null,
  injectFailure: boolean,
  bundleKey = mergeSha,
): Promise<string> {
  const bundleRoot = join(stateRoot, bundleKey);
  mkdirSync(bundleRoot, { recursive: true });
  try {
    if (injectFailure) throw new Error('POST_MERGE_OBSERVATION_INJECTED_FAILURE');
    const inventory = await regenerateInventory({
      repoRoot: worktreeRoot,
      timestamp,
      integrationHead: mergeSha,
    });
    const readings = loadReadingsFromDir(join(worktreeRoot, 'record/proofs/freshness/readings'));
    const naCells = scorecardNaCellSet(loadScorecardNaConfig(resolveScorecardNaPath(worktreeRoot)));
    const scorecard = computeScorecard({
      timestamp,
      integrationHead: mergeSha,
      readings,
      naCells,
      staleFailAfterMs: loadScorecardFailureMaxAgeMs(worktreeRoot),
    });
    const assessment = assessScorecard(scorecard, timestamp, 1, readings);
    const backlogCurrent = await compileBacklogObservation(worktreeRoot, scorecard, timestamp);
    let previousBacklog: JsonRecord | null = null;
    if (previousMergeSha !== null) {
      const previousPath = join(stateRoot, previousMergeSha, 'backlog.json');
      if (existsSync(previousPath)) {
        const parsed: unknown = JSON.parse(readFileSync(previousPath, 'utf8'));
        if (isRecord(parsed) && isRecord(parsed['current'])) previousBacklog = parsed.current;
      }
    }
    const backlog = {
      schemaVersion: '1.0.0',
      merge_sha: mergeSha,
      previous_merge_sha: previousMergeSha,
      current: backlogCurrent,
      deltas: backlogDelta(backlogCurrent, previousBacklog),
    };
    if (!validators.inventory(inventory)) throw new Error('POST_MERGE_INVENTORY_INVALID');
    if (!validators.scorecard(scorecard)) throw new Error('POST_MERGE_SCORECARD_INVALID');
    if (!validators.assessment(assessment)) throw new Error('POST_MERGE_ASSESSMENT_INVALID');
    const artifacts = { inventory, scorecard, backlog, assessment };
    for (const [name, value] of Object.entries(artifacts)) {
      writeFileSync(
        join(bundleRoot, `${name}.json`),
        `${JSON.stringify(value, null, 2)}\n`,
        'utf8',
      );
    }
    const artifactDigest = canonicalSha256(artifacts);
    const completed = {
      schemaVersion: '1.0.0',
      merge_sha: mergeSha,
      status: 'completed',
      generated_at: timestamp,
      readiness_promoting: false,
      previous_observation_digest_sha256: previousDigest,
      artifact_digest_sha256: artifactDigest,
    };
    const observationDigest = canonicalSha256(completed);
    writeFileSync(
      join(bundleRoot, 'status.json'),
      `${JSON.stringify({ ...completed, observation_digest_sha256: observationDigest }, null, 2)}\n`,
      'utf8',
    );
    return observationDigest;
  } catch (error) {
    const failed = {
      schemaVersion: '1.0.0',
      merge_sha: mergeSha,
      status: 'error',
      generated_at: timestamp,
      readiness_promoting: false,
      previous_observation_digest_sha256: previousDigest,
      code: observationErrorCode(error),
    };
    const observationDigest = canonicalSha256(failed);
    writeFileSync(
      join(bundleRoot, 'status.json'),
      `${JSON.stringify({ ...failed, observation_digest_sha256: observationDigest }, null, 2)}\n`,
      'utf8',
    );
    throw error;
  }
}

function commitAuditBundle(worktreeRoot: string, stateRoot: string, mergeSha: string): void {
  const auditRoot = join(worktreeRoot, 'work/audit/post-merge');
  const auditBundle = join(auditRoot, mergeSha);
  const runtimeBundle = join(stateRoot, mergeSha);
  mkdirSync(auditBundle, { recursive: true });
  for (const name of [...OBSERVATION_ARTIFACT_NAMES, 'status'] as const) {
    writeFileSync(
      join(auditBundle, `${name}.json`),
      readFileSync(join(runtimeBundle, `${name}.json`)),
    );
  }
  const auditPath = relative(worktreeRoot, auditBundle).split(sep).join('/');
  if (git(worktreeRoot, ['add', '--', auditPath]).status !== 0) {
    throw new Error('POST_MERGE_AUDIT_STAGE_FAILED');
  }
  if (git(worktreeRoot, ['commit', '-m', `audit(post-merge): observe ${mergeSha}`]).status !== 0) {
    throw new Error('POST_MERGE_AUDIT_COMMIT_FAILED');
  }
  if (git(worktreeRoot, ['update-ref', `refs/devai/post-merge/${mergeSha}`, 'HEAD']).status !== 0) {
    throw new Error('POST_MERGE_AUDIT_REF_FAILED');
  }
}

export async function runPostMergeAuditor(
  opts: PostMergeAuditorOptions,
): Promise<PostMergeAuditorResult> {
  const repoRoot = realpathSync(resolve(opts.repoRoot));
  const verified = verifyPostMergeHostReceipt({ ...opts, repoRoot });
  const worktreeRoot = join(repoRoot, '.devai/worktrees/auditor-post-merge');
  const stateRoot = join(repoRoot, '.git/devai/post-merge-observations');
  const lockPath = join(repoRoot, '.git/devai/post-merge.lock');
  return (async () => {
    try {
      mkdirSync(lockPath);
    } catch (error) {
      if (existsSync(lockPath)) {
        return {
          status: 'busy',
          merge_sha: verified.mergeSha,
          processed: [],
          worktree: worktreeRoot,
          cadence: { installed_checkout: 'persistent', remote_host: 'unknown' },
        };
      }
      throw error;
    }
    try {
      const merges = gitText(
        repoRoot,
        [
          'rev-list',
          '--first-parent',
          '--merges',
          '--reverse',
          `${verified.baselineSha}..${verified.mergeSha}`,
        ],
        'POST_MERGE_HISTORY_UNAVAILABLE',
      )
        .split(/\r?\n/u)
        .filter((sha) => FULL_SHA.test(sha));
      if (!existsSync(worktreeRoot)) {
        mkdirSync(dirname(worktreeRoot), { recursive: true });
        const added = git(repoRoot, [
          'worktree',
          'add',
          '--detach',
          worktreeRoot,
          verified.mergeSha,
        ]);
        if (added.status !== 0) throw new Error('POST_MERGE_WORKTREE_CREATE_FAILED');
      }
      assertCleanObservationWorktree(worktreeRoot);
      const processed: string[] = [];
      let previousMergeSha: string | null = null;
      let previousDigest: string | null = null;
      for (const mergeSha of merges) {
        const completedDigest = completedObservationDigest(stateRoot, mergeSha);
        const committedDigest = completedAuditObservationDigest(worktreeRoot, mergeSha);
        if (completedDigest !== null && committedDigest === completedDigest) {
          previousMergeSha = mergeSha;
          previousDigest = completedDigest;
          continue;
        }
        const checkout = git(worktreeRoot, ['checkout', '--detach', mergeSha]);
        if (checkout.status !== 0) throw new Error('POST_MERGE_WORKTREE_ADVANCE_FAILED');
        archiveIncompleteObservation(stateRoot, mergeSha);
        previousDigest = await writeBundle(
          worktreeRoot,
          stateRoot,
          mergeSha,
          opts.now ?? new Date().toISOString(),
          previousMergeSha,
          previousDigest,
          opts.injectFailure === true,
        );
        commitAuditBundle(worktreeRoot, stateRoot, mergeSha);
        previousMergeSha = mergeSha;
        processed.push(mergeSha);
      }
      assertCleanObservationWorktree(worktreeRoot);
      return {
        status: processed.length === 0 ? 'replayed' : 'completed',
        merge_sha: verified.mergeSha,
        processed,
        worktree: worktreeRoot,
        cadence: { installed_checkout: 'persistent', remote_host: 'unknown' },
      };
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  })();
}

export function assertCleanObservationWorktree(worktreeRoot: string): void {
  const clean = git(worktreeRoot, ['status', '--porcelain']);
  if (clean.status !== 0 || clean.stdout.trim().length > 0) {
    throw new Error('POST_MERGE_WORKTREE_DIRTY');
  }
}
