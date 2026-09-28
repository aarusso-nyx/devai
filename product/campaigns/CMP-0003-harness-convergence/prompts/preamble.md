# Session preamble

You are working in the aarusso-nyx/devai repository, in a dedicated worktree, on a
branch named `codex/<round>-<task>-<slug>` or `claude/<round>-<task>-<slug>`.
Declare exactly one role for this session and do not change it. The task prompt
that follows names the role.

Read first: `AGENTS.md`, `law/constitution.md` Articles 4 to 7, 18, 23 to 28, and
32 to 36, the decision record named in the task, `law/policy/campaign-execution.json`,
`law/policy/self-dogfood.json`, the proposals document
`docs/dev/operations/harness-convergence-proposals.md` (its Decisions taken by the
maintainer section binds every task), and the task entry in
`product/campaigns/CMP-0003-harness-convergence/campaign.json`.

Model and effort: the task prompt names a tier and an effort. The orchestrator
resolves the tier to a host model through `models.tiers` in `campaign.json`
(Claude and Codex columns). Never name a model in a commit or report; name
the tier. If the task fails once, reports a gap, or exceeds its time budget
without a pull request, the orchestrator reruns it one tier rank up.

Time matters. Deliver the declared scope within the time budget. When a
choice would take more than a few minutes to settle, take the simpler option
that satisfies the acceptance commands and note the alternative in your
report. Report partial progress rather than pursue perfection, and never
widen scope to chase an unrelated improvement.

Rules for this campaign:

- The check runner under `.devai/state/pr-bootstrap/` is gitignored and compiled
  from the checkout by `pnpm run release:bootstrap`; run it after `pnpm run build`
  before any acceptance command that invokes `bin.js`, or you measure a stale build.
- Acceptance is a correct measured outcome, never a green score: a real FAIL stays
  visible, a missing prerequisite is a diagnostic, and no threshold, override, or
  reading is edited to make a check pass.
- Inspector tests are written before the engineer implements; they may be red at
  the inspector's merge and must be green at the engineer's. A coupled wave ships
  as one pull request from the engineer's head when one orchestrator runs it.
- Broker admission edits, authority policy edits, and repository settings are
  never widened silently; a task that needs one outside its boundary stops and
  reports.

Rules for every task:

- Stay inside the task boundary paths. A needed change outside them is a reason to
  stop and report, never to widen the task.
- Commit with `type(scope): subject`, using only the task's declared commit types.
  Never mix governance paths (`law/`, `product/`, `record/`) with implementation
  paths (`packages/`, `tests/`, `docs/`, `scripts/`, `.github/`) in one commit. The
  one permitted pairing is a law policy with its materialized copy under
  `.devai/config` and the action registry with its generated views.
- Run every acceptance command and read every result before claiming completion.
- Do not push, tag, publish, change repository settings, bump a version, add a
  dependency, or edit an accepted or superseded decision record.
- When the record is silent, contradictory, or materially ambiguous, stop and
  report the exact question. Do not invent policy.
- Never place a credential, token, or environment value in a file, a commit, or
  your report.
- Finish with three sections: files changed, commands run with a one-line result
  each, open questions.
