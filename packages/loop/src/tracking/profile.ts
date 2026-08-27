/**
 * Runtime mirror of the `public-safe-v1` limits declared in
 * `law/policy/github-issues-tracking.json`.
 *
 * The recorder must not read policy files from disk — it runs on every
 * mediated action and must stay allocation-cheap and failure-free. The cost of
 * mirroring is drift, so drift is made detectable instead of accepted: an
 * Inspector test asserts these constants equal the canonical policy byte for
 * byte, and Doctor fails a binding whose defaults do not match.
 */
export const PUBLIC_SAFE_PROFILE = {
  profile: 'public-safe-v1',
  max_summary_chars: 512,
  max_events_per_batch: 128,
  max_batch_chars: 60_000,
  withheld_payload_digest: 'sha256',
} as const;

export type DisclosureProfile = typeof PUBLIC_SAFE_PROFILE.profile;
