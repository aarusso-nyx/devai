---
id: ADR-SCR-0015
title: Candidate-bound sensor instances and policy-owned task and route inputs
type: adr
status: accepted
date: 2026-10-10
authority: Architect
supersedes: []
provenance:
  - ADR-SCR-0008
  - ADR-SCR-0013
  - ADR-CFG-0002
  - ADR-AUT-0002
  - ADR-AUT-0006
  - law/schemas/sensor-inputs.schema.json
affected_rules:
  - law/schemas/adopter-policy.schema.json
  - law/schemas/sensor-inputs.schema.json
  - law/schemas/test-task-descriptor.schema.json
  - law/policy/adopter-migrations.json
  - law/policy/subprocess-effects.json
  - packages/cli/src/services/adopter-policy.ts
  - packages/cli/src/services/adopter-policy-binding.ts
  - packages/cli/src/commands/init/bind-adapters.ts
  - packages/cli/src/commands/sense/run-set.ts
  - packages/cli/src/commands/sense/reading-instance.ts
  - packages/cli/src/commands/sense/readings-rebuild.ts
  - packages/cli/src/authority/broker.ts
  - packages/sensors/src/docs-drift.ts
inspector_acceptance:
  - IA-001 -- Bind an explicit sensor_inputs block, verify source and target digests, rebind idempotently, retire it to installed defaults using prior ownership, and preserve a never-owned target when the block is absent.
  - IA-002 -- Re-record identical evidence unchanged; produce a new measurement with different timestamp, duration, metrics or findings and obtain a digest-bound instance with a verified same-candidate predecessor. Preserve every historical byte and chain prefix.
  - IA-003 -- Refuse tampered, ambiguous, wrong-kind or invalid-custody predecessors and same-ID/different-body recording. Cross-candidate selection never inherits custody or creates a cross-candidate supersession edge.
  - IA-004 -- Execute a type_check preset member through trusted resolver context; reject forged member inputs, unknown or wrong-kind task references, population mismatches, changed task policy and unadmitted subprocess effects before execution.
  - IA-005 -- Run installed CLI from omitted, dot and absolute checkout roots including spaces; direct and regenerated Angular route inventories agree, no React population is fabricated, and real absolute-path leaks remain refused.
  - IA-006 -- Accept a registered constitution entrypoint only when its declared version, pinned bytes and digest agree. Missing, malformed, mismatched or tampered bindings remain failures; no version header is fabricated in adopter prose.
---

# Candidate-bound sensing without mutable history

## Status

Accepted for the Owner-authorized DEVAI 2.4.0 minor campaign on 2026-10-10.
This amends the producer and input-binding interfaces of the cited records;
it adds no public action and does not change constitution, thresholds, verdicts,
N/A eligibility, recorder collision rejection or existing evidence bytes.
Adopter observations remain measurements, not a release promotion.

## Context

Published adopter observations exposed producer collisions despite immutable recorder
semantics, loss of member identity in preset subprocess admission, a dot-root
portability false positive, missing Angular input forwarding and valid bound
constitution entrypoints treated as versionless full constitutions. Adopters also
lacked a registered source projection for sensor inputs. These are interface and
producer defects; changing recorded evidence or verdict thresholds would conceal
them. Exact task references require explicit kind and population admission rather
than guessing the meaning of repository scripts.

## Decision

### Policy-owned inputs

The optional `sensor_inputs` block in the adopter policy is a complete document
under `sensor-inputs.schema.json`. Only the registered
`init bind --adopter-policy --write` path projects it to
`.devai/config/sensor-inputs.json`, atomically with the existing binding receipt.
The receipt binds the source and exact target digest; upgrade and doctor use the
same ownership and verification rules. There is no manual generated-config edit.

An explicit block owns the entire target. An absent block with no verified prior
ownership preserves an existing unmanaged file and omits it from the receipt.
Removing the block after verified prior ownership retires its overrides by
materializing the installed canonical sensor-input defaults, retaining the target
digest in the receipt. It does not delete the file, retain retired overrides or
invent ownership from file existence. Unchanged rebinding is byte-idempotent.
This is the optional whole-file extension of ADR-CFG-0002.

### Reading instances and custody

The legacy reading builder and first-instance ID remain unchanged. The producer
reconciles its reading before emission against validated immutable stored readings
and verified chain artifacts. Measurement equality is canonical equality of the
full reading body excluding **only** `id` and `supersedes`; timestamp and duration
remain evidence. Re-recording exactly identical evidence reuses the exact stored
body. A newly executed measurement with new provenance is a new instance.

A genuinely different measurement that collides with a legacy ID, or follows a
verified current instance for the same sensor kind and exact candidate, receives
a deterministic digest-derived instance ID bound to that candidate and body.
It supersedes only the unique verified current same-kind instance whose chain
custody names that candidate. No timestamp sorting chooses a predecessor.
Ambiguity, invalid readings, identity mismatch and chain-digest mismatch fail
closed. A different candidate never supplies a supersession predecessor.
Identical immutable bytes may be reused across candidates only through the
existing recorder's independently verified, candidate-specific chain binding;
selection cannot inherit custody from a prior candidate. Latest-reading
composition uses the requested candidate's verified population, not a global
same-kind tail. Same-ID/different-body recording remains refused, and recording
appends without rewriting historical files or any chain prefix.

### Exact task references and member admission

`type_check`, `unit_test`, `integration_test`, `e2e_test`, `perf_test`, `build`
and `migration_check` may declare `{ "taskId": "<nodeId>", "population":
"<reviewed-label>" }`. Both keys are required together and mutually exclusive
with `argv`, `cwd` and `scriptName`. Existing command modes retain their exact
admission and defaults. No root-script alias or arbitrary argv is newly admitted.

The referenced node in validated `test-tasks.json` explicitly lists the sensor
in its closed `sensorKinds` array and declares the exact matching nonempty
`outputContract.population`. Missing annotation, unknown node, wrong kind or
population mismatch is refused. Node IDs and command names do not imply a kind.
The reference names an executable task, never a probe-only `preflight-v1` node.
The reference is bound to the exact descriptor/task-policy digest and preserves
its argv, cwd, runner, dependency requirements, input selectors, toolchain and
allowlisted environment identities. Existing task admission and effect controls
remain mandatory. Every taskId-bound member is at least local-write with
`fs:workspace` and `proc:declared-sensor-task`, requiring explicit `--write`;
`migration_check` additionally retains `db:write`. A read preset containing such
a member is refused; write-capable members are run separately. No remote-write
authority is inferred from a task declaration.
Changes between validation and execution fail closed. Dependency closure binds
prerequisite identities, but does not execute them implicitly: required prior
completion must be verified for this candidate, policy and environment or the
measurement refuses. Only the selected node is measured. A cached result cannot
replace actual execution when producing a new measurement.

Preset execution supplies the resolved member kind through internal scoped
context. Neither user argv, sensor input nor caller-created data can impersonate
that context. Broker admission uses that exact member and exact task identity,
with the same checks as single-member execution. This fixes preset context loss
without widening subprocess mirrors or public action authority.

The reading states task identity, policy/descriptor identity and population
alongside actual execution results. A population label or zero exit code is not
coverage evidence. Test counts, performance metrics and coverage must come from
actual validated results; absent, malformed or truncated evidence keeps the
existing unknown/review/error outcome and cannot become fabricated PASS or 100%.
An output contract the selected sensor cannot parse is refused explicitly before
execution; task annotation does not invent a parser or silently substitute one.
This release supports an omitted `outputContract.kind` for the sensor's ordinary
parser, or the explicit kinds `command-result`, `vitest` and `workspace-build`.
It does not support `generated_namespaces` protected output-census contracts
through sensing. Probe-only, mutation-testing and other output contracts are
refused before execution; they cannot gain another execution path by annotation.
Actual stdout/stderr still has to satisfy the selected sensor's parser and
population contract, independently of its declared kind.
The `declared-sensor-task` subprocess template describes only this internally
verified binding. Its executable marker is not an executable name or a public
argv pattern; the broker matches the concrete executable bytes, argv, working
directory, member, candidate and policy identities. It adds no generic fallback.

### Root, routes and documentation binding

Resolve the physical repository root once before sensing or regeneration. The
omitted root and `.` are equivalent to the same absolute checkout, including a
checkout containing spaces. Portability guards compare actual checkout paths;
the literal `.` in portable `sourceRepo` is not an absolute-path leak. Actual
absolute paths, out-of-root paths, untracked or invalid inventory sources remain
refused, and inventory regeneration remains staged and atomic.

`inventory_routes` accepts `framework: "angular" | "react"` and `scanDirs`
containing safe repository-relative paths. Both direct sensing and inventory
regeneration forward the same effective inputs and surfaces. Omission keeps the
existing React default. An Angular application declares Angular and measures its
real route declarations; an empty or unsupported population is not a React PASS.

Docs drift recognizes the registered adopter constitution entrypoint and its
project binding. For that form it verifies the pinned file's SHA-256, declared
binding version and parsed pinned constitution version, and verifies the
entrypoint is the registered form. A malformed or unrecognized entrypoint, absent
binding, wrong version or tampered pin fails closed. Repositories carrying the
full constitution keep the existing direct version comparison. Neither a copied
version header nor a waived drift check replaces a valid binding.

The registered `law/constitution.md` entrypoint is exactly this document shape,
after CRLF-to-LF normalization and with zero or one terminal LF:

```markdown
# <label> constitution binding

The DEVAI Constitution bound to this repository is the immutable vendored copy
at [`.devai/pin/constitution.md`](../.devai/pin/constitution.md). Its version
and SHA-256 digest are pinned in `.devai/config/project.json` by
`devai init bind --constitution --write`.

This file is the Architect-owned reading-order entrypoint. It does not restate
or override the pinned Constitution.
```

The display-only label has 1–80 Unicode letters or numbers, ASCII spaces, dots,
underscores or hyphens, without a leading or trailing space. The remainder is
fixed, including its links and paragraph boundaries. Extra prose, frontmatter,
competing links and substring matches are not registered. The pin and project
configuration must be regular files contained within the repository; the digest
is over the raw pinned bytes, not normalized text. The existing bootstrap
`.devai/constitution.md` pointer and its producer remain unchanged; this law
entrypoint is the Architect-authored reading-order form.

## Consequences

Adopters edit law-owned policy and reviewed task descriptors, then use the pinned
CLI binding. All optional modes remain opt-in. Regression coverage must exercise
installed-package execution, candidate transitions, custody tampering, exact
population/kind mismatches, effect admission and no-write/read-only guarantees.
The campaign must independently measure its target cells after adoption; this
record guarantees no scorecard result and does not alter historical observations.

## Alternatives Considered

Timestamp-based IDs for every reading remain rejected: unchanged exact evidence
must remain idempotent. Ignoring timestamp or duration during reconciliation is
also rejected because it discards measurement provenance. Overwriting collided
readings, picking a predecessor by filesystem order, accepting caller-supplied
member authority, admitting arbitrary package scripts, or relaxing the absolute
path guard would each weaken a current boundary. Manual config repair and copied
constitution version headers would hide the missing binding interface.

## Affected Rules

The schema, policy projection, ownership receipt, sense producer, broker,
inventory regeneration and docs-drift paths named in frontmatter implement this
record. The public action registry, recorder collision contract, constitution pin,
existing subprocess argv modes and scorecard thresholds remain in force.

## Inspector Adversarial Acceptance

Discharge IA-001 through IA-006 with positive and hostile fixtures, including
installed package paths containing spaces, repeated recording versus freshly
executed measurements, candidate-specific custody, exact task/population/kind
binding, tampered constitution bytes and real Angular declarations. Existing
assertions and historical records must survive unchanged. Missing measurements
remain visible rather than being filled by declared intent.
