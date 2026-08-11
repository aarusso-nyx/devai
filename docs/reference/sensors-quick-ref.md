# Sensors quick reference

The canonical registry contains 59 sensor kinds. Each kind declares its emitter, intrinsic
effect, scorecard cells or diagnostic standing, and eligible tiers. The canonical source is
[`law/policy/sensor-registry.json`](../../law/policy/sensor-registry.json); the generated
[sensor-kind catalog](./cli/sensor-kinds.md) provides per-kind operator detail.

## Families

| Standing                 | Kinds |
| ------------------------ | ----: |
| Specification (`F1`)     |     9 |
| Plant (`F2`)             |     9 |
| Tests/observation (`F3`) |    11 |
| Inventory (`F4`)         |    11 |
| Harness (`F5`)           |    10 |
| Diagnostic-only          |     9 |

Run one exact kind through the single `sense run` action:

```bash
devai sense run type_check --repo-root . --dry-run --format json
```

Sensor execution and persistence are separate. To retain an emitted reading, capture the exact
JSON artifact and authorize `sense record`:

```bash
devai sense run type_check --repo-root . --format json > /tmp/type-check-reading.json
devai sense record --input /tmp/type-check-reading.json \
  --as-role inspector --write --format json
```

An unknown kind or preset remains UNKNOWN; DEVAI does not substitute another identifier,
default, or nearby match. A reading is evidence only for its exact subject, inputs, and freshness
bound.
