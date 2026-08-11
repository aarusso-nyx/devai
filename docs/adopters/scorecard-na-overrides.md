# Scorecard N/A overrides

Use `.devai/config/scorecard-na.json` only when a scorecard cell genuinely does not apply to an
adopter's declared substrate. Do not use it to hide a defect, unknown reading, missing test, or
stale evidence.

```json
{
  "schemaVersion": "1.0.0",
  "cells": [
    {
      "cell": "F4:T1",
      "reason": "This library exposes no route inventory by design.",
      "constitution_anchor": "Article 5"
    }
  ]
}
```

Each cell must be inside the declared grid and carry a reviewable reason. Prefer authoring a real
sensor input when that substrate exists. Validate the file against the schema installed by the
exact CLI package, and review every override as an explicit product decision.
