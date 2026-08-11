import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Local-CI-evidence policy resolution (D-117; ADR-CI-ECONOMY
 * Decisions 1-3 promoted from the stynx C-4 prototype).
 *
 * The policy is declared in `.devai/config/project.json` under
 * `ci_economy.local_evidence` (project-config.schema.json). Absent
 * declaration means the repo does not accept local evidence: the
 * gate's fallback path always runs heavy tiers remotely, and a
 * manifest claimed via commit trailer against an undeclared policy
 * is a hard failure (never-silently-open, ADR-CI-ECONOMY Decision 2).
 */
export interface LocalEvidencePolicy {
  readonly manifestPath: string;
  readonly maxAgeHours: number;
  readonly requiredJobs: readonly string[];
  readonly allowedPlatforms: readonly string[];
  /** Built-in prefixes + manifest dir + declared extras (extend-only). */
  readonly forbiddenPaths: readonly string[];
  readonly requireDocker: boolean;
}

export const DEFAULT_MANIFEST_PATH = 'record/proofs/work/local-evidence/local-ci.json';
export const DEFAULT_MAX_AGE_HOURS = 24;
export const DEFAULT_ALLOWED_PLATFORMS: readonly string[] = ['linux/arm64', 'linux/amd64'];

/**
 * Policy-sensitive surfaces whose changes always reject evidence
 * mode, regardless of declared config. Declared `forbidden_paths`
 * entries extend this set; they can never shrink it.
 */
export const BUILT_IN_FORBIDDEN_PATHS: readonly string[] = ['.github/workflows/', '.devai/config/'];

interface RawLocalEvidenceConfig {
  readonly manifest_path?: string;
  readonly max_age_hours?: number;
  readonly required_jobs?: readonly string[];
  readonly allowed_platforms?: readonly string[];
  readonly forbidden_paths?: readonly string[];
  readonly require_docker?: boolean;
}

/**
 * Resolve the declared local-evidence policy for a repo, or null
 * when the repo declares none. Malformed project.json resolves to
 * null (same posture as `readProfile`): the strict default is
 * "no local evidence accepted", so parse failures can only make
 * the gate stricter, never laxer.
 */
export function resolveLocalEvidencePolicy(repoRoot: string): LocalEvidencePolicy | null {
  const configPath = join(repoRoot, '.devai/config/project.json');
  if (!existsSync(configPath)) return null;

  let raw: RawLocalEvidenceConfig | undefined;
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
      ci_economy?: { local_evidence?: RawLocalEvidenceConfig };
    };
    raw = parsed.ci_economy?.local_evidence;
  } catch {
    return null;
  }
  if (raw === undefined) return null;
  if (!Array.isArray(raw.required_jobs) || raw.required_jobs.length === 0) return null;

  const manifestPath = raw.manifest_path ?? DEFAULT_MANIFEST_PATH;
  // Note: the manifest's own path is deliberately NOT added here — it
  // always changes in the commit that claims evidence mode (that's
  // the mechanism), and is separately excluded from the source-hash
  // computation itself (see collect()/verify()'s `[dirname(manifestPath)]`
  // exclusion). Forbidding it would make evidence mode unusable.
  const forbidden = new Set<string>(BUILT_IN_FORBIDDEN_PATHS);
  for (const extra of raw.forbidden_paths ?? []) forbidden.add(extra);

  return {
    manifestPath,
    maxAgeHours: raw.max_age_hours ?? DEFAULT_MAX_AGE_HOURS,
    requiredJobs: [...raw.required_jobs],
    allowedPlatforms:
      raw.allowed_platforms !== undefined && raw.allowed_platforms.length > 0
        ? [...raw.allowed_platforms]
        : [...DEFAULT_ALLOWED_PLATFORMS],
    forbiddenPaths: [...forbidden],
    requireDocker: raw.require_docker === true,
  };
}
