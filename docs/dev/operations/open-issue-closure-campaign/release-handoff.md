# Release handoff template — not authorization

Current execution authority is the [standing Owner decision](execution-discipline.md).
It supersedes earlier preparation-only and repeated routine authorization text;
exact evidence, role boundaries, substantive unresolved contracts and actual
performance gates remain. Historical observations and approvals below are
preserved; they do not describe a new human review of later candidates.

Prepare the handoff from exact remediation checkpoints and include it in PR-A.
Complete actual release evidence only after PR-A merges and the implementation
round close gates hold. PR-B repins only after immutable publication.

- Candidate commit/tree, fetched main, clean status and release/support intent.
- Current test-task policy digest and all mandatory-floor results: formatting,
  lint, type integrity, schema/generated consistency, secret/path and package
  boundaries, exact candidate identity, then the authorized RC gate.
- Receipt actually used, unsigned evidence identity, signer custody, signed export
  and independently verified bundle policy reconstruction.
- R-0401 historical binding: head 259197ac0c809f360884fc14da1d87ac92f3f0e2,
  digest a33e478245b2e05adbc0f768a2544c77c699a9edd68443d0528a8719013685ed.
  Sign/export before use, or explicitly decline use and issue a fresh candidate
  receipt. This historical result never substitutes for changed-candidate evidence.
- Proposed release version derived from actual changes; no fixed next version.
- Exact signed tag and candidate, immutable pack/SRI/artifact identities, trusted
  verifier pin, exact-tag rehearsal run and every required job including Linux
  adoption, followed by recorded standing publish consent, publish:true and required
  protected environment approvals.
- Owner effects consumed, run IDs, final registry/Release identities, tag/source/
  tree rechecks. A skip is not PASS; package availability is not adopter proof.

Preserve the four-step verifier order in release-discipline.md: canonical source
and tests (already PR 12), byte-exact re-vendor (already PR 227), shipping release
under the existing trusted pin, then one atomic published-artifact repin in R-0608.
Canonical verifier stays read-only unless a new separately scoped upstream task
is approved. No vendored file is edited by hand.
