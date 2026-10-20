---
id: ADR-SCR-0021
title: Bound unconsumed directory links as native candidate metadata
type: adr
status: accepted
date: 2026-10-19
authority: Architect
supersedes: []
provenance:
  - ADR-SCR-0015
  - ADR-SCR-0017
affected_rules:
  - packages/cli/src/commands/sense/native-candidate-links.ts
  - packages/cli/src/commands/sense/native-runner-selection.ts
inspector_acceptance:
  - IA-001 -- A real owned native execution admits an unrelated tracked internal directory alias outside its collection root while reading target bytes only through a canonical regular path.
  - IA-002 -- Mode, literal link bytes and the complete tracked regular target population remain bound; changes invalidate native standing without changing portable historical keys.
  - IA-003 -- External, absolute, dangling, chained, cyclic, mutable, dependency, credential, untracked and ignored targets refuse; repeated observations reject races and case aliases.
  - IA-004 -- Configuration, executable, audit-projection and actual runtime reads through aliases retain their existing refusal; an alias inside collection scope is unsupported if discovery follows it.
  - IA-005 -- Linux transport support is independently observed or explicitly unproven; no host-platform substitution or transport exception establishes standing.
---

# Bound unconsumed directory links as native candidate metadata

## Status

Accepted implementation contract for the authorized native measurement repair.
Implementation acceptance does not establish an adopter verdict; the independent
adversarial obligations and existing release gates remain mandatory.

## Context

ADR-SCR-0017 requires the complete tracked candidate closure and a link-free
configuration, executable and observed-read census. Its current implementation
applies the regular-file reader to every tracked entry, conflating repository
metadata with executable or consumed bytes. DETRAN has a tracked directory alias
from its RAIT preview to two canonical fixture files. That alias lies outside all
seven backend invariant collection roots. A clean native declaration currently
refuses before executing any test.

The existing portable Git snapshots already bind mode120000 and the literal link
bytes, together with every tracked target file. No path may be dropped from this
closure to obtain a verdict. The product alias and the strict audit reader remain
unchanged.

## Decision

Amend only the whole-candidate metadata census interpretation of ADR-SCR-0017.
A private native validator may represent an **unconsumed tracked internal directory
alias** as metadata. It grants no permission to follow that alias.

The validator keeps ordinary entries under `readCandidateFile`. For an actual
tracked120000 entry, it verifies the committed and worktree modes and literal
link-byte digests through the existing Git snapshot boundary. Parent components
must be regular directories. A relative literal may contain parent segments only
when its normalized target is contained and its actual canonical path is byte and
case identical. Root/ancestor/self targets, mutable or harness namespaces,
`.git`, dependency and credential locations are refused. Absolute, dangling,
chained and regular-file aliases are unsupported.

The target must be a closed, non-followed directory census containing only tracked
regular files already in the complete task input closure. Ignored or untracked
children, nested links, unsupported file types and mode/content/population changes
refuse. Observe the link and target census before and after validation and refuse
any difference. Existing admission, post-execution and attestation freshness checks
recompute this identity; one realpath observation is not a race guarantee.

Bind a versioned `candidateLinks` identity into the native selection digest,
including each path, mode, literal-byte digest, canonical target and exact sorted
target population identity. Preserve historical portable task keys. Repositories
without aliases retain an empty versioned entry list and incur no additional Git
snapshot work for this capability.

The strict global audit reader, configuration/import/executable census and runtime
provenance checks are not relaxed. Actual alias consumption, including discovery
that traverses an alias inside collection scope, remains unsupported and refuses
standing. A successful metadata census is never proof of a successful test, real
nonce, complete native collection or authentic execution origin.

## Inspector Adversarial Acceptance

Independent tests must reproduce the old refusal using a real Git/native fixture,
then execute the accepted shape through the owned native path and built reporter
assets. The positive case uses a literal include under a backend-like root and a
canonical target read; the unrelated alias remains outside collection scope.
Negative cases cover every refusal class, mutation between observations, stale
standing and actual alias reads. Raw diagnostics and inconclusive outcomes remain
visible. Linux plan/transport acceptance requires its own observation; a Darwin
runtime refusal establishes no Linux transport support.

## Consequences

The versioned native selection identity changes, including an empty entry list in
repositories without aliases. Previously issued native selections require a fresh
execution; portable historical task keys and evidence bytes remain unchanged.
Unconsumed aliases are admitted only as closed metadata, while actual alias reads
continue to refuse standing. Linux transport support remains separately unproven.

This is an accepted implementation contract, not an adopter measurement or
readiness approval. Independent final review, affected PR checks, full release RC,
packed-adopter verification, rehearsal and authenticated publication remain
required under their existing official workflows. No threshold, effect, authority,
trust, proof history or application behavior changes.

## Alternatives Considered

Dropping tracked aliases from the candidate census would omit committed inputs and
is rejected. Following aliases through the regular-file reader would broaden
execution and observation authority and is rejected. Rewriting the adopter's
fixture alias would mix a product change into provider measurement repair. The
closed metadata identity preserves the complete candidate census and the existing
strict refusal for consumed paths.

## Affected Rules

- `packages/cli/src/commands/sense/native-candidate-links.ts` defines the closed
  candidate-link metadata validation and freshness observations.
- `packages/cli/src/commands/sense/native-runner-selection.ts` binds that metadata
  into native selection identity without broadening strict file readers.
