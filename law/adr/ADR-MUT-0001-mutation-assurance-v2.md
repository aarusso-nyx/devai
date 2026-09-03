---
id: ADR-MUT-0001
title: Additive mutation assurance v2 with exact identity binding
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 30 (test weakening prohibition)
  - law/constitution.md Article 39 (explicit uncertainty over false precision)
  - law/constitution.md Article 41 (evidence)
  - law/policy/mutation-strength.json
  - law/adr/ADR-014-release-verification-profiles.md
affected_rules:
  - law/policy/mutation-assurance-v2.json
  - law/schemas/mutation-assurance-v2.schema.json
  - law/schemas/mutation-assurance-policy-v2.schema.json
inspector_acceptance:
  - IA-001 -- A report with disposition not-required never carries verdict pass. The contract admits only verdict not-applicable for that disposition.
  - IA-002 -- A targeted report is rejected as evidence for a full-roster requirement, including when it is reused and including when its score exceeds the threshold.
  - IA-003 -- Reuse fails when any one of the ten identity bindings differs. Changing only the lockfile digest, or only the sanitizer digest, is enough to deny reuse.
  - IA-004 -- Reuse fails when an identity binding is absent rather than mismatched. A missing identity is a denial, not a wildcard.
  - IA-005 -- A run with a non-zero infrastructure_error or runtime_error count cannot report verdict pass. A failure to observe is neither a pass nor a fail.
  - IA-006 -- A full-mode pass with selection.roster_complete false is rejected. Partial roster coverage never discharges a full requirement.
  - IA-007 -- A report with caller_trimmed true is rejected. A caller-narrowed selection is not a smaller result, it is not a result.
  - IA-008 -- An empty scenario selection cannot produce verdict pass in either mode.
---

# Additive mutation assurance v2 with exact identity binding

## Status

Accepted.

## Context

`law/policy/mutation-strength.json` already states the right dispositions: a
`not-required` scope is explicit and reasoned rather than passing, an
infrastructure error is `unknown` rather than `fail`, and an empty selection is
never a pass. ADR-014 added that mutation is targeted for behavioral change and
full-roster for LTS.

What neither states is what a mutation result is *about*. A mutation score is
meaningful only relative to a specific candidate, a specific source tree, a
specific test tree, a specific runner configuration and toolchain, a specific
scenario roster, specific thresholds, specific sanitizers, specific
orchestration, and a specific dependency lockfile. Without those bindings, a
result is a number that can be carried across a change that invalidates it. The
practical failure is reuse: a cached result from a prior run silently satisfies
a later requirement whose inputs have moved.

The second gap is that targeted and full were described as selection strategies
rather than as distinct results. Read as strategies, a targeted pass looks like
a cheaper full pass.

## Decision

Mutation assurance v2 is additive. It relaxes no v1 pass condition and adds
identity binding to every result.

Every report binds ten identities exactly: candidate, source, test, config,
toolchain, roster, threshold, sanitizer, orchestration, and lockfile. Each
non-candidate identity is a content digest over an ordered member set with its
member count included, so a truncated or empty set never matches a populated
one. The candidate is bound by release unit, commit, and tree.

Targeted and full are distinct assurance kinds, and each report states the
requirement it may discharge. That value always equals its mode: a targeted
report discharges only a targeted requirement, and a full report requires
complete roster coverage. Cross-mode reuse is denied.

`not-required` is never a pass. The contract admits exactly one verdict for that
disposition — `not-applicable` — with a typed reason from a closed set. There is
no representation in which a not-required scope reports as a pass.

Reuse is permitted only on an exact match of all ten identities. A partial match
is a denial. A missing identity is a denial, not a wildcard. Cross-mode reuse is
a denial.

A pass additionally requires zero runtime errors, zero infrastructure errors, an
independently checkable result, a non-empty selection, and an untrimmed
selection.

## Consequences

Cached mutation results stop being portable across input changes. A dependency
bump invalidates reuse through the lockfile identity, and a sanitizer change
invalidates it through the sanitizer identity. This is more re-execution and it
is the point.

Producers must compute and record ten digests per report. The canonical form is
fixed so two producers on the same inputs agree byte-for-byte.

`law/policy/mutation-strength.json` is unchanged and remains in force. v2 extends
it; the v2 policy names it in `supersedes_policy` as the artifact it extends,
and no v1 condition is loosened.

No runner is bound by this decision. It defines the record and the policy; the
producer and consumer implementations are a separate Engineer and Inspector
concern, and until they exist there is no v2 evidence in the repository.

## Alternatives Considered

**Bind only the candidate commit.** Rejected: a commit fixes the tree but not
the toolchain, thresholds, sanitizers, or orchestration a run actually used, and
those are exactly the inputs that drift between runs on the same commit.

**Let a full result satisfy a targeted requirement implicitly.** Rejected: the
direction is defensible but the implicit widening invites the reverse, and a
single explicit `satisfies_requirement` field with no exceptions is checkable.

**Allow reuse on a scored similarity of identities.** Rejected: a threshold on
identity match is a mechanism for accepting a mismatch. Exact or denied.

**Represent not-required as a pass with a reason.** Rejected: every downstream
aggregation over pass counts would then count a scope that was never measured.

## Affected Rules

- `law/policy/mutation-assurance-v2.json` — new canonical v2 policy.
- `law/schemas/mutation-assurance-v2.schema.json` — new v2 report contract.
- `law/schemas/mutation-assurance-policy-v2.schema.json` — new v2 policy contract.
- `law/policy/mutation-strength.json` — unchanged and still in force.
- `law/policy/thresholds.json` — remains the sole threshold source.

## Inspector Adversarial Acceptance

Acceptance is demonstrated by the attacks in this record's
`inspector_acceptance` frontmatter, each of which must fail closed. The
Inspector additionally demonstrates that a report claiming
`independently_checkable: false` cannot reach verdict pass, and that a report
whose `thresholds_applied.source` is not the canonical threshold path is
rejected rather than silently rescored.
