# Release verification profiles

DEVAI 1.5 maps generic release capabilities to existing `test-tasks.json` nodes.
Mutation testing is optional external hardening owned by
[Bedel](https://github.com/aarusso-nyx/bedel). DEVAI neither executes it in CI nor
requires its results for certification, preparation, export or publication.
This applies to DEVAI and every adopter, including minor, major and LTS releases.
Bedel is not a DEVAI dependency.

## Release capabilities

A release intent declares a SemVer transition (`patch`, `minor`, `major`, or
`prerelease`) and support intention (`preview`, `current`, or `lts`). An unchanged
immutable artifact may enter LTS through explicit support promotion. Invalid
versions, downgrades, unknown risks and ordinary same-version releases block.

Transition, support, changed-path task impact, declared risks, adopter policy and
Owner escalations select ordinary verification. Every candidate retains the
unconditional floor: formatting, lint, types, schema/generated consistency,
secret and portable-path checks, package boundaries and exact candidate identity.
No selection or escalation can reintroduce mutation testing.

## Prerelease channels

Prerelease versions follow the ladder in the materialized lifecycle policy
(`plan_determination.prerelease_ladder`, ADR-REL-0028): `alpha`, then `beta`,
then `rc`, each with a numeric suffix such as `2.0.0-beta.3`. Any other prerelease
identifier blocks as `invalid-semver`. Each rung requires its own verification
depth: alpha runs the unconditional floor plus affected and dependent checks, beta
adds the unit and integration closure, and rc requires the complete RC coverage
closure. Only an rc may be promoted to the stable version.

Rungs publish to their own dist-tags, `alpha`, `beta`, and `next`; stable versions
publish to `latest` only. Promotion moves forward one rung at a time or increments
the suffix within a rung; skipping a rung or moving backward blocks as a
`downgrade`. A release intent may declare `channel` (`alpha`, `beta`, `rc`, or
`stable`); it must agree with the target version or the plan blocks.

Adopters inherit the ladder through the materialized policy. They may narrow which
rungs they use, for example by publishing only `rc` builds, but may never add
identifiers or reorder the ladder.

## Configuration and migration

Declare the release unit, version source and capability-to-task mapping in
`.devai/config/release-verification.json`. Current profiles use schema version
`1.4.0`, an empty `mutation_roster: []` compatibility field, and no
`mutation_execution`. Historical profile versions remain readable for migration;
their mutation declarations no longer select execution or require evidence.

The version source is a repository-relative JSON package manifest containing a
string `version`. Its exact base and candidate bytes must match the declared
current and target versions. Mixed transitions require separate release intents.

Package policies opt into materialization through `release_verification`. Use
`devai init bind` to preview the diff and the reviewed `--write` flow to apply it.
The preview must show removal of the old roster and execution template. Preserve
custom ordinary task mappings; customized adopter bytes are never silently
replaced. Remove mutation tasks from CI and release dependencies, including
reusable and manually dispatched workflows and required repository checks.

Existing adopters without a release profile retain their ordinary affected,
local and RC verification. Mutation commands are deprecated interfaces that
explain the move to Bedel and do not dispatch a runner.

## Preflight and certification

```bash
pnpm exec devai check \
  --release-intent ./release-intent.json \
  --release-profile .devai/config/release-verification.json \
  --release-stage preflight --base <exact-base-sha> \
  --run --as-role inspector --write --format json
```

Certification uses the same command with `--release-stage certify` and
`--preflight-receipt <path>`. Receipts bind exact candidate, intent, policy,
toolchain and mandatory results. Changes to those bindings refuse execution.
The declared `changed_paths` must equal the base-to-candidate Git diff.

Mutation disposition is `not-required`, with reason
`mutation-external-hardening`; it is never a fabricated pass. Absent, invalid,
incomplete or failing mutation reports do not block delivery. Historical
readers remain available only for historical evidence and are isolated from
current readiness. Optional reports do not enter required publication artifacts.

Ordinary checks retain executed, reused, failed, blocked and unknown outcomes.
Human authorization and existing protected approvals still control external
publication effects.
