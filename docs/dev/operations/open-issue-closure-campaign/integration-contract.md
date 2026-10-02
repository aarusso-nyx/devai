# CMP-0006 accepted integration contract

The Owner accepted all four forward ADRs and both recommended integration
arrangements. After reviewing PR counts and the publication-order conflict, the
final instruction was: “Go with One cumulative remediation PR, plus one
post-release repin PR”. This replaces the earlier strict one-PR proposal.
The choice is effective for CMP-0006 source development and expires at campaign
closure or abandonment. It grants no publication or merge effect by itself.

## Two delivery PRs

PR-A is the cumulative remediation PR: the planning/authority bundle, R-0601
through R-0606 source outcomes, and the R-0607 release/Pages preparation artifacts.
It contains 44 planned task contributions. Architect, Inspector and Engineer
sessions remain separate, with exact owned paths, isolated worktrees and
single-family attributed commits. A human integrates reviewed task commits into
one campaign branch. No task or CTG opens a separate PR. The final human review
and admission cover the combined candidate, including all generated outputs.

PR-B is the post-release verifier repin PR: TASK-0681 plus only the bounded
TASK-0691 accounting artifacts needed to review repin and issue evidence. It is
based on fetched main after PR-A is observed merged and OE-06 has produced an
immutable shipping artifact. It does not change a generator, dependency, public
API or unrelated implementation. Supporting repin manifest/DETRAN notice/accounting
prose commits remain separate from the atomic policy/workflow commit.
No third implementation PR is planned. A newly discovered source repair stops
for a bounded amended plan; it is not hidden in the repin PR.

## Source dependencies and evidence

The scoped source-only exception in campaign-execution.json 1.4.0 applies only to
aarusso-nyx/devai CMP-0006. It preserves the default lifecycle for every other
campaign and for materialized adopter/runtime records. Source dependency edges
are satisfied by human-ratified checkpoints, not intermediate main merges.

Each checkpoint identifies role/task/wave/round, exact commit/tree/base, owned
diff, prompt SHA-256, resolved tier, commands/results and reviewer/handoff.
Architect checkpoints establish accepted design. Inspector checkpoints establish
counterexamples; a declared red test can hand off to the Engineer but is never a
passing admission gate. Engineer checkpoints require all declared implementation
acceptance. Changed candidate inputs invalidate affected evidence.

Acquire the complete declared wave locks before writing. Freeze and release them
at the reviewed checkpoint/handoff; later overlapping writers serialize and
reopen/re-review a prior contribution if they change its inputs. No unmerged
completed writer remains concurrently active.

All final task acceptance commands, wave gates and the unconditional floor must
pass on the cumulative candidate before its PR is admitted. CTG-0624 implements
checker accounting for the shared exact PR identity; it counts that PR once and
rejects undeclared/different identities within the phase. Default serialized
one-PR-at-a-time admission remains in force. Human ratification, PR creation,
source publication and merge are still separate exact effects.

A checkpoint never sets merged_as or closes a round. After each actual merge,
map the observed task commits to its PR and merged head, then perform real close
gates. R-0607 does not close when its preparation docs merge: OE-05/OE-06/OE-07
must actually complete. R-0608 waits for actual R-0607 closure and immutable
publication. R-0609 final observation and issue closure wait for the repin merge
and all effect evidence. Post-merge bookkeeping is based on observed results;
no future merge SHA, runtime proof or closure is fabricated in either PR.

## Error-reference integration

CTG-0653 retains its Architect/Inspector/Engineer pipeline. Architect TASK-0657
defines the contract, Inspector TASK-0658 writes counterexamples, Engineer
TASK-0659 changes only the generator. From that exact reviewed checkpoint,
Architect TASK-06510 (CTG-0654) generates the canonical page. Both are present
on PR-A before final generated-consistency checks. Final Inspector review covers
the combined candidate. No stale generated page reaches main and no role changes.

## Verifier atomic pairing and generation

Workflow paths remain CI. CTG-0624 delivers a schema-declared, fail-closed pairing
restricted to law/policy/trusted-local-rc-verifier-package.json plus only its
restatements in .github/workflows/devai-ledger-verify.yml and
.github/workflows/release.yml. The policy path is mandatory and at least one
workflow changes; every unchanged restatement must still match the new identity.
Extra law/CI paths and split identity updates are refused. Existing unscoped
law/generated compatibility remains. A broad law/CI class pairing is forbidden.

Current classifyPaths (scripts/check-commit-range.mjs:87-113) matches pairings by
class alone, so the triplet supplies real path enforcement before PR-B can use
this pairing. Existing workflow-reference/CI-integrity/candidate gates remain.
Current buildCiScaffoldPlan (packages/cli/src/services/ci-scaffold/index.ts:36-68)
emits ledger/attested-RC output, not release.yml. The Engineer adds a deterministic
pure generator for the release verifier section, preserving all surrounding
bytes. TASK-0681 later invokes it as Architect; no canonical workflow is manually
authored and the ledger template never overwrites release.yml.

## Publication sequence

1. Complete reviewed source checkpoints and generated outputs; admit and merge PR-A
   only with exact external authorization and passing final candidate checks.
2. Close the implementation rounds on observed integration evidence. Select the
   exact main candidate/version, resolve the receipt and run separately authorized
   RC/export/exact-tag rehearsal/publication under the existing trusted verifier.
3. Only after immutable OE-06 publication, derive package/source/provenance/count/
   selector identities from that artifact; prepare PR-B with the atomic repin.
4. After authorized PR-B integration, perform OE-08 variable readback and OE-09
   DETRAN notification/independent clone confirmation. Execute final OE-10 Inspector
   observations, then separately authorized OE-11 issue closure and backlog refresh.

The release workflow main ancestry requirement (.github/workflows/release.yml:245)
and release-discipline step 4 (docs/dev/operations/release-discipline.md:458-473)
remain intact. No live provider, release, Pages, variable, notification or issue
state effect was authorized by choosing PR cardinality.
