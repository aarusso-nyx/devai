# DEVAI 1.5.0 release notes

**Status:** prepared for review; publication has not been established by these notes.
**Upgrade paths:** 1.4.5 → 1.5.0 and 1.5.0-rc.1 → 1.5.0.

## Mutation testing leaves delivery

DEVAI 1.5.0 removes mutation testing from CI and from release eligibility for
DEVAI and its adopters. Preflight, certification, preparation, export and
publication require no mutation execution, report, score, closure or seal.
Minor, major, LTS and risk escalation cannot reintroduce that requirement.

A current release plan records mutation `none`, disposition `not-required` and
reason `mutation-external-hardening`. Missing, stale, incomplete, invalid or
failing mutation evidence is not a delivery failure and is never reported as a
synthetic pass.

The package removes the Stryker execution drivers, plugins and mutation
qualification fixtures. Mutation-only compatibility entry points report
`mutation-offloaded-to-bedel` without dispatching a mutation engine. Ordinary
verification remains required: functional tests, formatting, lint, types,
schemas, candidate identity, signatures, artifact integrity and package checks.
Source-write authorization and its ordinary regression tests remain in force.

Mutation hardening moves to the independent [Bedel repository](https://github.com/aarusso-nyx/bedel).
DEVAI has no Bedel dependency, and its publication does not wait for a Bedel
release. Historical mutation report readers retain historical semantics; they
do not supply or block current release eligibility. Tests exclusive to retired
machinery are preserved in Bedel's provenance archive. Archive preservation is
not a claim that those tests execute or pass in Bedel.

## Upgrade from 1.4.5 or 1.5.0-rc.1

1. Select the exact stable package version **1.5.0** when published, then install
   using the existing package channel. Keep `v1.5.0-rc.1` and its published
   artifacts unchanged; stable 1.5.0 is a new immutable release.
2. Preview the existing `devai init bind` migration before its reviewed write.
   Adopt Constitution **1.0.1** through the explicit constitution binding flow.
   Preserve custom ordinary task mappings and inspect every generated diff.
3. Update the release-verification profile to **schema 1.4.0** with
   `mutation_roster: []` and no `mutation_execution`. This is the configuration
   schema version, not the DEVAI package version. Older profile grammars remain
   readable for migration; their rosters do not schedule current mutation work.
4. Remove mutation jobs and dependencies from push, pull-request, scheduled,
   manually dispatched and reusable CI workflows. Review local composite
   actions, package-script wrappers and task descriptors. Remove obsolete
   required mutation checks from repository protection through the normal
   reviewed settings change.
5. Generate fresh ordinary release evidence for the exact new candidate.
   Existing mutation campaigns may remain available for historical inspection;
   do not rerun them to obtain delivery eligibility.

Customization is not permission to overwrite adopter files silently. A bind
preview and reviewed write remain the migration boundary. Existing protected
approvals continue to apply to integration and publication.

## CI transport migration

Current DEVAI protected workflows select evidence transport **3.0.0**. It
contains the ordinary ledger population plus `release-export.tgz`; it excludes
`mutation-input-plan.json` and `mutation-export.tgz`. Ordinary installed export,
trust, signature and artifact checks continue to run.

Before dispatching an updated workflow, prepare and review the exact compatible
process-control commit, installed host and v3 bundle. Update their protected
references together: workflows execute the separately pinned process-control
checkout, so changing candidate code alone does not update the active control.
Historical transport versions 1 and 2 remain explicitly readable for historical
operations and are not substitutes for a current v3 bundle.

See [mutation-free delivery and transport operations](devai-1.5-mutation-free-delivery.md)
for the packing command and operational boundaries, and
[adopter release profiles](../../adopters/release-profiles.md) for profile migration.
