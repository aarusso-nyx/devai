# Atomic verifier repin manifest template — unperformed

Current execution authority is the [standing Owner decision](execution-discipline.md).
It supersedes earlier preparation-only and repeated routine authorization text;
exact evidence, role boundaries, substantive unresolved contracts and actual
performance gates remain. Historical observations and approvals below are
preserved; they do not describe a new human review of later candidates.

Precondition: immutable OE-06 shipping release and all exact artifact identities.
Record package name/version/registry/tarball, SHA-1, SRI, release_source commit/tree,
published provenance digest/source_commit/payload_file_count, and selector kinds
read from that published verifier schema. Independently verify extraction/population.

Freeze actual ci-scaffold generator output paths before mutation. In one
law(release) change repin trusted-local-rc-verifier-package.json and its generated
ledger/release workflow restatements, following release-discipline.md step 4.
Any incompatible generator behavior or extra file is a new bounded Engineer task,
not an Architect source edit. No policy field moves alone. Require OE-08 repository
variable readback equal to the new published provenance digest. Recheck policy,
generated workflows and external_duplicate identity together on the merged head.

Delivery: PR-B, the one accepted post-release repin PR, derived from fetched main
after PR-A integration and immutable OE-06 publication. Use CTG-0624 typed
generation/helpers for the ledger and release verifier section. No generator
source edit, dependency update or unrelated source repair is admitted to PR-B.
