# Session preamble

You are working in the aarusso-nyx/devai repository, in a dedicated worktree, on a
branch named `codex/<round>-<task>-<slug>` or `claude/<round>-<task>-<slug>`.
Declare exactly one role for this session and do not change it. The task prompt
that follows names the role.

Read first: `AGENTS.md`, `law/constitution.md` Articles 4 to 10, 18, 23 to 28, 36,
and 40, the decision records named in the task (ADR-GOV-0024 and ADR-AUT-0003),
`law/policy/campaign-execution.json`, `law/policy/self-dogfood.json`, the proposal
`docs/dev/operations/multi-stack-path-authority-proposal.md` (its "Decisions
required" section and the Owner's answers recorded under OE-01 bind every task),
and the task entry in
`product/campaigns/CMP-0005-multi-stack-path-authority/campaign.json`.

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
- `law/constitution.md` is edited by TASK-0511 only, with exactly the text
  ADR-GOV-0024 states and only after OE-01 records the Owner's approval; no other
  task edits the constitution, a pinned copy, or a materialized policy by hand.
- Authority is never widened silently: the immutable core rules, the package
  extension `devai-adopter-authority`, and their precedences are not edited; the
  adopter extension is compiled from its source and materialized only through
  `init bind`. A task that needs a change outside its boundary stops and reports.
- Acceptance is a correct measured outcome, never a green score: a real deny stays
  a deny, a refusal code is asserted by name, and no fixture, threshold, or reading
  is edited to make a check pass.
- Inspector tests are written before the engineer implements; they may be red at
  the inspector's merge and must be green at the engineer's. A coupled wave ships
  as one pull request from the engineer's head when one orchestrator runs it.

Rules for every task:

- Stay inside the task boundary paths. A needed change outside them is a reason to
  stop and report, never to widen the task.
- Commit with `type(scope): subject`, using only the task's declared commit types.
  Never mix governance paths (`law/`, `product/`, `record/`) with implementation
  paths (`packages/`, `tests/`, `docs/`, `scripts/`, `.github/`) in one commit. The
  one permitted pairing is a law source with its materialized or pinned copy under
  `.devai/` and the action registry with its generated views.
- Run every acceptance command and read every result before claiming completion.
- Do not push, tag, publish, change repository settings, bump a package version, add
  a dependency, or edit an accepted or superseded decision record.
- When the record is silent, contradictory, or materially ambiguous, stop and
  report the exact question. Do not invent policy.
- Never place a credential, token, or environment value in a file, a commit, or
  your report.
- Finish with three sections: files changed, commands run with a one-line result
  each, open questions.
