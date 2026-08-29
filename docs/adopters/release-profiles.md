# Release verification profiles

DEVAI 1.4 lets an adopter map generic release capabilities to its existing
`test-tasks.json` nodes. DEVAI validates and executes that declaration; it does
not invent product commands, risks, consumers, databases, RLS rules, or mutation
targets.

## Two independent axes

A release intent declares a SemVer transition (`patch`, `minor`, `major`, or
`prerelease`) and a support intention (`preview`, `current`, or `lts`). An
unchanged immutable artifact may enter LTS only through an explicit support
promotion. Downgrades, invalid versions, unknown risks, and ordinary
same-version releases block.

The selected capabilities are a union. Transition, support, changed-path task
impact, declared risks, adopter policy, and Owner escalations may add work; none
may remove the unconditional floor. Every candidate therefore verifies
formatting, lint, appropriate types, schema/generated consistency, secret and
portable-path surfaces, package boundaries, and exact candidate identity.

## Configuration

Place a schema-valid profile at
`.devai/config/release-verification.json`. Its canonical schema is
`release-verification-profile.schema.json`. The declaration identifies the
release unit and version source, maps each capability to one or more existing
task nodes, maps adopter-specific risk names to capabilities, and declares the
mutation roster and its source/test/config/sanitizer selectors.

The version source is a repository-relative JSON package manifest with a string
`version`. The runner reads it from both the exact base commit and the exact
candidate commit and requires those bytes to agree with `current_version` and
`target_version`. A monorepo release unit must therefore have one unambiguous
version source. Mixed transitions require separate release intents; an absent,
malformed, or inconsistent source fails closed.

Each roster entry names its existing mutation task node, package, applicable
risk classes, source and test populations, manifest, configuration, sanitizer
and orchestration inputs, lockfile, toolchain identities, and thresholds. The
runner selects affected entries from the candidate's exact declared path set,
selects risk-matched entries for targeted assurance, and selects the complete
roster for LTS. When targeted assurance cannot prove a narrower population it
fails safe to the complete declared roster; an unresolved affected population
blocks.

Package policy can opt into materialization with `release_verification`. Use the
existing `init bind` preview and reviewed write flow. Existing adopters without
that field receive no release profile and retain their prior `affected`, `local`,
and `rc` behavior. An update never silently replaces adopter-owned bytes.

## Preflight and certification

```bash
pnpm exec devai check \
  --release-intent ./release-intent.json \
  --release-profile .devai/config/release-verification.json \
  --release-stage preflight --base <exact-base-sha> \
  --run --as-role inspector --write --format json
```

The preflight receipt binds the exact commit/tree, base, intent, profile, task
policy, toolchain, and mandatory floor results. Certification uses the same
command with `--release-stage certify` and `--preflight-receipt <path>`. It
refuses to start when any binding differs. A receipt records `executed`,
`reused`, `not-required`, `failed`, `blocked`, or `unknown`; skipped work is
never reported as passed.

Failed, blocked, and unknown checks also carry one bounded `failureClass`:
`static-defect`, `sensor-stale`, `environment-drift`, `product-regression`,
`policy-invalid`, `evidence-mismatch`, or `unknown`. Receipts never embed raw
errors or unbounded command output.

The release intent's `changed_paths` must exactly equal the base-to-candidate
Git diff. `changed_packages` can provide the adopter's package mapping, but it
cannot conceal a roster entry selected by the exact changed paths.

Mutation reuse is exact per roster entry. A change to source, tests, manifest,
configuration, orchestration, roster, thresholds, sanitizers, lockfile,
toolchain, dependencies, report integrity, or required candidate/profile/policy
identity invalidates reuse.

These checks establish verification facts only. Human maintainers still choose
scope and separately authorize push, merge, tag, release, publication,
deployment, and rollback effects.
