# Opt-in GitHub Issues governance tracking

DEVAI can record every governed finding and mediated action locally and project a public-safe
summary into one GitHub Issue per governed round.

Tracking is **disabled by default**. A repository with no tracking binding behaves exactly as it
did before this feature existed: no tracking state, no network call, no readiness effect. That is
a fully supported posture, and `devai doctor` reports it as a clean opt-out rather than a defect.

Turning it on takes three separate, explicit decisions by two different authorities:

1. The **Architect** binds the repository capability.
2. The **Owner** activates tracking for one specific round.
3. That same Owner activation authorizes the bounded remote publication it performs — nothing
   more.

## What is and is not covered

Only **DEVAI-mediated actions** are tracked: registered runtime actions and declared host-adapter
events. Editor writes, shell commands, and anything else outside the DEVAI runtime are **not**
covered, and DEVAI never implies otherwise. Every status report and every projected issue states
this boundary explicitly, and unmediated activity that DEVAI does notice is recorded as
explicitly uncovered rather than omitted or claimed as tracked.

Events are recorded at these boundaries:

| Boundary                                           | Event kind                                         |
| -------------------------------------------------- | -------------------------------------------------- |
| Owner activation of a round                        | `session_opened`, `authorization_recorded`         |
| Task started or resumed                            | `action_intended`                                  |
| Task completed                                     | `action_completed`                                 |
| Task paused for a reference gap, or escalated      | `failure_observed`                                 |
| Reference gap emitted                              | `finding_emitted`                                  |
| Reference gap resolved                             | `finding_classified`                               |
| Routine executor verification receipt              | `verification_result` (with exact commit and tree) |
| Round closed                                       | `round_verdict`                                    |
| Tracking disabled                                  | `tracking_disabled`                                |
| Backlog item projected (`backlog add --round`)     | `backlog_item_projected`                           |
| Sensor failure triaged (`triage classify --round`) | `finding_classified`                               |
| Auditor observation (`audit observe --round`)      | `finding_emitted`                                  |
| Authority granted an outward-reaching action       | `authorization_recorded`                           |

`triage classify` and `audit observe` are not inherently round-scoped, so attribution there is
**opt-in per invocation** via an optional `--round`. Without it they behave exactly as they did
before tracking existed, and nothing is recorded — a round is never inferred. An Auditor
observation is recorded as an observation, never as a verdict (Article 7: a report may recommend,
never ratify).

Authority decisions are recorded at the boundary where the decision took effect, under three
deliberate limits:

- **Granted decisions only.** A refused invocation has, by definition, no authorized scope to
  write in. Minting one so the harness could note the refusal would grant an effect the decision
  had just denied, so refusals are not recorded.
- **Outward-reaching decisions only.** A `remote-write` action, or one carrying publication
  consent, is recorded. A purely local harness write is already bracketed by its
  `action_intended` / `action_completed` pair, and recording its authorization as well would
  crowd findings and verification results out of the projection without adding signal.
- **`--round` required.** As everywhere else, a round is never inferred.

## Binding the repository capability (Architect)

```bash
devai init bind --tracking-adapter github-issues --tracking-repository owner/name --as-role architect
```

The dry run is the default. Review the plan, then apply it:

```bash
devai init bind --tracking-adapter github-issues --tracking-repository owner/name --as-role architect --write
```

Binding materializes three things:

| Path                                         | Contents                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `.devai/config/github-issues-tracking.json`  | The canonical policy defaults, verbatim, plus this repository's exact identity and digests |
| `.github/workflows/devai-issue-tracking.yml` | The generated reconciliation workflow                                                      |
| `.devai/config/project.json`                 | A `governance_tracking` binding                                                            |

`--tracking-repository` takes the exact `owner/name` remote (an `https://` or `ssh` URL is also
accepted and normalized). Any other repository is refused at activation time rather than silently
re-targeted. `--target` keeps its usual meaning of the working tree.

**No token is ever stored.** The local projector invokes the already-authenticated `gh` boundary
and never reads, derives, or persists a credential. A configuration that contains credential
material is a Doctor failure.

## Activating one round (Owner)

```bash
devai round tracking enable --round R-0042 --publish --as-role owner --write
```

`--publish` is required and is never inferred from the presence of a binding. Activation binds the
round to the repository, the adapter digest, the Owner authority session, and the `public-safe-v1`
disclosure profile. It authorizes automatic publication only for validated public-safe events
belonging to **that** round.

### Chain identity

Events chain per authority session, and the chain identity is never invented per invocation.

- With `--authority-session <id>`, the session is validated exactly as the authority layer
  validates it — schema, self-digest, status, expiry, and declared role must all agree. A session
  that fails any of those checks is a **refusal**, never a silent downgrade.
- Without one, the invocation gets a deterministic `DIRECT-CLI-…` chain derived from the
  repository, role, and round. Repeated commands extend that one chain instead of scattering
  single-event chains, and every event records `session_source: "direct-cli"` so it is never
  mistaken for an authority session it never had.

Inspect at any time, with no network call:

```bash
devai round tracking status --round R-0042
```

```json
{
  "mode": "github-issues",
  "activation": "active",
  "canonical_events": 42,
  "projected_events": 35,
  "pending_events": 7,
  "projection": "pending",
  "issue": 123,
  "divergence": false
}
```

Readiness and tracking health are **separate axes**. A round can be `READY` while its projection
is still `PENDING`, `FAILED`, or `UNREACHABLE`. GitHub being unavailable is a failure to observe a
remote; it never manufactures or withdraws a governed verdict.

## Reconciling and disabling

```bash
devai round tracking sync --round R-0042 --publish --as-role owner --write
devai round tracking disable --round R-0042 --pending freeze --as-role owner --write
```

- `sync` is idempotent. Each batch carries a stable hidden marker, which is searched for before
  posting, so a retry after a timeout reconciles instead of duplicating.
- A **missing issue is reported as divergence, never silently recreated**. Recreating one requires
  `--replace-missing-issue` explicitly.
- `disable` defaults to `--pending freeze`, which stops projecting and keeps recording.
  `--pending drain` performs remote writes and therefore needs its own `--publish`.
- Previously published issues and comments are **never deleted**.

## CI reconciliation and derived authority

The generated workflow reconciles the sealed outbox on trusted `main`. It cannot declare a role,
because no human is present, and declaring `--as-role owner` from a workflow would be exactly the
silent role elevation Article 7 forbids.

It does not need to. The Owner already made the decision, at activation, and that decision is
explicitly standing: activation _"authorizes automatic publication only for validated public-safe
events belonging to that round"_. CI **replays** that recorded authorization; it never grants one.

This follows the pattern `round close --post-merge-receipt` already establishes in DEVAI —
caller-declared identity forbidden, authority derived from a verified artifact, effect scope
bounded to what that artifact covers.

Concretely, `round tracking sync --reconcile`:

- **Refuses** `--as-role`, `--authority-session`, `--write`, `--publish`, and `--machine-actor`.
  Supplying any of them is `TRACKING_RECONCILE_CALLER_AUTHORITY_FORBIDDEN`.
- Requires a committed, schema-valid activation for that exact round, in state `active`, carrying
  Owner publication consent. `frozen` and `disabled` are not standing authorizations.
- Requires the binding to still be byte-identical to canonical policy, and the activation's
  adapter and workflow digests to still match it. A re-binding is an Architect act, and an older
  Owner authorization is never carried across one silently.
- Checks the runner's own `GITHUB_REPOSITORY` against the binding, so a fork that merely copied
  the committed activation cannot replay it.
- Executes inside a **derived effect scope narrower than any live Owner session**: it may write
  this round's `delivery.json` and outbox, and invoke `gh api`. Nothing else. The canonical event
  log, sealed proofs, the activation record, other rounds, and every other process are refused at
  the boundary.

No fail-closed property is weakened by this. The interactive path is unchanged — an ordinary
`round tracking sync` still demands an explicit role declaration plus `--write` and `--publish`.

## Trust boundaries

GitHub is an output-only, rebuildable projection.

- Issue comments, labels, edits, and state are **untrusted output state**. They cannot authorize,
  route, close, merge, or publish anything, and tracked text is never interpreted as an
  instruction.
- Canonical events are append-only. Correction is a new appended supersession record; recorded
  bytes are never edited, and no remote acknowledgement can alter them.
- Ordering is **per authority session**. Independent worktrees and disconnected hosts keep
  separate hash chains rather than pretending to a single global order.
- Payload content is withheld by the `public-safe-v1` profile. Digests are published in its place,
  so a projection stays verifiable without disclosing prompts, command output, tokens, environment
  values, signing material, or host paths.

The generated workflow runs only on trusted `main` pushes and explicit dispatch, never through
`pull_request_target`. It holds `contents: read` and `issues: write` and nothing else, pins every
action to an immutable commit SHA, uses a per-round concurrency group, and is **not** a required
readiness context. Its reconciliation step runs under derived authority as described above, so a
workflow edit cannot grant itself publication rights the Owner never recorded.

## Backlog projection

The repository backlog (`backlog add`, `backlog list`, `backlog show`, `backlog resolve`;
ADR-GOV-0019) is a **local store**. Items live under `.devai/state/backlog/` as records validated
against `backlog-item.schema.json`, every backlog action works with network access denied, and
none of them is a remote write. A backlog item is not a round gap: it cannot pause, resolve, or
otherwise alter one, and it carries no round semantics of its own.

Projection of a backlog item into a governed round's issue is an extension of the same adapter,
under the same three decisions:

| Requirement        | Source                                                                      |
| ------------------ | --------------------------------------------------------------------------- |
| Repository binding | The existing Architect `init bind` — no separate backlog binding            |
| Round activation   | The existing Owner `round tracking enable --publish` for that exact round   |
| Disclosure         | The existing `public-safe-v1` profile — title and body digests, never text  |
| Event kind         | `backlog_item_projected`, appended to the round's canonical event log       |
| Batch bound        | `defaults.backlog_projection.max_items_per_batch` (64) items per projection |

Round attribution is **opt-in per item** through `backlog add --round R-0042`, exactly as
`triage classify --round` and `audit observe --round` work. Without it the item is recorded and
surfaced locally by `doctor` and `round plan`, and nothing is ever projected — a round is never
inferred from the session, the branch, or the active round. `backlog resolve` reads the round
from the item it resolves and never assigns one.

The `backlog_projection` block in `law/policy/github-issues-tracking.json` declares
`enabled_by: "round-activation"`: there is no backlog-specific activation, profile, or authority,
and an item attributed to a round whose activation is `frozen` or `disabled` stays local. As with
every other projected event, GitHub being unreachable is a failure to observe a remote and never
changes the item, its status, or any readiness verdict.

## Doctor behavior

| Situation                                                                                                                                        | Verdict                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| No binding                                                                                                                                       | Pass — valid opt-out, no network call |
| Binding byte-identical to canonical policy                                                                                                       | Pass                                  |
| Wrong repository, workflow drift, excess permissions, mutable action reference, credential fallback, malformed schema, or a false coverage claim | Fail                                  |
| GitHub unreachable, issue absent before first sync, events queued                                                                                | Advisory tracking status only         |

Round close always records and seals its final tracking event and never waits for GitHub. Any
remaining outbox is projected later, from sealed evidence, by a manual `sync` or by the
trusted-`main` workflow.
