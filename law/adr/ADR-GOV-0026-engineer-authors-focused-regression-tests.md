---
id: ADR-GOV-0026
title: The Engineer authors focused regression tests for its own change; designated assurance stays independent
type: adr
status: accepted
date: 2026-10-14
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 6 (write authority by path)
  - law/constitution.md Article 7 (what each role may author)
  - law/constitution.md Article 10 (authority separation in a single loop iteration)
  - ADR-AUT-0003 (governed adopter path authority by path classes)
  - ADR-AUT-0004 (registered write verbs per path class)
affected_rules:
  - law/constitution.md
  - packages/skills/resources/roles/engineer.md
  - packages/skills/resources/roles/inspector.md
  - packages/authority/src/capabilities/path-domains.ts
  - packages/authority/src/runtime/policy-resolver.ts
  - scripts/check-commit-range.mjs
  - law/schemas/campaign.schema.json
  - law/schemas/task.schema.json
  - packages/cli/src/services/experimental-dispatch/index.ts
inspector_acceptance:
  - IA-001 -- Under the amended contract an Engineer task that changed a source file may write a test that imports or targets that same changed file, and an Engineer write to a test file unrelated to the task's changed sources is still refused by path and by diff adjacency.
  - IA-002 -- An Engineer write is refused when it deletes a test, edits an assertion of a test the same task did not add, or lowers a coverage or mutation threshold; each of those stays an Inspector verb.
  - IA-003 -- A round or task designated independent-assurance withholds the Engineer test verb, so Article 6's original binding applies unchanged and the same focused-regression write is refused.
  - IA-004 -- Until the verb registration and path enforcement land the Engineer prompt's test authority has no mechanical effect, so a test-path write is refused and reported as a cross-scope need.
---

# The Engineer authors focused regression tests for its own change; designated assurance stays independent

## Status

Accepted on 2026-10-21 by the Architect after the Owner ratified the record and its exact
amended words for Articles 6, 7 and 10 ("take my express ratification WS-6 governance, be
accepting ADR-GOV-0026 and amending Articles 6, 7 and 10"). Proposed on 2026-10-14; Owner
decision D1 of the same date chose option B. Acceptance records the decision and the article
words; the authority it describes takes effect only in the release that also ships the verb
registration and its enforcement, and the amended constitution ships in that same release.

## Context

Article 6 binds the test class (`tests/`, `packages/*/tests/`) to the Inspector only. In practice every ordinary bug fix therefore needs two tasks and a handoff: the Engineer repairs the code, a separate Inspector task writes the regression test. With the current worker models the handoff is the dominant cost of a small fix, and the implementer's own regression test is usually the most informative one. Two independent reviews of the skills and role prompts (2026-10-14) identified this split as the largest per-task overhead that is contractual rather than prompt-level.

Decision D1 by the Owner (2026-10-14): option B.

## Decision

1. The Engineer class gains the write verb `add-or-modify-focused` on the test class, scoped to tests that exercise the files the same task changed. The verb is registered per ADR-AUT-0004 and enforced by path and by diff adjacency (a test file is in scope only if it imports or targets a source file changed in the same task).
2. The Engineer may not delete tests, change assertions of tests it did not add in this task, or lower coverage/mutation thresholds. Those remain Inspector verbs.
3. Campaigns may designate a round or task as **independent-assurance**; in that mode Article 6's original binding applies unchanged and the Engineer's test verb is withheld.
4. Article 10 is amended in the same release: its "Engineer may not edit tests" clause and the consequence that cross-substrate work in one role session is impossible are narrowed to admit the Engineer's focused-regression verb, and keep applying unchanged in independent-assurance mode.
5. The Inspector role is unchanged except that its mandate is now explicitly counterexamples, sensor configuration, and independent assurance rather than every test in the repository.

### Amended constitution text (1.1.0)

The Owner approved these exact words. The amendment is constitution 1.1.0, a minor version,
because it widens an authority; Article 9 requires an amendment for any change to Articles 6
through 10. Every other core row of Article 6 stays byte-identical.

Article 6, the test row. Replace

> - `tests/` and `packages/*/tests/` — Inspector (F3).

with

> - `tests/` and `packages/*/tests/` — Inspector (F3); the Engineer holds on these paths only the focused-regression verb of Article 7.

Article 6, the extension paragraph. Replace

> the test class (test directories and colocated test files) is Inspector;

with

> the test class (test directories and colocated test files) is Inspector, with the Engineer's focused-regression verb of Article 7;

Article 7, the Inspector bullet. Replace it with

> - **Inspector.** Sensor authority. Authors and modifies tests under F3 paths. Its mandate is counterexamples, sensor configuration, and independent assurance. Deleting a test, changing an assertion of a test the current task did not add, and changing a coverage or mutation threshold remain Inspector verbs.

Article 7, the Engineer bullet. Replace it with

> - **Engineer.** Plant authority. Authors and modifies code under F2 paths. Within a task that changes F2 sources, the Engineer may also add focused regression tests under F3 paths, and modify tests that task added, when the test imports or targets a source file the same task changed. The Engineer may not delete a test, change an assertion of a test the task did not add, or lower a coverage or mutation threshold. A round or task designated independent-assurance withholds this verb.

Article 10. Replace the paragraph with

> Within a single human-directed work iteration, no discipline may both set its own reference and actuate against it. Architect may not edit code; Engineer may not edit tests except through the focused-regression verb of Article 7, which never reaches an existing test's assertions, its deletion, or a threshold; Inspector may not edit specifications. In a round or task designated independent-assurance the Engineer may not edit tests at all. Cross-substrate work in a single role session is otherwise impossible by design; coordinated work traverses the authority chain via coupled task triplets (Article 24).

## Consequences

- One task completes the repair-and-regression loop; review stays independent (`devai-verify`, `review.mode`).
- `roles/engineer.md` already describes the new authority; it is effective only once the verb registration and path enforcement land (same release).
- Articles 6, 7 and 10 are amended together; amending Articles 6 and 7 alone would leave Article 10 forbidding the Engineer test edit the other two grant.
- Adopters pin a constitution version; this amendment reaches them through the ordinary pin upgrade, not by editing `.devai/pin/constitution.md`.
- Risk: a weakened separation of duties for routine changes. Mitigation: the independent-assurance designation and the unchanged deletion/assertion/threshold verbs.
- Enforcement facts on main at `a1521a78`. No runtime authorizes agent file writes by path: only CLI actions reach the broker, and the core `**/tests/**` rows compile to no rule (ADR-AUT-0004, Context). The verb is therefore enforced in two places: the task diff check of experimental dispatch (`EXPERIMENTAL_WRITE_SCOPE_VIOLATION`, `packages/cli/src/services/experimental-dispatch/index.ts:701`, which already holds the task's changed paths), and the commit-range check (`scripts/check-commit-range.mjs`, whose author-path table ADR-CHK-0009 amends).
- Adjacency means that the test file imports, through a relative or workspace import that resolves to the file, a source the same task changed; in the commit-range check, a source the same commit changed.
- Detecting an assertion edit needs per-assertion identity, which `packages/sensors/src/test-weakening.ts` does not have today (it counts `expect` calls per file); the implementation adds it.
- The designation is the optional `independent_assurance` boolean, default false, on rounds and tasks in `law/schemas/campaign.schema.json` and on `law/schemas/task.schema.json`.

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

- law/constitution.md
- packages/skills/resources/roles/engineer.md
- packages/skills/resources/roles/inspector.md
- packages/authority/src/capabilities/path-domains.ts
- packages/authority/src/runtime/policy-resolver.ts
- scripts/check-commit-range.mjs
- law/schemas/campaign.schema.json
- law/schemas/task.schema.json
- packages/cli/src/services/experimental-dispatch/index.ts

## Inspector Adversarial Acceptance

The four counterexamples in the frontmatter must fail against an implementation that omits the
corresponding rule and pass against the candidate.
