---
id: ADR-REL-0004
title: Separate release append-log tail from completed-state head
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-REL-0003
  - ADR-GOV-0015
provenance:
  - law/constitution.md Article 3 (human-directed control)
  - law/constitution.md Article 9 (authority chain)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-REL-0003-blocked-plan-receipts.md
  - law/adr/ADR-GOV-0015-lifecycle-kernel-closure.md
affected_rules:
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/schemas/release-lifecycle-store-record.schema.json
inspector_acceptance:
  - IA-001 -- After attempt then failure, a successor attempt names the failure as predecessor_record while retaining the unchanged completed-state head as observed_head_before.
  - IA-002 -- Every terminal record names its exact attempt as predecessor_record and copies that attempt's observed_head_before byte-for-byte.
  - IA-003 -- Only completion may compare-and-swap HEAD; failure advances only the append-log tail and unknown is terminal without retry or redispatch.
  - IA-004 -- A failed remote attempt can be followed only by a distinct attempt bound to a fresh exact Owner authorization; the consumed attempt can never be dispatched again.
  - IA-005 -- Resume validates both the append-log tail and full v2 canonical completed-state head before returning one exact next action or blocked reason, and writes nothing.
---

# Separate release append-log tail from completed-state head

## Status

Accepted as a narrow forward correction to the active release store contract.
It supersedes ADR-REL-0003 and ADR-GOV-0015 only for their shared lifecycle
store, retry, and resume subjects. Their release-state, receipt, authorization,
trust, package-closure, and schema-reachability decisions remain unchanged.

## Context

The v2 release store has two different moving identities. Its append-only audit
log advances for every attempt and terminal record. Its completed-state `HEAD`
advances only when an action completes successfully. The prior kernel used one
predecessor identity for both purposes.

That model works after completion because the log tail and completed-state head
both identify the completion. It becomes contradictory after failure. The
failure must become the next append-log predecessor, while `HEAD` must remain at
the last successful completion. A successor attempt cannot name both. The
contradiction either makes a legitimate retry impossible or encourages an
implementation to skip the failure in the audit chain.

## Decision

Every store record carries two distinct identities.

`predecessor_record` is null only for the opening attempt. Otherwise it is the
exact preceding append-log record, including a failure. It defines the single
content-addressed audit chain and advances on every valid append.

`observed_head_before` is null when no action has ever completed. Otherwise it
is the complete byte-identical document accepted by the existing
`release-lifecycle-store-head.schema.json`: the full v2 canonical completed-state
head, not a partial sequence or digest projection. It is the compare-and-swap
input and does not advance on an attempt, failure, or unknown result.

The opening attempt has null `predecessor_record` and null
`observed_head_before`. A successor attempt after completion or failure names
the exact append-log tail as `predecessor_record` and records the exact current
completed-state head as `observed_head_before`; this may still be null if no
action has ever completed.

Every completion, failure, or unknown-provider-result is terminal for exactly
one attempt. Its `predecessor_record` is that exact attempt, and its
`observed_head_before` is byte-identical to the attempt's value. Each attempt
has at most one terminal record.

Completion alone may advance `HEAD`. After durably appending the completion,
the core re-reads the complete v2 head and compares it byte-for-byte with the
attempt's `observed_head_before`. Only equality permits atomic replacement with
the new completed-state head. A failure leaves `HEAD` unchanged but becomes the
append-log tail. An unknown result also leaves `HEAD` unchanged, is terminal,
and is non-retriable.

A failed remote attempt is never redispatched. A later dispatch is a new
attempt with a distinct attempt ID and a fresh exact Owner authorization bound
to that attempt, request, repository, candidate, action, and destination. The
consumed authorization of the failed attempt grants nothing to its successor.

`release resume` validates the complete append chain and the complete v2
canonical head as separate inputs. From their pair it returns exactly one next
action or one blocked reason. A completion derives the next action from the
new head. A failure derives the same state transition as a new attempt; a
remote action remains blocked until fresh exact authorization is supplied. An
unknown result or unterminated attempt has null next action and its exact
blocked reason. Any divergence between log and head is a store error. Resume
never appends, repairs, deletes, links, retries, or redispatches.

## Consequences

Failure evidence remains in the append chain without being mistaken for a
completed release state. Authorized retries become representable, including a
retry after the opening action failed while `HEAD` is still absent.

The full v2 canonical head remains unchanged and authoritative. The correction
adds an explicit observed copy to the record contract; it does not replace the
head with a smaller or independently interpreted projection.

At-most-once remote dispatch remains fail-closed. Failure does not refund or
transfer authorization, and an uncertain provider result still stops the
campaign instead of becoming an automatic retry.

## Alternatives Considered

**Point a successor attempt to the unchanged completed-state head.** Rejected
because it skips the failure record and forks the append-only audit history.

**Advance `HEAD` on failure.** Rejected because `HEAD` represents completed
release state, not the latest event, and a failure cannot manufacture a state
transition.

**Reuse the failed attempt or its authorization.** Rejected because the
provider may already have observed the dispatch and the authorization was
consumed for one exact attempt.

**Let resume choose whichever identity appears newer.** Rejected because it
would silently repair a contradiction and make the result dependent on an
unrecorded precedence rule.

## Affected Rules

- `law/policy/release-lifecycle.json` defines independent append-tail and
  completed-head semantics, retry authority, and two-input resume resolution.
- `law/schemas/release-lifecycle-policy.schema.json` freezes the corrected v3
  store semantic kernel and adversarial fixtures.
- `law/schemas/release-lifecycle-store-record.schema.json` requires both the
  append predecessor and the exact observed full v2 head on every record.

## Inspector Adversarial Acceptance

The five frontmatter cases must be executed against complete histories, not
isolated records. Acceptance includes opening failure then authorized retry,
completion then failure then retry, terminal-to-attempt observed-head mismatch,
failure that attempts to move `HEAD`, unknown-result retry, same-attempt
redispatch, consumed-authorization reuse, and resume decisions made with only
one of the two history identities. Every malformed history must return its
frozen store error without mutation.
