---
title: Aspect grid
sidebar_position: 4
---

# Aspect grid

> **Governed generator stub.** Site sync replaces the site copy with the
> deterministic output of `scripts/gen-aspect-grid.mjs` for the checked-out
> source tree. The generator's complete mapping input is
> `docs/theory/architecture/sensors/*.md`: it extracts each design note's H1
> `Sensor: <kind> → F<n>×T<n>` declaration and combines it with the two
> Article-5 degenerate cells encoded by the generator. It does not read a
> `cell-mapping.json`, scorecard, persisted reading, or deployment state.
>
> The result is therefore a repository-local sensor-mapping projection, not a
> current readiness verdict. Unmapped cells render `UNKNOWN`; mapped cells
> link to their sensor design notes; the two structural cells render N/A. A
> scorecard is a separate, exact-subject observation projection and is current
> only when its own subject, render, freshness, and deployment provenance
> support that claim.
