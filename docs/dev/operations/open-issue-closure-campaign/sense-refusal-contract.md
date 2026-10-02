---
title: Sense selection refusal contract
---

# Sense selection refusal contract — TASK-0651

## Provisional preparation boundary

This design records the settled behavior for issue
[#252](https://github.com/aarusso-nyx/devai/issues/252). It is provisional Architect
preparation under `CMP0006-OD-EARLY-ARCH-20261002`, from accepted central source
commit `cb00b8a5ef1c0acce3bd249f660951b67ff20bd6`, tree
`88f53cf5fa46c5d42ae2a28333e70da29ad335e4`. It proves neither implementation nor
final task, wave or round acceptance. The
[execution discipline](execution-discipline.md#early-architecture-preparation)
retains every R-0605 predecessor: R-0601, R-0602, R-0603, R-0604 and R-0606.
Before Inspector or Engineer handoff, refresh this design against their exact
completed composition, reacquire the complete CTG-0651 lease, obtain distinct
Architect review, run the required validation and obtain the central downstream
permit. Release the frozen reviewed preparation lease when idle.

Only `docs/reference/cli/sense-presets.md` and this document are authored here.
TASK-0652 owns the selection/admission counterexamples; TASK-0653 owns the router
and authority-selection implementation. Their work remains pending. Later refusal
hints and missing-registry behavior belong to CTG-0652 and are outside this design.

## Owner decision and public refusal

The [Owner decision of 2026-10-01](https://github.com/aarusso-nyx/devai/issues/252#issuecomment-5940972742),
also recorded in the [decision register](decision-register.md), requires:

- The separated `sense run --preset <name>` form remains supported.
- The inline `sense run --preset=<name>` form is unsupported.
- Selection and schema admission refuse the inline form consistently with one
  public error code.

The proposed public identity is the existing `SENSE_SELECTION_INVALID`, with
class `routing-authority` and usage exit `2`. Reuse the existing structured error
and action-envelope contracts; human and JSON output convey the same code and
exit. State that inline preset syntax is unsupported and direct the caller to
`--preset <name>`. Do not present a schema repair as remediation for a syntactically
invalid selection. Internal diagnostic detail may identify the offending token;
it does not introduce a second public refusal identity.

Every inline `--preset=` token on an execution invocation invalidates the
selection, regardless of its value. This includes valid, unknown and empty names,
and an inline token combined with a positional kind or a separated preset. A
valid companion selection, `--dry-run`, `--write`, `--publish`, a role declaration
or round identity cannot admit that token. Selection invalidity must be decided
before schema membership is examined, so an unsupported schema member cannot
replace this refusal with `SENSOR_KIND_SCHEMA_UNSUPPORTED`. Do not normalize the
inline token into the supported separated form or ignore it while selecting
something else. This contract does not change help/version handling or the syntax
of other options.

## Observed split at the preparation base

The [source map](source-map.md) identifies these read-only seams:

| Seam at `cb00b8a5`                                                                                      | Observed behavior                                                                                                                                         | Required alignment                                                                                                  |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/authority/sense-selection.ts:190-208`, `resolveSenseInvocation`; `flagValue` at 30-33 | Selection reads only a separated `--preset` value. A lone inline token has neither a kind nor a preset and throws `SENSE_SELECTION_EXACTLY_ONE_REQUIRED`. | Explicitly refuse inline syntax, including mixed-selection cases, before resolving a population or authority entry. |
| `packages/cli/src/command-router.ts:104-132`, `schemaAdmissionRefusal`                                  | Admission extracts a separated value or an inline `--preset=` value and can return `SENSOR_KIND_SCHEMA_UNSUPPORTED` for an inline preset's members.       | Apply the same syntax refusal before schema admission; admission consumes only an otherwise valid selection.        |
| `packages/cli/src/command-router.ts:356-401`, selection exception mapping                               | A sense selection exception becomes public `SENSE_SELECTION_INVALID`, usage exit `2`.                                                                     | Preserve this public identity and provide remediation naming the supported separated form.                          |

This is source inspection, not an executed counterexample or Inspector evidence.
Line spans describe the frozen preparation base and must be refreshed after
composition; mutable sibling files are not evidence inputs.

## Preserve schema admission and effect authority

[ADR-SCR-0011](../../../../law/adr/ADR-SCR-0011-sweep-kinds-admitted-by-the-packaged-schema.md)
requires every selected kind to be admitted by the packaged SensorReading schema
and a named refusal before any sensor starts when a registry entry is explicitly
unsupported. It does not authorize inline selection syntax. For an otherwise
valid separated preset or positional kind, preserve the existing
`SENSOR_KIND_SCHEMA_UNSUPPORTED` refusal, selected-kind context and absence of
dispatch. Do not widen the schema, remove an unsupported marker or reinterpret
an invalid reading as a pass to resolve this issue.

The [preset policy](../../../../law/policy/sense-presets.json),
[preset schema](../../../../law/schemas/sense-presets.schema.json),
[sensor registry](../../../../law/policy/sensor-registry.json) and
[action registry](../../../../law/policy/action-registry.json) remain authoritative.
Supported selections retain exactly one kind or one named preset, canonical
membership and order, exclusions, round requirements and no implicit persistence.
Unknown separated preset names and existing invalid-selection cases continue to
refuse; existing unrelated refusal identities remain intact.

`resolveSenseSelection` (`packages/cli/src/commands/sense/facade.ts:114-189`)
resolves every member from canonical policy and registry before dispatch.
`resolvedEntry` (`packages/cli/src/authority/sense-selection.ts:141-183`) derives
the aggregate effect and capabilities and checks their agreement, mutation
targets, planner and boundary. Preserve those fail-closed checks and the action
registry's generic ceiling. Missing or invalid effect metadata must never yield
a read default, an empty successful population or a generic authority fallback.
Selection syntax cannot grant consent: local/harness effects retain required
`--write`, remote effects retain their additional `--publish` requirement, and
the canonical read-only sweep retains its round requirement and exact exclusions.
No sensor, adapter, subprocess, reading persistence or publication may occur
after a selection or schema-admission refusal.

## Required downstream counterexamples

TASK-0652 must retain the existing named-preset and authority negatives and add
evidence on the exact refreshed candidate. TASK-0653 then satisfies those tests
without broadening syntax or authority.

| Input or condition                                                                                      | Required observation                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inline valid name, unknown name or empty name                                                           | Public `SENSE_SELECTION_INVALID`, exit `2`; no dispatch or member execution.                                                                                                                                 |
| Inline preset whose member is marked schema-unsupported                                                 | The same selection refusal; schema diagnosis must not win for invalid syntax.                                                                                                                                |
| Inline token plus a valid separated preset or positional kind, with preview/consent flags               | The same selection refusal; no companion selection runs.                                                                                                                                                     |
| Separated canonical preset with complete valid inputs                                                   | Exact policy population, ordering, exclusions, aggregate/member effects and consent resolution preserved. Use bounded preview or controlled adapter seams rather than running a sweep for this syntax proof. |
| Separated unknown preset, missing selection, kind plus separated preset, invalid/missing required round | Existing fail-closed selection refusals and negative coverage retained.                                                                                                                                      |
| Valid separated preset or kind marked schema-unsupported                                                | Existing `SENSOR_KIND_SCHEMA_UNSUPPORTED` before execution; schema marker remains effective.                                                                                                                 |
| Missing effect or effect/capability/mutation-boundary inconsistency                                     | Resolution refuses before dispatch; no read default or generic fallback.                                                                                                                                     |
| JSON versus human rendering                                                                             | Same public selection refusal code and usage exit; remediation names separated syntax.                                                                                                                       |

Compare selection and admission paths, assert absence of member/adapter dispatch,
and preserve positive spaced-selection cases. A test that checks only an error
string while a member executes is insufficient. Do not weaken schema, registry,
authority, consent, round or negative-selection assertions to unify the code.

## Validation and remaining obligations

TASK-0651 declares `check --only adrs`, `check --only schemas` and
`check --only docs-links` through the exact checkout's built/bootstrap CLI.
The preparation checkout has no matching bootstrap or installed dependencies at
entry. Those commands remain **NOT RUN** until prerequisites are available from
this exact source or a separately reviewed bounded setup/build plan. The early
permit grants no production generator or runtime effect. Known schema/catalogue
and full-build failures remain unwaived; this document supplies no final PASS.

Changed-doc formatting, repository lint applicability, whitespace/path checks,
mandatory precommit, exact patch/tree identity and distinct Architect review are
recorded in the provisional checkpoint outside the governed product state.
The generated reference block in the sense-presets page remains byte-identical;
this change adds authored guidance only. CTG-0651 still requires its declared
`test:cli` gate, and R-0605 still requires its declared close checks and all later
waves on the completed cumulative candidate.
