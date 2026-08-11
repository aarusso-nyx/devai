import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getValidator } from '@devai-nyx/schemas';
import { computeSourceHash } from './source-hash.js';
import { dirname } from 'node:path';
import { resolveLocalEvidencePolicy, type LocalEvidencePolicy } from './config.js';
import type { LocalEvidenceManifest } from './collect.js';
import { deriveExactSubject, deriveTrailerParentSubject } from './subject.js';

const validateLocalEvidenceManifest = getValidator('local-evidence-manifest.schema.json');

/**
 * `devai evidence local verify` core (D-117): validate a
 * local-evidence manifest against the repo's declared policy.
 * Fail-closed throughout (ADR-CI-ECONOMY Decision 2): a claimed
 * manifest that is missing, stale, tree-mismatched, policy-laxer
 * than declared, untrusted, or accompanied by policy-sensitive file
 * changes throws LocalEvidenceError; only the *absence* of a claim
 * resolves to the fallback path (evidence_mode=false, heavy tiers
 * run remotely).
 */
export class LocalEvidenceError extends Error {
  readonly evidenceFailure = true;
}

function fail(message: string): never {
  throw new LocalEvidenceError(message);
}

export type VerifyMode = 'auto' | 'strict' | 'gate';

export interface VerifyContext {
  readonly eventName: string;
  readonly ref: string;
  readonly actor: string;
  readonly headMessage: string;
  /** Changed files for forbidden-path checks; null when unknowable. */
  readonly changedFiles: readonly string[] | null;
}

export interface VerifyLocalInputs {
  readonly repoRoot: string;
  readonly mode: VerifyMode;
  readonly context: VerifyContext;
  /** Override the declared manifest path. */
  readonly manifestPath?: string;
  /** Trusted-actor allowlist (already normalized to a list). */
  readonly trustedActors?: readonly string[];
  /** Injectable clock for tests. */
  readonly now?: number;
}

export interface VerifyLocalResult {
  readonly evidenceMode: boolean;
  readonly outcome: 'evidence-valid' | 'no-claim' | 'pr-disabled' | 'strict-valid';
  readonly message: string;
  readonly manifestPath: string;
}

export function parseTrailerPath(message: string): string {
  const match = /^Local-CI-Evidence:\s*(\S+)\s*$/imu.exec(message);
  return match?.[1] ?? '';
}

export function normalizeActorList(value: string): string[] {
  return value
    .split(/[\s,;]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readManifest(absPath: string): LocalEvidenceManifest {
  if (!existsSync(absPath)) fail(`missing evidence manifest: ${absPath}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absPath, 'utf8'));
  } catch (err) {
    fail(
      `evidence manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!validateLocalEvidenceManifest(parsed)) {
    const errors = (validateLocalEvidenceManifest.errors ?? [])
      .map((e) => `${e.instancePath} ${e.message ?? ''}`)
      .join('; ');
    fail(`evidence manifest fails schema validation: ${errors}`);
  }
  return parsed as LocalEvidenceManifest;
}

/** The manifest's carried policy may be stricter than declared, never laxer. */
function validatePolicyAlignment(
  manifest: LocalEvidenceManifest,
  policy: LocalEvidencePolicy,
): void {
  if (manifest.policy.maxAgeHours > policy.maxAgeHours) {
    fail(
      `manifest maxAgeHours ${String(manifest.policy.maxAgeHours)} exceeds declared ${String(policy.maxAgeHours)}`,
    );
  }
  for (const job of policy.requiredJobs) {
    if (!manifest.policy.requiredJobs.includes(job)) {
      fail(`manifest requiredJobs is missing declared job: ${job}`);
    }
  }
  for (const platform of manifest.policy.allowedPlatforms) {
    if (!policy.allowedPlatforms.includes(platform)) {
      fail(`manifest allows undeclared platform: ${platform}`);
    }
  }
}

function validateAge(manifest: LocalEvidenceManifest, now: number): void {
  const generatedAt = Date.parse(manifest.generatedAt);
  if (!Number.isFinite(generatedAt)) fail('manifest generatedAt is not a valid timestamp');
  if (generatedAt > now + 5 * 60 * 1000) fail('manifest generatedAt is in the future');
  const ageHours = (now - generatedAt) / (60 * 60 * 1000);
  if (ageHours > manifest.policy.maxAgeHours) {
    fail(
      `manifest is stale: ${ageHours.toFixed(2)}h old, max ${String(manifest.policy.maxAgeHours)}h`,
    );
  }
  const expiresAt = Date.parse(manifest.expiresAt);
  const expectedExpiresAt = generatedAt + manifest.policy.maxAgeHours * 60 * 60 * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt !== expectedExpiresAt) {
    fail('manifest expiresAt does not equal generatedAt plus maxAgeHours');
  }
  if (now > expiresAt) fail('manifest has expired');
}

export function validateExactSubject(
  manifest: LocalEvidenceManifest,
  repoRoot: string,
  manifestPath: string,
): void {
  const current = deriveExactSubject(repoRoot);
  let expected = current;
  if (manifest.subject.commitSha !== current.commitSha) {
    try {
      expected = deriveTrailerParentSubject(repoRoot, manifestPath);
    } catch {
      // Retain the current subject so ordinary commits keep the stable
      // subject-mismatch diagnostic instead of being mistaken for trailers.
    }
  }
  if (manifest.subject.repository !== expected.repository) {
    fail(
      `manifest repository subject mismatch: expected ${expected.repository}, got ${manifest.subject.repository}`,
    );
  }
  if (manifest.subject.commitSha !== expected.commitSha) {
    fail(
      `manifest commit subject mismatch: expected ${expected.commitSha}, got ${manifest.subject.commitSha}`,
    );
  }
  if (
    manifest.subject.tree.algorithm !== expected.tree.algorithm ||
    manifest.subject.tree.value !== expected.tree.value
  ) {
    fail('manifest tree subject mismatch');
  }
}

function validateSourceHash(
  manifest: LocalEvidenceManifest,
  repoRoot: string,
  manifestPath: string,
): void {
  const current = computeSourceHash(repoRoot, [dirname(manifestPath)]);
  if (manifest.sourceHash.value !== current.value) {
    fail(
      `manifest source hash mismatch: expected ${current.value}, got ${manifest.sourceHash.value}`,
    );
  }
  if (manifest.sourceHash.fileCount !== current.fileCount) {
    fail(
      `manifest source file count mismatch: expected ${String(current.fileCount)}, got ${String(manifest.sourceHash.fileCount)}`,
    );
  }
}

function majorFromEngine(engine: string): string {
  const match = />=\s*(\d+)/u.exec(engine);
  return match?.[1] ?? '';
}

function validateTools(
  manifest: LocalEvidenceManifest,
  repoRoot: string,
  policy: LocalEvidencePolicy,
): void {
  let pkg: { packageManager?: string; engines?: { node?: string } } = {};
  try {
    pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as typeof pkg;
  } catch {
    fail('cannot read package.json for tool-version validation');
  }

  const expectedNodeMajor = majorFromEngine(pkg.engines?.node ?? '');
  const observedNode = manifest.tools['node']?.observed ?? [];
  if (expectedNodeMajor.length > 0) {
    if (
      observedNode.length === 0 ||
      observedNode.some((version) => !version.startsWith(`v${expectedNodeMajor}.`))
    ) {
      fail(`manifest node versions must all use major ${expectedNodeMajor}`);
    }
  }

  const pm = pkg.packageManager ?? '';
  const at = pm.indexOf('@');
  if (at > 0) {
    const pmName = pm.slice(0, at);
    const pmVersion = pm.slice(at + 1);
    const observedPm = manifest.tools[pmName]?.observed ?? [];
    if (observedPm.length === 0 || observedPm.some((version) => version !== pmVersion)) {
      fail(`manifest ${pmName} versions must all equal ${pmVersion}`);
    }
  }

  if (policy.requireDocker && (manifest.tools['docker']?.observed ?? []).length === 0) {
    fail('manifest must record docker version evidence (require_docker is set)');
  }
}

function validateJobs(manifest: LocalEvidenceManifest, policy: LocalEvidencePolicy): void {
  for (const jobName of policy.requiredJobs) {
    const job = manifest.jobs[jobName];
    if (job === undefined) fail(`manifest missing required job: ${jobName}`);
    if (job.result !== 'success') fail(`manifest job ${jobName} did not succeed`);
    if (job.metadata['job'] !== jobName) fail(`manifest job ${jobName} metadata does not match`);
    const platform = job.metadata['platform'] ?? '';
    if (!policy.allowedPlatforms.includes(platform)) {
      fail(`manifest job ${jobName} used disallowed platform: ${platform}`);
    }
  }
}

function validateTrustedActor(actor: string, trustedActors: readonly string[]): void {
  if (actor.length === 0) fail('evidence mode requires a GitHub actor');
  if (trustedActors.length === 0) fail('evidence mode requires a trusted-actor allowlist');
  if (!trustedActors.includes(actor)) fail(`actor is not trusted for local evidence: ${actor}`);
}

function validateForbiddenFiles(
  changedFiles: readonly string[] | null,
  policy: LocalEvidencePolicy,
  requireChangedFiles: boolean,
): void {
  if (changedFiles === null) {
    if (requireChangedFiles) fail('unable to determine changed files for evidence policy');
    return;
  }
  const forbidden = changedFiles.filter((file) =>
    policy.forbiddenPaths.some(
      (path) => file === path || file === path.replace(/\/$/u, '') || file.startsWith(path),
    ),
  );
  if (forbidden.length > 0) {
    fail(
      `evidence mode cannot be used with policy-sensitive file changes: ${forbidden.join(', ')}`,
    );
  }
}

function validateManifest(
  inputs: VerifyLocalInputs,
  policy: LocalEvidencePolicy,
  manifestPath: string,
  options: { requireTrust: boolean; requireChangedFiles: boolean },
): void {
  const manifest = readManifest(join(inputs.repoRoot, manifestPath));
  validatePolicyAlignment(manifest, policy);
  validateAge(manifest, inputs.now ?? Date.now());
  validateExactSubject(manifest, inputs.repoRoot, manifestPath);
  validateSourceHash(manifest, inputs.repoRoot, manifestPath);
  validateTools(manifest, inputs.repoRoot, policy);
  validateJobs(manifest, policy);
  if (options.requireTrust) {
    validateTrustedActor(inputs.context.actor, inputs.trustedActors ?? []);
  }
  validateForbiddenFiles(inputs.context.changedFiles, policy, options.requireChangedFiles);
}

export function verifyLocalEvidence(inputs: VerifyLocalInputs): VerifyLocalResult {
  if (inputs.mode === 'gate' && inputs.manifestPath !== undefined) {
    fail('caller-selected manifest paths are forbidden in gate mode');
  }
  const policy = resolveLocalEvidencePolicy(inputs.repoRoot);
  const trailer = parseTrailerPath(inputs.context.headMessage);
  const isPullRequest =
    inputs.context.eventName === 'pull_request' ||
    inputs.context.eventName === 'pull_request_target';
  const isMainPush =
    inputs.context.eventName === 'push' && inputs.context.ref === 'refs/heads/main';

  const manifestPath = inputs.manifestPath ?? policy?.manifestPath ?? '';

  if (inputs.mode === 'strict') {
    if (policy === null) {
      fail(
        'no local-evidence policy declared: set ci_economy.local_evidence.required_jobs in .devai/config/project.json',
      );
    }
    validateManifest(inputs, policy, manifestPath, {
      requireTrust: false,
      requireChangedFiles: false,
    });
    return {
      evidenceMode: false,
      outcome: 'strict-valid',
      message: 'local CI evidence is valid',
      manifestPath,
    };
  }

  if (isPullRequest) {
    return {
      evidenceMode: false,
      outcome: 'pr-disabled',
      message: 'pull request evidence mode is disabled; normal CI is required',
      manifestPath,
    };
  }

  if (isMainPush && trailer.length > 0) {
    if (policy === null) {
      fail(
        'commit claims Local-CI-Evidence but the repo declares no ci_economy.local_evidence policy (never-silently-open)',
      );
    }
    if (trailer !== manifestPath) {
      fail(`Local-CI-Evidence trailer must point to ${manifestPath}, got ${trailer}`);
    }
    validateManifest(inputs, policy, manifestPath, {
      requireTrust: true,
      requireChangedFiles: true,
    });
    return {
      evidenceMode: true,
      outcome: 'evidence-valid',
      message: 'trusted local CI evidence is valid; heavy jobs may skip',
      manifestPath,
    };
  }

  return {
    evidenceMode: false,
    outcome: 'no-claim',
    message:
      inputs.mode === 'gate'
        ? 'no trusted local CI evidence claimed; normal CI is required'
        : 'normal CI is required',
    manifestPath,
  };
}
