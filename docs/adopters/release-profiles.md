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

The current protected Stryker template additionally records one exact Vitest
configuration path and one TypeScript configuration root for every roster row.
Both are part of the row's bound configuration population; the protected host
also binds the no-follow TypeScript `extends` and project-reference closure.
The complete declared test population and its security-relevant source/test
population remain intact even when an effective runner configuration excludes
files or Stryker emits no mutant for a selected file.

Mutation-v2.1 release evidence is retained as one protected, unit-scoped
closure in the existing certification-evidence sink. It contains a report and
result for each required package, plus exactly one summary and semantic receipt.
It is not a publishable package row and is never added to a package tarball or
the prepare/export ArtifactSink vocabulary. Certification, prepare, export and
the prepare/export ArtifactSink vocabulary. Certification and prepare re-read
and re-hash the sink closure. Export carries an exact copy in its existing
provider result; offline verification re-hashes that portable copy without
requiring the original host evidence store.

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

## Protected mutation verifier hosts

Governed mutation v2.1 finalization and verification through the protected
`@aarusso-nyx/devai/release-host` entry point require Node.js 24 or later on
Linux or macOS with POSIX `O_NOFOLLOW` support. Hosts without that support,
including Windows, fail closed; there is no weaker pathname fallback.
Missing or divergent verifier provenance also refuses before use. This
limitation applies to the protected mutation verifier, not the generic CLI.

These checks retain the trusted-local evidence boundary. They do not establish
independent signer/verifier custody or independent attestation.
