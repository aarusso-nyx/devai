---
'@aarusso-nyx/devai': minor
---

Add opt-in GitHub Issues governance tracking.

Tracking is disabled by default and preserves 1.2.13 behavior exactly when absent.
Enabling it requires an Architect repository binding
(`devai init bind --tracking-adapter github-issues --tracking-repository <owner/name>`),
then explicit Owner activation per round
(`devai round tracking enable --round <id> --publish --write`).

Every governed finding and mediated action is recorded locally first, in append-only
per-session hash chains, and sealed into `record/proofs/governance/`. GitHub is an
output-only, rebuildable projection: batches are posted idempotently by a stable marker,
issue comments and labels carry no authority, and an unreachable remote is reported as
projection health rather than as a governed verdict. Publication is redacted through the
`public-safe-v1` disclosure profile, which withholds payload content and publishes digests
in its place.

New preview actions: `round tracking enable`, `round tracking status`, `round tracking sync`,
and `round tracking disable`. The public action surface grows from 44 to 48.
