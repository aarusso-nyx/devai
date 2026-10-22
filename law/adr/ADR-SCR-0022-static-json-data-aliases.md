---
id: ADR-SCR-0022
title: Classify bounded JSON data aliases in read-only static test observations
type: adr
status: accepted
date: 2026-10-22
authority: Architect
supersedes: []
provenance:
  - ADR-SCR-0015
  - ADR-SCR-0017
affected_rules:
  - packages/sensors/src/json-data-alias.ts
  - packages/sensors/src/test-file-population.ts
inspector_acceptance:
  - IA-001 -- All five static observations retain identical executable counts, source counts, package boundaries, metrics and status with or without a valid JSON-only nested alias.
  - IA-002 -- Default executable and generic census remain strict; explicitly selected alias roots and non-JSON descendants refuse.
  - IA-003 -- Absolute, external, chained, nested, cyclic, dangling, executable, malformed, mutable-namespace and over-bound aliases refuse.
  - IA-004 -- No native runner, candidate identity, observed-read authority, service fixture or invariant producer is changed or activated.
---

# Classify bounded JSON data aliases in static observations

## Status

Accepted for the bounded read-only measurement repair. Publication and adopter activation remain gated.

## Context

The read-only test coherence, idiomaticity, security, performance and robustness sensors currently refuse a package containing a nested directory alias even when its target contains only JSON fixture data. Narrowing roots would change package denominators; following aliases would duplicate or admit executable inputs. Neither is acceptable.

## Decision

Only these five static observation paths opt into a private bounded classification. A nested alias contributes zero executable or source entries. Its literal must be relative, valid UTF-8 and NFC, its canonical target must be inside the repository, and its prefixes must be regular directories. The target must contain at least one valid UTF-8 JSON regular file, no executable files, no descendant links and no other file types. Credential, dependency and mutable evidence namespaces refuse.

Observe the link and complete target twice. Compare literal bytes, canonical path, inode/mode/size/timestamps, sorted directory populations and SHA256 file contents. Read regular files through O_NOFOLLOW descriptors and compare descriptor/path identities before and after. Refuse exceptions or observed changes. Bound the inspection at 4 MiB total, 256 entries and depth 16; these are fail-closed admission limits, not verdict thresholds.

The alias itself is never traversed for a census. Explicitly selected alias roots refuse. Source/test files reached through canonical package paths retain their original package and executable classification. The default generic and executable census remain link-free; opt-in is limited to static observations. No input root, metric, predicate or threshold changes.

## Consequences

Double observation detects observed instability; it is not native execution provenance or a claim of atomic adversarial filesystem custody. This repair does not edit native candidate-link validation, the native runner, service fixtures, permission effects or invariant bindings. ADR-SCR-0021 is a distinct native metadata contract and is not activated or validated by these static tests. The adopter's C6 security hold remains in force.

Independent review, affected checks and official publication/adoption are required before an adopter claims repaired canonical readings. A passing sensor fixture is not evidence of product readiness or a measured full adopter population.

## Alternatives Considered

Narrowing package roots would alter denominators. Following aliases could duplicate or hide executable inputs. Rewriting adopter product fixtures would mix product changes into measurement repair. All are rejected. Default strict admission remains available to every existing non-static caller.

## Affected Rules

The private JSON classification helper and the static opt-in in test-file-population implement this bounded observation contract. No native runner or C6 producer is an affected subject.

## Inspector Adversarial Acceptance

Compare identical five-sensor statuses, metrics and package boundaries before and after adding valid nested JSON data. Require default strict and explicitly selected-root refusals. Exercise non-JSON and executable entries, malformed UTF-8/JSON, namespace, external, absolute, nested, chained, dangling, cyclic, byte, entry and depth refusals. Verify no native source, effect, permission, target or threshold is changed. These regressions do not grant native execution standing.
