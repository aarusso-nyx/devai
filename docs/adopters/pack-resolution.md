# Stack-pack inventory

Stack-adapter packs provide declared detection signals and extractor settings for a
repository stack. Pack matching is an inventory slice, not an adoption mutation:

```bash
devai sense inventory \
  --slice pack \
  --repo-root . \
  --adopter-root . \
  --format json
```

Read the selected pack, confidence, and unresolved signals. Ambiguity remains visible;
DEVAI does not silently choose a universal parser or rewrite the adopter from this
observation. Apply configuration only through a separately reviewed `init` plan.

## Packed-adopter publication proof

A version that changes the readings store, the scorecard resolver, or the sensor schema is
proven from the packed artifact before it is published
([ADR-REL-0033](../../law/adr/ADR-REL-0033-scorecard-store-publication-proof.md)). Source tests
proved the route once while the published package still read another store (#185), so the proof
executes the same bytes an adopter installs. The rehearsal, `scripts/rehearse-packed-adopter.mjs`
exposed as `pnpm run release:packed-adopter`, packs the candidate through the `npm-pack-output`
guard, extracts the tarball into a disposable adopter fixture, and runs, from the package:

1. `sense run <kind>` for one read kind, producing a schema-valid reading;
2. `sense record --write`, persisting it under `.devai/state/sensor-readings/<kind>/<id>.json`;
3. `audit scorecard --repo-root . --at <HEAD>` twice, `<HEAD>` being the fixture's exact
   40-character head.

It passes only when every condition below holds; each failure exits non-zero with its named code
and the proof never edits a threshold, a reading, or an override to reach a pass.

| Condition                                                                                                                                                                                          | Failure code                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| The pack output describes exactly the candidate and the tarball extracts.                                                                                                                          | `RELEASE_PACK_OUTPUT_INVALID`                     |
| The packed `law/policy/sensor-registry.json`, `law/policy/sense-presets.json`, and `law/schemas/sensor-reading.schema.json` are byte-identical to source.                                          | `RELEASE_PACKED_ADOPTER_ARTIFACT_DIVERGED:<path>` |
| Every `sweep` read-kind reading validates against the packed schema.                                                                                                                               | `RELEASE_PACKED_ADOPTER_READING_INVALID:<kind>`   |
| No member of the packed `sweep` preset declares an effect other than `read`.                                                                                                                       | `RELEASE_PACKED_ADOPTER_SWEEP_EFFECT:<kind>`      |
| The two `audit scorecard` outputs are byte-identical.                                                                                                                                              | `RELEASE_PACKED_ADOPTER_ROUTE_DIVERGED`           |
| The cell bound to the recorded kind consumed the persisted reading from `.devai/state/sensor-readings`.                                                                                            | `RELEASE_PACKED_ADOPTER_READING_NOT_CONSUMED`     |
| No copy or symlink into `record/proofs/freshness/readings` exists in the fixture after the run.                                                                                                    | `RELEASE_PACKED_ADOPTER_LEGACY_STORE_PRESENT`     |
| With the store emptied the cell reads `UNKNOWN`.                                                                                                                                                   | `RELEASE_PACKED_ADOPTER_EMPTY_STORE_NOT_UNKNOWN`  |
| A file of invalid JSON in the store is rejected by the command with `SCORECARD_READING_UNPARSEABLE:<path>` and never counts as `PASS`.                                                             | `RELEASE_PACKED_ADOPTER_INVALID_READING_ACCEPTED` |
| A schema-invalid reading in the store is rejected with `SCORECARD_READING_INVALID:<path>` and never counts as `PASS`.                                                                              | `RELEASE_PACKED_ADOPTER_INVALID_READING_ACCEPTED` |
| `--at` set to anything but the exact 40-character `HEAD` is refused with `AUDIT_SCORECARD_EXACT_HEAD_REQUIRED`.                                                                                    | `RELEASE_PACKED_ADOPTER_HEAD_NOT_ENFORCED`        |
| With two readings of one kind the later one is selected on both runs; a reading older than `freshness.scorecard_failure_max_age_hours` in `law/policy/thresholds.json` reads stale and not `PASS`. | `RELEASE_PACKED_ADOPTER_SELECTION_DIVERGED`       |

The rehearsal reads only the packed artifact and the fixture it creates, performs no push, tag,
publish, or network write, and completes without network access. It is a release gate: the
Owner publishes only after the rehearsal passed on the exact artifact to be published, and a
published version is never republished under its number. The store the proof exercises is the
one every scorecard consumer resolves through the loop input resolver (see
[One readings store](../theory/framework/scorecard.md#one-readings-store)); the proof proves the
package, not the adopter's own measurement, which stays on the adopter's candidate head.
