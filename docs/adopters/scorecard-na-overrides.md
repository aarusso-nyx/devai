# Scorecard N/A overrides

The N/A ledger is the only source of N/A cells in the scorecard. The loop holds no list of
degenerate cells of its own: a cell is N/A because the ledger lists it with a written reason,
and for no other reason. The ledger is `law/policy/scorecard-na.json`, materialized
byte-for-byte at `.devai/config/scorecard-na.json` by `init bind`; the scorecard reads the
materialized copy, and `check-policy-materialization` fails when the two differ.

Use the ledger only when a scorecard cell genuinely does not apply to an adopter's declared
substrate. Do not use it to hide a defect, unknown reading, missing test, or stale evidence.

## What the adopter default ships

The adopter default (`law/policy/adopter-defaults/scorecard-na.json`) carries one entry, the
cell Constitution Article 5 names as degenerate:

```json
{
  "schemaVersion": "1.0.0",
  "cells": [
    {
      "cell": "F4:T5",
      "reason": "Inventory x Idiomaticity is the degenerate cell Article 5 names: inventory artifacts are derived deterministically from F1, F2 and F3 and never authored, so idiomaticity has no authored subject to measure.",
      "constitution_anchor": "Article 5"
    }
  ]
}
```

Inventory (F4) is derived, never authored, so idiomaticity (T5) has nothing to measure there.
Every adopter starts with 45 cells, 1 N/A, 44 scoreable.

## Adding an override

Append a cell to the ledger with its reason and, where it applies, the constitutional
article that anchors the carve-out:

```json
{
  "cell": "F4:T1",
  "reason": "This library exposes no route inventory by design.",
  "constitution_anchor": "Article 5"
}
```

Each cell must be inside the declared 5x9 grid and carry a reviewable reason of at least
eight characters; the schema and `check schemas` reject an entry outside the grid or without
a reason. Prefer authoring a real sensor input when that substrate exists. Validate the file
against the schema installed by the exact CLI package, and review every override as an
explicit product decision: removing an entry makes the cell scoreable again at the next
`audit scorecard`.

## The framework repository

DEVAI's own ledger adds F1:T1 (contract validation has no live emitter) to the default
F4:T5, so the framework repository scores 45 cells, 2 N/A, 43 scoreable. The
[scorecard theory page](../theory/framework/scorecard.md#grid-size-and-na-cells) states
the same number.
