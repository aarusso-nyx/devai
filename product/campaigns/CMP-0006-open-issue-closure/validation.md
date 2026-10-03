# Preparation validation

Baseline: main 180a122787193f9bdfce9b7f4cd5600e85ae7854, tree
90c7c4b5acbd9c9bc4acd9aea54a2eb0b0c60921, dedicated worktree.

The Owner accepted ADR-EVI-0004, ADR-SCR-0012, ADR-EVI-0005 and ADR-MDL-0003,
both narrow integration outcomes, and the final two-PR discipline. Accepted
predecessor bytes remain unchanged. All rounds/tasks remain planned; no
implementation or external effect is reported by this bundle.

Preparation checks:

- Campaign checker passes all six campaigns, including accepted CMP-0006.
- Full ADR v2 semantic resolution passes 104 files; all four forward records are
  accepted and effective, with no errors or accepted-history rewrite.
- Generated ADR catalogue equals renderDecisionIndex. Catalogue/exception digests
  are repinned in adr-validation 2.7.2.
- campaign-execution 1.4.0 validates against its existing schema. Its explicit
  CMP-0006 source-only two-PR/checkpoint override expires with this campaign and
  preserves default adopter/runtime lifecycle, actual close gates and effects.
- Focused campaign, catalogue-freshness and accepted-history checks: 3 files,
  40 tests passed. These are preparation checks, not future integration-feature
  acceptance. No full Vitest, coverage, RC, live model or release gate ran.
- All 46 prompt SHA-256 values and acceptance-vector parity match the plan.
  Current scope: 9 rounds, 20 CTGs, 46 tasks. CTG-0624 is planned implementation
  support with Inspector-first tests; its new tests/helpers are not yet written.
- Original coverage retains all 22 immutable issue IDs; 21 remain open and #253
  is preserved as externally closed not_planned. Live main/body/comment refresh
  and complete paginated comments for current plus original scope are recorded
  in revalidation.json. A new execution session must refresh again.
- Local Markdown links, owned/forbidden path overlap, role/prompt references,
  formatting, tracked/untracked whitespace and final artifact hashes are checked.
  artifact-manifest.json inventories the actual saved files, excluding itself.

The only tracked pre-existing changes are the doc index, generated ADR catalogue,
ADR-validation bookkeeping and the explicitly approved source-scoped execution
policy amendment. No implementation source, schema, test, dependency manifest,
lockfile, runtime record, issue state or external destination changed.
Dependency installation previously used the frozen lockfile with lifecycle
scripts disabled; only the existing loop/spec dependency build used for artifact
validation ran. No commit, PR, push, tag, package/release publication, deployment,
setting change, receipt signing/export or notification was performed.

Verdict: preparation complete and ready for fresh-session entry under the saved
handoff, subject to current identity/issue/comment validation and exact task-start
authority. Actual implementation, integration, live release/Pages/adopter results
and issue closure remain future work and require their declared gates.

## R-0602 scope amendment

Current declared scope: 9 rounds, 22 CTGs, 50 tasks (48 PR-A contributions and the two original PR-B tasks). Historical preparation results above retain their original population. This amendment adds CTG-0625/TASK-06213–TASK-06215 and CTG-0626/TASK-06216, expands only exact role-owned CTG-0622 paths and preserves all original issue IDs, source receipts, accepted records and final runtime/effect gates. Central must validate all 50 prompt hashes/acceptance vectors, six campaigns, affected campaign contracts, formatting, links and refreshed manifest against the applied exact planning bytes; these checks are not claimed by this proposal.
