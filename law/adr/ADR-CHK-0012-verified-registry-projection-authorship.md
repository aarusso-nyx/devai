---
id: ADR-CHK-0012
title: Admit exact verified registry projections in the Architect law commit
type: adr
status: accepted
date: 2026-10-29
authority: Architect
supersedes:
  - ADR-CHK-0009
provenance:
  - ADR-CHK-0008 author-path table
  - ADR-CHK-0009 bounded focused-regression amendment
  - ADR-GOV-0018 registry and generated-view co-commit rule
  - law/policy/change-taxonomy.json law with generated pairing
  - AGENTS.md maintainer-governed DEVAI source
  - Local source-application candidate commit 6cd7c88c blocked by exact author provenance
  - Accepted base b75d580e5fa1bb39fef079c86b2b133b8775fd34
affected_rules:
  - scripts/check-commit-range.mjs
  - tests/contract/commit-range-registry-generated.contract.test.ts
  - docs/dev/operations/remote-preflight-contract.md
inspector_acceptance:
  - IA-001 -- An exact Architect commit changing the canonical registry and its changed generated projections passes only when all three fixed output blobs at that commit are regular mode-100644 files and byte-exact trusted generation; an unchanged correct sensor view need not appear in the diff.
  - IA-002 -- Missing source change, deleted or absent output, wrong output bytes, symlink, executable mode, renamed output and an unrelated generated-looking package path each refuse Architect admission without broadening another role.
  - IA-003 -- A candidate-selected output list, generator, formatter, configuration or preload cannot choose verification; missing or modified generator or formatter bytes refuse before execution and the isolated copy is verified against the reviewed pins.
  - IA-004 -- The verifier reads exact commit blobs, not worktree or index output bytes; later repairs cannot authorize an earlier invalid commit and candidate source is parsed as data without executing its modules or hooks.
  - IA-005 -- Exact role identities, committer checks, merge refusal, law co-commit, unrelated package paths and the focused-regression conditions retain their prior behavior; Machine gains no new package-path authority.
  - IA-006 -- Pinned verifier identity changes require a separately reviewed rebind; no failure triggers auto-repin, ambient dependency fallback, unchecked generation, or a skip of the commit-range gate.
---

# Admit exact verified registry projections in the Architect law commit

## Status

Accepted as the reviewed architectural decision on 2026-10-29 under the
maintainer-authorized prerequisite repair. The prerequisite was integrated through
#443 and is present in the source-application integration #444. This record grants
no publication, protected-branch change, adoption or historical rewrite. The
original failed source-application candidate and its evidence remain preserved;
preparation used accepted base `b75d580e5fa1bb39fef079c86b2b133b8775fd34`.

This forward record changes only the bounded registry-projection admission in
the commit-author table inherited through ADR-CHK-0009. Its focused-regression
amendment and every other table row and rule remain in force. Existing accepted
records are not edited. No constitutional path authority or ordinary Architect
package-source writing permission is added.

## Context

ADR-GOV-0018 and the change taxonomy require the canonical action registry and
its generated views to co-commit. The registry is law and therefore requires an
Architect author. The current author-path checker recognizes same-source
Architect pairing for selected config and pin materializations, but not the
three registry projections under packages. Those paths consequently admit only
Engineer. Candidate commit `6cd7c88c` obeys the co-commit requirement and is refused
by the author-path rule. Splitting the commit or changing its role cannot satisfy
both rules.

These exact views contain generated code, so a path name or generated marker is
not sufficient evidence. Running the candidate's own generator or ambient
formatter would let altered tooling vouch for altered output. The correction
needs both a finite path scope and an explicit trusted verification boundary.

## Decision

### Exact additional author admission

For the following three paths only, admit Architect in addition to the existing
Engineer author when the same commit changes `law/policy/action-registry.json`
and the byte-verification conditions below pass:

- `packages/cli/src/generated/action-registry.ts`
- `packages/effects-check/src/generated/action-catalog.ts`
- `packages/sensors/src/generated/action-kinds.ts`

Require the canonical registry and all three outputs to exist as regular
mode-100644 Git blobs at the examined commit. Require all three output bytes to
match generation from that commit's registry, including an output whose bytes
are unchanged by the registry edit. Do not require an unchanged sensor projection
to appear artificially in the commit diff. The three paths are fixed by the
reviewed checker, never selected by `generated_views` or another candidate field.

Every changed path must still be admitted for the actual exact commit author.
A matching source path does not grant Architect authority to handwritten package
code, another generated file, the generator itself, or its dependencies. No new
Machine, Owner or Inspector permission follows. Existing Engineer admission is
unchanged; this narrow exception does not alter other co-commit, schema or
freshness obligations. There is no path-only fallback when verification fails.

This is commit provenance for independently reproducible projections of the
Architect's canonical law change. It does not permit manual edits to generated
outputs or transfer ownership of the generator and package implementation to
Architect. The supported generator remains the producer; a human author cannot
use metadata to certify arbitrary package bytes.

### Trusted byte verification

Read the source and output blobs through fixed Git paths at the exact examined
commit. Do not use later working-tree, index or HEAD repairs as those bytes.
Materialize only these inputs in a fresh owned temporary tree. Execute the
reviewed generator in `--check` mode against that tree using an admitted Node
runtime, then retain failure as a refusal rather than repairing the commit.

The initial verifier pins in `scripts/check-commit-range.mjs` are:

- Generator SHA-256 `6c6ff06564fa19539adec3c750351b78e4f3383e102dca60799ec87af78a82ea`, from `scripts/generate-action-registry.mjs` at the accepted base named above.
- Prettier version `3.9.6`, full-package content SHA-256 `ec9283d8a414942aeb3d9083a1164842447406877252e43b23ac9250cba89cbe`.

The formatter content digest is SHA-256 over every regular file in the recursive
package tree, ordered by relative path: for each file append the relative path's
UTF-8 bytes, NUL, then the binary SHA-256 of its bytes. Refuse nonregular members
rather than following links. The initial package was obtained by the frozen
pnpm installation with lock integrity
`sha512-OpN0zzVdiaiAhxpuuj5efpIS4sY9j7bY6uR5mnj5yPzGkdkjNKSJeUThPb60Jw29QuAZgA4o+/iB49kFiaBX6g==`.
The package-content pin and source provenance are distinct from merely matching
a package version string.

Verify the generator and formatter before use, copy the verified bytes into
owned isolation and verify that copy. Resolve the formatter from the isolated
package, with no ambient dependency, package configuration or plugin fallback.
Strip Node preload/module-search environment hooks such as `NODE_OPTIONS` and
`NODE_PATH`. The generator uses its fixed explicit formatter options, never
candidate formatter configuration. The candidate registry is data; no candidate
module, hook or package script is executed.

The reviewed checker, its pins, the admitted Node runtime and host are trust
roots. This is not independent cryptographic approval of modifications to the
checker itself. Changes to the generator or formatter require a separately
reviewed pin rebind and corresponding negative evidence; do not derive a new
expected hash automatically from candidate bytes, waive a mismatch, or claim
verification independent of its trusted implementation. A verifier mismatch
blocks only this admission and retains the existing path-specific author denial;
that refusal does not identify the particular verifier pin that mismatched.

### Integration and historical custody

Prepare and review this prerequisite separately. Run its unchanged existing
provenance tests and additive adversarial cases. Only after the corrected gate
is available through the normal accepted integration path should the source
candidate be retested under it. Preserve the original failed candidate and
pre-push evidence; do not rewrite history to pretend its original check passed.
Publication and prerequisite integration are separate authorized effects, not
consequences of a local test pass.

## Consequences

A law change can carry its exact canonical projections in one Architect commit,
as required by the existing taxonomy, without authorizing handwritten package
code. Verification checks three blobs even when fewer outputs changed. It adds
a pinned generator/formatter maintenance obligation and a bounded local temporary
verification cost. No network, install, release, push or role switch is performed
by this admission. Normal generated-file freshness checks remain independent.

## Alternatives Considered

Splitting the law and projections violates the co-commit contract. Changing the
whole commit to Engineer violates law authorship. General Architect authority
under packages, a generated-marker allowance, a Machine-role substitution, a
historical exception or disabling the hook would weaken unrelated protections.
Using the candidate's unverified generator or formatter fails to establish exact
projection bytes. These alternatives are not admitted.

## Affected Rules

The commit-range checker gains only the conditional author admission and trusted
byte verifier described above. The dedicated contract tests cover its allowed,
refused and tampered-tool cases. The remote-preflight documentation describes the
same restriction. The change taxonomy's co-commit rule, constitutional text,
existing generated output contents, protected histories, commit identities and
all other author rules remain unchanged. The decision catalogue and its digest
bindings are regenerated using the documented public renderer during integration.

## Inspector Adversarial Acceptance

Discharge IA-001 through IA-006 with real temporary Git histories and exact role
identities. Include altered source/output, an unchanged sensor projection,
nonregular and executable modes, substituted verifier/formatter, unrelated paths,
missing source change, later working-tree repairs and unchanged legacy author
rules. Retain failure evidence; no skip, broad whitelist, historical exception or
weakened assertion is authorized. The independent 20-case provenance review,
including malformed UTF-8 and copied-tool corruption, informed design acceptance.
The complete IA evidence mapping and final-candidate qualification remain explicit
obligations; architectural acceptance is not a signed RC, publication or adopter
effect.
