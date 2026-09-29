---
id: ADR-CHK-0005
title: Every check member declares where it applies and a framework-only member reports not-applicable in an adopter
type: adr
status: proposed
date: 2026-09-29
authority: Architect
supersedes: []
provenance:
  - ADR-CHK-0003
  - ADR-GOV-0017
  - law/policy/check-suites.json
  - packages/cli/src/commands/check/adapters-reports.ts
  - packages/cli/src/commands/check/action-effects.ts
  - docs/dev/operations/harness-convergence-extension-proposal.md
affected_rules:
  - law/policy/check-suites.json
  - law/schemas/check-suites.schema.json
  - packages/cli/src/commands/check/adapters-reports.ts
  - packages/cli/src/commands/check/adapters.ts
  - packages/cli/src/commands/check/action-effects.ts
  - packages/cli/src/commands/check/contracts.ts
  - packages/cli/src/commands/check/facade.ts
  - packages/cli/src/commands/spec/validate-action-coverage.ts
  - docs/reference/cli/check-suites.md
  - docs/adopters/install.md
  - docs/adopters/ci-economy.md
  - docs/reference/error-codes.md
inspector_acceptance:
  - IA-001 -- In a DEVAI self fixture, action-coverage, action-effects, and cli-reference each execute their substantive check, and a deliberately broken action, effect, catalogue, or CLI reference still fails; none reads not-applicable on the framework.
  - IA-002 -- In a minimal adopter fixture, action-effects and cli-reference report not-applicable with member, detected repository kind, the evidence by which the kind was identified, the selected input source, and reason; no ENOENT is raised and no file is created beneath the adopter root.
  - IA-003 -- In an adopter fixture with no substantive action population, action-coverage reports the empty population explicitly and never an empty PASS; with a real population it evaluates the adopter scope and a broken claim fails.
  - IA-004 -- An adopter that opts into a supported explicit input source has that source validated; an invalid or missing explicit path fails with a named code and never falls back to not-applicable; a policy error stays a failure.
  - IA-005 -- check and check --only classify a member identically; not-applicable is a distinct value from PASS, REVIEW, and execution error in machine JSON, human output, and aggregate status; the aggregate never reports ok true when any member's population was empty; two reruns are byte-identical.
  - IA-006 -- A check member without an applicability declaration is rejected by the check-suites schema, and a member declared self that is dispatched in an adopter without the not-applicable path is a test failure.
---

# Every check member declares where it applies and a framework-only member reports not-applicable in an adopter

## Status

Proposed on 2026-09-29 from DETRAN R-0020 CTG-0004 (#187). Binds nothing
until the Architect sets it to accepted before round R-0309 opens. Extends
the check contract of ADR-CHK-0003 with an applicability dimension; the
planning lane, the class selectors, and the suites are unchanged. DETRAN's
Owner has already accepted explicit not-applicable for the three members
named here, which is why option A is chosen first.

## Context

`check` exposes `action-coverage`, `action-effects`, and `cli-reference` to
adopters, but they behave as framework self-checks. `adapters-reports.ts`
calls `runActionCoverageCheck` with `scope: 'self'` unconditionally, though
the function supports an adopter scope, so an adopter reads
`ACTION_INVOCATION_REFUSED` with a claimed count of zero. `action-effects`
reads `law/policy/subprocess-effects.json` and
`tests/config/tsconfig.effects.json` beneath the adopter root, and
`cli-reference` reads `law/policy/documentation-information-architecture.json`
there; none exists in an adopter, so each raises ENOENT (#187). Copying the
framework's policy and catalogue into an adopter to turn the checks green is
not acceptable, and neither is marking an unexecuted check `ok: true`.
Verified against this checkout on 2026-09-29: the forced scope is at
`adapters-reports.ts:114` and the defaults at `action-effects.ts:22` and
`:31`.

## Decision

Every member in `law/policy/check-suites.json` declares `applicability` as
`self`, `adopter`, or `both`, and the schema rejects a member without it.
`action-coverage` is `both`. `action-effects` and `cli-reference` are `self`
unless and until a package-owned input mode is declared for them, which is
option B of #187 and a later record.

A member declared `self` that is dispatched in an adopter returns a
structured `not-applicable` result carrying the member, the detected
repository kind, the evidence by which the kind was identified, the input
source that was selected, and the reason. The repository kind is detected
from the bound project configuration, not from the presence of directories.
`not-applicable` is a distinct value from PASS, REVIEW, and execution error
in machine JSON, in human output, and in aggregate status, and it is stable
across reruns.

Applicability never absorbs a failure. A missing required adopter source, an
invalid or missing explicit input path, a policy error, a malformed input,
and a genuine self-check failure on the framework each stay failures with
their named codes; an invalid explicit path never falls back to
`not-applicable`.

`action-coverage` passes the detected scope instead of the forced self
scope. When no substantive adopter population exists, it reports the empty
population explicitly, never an empty PASS. `check` and `check --only`
classify identically, and the aggregate never reports `ok: true` when any
member's population was empty.

The CLI reference documents which members apply to adopters and how to test
the classification, and the error-codes reference names the new result
class.

## Consequences

DETRAN's three explicit N/A entries become framework results instead of a
downstream exception, and the accepted downstream CI list is unchanged. The
check-suites policy grows one field per member and the materialized suite
views regenerate. A framework self-check keeps every failure it had. The
choice of option A leaves `action-effects` and `cli-reference` unmeasured in
adopters, which is stated on the adopter pages; option B remains open as a
later record.

## Alternatives Considered

Option B, a package-owned input mode that evaluates the DEVAI sources from
the installed package, is deferred rather than rejected; it needs a decision
on which package files are inputs and is not required for DETRAN's
acceptance. Detecting the repository kind from directory existence is
rejected because an adopter with a `law/` directory would be misread.
Turning missing adopter sources into `not-applicable` is rejected because it
would hide a real misconfiguration. Marking the three members `adopter:
excluded` in the suites is rejected because an adopter that runs `--only`
on one of them would still hit the ENOENT.

## Affected Rules

- `law/policy/check-suites.json` and `law/schemas/check-suites.schema.json` declare and require `applicability`.
- `packages/cli/src/commands/check/adapters-reports.ts`, `adapters.ts`, `action-effects.ts`, `contracts.ts`, and `facade.ts` dispatch by applicability, detect the repository kind, and carry the result class.
- `packages/cli/src/commands/spec/validate-action-coverage.ts` evaluates the detected scope.
- `docs/reference/cli/check-suites.md`, `docs/adopters/install.md`, `docs/adopters/ci-economy.md`, and `docs/reference/error-codes.md` document the classification.

## Inspector Adversarial Acceptance

On the framework, break one action claim, one declared effect, one catalogue
entry, and one CLI reference line in turn and confirm each member fails. In
a minimal adopter fixture, run each of the three members through `check` and
through `--only`, confirm identical `not-applicable` results with the five
fields, and confirm no file was created beneath the root. Give the adopter
an empty action population and confirm the explicit empty-population result;
give it a broken claim and confirm failure. Point an explicit input option at
a missing path and at a malformed file and confirm named failures with no
fallback. Remove `applicability` from one member and confirm the schema
rejects the policy. Run the adopter fixture twice and diff the JSON.
