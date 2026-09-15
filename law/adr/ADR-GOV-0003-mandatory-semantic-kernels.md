---
id: ADR-GOV-0003
title: Mandatory fail-closed semantic kernels
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-GOV-0001
  - ADR-GOV-0002
  - ADR-MUT-0001
  - ADR-REL-0002
provenance:
  - law/constitution.md Article 6 (substrate authority-by-path)
  - law/constitution.md Article 10 (role separation)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-GOV-0001-adr-identity-and-fail-closed-validation.md
  - law/adr/ADR-GOV-0002-constrained-self-dogfood.md
  - law/adr/ADR-MUT-0001-mutation-assurance-v2.md
  - law/adr/ADR-REL-0002-nine-state-release-lifecycle-and-observed-publication.md
affected_rules:
  - law/policy/adr-validation.json
  - law/policy/mutation-assurance-v2.json
  - law/policy/release-lifecycle.json
  - law/schemas/adr-validation-policy.schema.json
  - law/schemas/effect-authorization-event.schema.json
  - law/schemas/effect-authorization-ledger.schema.json
  - law/schemas/mutation-assurance-policy-v2.schema.json
  - law/schemas/mutation-assurance-v2.schema.json
  - law/schemas/release-lifecycle-observation.schema.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/schemas/release-offline-verification-receipt.schema.json
  - law/schemas/release-plan-receipt.schema.json
  - law/schemas/release-publication-receipt.schema.json
  - law/schemas/self-dogfood-policy.schema.json
inspector_acceptance:
  - IA-001 -- An ADR graph with an unresolved reference, cycle, conflicting successor, or multiple effective accepted heads fails with the frozen ADR resolver error rather than selecting an arbitrary authority.
  - IA-002 -- A ledger with a missing event, forged content digest, repeated or gapped sequence, broken previous digest, invalid terminal reference, reused grant, or non-final head authorizes nothing.
  - IA-003 -- A mutation report whose score, survivors, thresholds_met, or verdict cannot be recomputed from the bound immutable execution artifacts fails even when it is schema-valid.
  - IA-004 -- An offline-verification receipt with an omitted, reordered, substituted, placeholder, or unresolved roster result cannot pass; mutation-semantics is the only conditionally not-applicable check.
  - IA-005 -- A lifecycle observation derives no published state when any head, verified-against, receipt, candidate, artifact, workflow, signer, trust, or digest binding differs.
  - IA-006 -- A self-dogfood policy with a duplicate, missing, reordered, or widened role row or permitted-check entry fails its exact closed schema.
  - IA-007 -- A plan receipt with a missing, reordered, substituted, or incorrect lifecycle step, determination, input digest, receipt digest, or receipt id fails verification.
  - IA-008 -- Publication receipt projection and authorization-event projection are evaluated in their frozen acyclic calculation order; substituting an identity, digest, signed payload, or signature fails verification.
---

# Mandatory fail-closed semantic kernels

## Status

Accepted. Supersedes ADR-GOV-0001, ADR-GOV-0002, ADR-MUT-0001, and
ADR-REL-0002 forward without editing their bytes.

## Context

The superseded records froze the correct public surfaces, roles, effects, and
nine-state release lifecycle. Their schemas constrained document shape, but
several correctness claims relate values across documents or require
recomputation from immutable evidence. JSON Schema validation alone cannot
establish those claims. Digest definitions also need a single acyclic
projection and calculation order.

## Decision

The eight governed semantic boundaries below use named, versioned, mandatory
kernels. Each kernel's exact algorithm and error-code vocabulary is part of the
contract. Schema validation alone never establishes authority, pass, or
publication. A missing, unknown, skipped, partially executed, or weaker kernel
fails closed.

1. `devai.kernel.adr-supersession-resolution.v1` resolves all ADR-v2 records and
   the digest-bound legacy catalog. An effective ADR is accepted and is not
   superseded directly or transitively by another effective accepted record.
   Unresolved references, self-links, cycles, duplicate identities, conflicting
   accepted successors, and multiple effective heads in one lineage are errors.
2. `devai.kernel.effect-authorization-ledger.v1` resolves every event, invokes
   `devai.kernel.effect-authorization-event-canonicalization.v1`, recomputes
   payload identities and complete-event digests, requires contiguous unique
   sequence and an exact previous-digest chain, validates terminal-to-grant
   transitions and one-time consumption, and requires the ledger head to equal
   the final entry. Ledger shape or possession authorizes nothing.
3. `devai.kernel.mutation-assurance-v2.v1` recomputes counts, score, survivors,
   thresholds, `thresholds_met`, and verdict from the bound immutable execution
   artifacts and threshold snapshot. Reported summaries cannot establish pass.
4. `devai.kernel.offline-verification-receipt.v1` requires the complete ordered
   roster for candidate/tree identity, receipt-envelope canonicality,
   signer/trust, policy, result DAG/digests, artifact population/digests/safety,
   and mutation semantics. The first eight checks must pass; only mutation
   semantics may be policy-authorized as not applicable.
5. `devai.kernel.release-lifecycle-observation.v1` cross-checks lifecycle head,
   `verified_against`, dispatched publication state, signed receipt, derived
   state, candidate, artifact, workflow, signer, trust, and every referenced
   digest. Any mismatch derives no `published` state and writes nothing.
6. The self-dogfood contract is a closed ordered matrix with exactly one row for
   each of Owner, Architect, Inspector, Engineer, and Auditor, plus the exact
   nine permitted checks. Duplicate, missing, reordered, or widened entries are
   invalid; no row gains remote-write.
7. `devai.kernel.release-plan-receipt.v1` resolves and hashes the required
   inputs, recomputes SemVer, support, impact, risk, and the exact ordered
   nine-action mapping, then recomputes receipt digest and id. A substituted or
   merely well-formed plan cannot pass.
8. `devai.kernel.publication-receipt-canonicalization.v1` excludes receipt
   identity, signed-payload digest, signature, and whole-receipt digest from the
   signed projection; derives the receipt id only after that digest and the
   whole-receipt digest only after signing. Authorization events analogously
   derive payload digest, then event id, then the complete-event ledger digest.
   Neither construction contains a self-reference.

All kernel identifiers, ordered algorithms, projections, and named errors are
frozen in the affected policies and schemas. Implementations may add diagnostic
detail but may not omit a step, reinterpret an error as success, or substitute
a weaker algorithm.

The public action registry remains exactly fifty-seven actions: thirty-two
stable, fourteen preview, and eleven internal. The same nine stable release
actions, roles, effects, and pure-read boundaries remain unchanged.

## Consequences

Schema-valid evidence can still be rejected by its mandatory semantic kernel;
that is intentional. Implementations must resolve immutable inputs and perform
the frozen recomputation before accepting a pass, authority, or derived state.
Cross-document ambiguity is an error rather than an implementation choice.

Earlier accepted ADR files remain immutable. Under the new resolver this record
is the single effective accepted head for the four joined decision lineages;
the superseded records remain historical evidence.

## Alternatives Considered

**Rely on JSON Schema alone.** Rejected because relational equality, graph
resolution, cryptographic recomputation, and append-only history are not proven
by structural validation.

**Let runtimes choose their own semantic checks.** Rejected because two
conforming runtimes could then disagree on authority or publication.

**Amend the earlier accepted ADRs.** Rejected because forward-only governance
requires a new accepted decision and preserves the exact prior bytes.

## Affected Rules

The `affected_rules` frontmatter is exhaustive. It adds semantic requirements
only; no runtime, generated view, workflow, test, or registry action is changed.

## Inspector Adversarial Acceptance

Acceptance requires the eight attacks in `inspector_acceptance` to be rejected
either structurally or by the exact mandatory kernel named for that boundary.
A validator that reports success without executing a required semantic kernel
is itself a failing implementation.
