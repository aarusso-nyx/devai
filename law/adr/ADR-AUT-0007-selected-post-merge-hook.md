---
id: ADR-AUT-0007
title: Invoke the checkout-local merge hook only for its selected adapter
type: adr
status: accepted
date: 2026-10-11
authority: Architect
supersedes: []
provenance:
  - law/constitution.md
  - ADR-AUT-0003
affected_rules:
  - packages/cli/src/services/hooks-install/index.ts
  - packages/cli/src/commands/init/apply.ts
  - law/policy/adopter-migrations.json
  - docs/adopters/install.md
inspector_acceptance:
  - IA-001 -- With a valid GitHub Actions or recognized non-host-integrated selection, the generated shared hook reports NOT_SELECTED without reading a local key, invoking an issuer, creating or consuming a receipt, or invoking round close.
  - IA-002 -- Missing, malformed, unknown or inconsistent authority selection refuses; selecting post-merge retains missing-helper failure and all existing HMAC, checkout, canonical declaration, current-policy and receipt checks.
  - IA-003 -- Fresh linked checkouts with the GitHub primary need no local receipt issuer; refreshing the generated hook uses registered init apply and does not switch adapter selection or manufacture local enforcement.
---

# Selected post-merge hook

## Status

Accepted for the Owner-authorized DEVAI 2.6.0 repair. Source review and
independent installed positive/hostile witnesses are required before release.

## Context

A tracked Husky hook or shared Git hook is visible in fresh and linked checkouts
that have no checkout-local receipt issuer. DEVAI 2.5.0's generated hook invokes
the issuer and `round close` unconditionally. Selecting GitHub Actions as the
host-policy identity does not create a valid simultaneous local binding; a later
policy materialization can correctly make an earlier local attestation stale.

## Decision

The generated hook validates a contained, no-link project identity and
authority-selection projection: a plain object with `schemaVersion: "1.0.0"`,
a supported `project_type`, and a closed `authority_enforcement` object. The
projection is a dispatch precondition, not full project-schema validation, Doctor
acceptance or verification of the selected host adapter. `cli-only` forbids an
`adapter_config`; `host-integrated` requires exactly a recognized GitHub Actions
or post-merge adapter path.
Only exact `host-integrated` selection of
`.devai/config/post-merge-host-adapter.json` enters the checkout-local receipt
and round-close path. A valid GitHub Actions selection or recognized valid
non-host-integrated mode reports an explicit `NOT_SELECTED` outcome and exits
successfully before accessing local issuer/key/receipt state or invoking the
round CLI. Missing or malformed configuration, unknown adapters/modes and
inconsistent selection refuse rather than guessing a skip.

This is dispatch by declared authority, not simultaneous adapter enforcement.
The GitHub primary retains its separately verified workflow/observation path.
A skip is not a local binding PASS, audit result, merge receipt or round closure.
It cannot consume a stale receipt or close an unrelated round.

When the local adapter is selected, every existing check remains mandatory:
canonical declaration, exact checkout/git-directory identity, installed helper
and package, private key/HMAC, current policy digest and verified merge receipt.
Missing or stale selected local state remains an error. This decision adds no
effect, permission, write scope, CLI action or exemption from receipt validation.

Refresh previously installed hook bytes through the existing registered action:

```sh
devai init apply architect --target . --only hooks --hook post-merge --as-role architect --write --format json
```

The closed `--only hooks` selector is mutually exclusive with `--include` and
rejects `--force` and `--command`. It omits all bootstrap core entries, planning,
preflight targets and execution; only the existing hook installation's exact
hook/declaration/git-directory helper, key and attestation targets may be
planned and written, with existing consent, role enforcement and rollback.
It does not change project selection, authority-policy bytes, adopter-policy
receipts, guidance, mutation policy or unrelated scaffold files. Other Architect
initialization and `--include hooks` semantics remain unchanged. The additive
`--include hooks` form is not a scoped refresh and may create missing scaffold;
it is not the migration route for this repair.

This scoped operation may materialize/reseal the existing local helper state
against current policy bytes, but does not claim simultaneous enforcement or
make a nonselected local adapter authoritative. Do not hand-edit hooks,
attestations, keys or policy, and do not bind another adapter merely to suppress
a selected binding failure. Selecting local processing still uses registered
`init bind --host-adapter post-merge`; its attestation must bind the final current
policy. There is no new public action, local-only binding or effect grant.

## Compatibility

The corrected generated behavior ships with DEVAI 2.6.0. Existing hook bytes need
an explicit registered refresh. Existing valid selected-local behavior and
protected evidence checks remain unchanged. The optional hook refresh is listed
in the migration manifest; it does not silently change the project's selected
adapter.

## Consequences

Shared hooks no longer mistake GitHub-primary clones for selected local
receipt producers. Skipping unselected local processing grants no authority;
selected failures remain visible. Older generated hooks need an explicit refresh.

## Alternatives Considered

Automatically selecting/resealing a second adapter would change policy identity
and effect admission. Ignoring issuer failures or fabricating receipts would
weaken custody. Unconditional hook execution preserves the reproduced defect.

## Affected Rules

The generated hook implementation and registered Architect hook installation
carry the correction. The migration manifest and installation guide explain the
refresh. Existing binding, HMAC, receipt, round-close and protected workflow
contracts are retained.

## Inspector Adversarial Acceptance

Discharge IA-001 through IA-003 in fresh and linked checkout fixtures using
installed generated hooks. Include valid GitHub/non-host modes, exact selected
post-merge, missing/malformed project bytes, unknown modes/paths, missing issuer,
issuer failure with a preexisting stale receipt, and no-link path checks. Prove
NOT_SELECTED causes no issuer/key/receipt/round invocation or mutation and every
selected-local validation remains mandatory. Add a missing unrelated scaffold
file and prove scoped refresh does not create it; refuse selector/include,
force and custom-command combinations before any write.
