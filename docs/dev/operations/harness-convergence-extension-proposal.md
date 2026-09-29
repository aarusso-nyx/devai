# Harness convergence extension proposal

Status: proposed. Drafted 2026-09-29 for Architect review. Nothing here binds
until the records are accepted, and no campaign file has been edited. It
extends CMP-0003 (harness convergence) with the five issues that opened on
2026-09-29 and match no round in CMP-0003 or CMP-0004:

| Issue | Title                                                                 |
| ----- | --------------------------------------------------------------------- |
| #184  | Reconcile sweep sensor kinds with the packaged SensorReading schema   |
| #185  | Publish the unified scorecard readings fix with a packed-adopter test |
| #175  | `round status` rejects sealed rounds with `TASK_ROUND_INACTIVE`       |
| #187  | Classify check member applicability in adopters                       |
| #186  | Support governed multi-stack path authority for adopter repositories  |

All five come from the DETRAN adopter (R-0020, CTG-0004 and CTG-0005). #184
and #185 block DETRAN CTG-0004 today, so they set the order.

## Checked against this checkout

- #184 holds. `decision_record_integrity`, `decision_citation_resolution`,
  `archive_immutability`, and `round_record_integrity` each appear in
  `law/policy/sensor-registry.json` and in none of
  `law/schemas/sensor-reading.schema.json`.
- #185 holds. Commit `268bb838` (the scorecard input resolver) is on main and
  `packages/cli/src/commands/audit/scorecard.ts` documents the
  `.devai/state/sensor-readings` store. Whether the published v1.6.0 lacks it
  is taken from the issue and not re-verified here.
- #187 holds. `packages/cli/src/commands/check/adapters-reports.ts:114` sets
  `scope: 'self'` unconditionally.
- #175 is plausible but not reproduced. `round/workflow.ts` calls
  `governedRoundStatus` and then `roundTaskStatus` (lines 331 and 338). Reproduce
  on a sealed fixture before writing the ADR.
- #186 is a design request. The current schema and Article 6 grammar were not
  re-read for this draft.

## Placement

Two of the five extend a campaign that is already planned, and the rest need
new decisions.

| Issue | Home                                                      | Why                                                                                             |
| ----- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| #184  | New round R-0308 in CMP-0003, first                       | A schema fix with no design question, and it blocks an adopter.                                 |
| #185  | R-0308, after #184                                        | A release gate, not a code change. It cannot be verified before #184 lands.                     |
| #175  | R-0308, independent wave                                  | A small handler fix. It overlaps ADR-EVI-0001 in CMP-0004 (closure index) but does not need it. |
| #187  | R-0309 in CMP-0003                                        | A check contract change (applicability is a new result class). Extends ADR-CHK-0003.            |
| #186  | R-0310 in CMP-0003, last, or a separate proposed campaign | Needs a constitutional or schema change and DETRAN adoption steps. Largest and least urgent.    |

Recommendation: add R-0308 and R-0309 to CMP-0003 and decide #186 separately.
CMP-0003 is already seven rounds, and #186 may need a versioned Article 6
change that deserves its own review.

## Decision records

### ADR-SCR-0011: sweep kinds admitted by the packaged schema (#184)

- The kind enum in `sensor-reading.schema.json` admits the four kinds. The
  schema stays closed and every other required field is unchanged. The four
  are diagnostic kinds with no scorecard cell mapping, so admitting them
  produces no cell PASS.
- A source-level invariant test asserts that every selectable registry kind,
  and in particular every `read` kind in the `sweep` preset, is accepted by
  the packaged schema. If a registry entry is intentionally unsupported, the
  registry or preset must say so and fail before a run, not emit an invalid
  reading.
- Each of the four kinds gets an emission-and-validation test through real
  `sense run` output and the same installed JSON Schema boundary an adopter
  uses. A negative test proves an unknown kind still fails and that a failed or
  skipped sensor cannot be promoted to PASS.
- The packed tarball is tested, not only source: extract it, compare registry,
  preset, and schema, and validate all 49 sweep read-kind readings. No effectful
  kind may appear in the read-only sweep.
- Open question for the Architect: the issue counts five schema-minus-registry
  legacy values. Retire them here or leave them, since removal could break old
  readings.

### ADR-REL-0033: scorecard store fix publication proof (#185)

- A new immutable version carries the #184 schema fix and `268bb838`. v1.6.0 is
  not republished.
- The packed-adopter regression runs in a disposable fixture: `sense run`, then
  `sense record --write`, then `audit scorecard --at <HEAD>` twice, with
  identical output and the cell consuming the persisted reading. No copy or
  symlink into `record/proofs/freshness/readings` may be needed.
- The same resolver serves every scorecard consumer and the N/A ledger applies
  uniformly. An empty store stays UNKNOWN. Invalid JSON or an invalid
  SensorReading never counts as PASS. Exact-HEAD enforcement and latest-per-kind
  selection are unchanged.
- Not this record's job: the observation-store design in #160, which R-0402 in
  CMP-0004 covers. State the boundary in the record so the two do not diverge.
- The release itself, the tag and the publication, is an Owner effect.

### ADR-CHK-0005: member applicability in adopters (#187)

- Each `check` member declares its applicability: `self` (framework only),
  `adopter`, or `both`. The declaration is part of the member's contract.
- For a self-only member run in an adopter, the result is a structured
  `not-applicable` carrying member, detected repository kind, reason, and
  evidence. It is distinct from PASS, REVIEW, and execution error in machine
  JSON, human output, aggregate status, and the CLI docs, and it is stable
  across reruns.
- Missing required adopter sources never become N/A. Malformed explicit inputs,
  policy errors, and genuine self-check failures stay failures. An invalid
  explicit path never falls back to N/A.
- `action-coverage` drops the forced `scope: 'self'` at
  `adapters-reports.ts:114`. If no substantive adopter population exists, it
  reports that explicitly instead of an empty PASS.
- `check` and `--only` classify identically, and no empty population reports
  `ok: true`.
- Open question: option A (explicit N/A) versus option B (a package-owned input
  mode). The issue allows either. Recommend A first, since DETRAN's Owner has
  already accepted explicit N/A for these three members.

### ADR-EVI-0003: sealed round lifecycle read (#175)

- `round status` returns the governed lifecycle, including `closed`, without
  requiring an active task round. The task summary is optional and never gates
  the lifecycle.
- Seal evidence stays append-only and is not touched.
- Regression test: seal a fixture round, then `round status` returns `closed`
  with exit 0.
- This is small enough to land as a fix under an existing record if the
  Architect prefers. It is listed here so it is not lost.

### ADR-AUT-0003: governed path authority for adopter repositories (#186)

Deferred as a design task. What the record must decide, from the issue:

- A versioned adopter-authored source for additive path authority. `init bind`
  or `init apply` materializes it into `authority-policy.json` with a binding
  receipt and digest. Doctor and runtime authorization verify it.
- Path classes take precedence over a blanket root grant: source and local
  README to Engineer, tests to Inspector, DDL and blueprints to Architect, and
  `docs/` to Architect. Roots are `src`, `backend`, `frontend`, `apps`,
  `mobile`, and `portal`.
- Ambiguous or overlapping grants are denied when precedence cannot be proven.
  Nothing is granted from a directory's existence alone. Invalid or removed
  rules fail closed.
- If Article 6's fixed-prefix table cannot express class precedence, that is a
  versioned constitutional and schema change, not a hand edit of a materialized
  file.
- Acceptance is real broker decisions for the matrix in the issue, byte-stable
  rebinding, and drift detection.
- Dependencies: ADR-CFG-0002 (owned projection, R-0302) defines how bound
  blocks are owned and retired, so this record should follow R-0302.

## Proposed rounds

| Round  | Title                                            | Records                                  | Issues           |
| ------ | ------------------------------------------------ | ---------------------------------------- | ---------------- |
| R-0308 | Adopter unblock: schema, release, seal status    | ADR-SCR-0011, ADR-REL-0033, ADR-EVI-0003 | #184, #185, #175 |
| R-0309 | Check applicability                              | ADR-CHK-0005                             | #187             |
| R-0310 | Governed path authority (or a separate campaign) | ADR-AUT-0003                             | #186             |

Each round follows the existing three-task pattern: a documentation task, a
proof task, and an implementation task. R-0308 splits into two waves, one for
#184 and #185 (dependent) and one for #175 (independent).

## Sequencing and dependencies

- R-0308 can start as soon as R-0302 is not blocking it. It touches the sensor
  schema, the scorecard, and `round status`, none of which R-0302 changes.
  Consider running it before R-0303 to R-0307, since DETRAN is waiting.
- R-0309 follows R-0308 only if the check contract work reuses its fixtures.
- R-0310 follows R-0302.
- R-0308 overlaps CMP-0004. #184 concerns the sweep kinds that ADR-SCR-0008
  (R-0402) also reorders, so keep the schema change first and let R-0402 build
  on it. #175 overlaps ADR-EVI-0001 (R-0403): the index renderer and the seal
  membership rule do not change `round status`, but both touch `round seal`.

## Separate Owner effects

- Publish the new package version after R-0308 (ADR-REL-0033). This includes
  the tag and the immutable publication, and is not delegated.
- Repoint `DEVAI_PROCESS_CONTROL_COMMIT` after any process-script change, as the
  existing release notes require.
- Tell DETRAN when the version is published, since it still needs a governed
  pin, a clone rehearsal, CI, and real readings on its candidate HEAD.

## Non-decisions

- Whether to retire the five legacy schema-only kinds (see ADR-SCR-0011).
- Whether #186 stays in CMP-0003 or becomes its own campaign.
- The `campaign.json` edits themselves. They require the campaign schema
  (`law/schemas/campaign.schema.json`), the campaign checker, and the wave
  contract format, and are not drafted here.
