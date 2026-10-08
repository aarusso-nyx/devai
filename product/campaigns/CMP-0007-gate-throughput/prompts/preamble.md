# CMP-0007 session preamble

This campaign brings the two pull-request gate cells of the self-scorecard to
PASS. F5:T7 is gate speed, read by `harness_performance`, with a median below
900 s (decision D6; it was 600 s). F5:T9 is gate pass rate, read by `harness_green_main`, with at least
95% green. No definition is relaxed and no threshold other than D6's, and no node
leaves the pull-request lane. The mandate, the baseline, and the Owner
decisions D1 to D5 of 2026-10-07 and D6 and the amended D4 of 2026-10-08 are in
[decisions.md](../decisions.md). Read it before you change anything.

Work in a dedicated worktree on a branch from a freshly fetched `origin/main`.
Declare the role your task prompt names and keep it. Read `AGENTS.md`,
`README.md`, `law/constitution.md`, the records your task names, and
`campaign.json` before you change governed state. Stay inside the boundary
paths of your task. Ask the orchestrator to widen a boundary rather than
editing outside it. Architect writes law and records, Inspector writes tests,
Engineer writes code.

Keep every commit inside one change family, with a subject from
`law/policy/commit-grammar.json` and one of the commit types your task lists.
Run the local preflight against the fetched base before you push. Serialized
admission is in force, because no merge queue was chosen under D2: at most one
task pull request is in `pre_merge` at a time. Never merge with `--admin`,
never squash, and never weaken or delete a test to get green.

No task performs an Owner effect. OE-02 (the auto-update branch setting) and
OE-03 (the 2.3.0 release) are performed by the Owner alone. Report partial
progress when your time budget runs out instead of continuing.
