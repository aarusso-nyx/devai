/**
 * Canonical policy loading and adopter binding for the opt-in `github-issues`
 * tracking adapter.
 *
 * Article 6 requires that anything under `.devai/config/` be materialized from
 * a canonical package or policy source and that a checker never write its own
 * inputs. The bound configuration therefore embeds the canonical defaults block
 * verbatim and adds only the adopter's exact identity plus the digests that
 * make drift detectable. No credential material is read, derived, or stored.
 */
import { existsSync, readFileSync } from '@devai-nyx/authority';
import { canonicalSha256 } from '@devai-nyx/utils';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TRACKING_ADAPTER_ID = 'github-issues';
export const TRACKING_CONFIG_RELATIVE = '.devai/config/github-issues-tracking.json';
export const TRACKING_WORKFLOW_RELATIVE = '.github/workflows/devai-issue-tracking.yml';
export const TRACKING_POLICY_RELATIVE = 'law/policy/github-issues-tracking.json';

export interface TrackingPolicyDefaults {
  readonly adapter: {
    readonly id: 'github-issues';
    readonly adapter_version: string;
    readonly issue_granularity: 'one-per-governed-round';
    readonly projection_timing: 'checkpoint-and-close';
    readonly disclosure_profile: 'public-safe-v1';
    readonly readiness_impact: 'best-effort';
  };
  readonly reconciliation: { readonly local: 'gh'; readonly ci: 'trusted-main-workflow' };
  readonly workflow: {
    readonly file: string;
    readonly triggers: readonly string[];
    readonly trusted_ref: string;
    readonly permissions: { readonly contents: 'read'; readonly issues: 'write' };
    readonly concurrency_group_prefix: string;
    readonly required_context: false;
    readonly pinned_actions: { readonly checkout: string; readonly setup_node: string };
  };
  readonly authentication: {
    readonly local_boundary: 'gh-authenticated-subprocess';
    readonly ci_token: 'github-token-scoped';
    readonly pat_fallback: false;
    readonly package_token_fallback: false;
    readonly store_token_in_config: false;
  };
  readonly disclosure: {
    readonly profile: 'public-safe-v1';
    readonly max_summary_chars: number;
    readonly max_events_per_batch: number;
    readonly max_batch_chars: number;
    readonly withheld_payload_digest: 'sha256';
    readonly neutralize: readonly string[];
    readonly forbidden_content: readonly string[];
  };
  readonly retry: {
    readonly max_attempts: number;
    readonly initial_delay_ms: number;
    readonly max_delay_ms: number;
    readonly multiplier: number;
  };
  readonly event_kinds: readonly string[];
}

export interface BoundTrackingConfig {
  readonly schemaVersion: '1.0.0';
  readonly id: 'github-issues-tracking';
  readonly binding: {
    readonly repository: string;
    readonly repository_id: string;
    readonly package_version: string;
    readonly bound_at: string;
    readonly bound_by_role: 'architect';
  };
  readonly defaults: TrackingPolicyDefaults;
  readonly digests: {
    readonly policy_defaults_sha256: string;
    readonly workflow_sha256: string;
  };
}

export class TrackingConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'TrackingConfigError';
  }
}

/**
 * Resolve the canonical policy from either the source checkout or the assembled
 * package layout. Failing to find it is an error, never a silent default: a
 * fabricated default would be exactly the false precision Article 39 forbids.
 */
export function loadTrackingPolicyDefaults(): TrackingPolicyDefaults {
  const moduleRoot = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleRoot, `../../${TRACKING_POLICY_RELATIVE}`),
    resolve(moduleRoot, `../../../../../${TRACKING_POLICY_RELATIVE}`),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) throw new TrackingConfigError('TRACKING_POLICY_MISSING');
  const policy = JSON.parse(readFileSync(path, 'utf8')) as { defaults?: TrackingPolicyDefaults };
  const defaults = policy.defaults;
  if (
    defaults?.adapter?.id !== TRACKING_ADAPTER_ID ||
    defaults.adapter.readiness_impact !== 'best-effort' ||
    defaults.workflow?.permissions?.contents !== 'read' ||
    defaults.workflow.permissions.issues !== 'write' ||
    defaults.workflow.required_context !== false ||
    defaults.workflow.trusted_ref !== 'refs/heads/main' ||
    defaults.workflow.triggers.includes('pull_request_target') ||
    defaults.authentication?.pat_fallback !== false ||
    defaults.authentication.package_token_fallback !== false ||
    defaults.authentication.store_token_in_config !== false ||
    defaults.disclosure?.profile !== 'public-safe-v1' ||
    !/^[0-9a-f]{40}$/u.test(defaults.workflow.pinned_actions?.checkout ?? '') ||
    !/^[0-9a-f]{40}$/u.test(defaults.workflow.pinned_actions.setup_node)
  ) {
    throw new TrackingConfigError('TRACKING_POLICY_INVALID');
  }
  return defaults;
}

export function trackingDefaultsDigest(defaults: TrackingPolicyDefaults): string {
  return canonicalSha256(defaults);
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** Normalize `owner/name`, an `https://` URL, or an `ssh://`-style remote. */
export function normalizeTrackingRepository(value: string): string {
  const trimmed = value.trim().replace(/\.git$/u, '');
  const fromUrl = /^(?:https?:\/\/[^/]+\/|git@[^:]+:|ssh:\/\/git@[^/]+\/)(.+)$/u.exec(trimmed);
  const candidate = fromUrl?.[1] ?? trimmed;
  if (!REPOSITORY_PATTERN.test(candidate)) {
    throw new TrackingConfigError('TRACKING_TARGET_REPOSITORY_INVALID');
  }
  return candidate;
}

export function readBoundTrackingConfig(repoRoot: string): BoundTrackingConfig | undefined {
  const path = join(resolve(repoRoot), TRACKING_CONFIG_RELATIVE);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as BoundTrackingConfig;
}

export interface TrackingBindingFinding {
  readonly code: string;
  readonly detail: string;
}

/**
 * Verify a bound configuration against the live canonical policy and the
 * on-disk workflow. Every finding is a hard failure of the binding, not an
 * advisory: a configuration that claims coverage it cannot deliver is worse
 * than no tracking at all.
 */
export function verifyTrackingBinding(options: {
  readonly repoRoot: string;
  readonly config: BoundTrackingConfig;
  readonly workflow: string | undefined;
  readonly expectedRepository?: string;
}): readonly TrackingBindingFinding[] {
  const findings: TrackingBindingFinding[] = [];
  const defaults = loadTrackingPolicyDefaults();

  if (canonicalSha256(options.config.defaults) !== trackingDefaultsDigest(defaults)) {
    findings.push({
      code: 'TRACKING_BINDING_POLICY_DRIFT',
      detail: 'bound defaults differ from law/policy/github-issues-tracking.json',
    });
  }
  if (options.config.digests.policy_defaults_sha256 !== canonicalSha256(options.config.defaults)) {
    findings.push({
      code: 'TRACKING_BINDING_DIGEST_MISMATCH',
      detail: 'recorded defaults digest does not match the embedded defaults',
    });
  }
  if (options.config.binding.bound_by_role !== 'architect') {
    findings.push({
      code: 'TRACKING_BINDING_ROLE_INVALID',
      detail: 'repository capability binding is Architect authority',
    });
  }
  if (
    options.expectedRepository !== undefined &&
    options.config.binding.repository !== options.expectedRepository
  ) {
    findings.push({
      code: 'TRACKING_BINDING_REPOSITORY_MISMATCH',
      detail: `bound to ${options.config.binding.repository}, observed ${options.expectedRepository}`,
    });
  }
  if (options.workflow === undefined) {
    findings.push({
      code: 'TRACKING_WORKFLOW_MISSING',
      detail: `${TRACKING_WORKFLOW_RELATIVE} is absent`,
    });
  } else if (
    options.config.digests.workflow_sha256 !== canonicalSha256({ workflow: options.workflow })
  ) {
    findings.push({
      code: 'TRACKING_WORKFLOW_DRIFT',
      detail: 'generated workflow bytes differ from the bound digest',
    });
  }
  // A token in configuration would survive in git history forever.
  if (/gh[pousr]_[A-Za-z0-9]{16,}|github_pat_/u.test(JSON.stringify(options.config))) {
    findings.push({
      code: 'TRACKING_BINDING_CREDENTIAL_PRESENT',
      detail: 'configuration must never carry credential material',
    });
  }
  return findings;
}
