---
id: ADR-AUT-0010
title: Exact documentation implementation core specialization
type: adr
status: accepted
date: 2026-10-30
authority: Architect
supersedes:
  - ADR-CHK-0012
provenance:
  - law/constitution.md Article 6
  - law/constitution.md Article 10
  - law/adr/ADR-CHK-0008-rebase-update-branch.md
  - law/adr/ADR-CHK-0009-commit-range-admits-engineer-focused-regression-tests.md
  - law/adr/ADR-AUT-0003-governed-adopter-path-authority.md
  - law/adr/ADR-AUT-0004-class-write-verbs-for-adopter-path-authority.md
  - Owner instruction on 2026-10-25 to prepare the upstream correction
affected_rules:
  - law/constitution.md
  - law/schemas/adopter-policy.schema.json
  - packages/authority/src/documentation-implementation.ts
  - packages/authority/src/runtime/policy-loader.ts
  - packages/authority/src/runtime/documentation-context.ts
  - scripts/check-commit-range.mjs
  - tests/contract/commit-range-registry-generated.contract.test.ts
  - docs/dev/operations/remote-preflight-contract.md
  - packages/cli/src/services/adopter-policy-binding.ts
  - packages/cli/src/services/write-scope/index.ts
  - packages/spec/src/translation-validation/path-authority.ts
inspector_acceptance:
  - IA-001 -- Current baseline constitution 1.2.0, earlier constitution 1.1.0, and adopter pin 1.0.2 refuse a specialization block; changing only a version string or digest never activates it.
  - IA-002 -- A disposable installed candidate admits only the exact supported constitution digest and actual package provenance through registered binding, without an environment switch or test-only authorization bypass.
  - IA-003 -- Globs, directories, traversal, absolute paths, duplicate paths, unsupported extensions, and protected documentation, test, or specification paths are refused before materialization.
  - IA-004 -- Only listed executable implementation files route to Engineer; unlisted documentation remains Architect and test authority including the existing focused-regression rule is preserved.
  - IA-005 -- Missing, stale, forged, or cross-repository source, constitution, package, compiled digest, or receipt provenance fails closed across all authority consumers.
  - IA-006 -- A failed or interrupted bind cannot expose preliminary authorization; ordinary writes require complete registered materialization and coherent receipt provenance.
  - IA-007 -- Broker, write scope, Doctor, release policy, frames, mutation validation, verification effect inference, and commit-range provenance agree on the same validated specialization or refuse missing context.
---

# Exact documentation implementation core specialization

## Status

Accepted for the bounded documentation implementation amendment and checked
upstream PR/integration. The Owner answered “Approve amendment and checked
upstream integration” to question `call_c5f12517cad34bed84e1452647579c35` on
2026-10-25. The Architect transcribes that direct answer as relayed verbatim by
the root coordinator. Publication and full STYNX pin/policy adoption remain
separate. Historical preparation evidence is retained; the final integrated
package and accepted law bytes still require qualification.

The reviewed docs proposal originally used identifier ADR-AUT-0008. Refreshed
upstream main already contains the distinct accepted ADR-AUT-0008 for exact
authority-policy create review. This record is therefore allocated ADR-AUT-0010
without replacing that existing record or changing the approved mechanism.
The integration of PR #435 on 2026-10-30 allocates ADR-AUT-0010 because
main already uses ADR-AUT-0009 for exact source-file application. The approved
mechanism and exact constitution digest are unchanged. The integrated commit-range
lineage follows ADR-CHK-0012 and retains its exact verified registry projections,
focused-regression limits and all existing provenance refusals.
The consistency review retained constitution 1.2.0's existing authority and
explicitly preserved its focused-regression exception.

## Context

Article 6 routes `docs/` to Architect while Article 10 forbids Architect from
writing implementation code. STYNX has five existing implementation files in
that prefix: `docs/site/docusaurus.config.js`,
`docs/site/scripts/generate-api-reference.mjs`,
`docs/site/scripts/run-lighthouse.mjs`, `docs/site/scripts/sync-content.mjs`,
and `docs/site/scripts/verify-api-reference.mjs`. Their location does not make
implementation an Architect activity. An additive extension cannot shadow a
core row. Blanket Engineer ownership of `docs/` would transfer unrelated human
documentation and specifications and is not the requested correction.

The preparation baseline is commit
`2df84159caabf869b866fb2a05e5b06be83295fb`. Its constitution is 1.1.0; the STYNX
pin observed for this request is 1.0.2. Both must refuse the new specialization.

## Decision

Adopt a package-defined core specialization, separate from additive root
extensions. An Architect-authored versioned adopter-policy source may declare
only `documentation_implementation: { files: [...] }`. Both this block and its
fields are closed. The list is nonempty, unique, finite, and contains exact
canonical repository-relative executable file paths under `docs/`. The shared
compiler enforces lexical grammar, supported source extensions, protected-class
exclusion, and overlap rules. It does not discover authority from file presence,
globs, an extension registry, or a caller-supplied role/precedence.

The capability is `documentation-executable-core-v1`, bound to constitution
version **1.2.1** and SHA-256 `4dbb9caa8961cf3bbf8070faf7525711b018b1aaa3b47b17ae9a85f55cf4b57c`.
This exact accepted integration artifact extends the observed origin/main
`90632fe72cf0f46e0528ef3c04e925b92e6e7388` constitution 1.2.0 with only the
reviewed documentation specialization. Constitution 1.2.1 is allocated to this accepted integration candidate; this
is not a package publication claim. Any later version or byte change requires
a new exact digest and qualification. No version range
or old proposed 1.1.1 identity is admitted. Existing published or pinned
constitutions and arbitrary toggles do not enable this feature. Publication and
adopter binding require separate authority.

Materialize the list only through the registered adopter-policy bind. Compile
Engineer implementation rules as immutable core specialization at precedence
700, above the ordinary docs row at 650, with test routing preserved. There is
no Architect implementation permission, Owner bypass, or generic extension of
Engineer authority. Human documentation, README/AGENTS/CLAUDE files, architectural
specifications, schemas, blueprints, ADRs, and executable tests and test configurations
remain protected from this specialization. Existing focused-regression test
rights under constitution 1.1.0 are preserved, not expanded or removed.

The closed materialization receipt binds `capability_id`, `repository_id`,
`source_digest_sha256`, `constitution` with exact `version` and `digest_sha256`,
`framework_package` with actual `name` and `version`, `compiled_digest_sha256`,
and `rule_count`. The shared closed parser owns this receipt; a second schema
or a changed authority-rule vocabulary is unnecessary. Schema validation of an
adopter source is not proof of capability or materialization. Source and rule
provenance must resolve to the same complete registered binding. A preliminary
bind plan must not authorize ordinary writes.

All consumers use the same validated package-owned classifier context. Missing
repository context, stale source or pin, forged receipts, package mismatch,
or differing compiled rules refuse authorization. Frame/mutation validation
must receive verified context rather than independently infer a docs exception.
No policy path, receipt, package fixture, or declaration may serve as a generic
capability handle outside this closure.

### Commit-range provenance and retained materialization

This forward record carries the bounded documentation and generated-policy
changes to the author-path table. Accepted ADR-CHK-0008 and ADR-CHK-0009 remain
byte-for-byte unchanged. Following the existing forward-amendment convention,
this record supersedes ADR-CHK-0009 only for the shared
`scripts/check-commit-range.mjs` affected-rule subject. It retains that record's
focused-regression test row and every other prior row and rule except the exact
documentation and generated-policy dispositions stated here. Supersession is
resolved per affected-rule subject under `law/policy/adr-validation.json`; it
does not transfer authority over the earlier workflow or other subjects.

| Path                                                                   | Admitted author                                                                              | Required evidence                                                                                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Exact executable documentation implementation selected by ADR-AUT-0010 | Engineer only                                                                                | Complete native proof in both the prior parent and implementation commit, with unchanged binding                                 |
| Unselected documentation with no invalid claimed specialization        | Architect                                                                                    | Existing path, role and provenance rules                                                                                         |
| `.devai/config/authority-policy.json` retained for this native proof   | Architect only in the same checkpoint that changes its actual validated `law/policy/` source | Genuine registered materialization and complete source pairing; no Machine grant, handwritten output or general config authority |

A claimed specialization with stale, invalid or unsupported evidence refuses;
it does not fall back to Architect authority.

Commit-range provenance is an authority consumer of this same specialization.
Its legacy `docs/` author row cannot override a verified exact Engineer-owned
implementation. The selected path admits only Engineer; unselected documentation
retains its legacy row. This does not transfer tests or specifications, expand
the focused-regression verb, or admit Architect implementation writes.

Judge a changed implementation against immutable Git evidence for its parent
and its own commit, not the range head or current worktree. The registered
binding must already exist before the Engineer commit, and its source, receipt,
pin, materialized configuration and package identity must remain coherent and
unchanged through that implementation commit. A later bind cannot authorize an
earlier write; a source-policy-plus-implementation commit cannot grant itself
authority. Check both rename endpoints and retain normal deletion checks.

Use the common package-owned native verifier and opaque context. Preserve
complete receipt/source/materialized digests, exact supported constitution and
actual owning-package identity, repository identity, compiled rules and full
policy integrity. Preserve journal, path-mode, freshness and enforcement
refusals. Do not mint a context from a caller-supplied list, inferred version,
rewritten project name, or reconstructed historical receipt. A missing or
incompatible native verifier is a verification refusal, not an invitation to
execute arbitrary historical code or add a broader version allowlist.

The native proof includes the actual `.devai/config/authority-policy.json`
produced by registered materialization. When that proof is needed in a Git
range, retain those exact generated bytes in a preceding governed source-policy
checkpoint. This one output is paired with the actual validated `law/policy/`
source that the same checkpoint changes, under the exact forward row above. No
handwritten policy, general config-tracking permission, or unconditional
Architect generated-file grant is created. The ignore-rule adjustment and
registered output are separately reviewed implementation and binding steps;
this record is not a claim that either has already occurred. Existing receipts
and their closed schemas are not widened to fabricate missing evidence.

Acceptance must use genuine registered binding and real Git ranges: valid
selected Engineer writes, selected Architect refusals, unselected/protected
refusals, later-bind and same-commit self-grant negatives, historical removal,
parent/current evidence tampering, actual package mismatch, journal and path
mode controls. Existing exact author/committer identity, App exception,
no-merge, grammar, change-family and focused-regression checks remain intact.
This clarifies the already approved all-consumers closure; it neither changes
constitution bytes nor establishes general historical-package compatibility.

## Consequences

The five motivating STYNX paths can be represented in an exact future adopter
policy without granting the entire directory to Engineer. This preparation does
not alter that adopter policy or pin. Local preparation now has actual installed
candidate evidence from the normal CLI build, offline pack with the official
parser, offline install and public installed release-host/bin matrix. The matrix
contains 70 logged steps ending PASS, not 70 independent test cases. It includes
all five selected writes, role/verb refusals, both unauthorized rename directions,
permitted endpoint combinations, stale/tampered/foreign provenance, removal and
installed-package tamper restoration. Installed dependencies remained unchanged;
final source custody errors were empty.

The disposable tarball is `@aarusso-nyx/devai@2.7.1`, SHA-256
`52c1f1347f95877aa678a21c5d225e17b857d81445ee2d528c58c88f23ea05f1`.
That existing manifest version is a local test identity, not a newly published
release. Source-mode consent checks passed 2/2, the final external test Program
has zero diagnostics, and default classifier compatibility passed 1/1. The
owning historical 410-case run had 409 passes and one proposed-law version
literal mismatch; its corrected affected case passed separately. No single
410-case all-green run is claimed. Historical pin tests use genuine older bytes
against the candidate receipt; they are pin-tamper refusals, not complete old
installed-binding campaigns.

These observations qualify the bounded prepared mechanism, not every final
integration or release gate. Inspector has placed the regression fixtures and observed 54 documentation
cases plus one affected law-literal case passing on the earlier candidate.
Inspector must rerun qualification on final accepted and integrated bytes; catalogue freshness
and independent review remain required. Retain all earlier failures and their
repairs. No installed local pass grants a currently pinned adopter permission.

The existing assembler copies the canonical constitution into both packaged
law locations and packages the canonical schemas. No generated distribution is
hand-edited, no package version is presented as a published candidate release,
and no extra packaging path is needed merely to transport this source draft.

`law/adr/README.md` is generated by the public loop `renderDecisionIndex`
export under ADR-GOV-0021. It is distinct from `evidence render --kind decisions`,
which concatenates record bodies rather than producing the catalogue. Regenerate
the index through the established exported catalogue renderer, review and copy
its exact bytes, and rebind only the corresponding non-record SHA-256 entry in
`law/policy/adr-validation.json` and its dependent canonical entries-array digest.
Preserve all other exception entries and
fail-closed rules. Verify byte freshness with the existing catalogue tests. No
currently unbound repository is initialized merely to generate this projection.

## Alternatives Considered

- Give Engineer the whole docs prefix: rejected because it transfers human and
  architectural documentation beyond the exact implementation need.
- Permit Architect to write docs implementation: rejected because it contradicts
  Article 10 and weakens role separation.
- Reuse additive roots or accept a local toggle: rejected because the former
  cannot shadow core authority and the latter manufactures authorization.
- Leave an empty capability table forever: insufficient for a reviewable tested
  correction. Exact proposed artifact binding permits disposable positive tests
  without claiming amendment acceptance or adopter activation.

## Affected Rules

The canonical constitution and adopter-policy schema describe the bounded
specialization. Engineer owns compiler, binding, classifier, and enforcement
implementation; Inspector owns adversarial tests and installed-artifact proof.
Architect owns this law/schema design and its adopter documentation. Existing
law records are preserved. Adoption, release classification,
publication, STYNX integration, formal DEVAI acceptance, and downstream DETRAN
or PORM acceptance remain separate decisions and evidence obligations.

## Inspector Adversarial Acceptance

The seven criteria already declared in this record remain the acceptance
requirements. Their repetition here satisfies the canonical ADR body contract;
it adds no permission and does not mark unfinished verification complete.

- IA-001 -- Current baseline constitution 1.2.0, earlier constitution 1.1.0, and adopter pin 1.0.2 refuse a specialization block; changing only a version string or digest never activates it.
- IA-002 -- A disposable installed candidate admits only the exact supported constitution digest and actual package provenance through registered binding, without an environment switch or test-only authorization bypass.
- IA-003 -- Globs, directories, traversal, absolute paths, duplicate paths, unsupported extensions, and protected documentation, test, or specification paths are refused before materialization.
- IA-004 -- Only listed executable implementation files route to Engineer; unlisted documentation remains Architect and test authority including the existing focused-regression rule is preserved.
- IA-005 -- Missing, stale, forged, or cross-repository source, constitution, package, compiled digest, or receipt provenance fails closed across all authority consumers.
- IA-006 -- A failed or interrupted bind cannot expose preliminary authorization; ordinary writes require complete registered materialization and coherent receipt provenance.
- IA-007 -- Broker, write scope, Doctor, release policy, frames, mutation validation, verification effect inference, and commit-range provenance agree on the same validated specialization or refuse missing context.

## Refreshed integration and future adoption boundary

The original preparation baseline and local tarball evidence above remain
historical. The current integration reference is observed origin/main
90632fe72cf0f46e0528ef3c04e925b92e6e7388 (CLI 2.8.0, constitution 1.2.0),
not the stale local main or preparation HEAD. Preserve the complete existing
1.2.0 proof-chain canonical-selection and registered Git-index reconciliation
clauses, existing focused-regression authority, and unrelated upstream changes.
The documentation mechanism remains unchanged from the reviewed proposal. Its
closing Article 10 sentence now expressly preserves the existing Article 7
focused-regression exception and independent-assurance restriction, correcting
the earlier imprecise blanket description of Engineer test-edit prohibitions.
This wording neither expands nor narrows test authority. IA-001 now names 1.2.0
as the current baseline while retaining the earlier 1.1.0 and adopter 1.0.2
refusals in both occurrences.

A future STYNX pin change from 1.0.2 must disclose the complete new constitution
delta, including Article 7/10 focused-regression authority and Article 6 proof
reconciliation/index boundaries. No part of this amendment itself authorizes
STYNX binding, downstream DETRAN/PORM acceptance, or lifting #211's hold.
