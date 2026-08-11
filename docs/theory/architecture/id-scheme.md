# ID scheme

**Authority:** Architect (Constitution Article 6, F1).

## Rule

DEVAI uses three ID shapes, chosen by the primary reader of the ID:

| Shape                     | Pattern                                | Examples                                           | Primary reader                     |
| ------------------------- | -------------------------------------- | -------------------------------------------------- | ---------------------------------- |
| Sequential human-readable | `<KIND>-<DOMAIN>-NNN` or `<KIND>-NNNN` | `INV-AUTH-001`, `TASK-0042`, `RGR-0007`, `JNY-001` | Human (logs, PRs, conversations)   |
| Date-stamped              | `<KIND>-YYYYMMDDTHHmmss-NNN`           | `SC-20260511T143022-001`                           | Human (chronological audit)        |
| Content-hash              | `<KIND>-<hex>`                         | `SR-a3f2b1c8…`, `EV-9d4e7a…`, `LOCK-…`             | Machine (deduplication, integrity) |

Every ID-bearing schema declares which shape it uses via its `id` field's `pattern`.

## Rationale

A uniform scheme (all-sequential, all-UUID, or all-hash) was considered and rejected:

- **All sequential** fails for entities generated in parallel by independent agents. Two agents racing to claim `EV-0009` would either need a central allocator (which serializes the agents) or collision detection (which makes IDs unstable).
- **All UUID** is unreadable in logs. `INV-AUTH-001` carries semantic weight at a glance; `7f3a2b8c-…-…` does not. For artifacts humans cite in PRs, conversations, and ADRs, this readability matters.
- **All content-hash** is collision-resistant and parallel-safe but loses any sense of _ordering_ and is just as unreadable as UUIDs.

The hybrid scheme matches each entity to its primary reader:

- **Architect-authored specs** (`INV-*`, `JNY-*`, ADRs) get sequential domain-prefixed IDs because they're cited by humans constantly.
- **Periodic snapshots** (scorecards) get date-stamped IDs because their primary axis is "when."
- **Machine-emitted evidence** (sensor readings, evidence chain entries, locks) get content-hash IDs because they're produced in parallel and never cited in human prose.

## Practical consequences

1. **Pattern enforcement at the schema layer.** Each schema's `id` field carries a `pattern` (JSON Schema regex). Examples:
   - `invariant.schema.json`: `^INV-[A-Z]+-[0-9]{3}$`
   - `task.schema.json`: `^TASK-[0-9]{4}$`
   - `evidence.schema.json`: `^EV-[0-9a-f]{40}$`

2. **Sequential ID allocation is per-domain, per-kind.** The next `INV-AUTH-NNN` is computed from the highest existing `INV-AUTH-*`. The allocator is not centralized; each authoring tool reads its directory and computes the next.

3. **Content-hash IDs are deterministic.** Two agents emitting the same sensor reading produce the same `SR-<hash>` — which is what makes the evidence chain's append-or-noop semantics work.

4. **Date-stamped IDs include seconds + sequence number.** Two scorecards emitted in the same second get distinct `-001`, `-002` suffixes. The sequence number resets per-second, not per-day.

5. **IDs are immutable once assigned.** Renaming an `INV-AUTH-001` to `INV-SEC-001` is not "fixing the ID"; it is "creating a new invariant and superseding the prior one." The trace and evidence chain track the supersession explicitly.

## When to revisit

Revisit the scheme if:

- The collision-resistance assumptions for content-hash IDs degrade (e.g., a hash truncation change that increases collision probability for the entity volumes DEVAI now handles).
- Sequential allocation under parallel agent execution becomes a real bottleneck (it has not, since the per-domain partitioning keeps contention low).
- A new entity kind does not fit any of the three shapes. Document the choice before adding a fourth shape.
