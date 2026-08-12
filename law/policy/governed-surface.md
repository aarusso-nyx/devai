---
id: GOVERNED-SURFACE-POLICY
title: Governed action and package surface
type: policy
status: active
date: 2026-07-26
authority: Architect
---

# Governed action and package surface

## Action identity

`law/policy/action-registry.json` is the sole authority for current action paths,
handlers, status, effect, profiles, and authority contracts. The v1.0 catalog is a
current-state list: it contains no compatibility aliases or historical dispositions.

The CLI, effects checker, sensors, generated documentation, and contract tests consume
byte-stable generated views of that registry. Generators compare UTF-8 bytes and do not
use host locale ordering. Generated files carry their canonical-source marker.

## Output and authority

Catalog and help output describe registered authority; they do not grant it. A write
action remains fail-closed until its authority contract, role, consent, and boundary
checks succeed. JSON output is the machine contract. Human output is a projection and
must not introduce an action, effect, or lifecycle absent from the registry.

## Sensor standing

Every live sensor kind resolves a current design note under
`law/policy/sensor-notes/`. The nine diagnostic-only kinds remain diagnostic and the
fifty cell-bound kinds retain their measured bindings. Notes document standing; they
grant no filesystem, database, network, release, or publication authority.

## Package topology

The release group contains exactly one package: `@aarusso-nyx/devai`. All implementation
packages are private build inputs and are not independently publishable.

## Root process and workflow boundary

Root `build` and `test` invoke their supported porcelain routes with fixed argv. They
accept no caller-supplied command string and do not recursively invoke themselves.
Required tool absence fails closed. CI pins third-party actions to immutable 40-hex
commits with readable major-version annotations and prewarms every install job.

Publication, deployment, tagging, release creation, Pages mutation, and external-project
writes require their own explicit action authority and consent.
