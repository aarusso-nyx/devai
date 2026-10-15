---
id: ADR-GOV-0026
title: The Engineer authors focused regression tests for its own change; designated assurance stays independent
type: adr
status: proposed
date: 2026-10-14
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 6 (write authority by path)
  - law/constitution.md Article 7 (what each role may author)
  - ADR-AUT-0003 (governed adopter path authority by path classes)
  - ADR-AUT-0004 (registered write verbs per path class)
affected_rules:
  - law/constitution.md
  - packages/skills/resources/roles/engineer.md
  - packages/skills/resources/roles/inspector.md
  - packages/authority/src/capabilities/path-domains.ts
  - packages/authority/src/runtime/policy-resolver.ts
inspector_acceptance:
  - IA-001 -- Under the amended contract an Engineer task that changed a source file may write a test that imports or targets that same changed file, and an Engineer write to a test file unrelated to the task's changed sources is still refused by path and by diff adjacency.
  - IA-002 -- An Engineer write is refused when it deletes a test, edits an assertion of a test the same task did not add, or lowers a coverage or mutation threshold; each of those stays an Inspector verb.
  - IA-003 -- A round or task designated independent-assurance withholds the Engineer test verb, so Article 6's original binding applies unchanged and the same focused-regression write is refused.
  - IA-004 -- Until the verb registration and path enforcement land the Engineer prompt's test authority has no mechanical effect, so a test-path write is refused and reported as a cross-scope need.
---

# The Engineer authors focused regression tests for its own change; designated assurance stays independent

## Status

Proposed on 2026-10-14. Owner decision D1 of the same date chose option B. The record is
not binding while its status is `proposed`, and the authority it describes takes effect only
when the verb registration and the path enforcement land in the same release as the amended
Articles 6 and 7.

## Context

Article 6 binds the test class (`tests/`, `packages/*/tests/`) to the Inspector only. In practice every ordinary bug fix therefore needs two tasks and a handoff: the Engineer repairs the code, a separate Inspector task writes the regression test. With the current worker models the handoff is the dominant cost of a small fix, and the implementer's own regression test is usually the most informative one. Two independent reviews of the skills and role prompts (2026-10-14) identified this split as the largest per-task overhead that is contractual rather than prompt-level.

Decision D1 by the Owner (2026-10-14): option B.

## Decision

1. The Engineer class gains the write verb `add-or-modify-focused` on the test class, scoped to tests that exercise the files the same task changed. The verb is registered per ADR-AUT-0004 and enforced by path and by diff adjacency (a test file is in scope only if it imports or targets a source file changed in the same task).
2. The Engineer may not delete tests, change assertions of tests it did not add in this task, or lower coverage/mutation thresholds. Those remain Inspector verbs.
3. Campaigns may designate a round or task as **independent-assurance**; in that mode Article 6's original binding applies unchanged and the Engineer's test verb is withheld.
4. The Inspector role is unchanged except that its mandate is now explicitly counterexamples, sensor configuration, and independent assurance rather than every test in the repository.

## Consequences

- One task completes the repair-and-regression loop; review stays independent (`devai-verify`, `review.mode`).
- `roles/engineer.md` already describes the new authority; it is effective only once the verb registration and path enforcement land (same release).
- Adopters pin a constitution version; this amendment reaches them through the ordinary pin upgrade, not by editing `.devai/pin/constitution.md`.
- Risk: a weakened separation of duties for routine changes. Mitigation: the independent-assurance designation and the unchanged deletion/assertion/threshold verbs.

## Alternatives Considered

- **Option A -- keep independent test authorship for every governed change.** Rejected by
  Owner decision D1: the handoff cost is paid on every small fix, while the assurance it buys
  is only needed where a round designates it.
- **Let the Engineer write any test.** Rejected: without diff adjacency the Engineer could
  reshape tests it did not cause to fail, which is the separation the test class exists to
  protect.
- **Change the role prompts only.** Rejected: Article 6 is enforced by path, so a prompt that
  claims authority the enforcement withholds produces refused writes and failed tasks instead
  of fewer handoffs.

## Affected Rules

As listed in the frontmatter.

## Inspector Adversarial Acceptance

The four counterexamples in the frontmatter must fail against an implementation that omits the
corresponding rule and pass against the candidate.
