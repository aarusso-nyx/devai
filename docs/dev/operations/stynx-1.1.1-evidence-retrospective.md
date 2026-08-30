# STYNX 1.1.1 evidence campaign retrospective

## Incident

The STYNX 1.1.1 RC completed its 17-node graph, including a composed mutation
run, but export and remote reconstruction discovered independent incompatibilities
one at a time. The final RC execution took about 18 minutes; repeated PREPARE and
receipt-only export attempts delayed publication and consumed operator attention.

## Causes and prevention controls

| Cause | Correction and regression control | Owner and measurable completion |
| --- | --- | --- |
| Runner hashed a PATH-resolved executable while verifier omitted it. | Ordinary task keys exclude ambient executable identity; an explicit identity is validated against the executable used. | CLI owner; macOS/Linux task-key fixture is byte-identical. |
| Verifier did not understand composed mutation evidence. | Strict `mutation-composed-report-set-v1` verifier recomputes roster, census, provenance, process tuples, digests, and aggregates. | Verifier owner; 38-package 4-fresh/34-reused fixture and malformed cases pass/fail closed. |
| Export discovered absent output-parent state through `realpath` after expensive work. | Non-writing export preflight validates destination, controlled signing inputs, candidate, receipt policy, and artifacts; it returns typed failures. | Evidence owner; missing parent yields `OUTPUT_PARENT_MISSING` before signing. |
| Packaged verifier and workflow could pin different source identities. | Vendored provenance is hash-checked by package assembly, release closure, installed smoke, and workflow static validation. | Release owner; every surface names the exact same source commit. |
| Failures were sequentially masked. | Use export preflight and package/workflow static reconstruction before release-profile certification. | Adopter owner; no RC task starts when preflight is non-passing. |

## Boundaries

This correction does not reinterpret `not-required`, stale, foreign-candidate, or
integrity-invalid mutation evidence as passing. It does not silently migrate STYNX;
the 1.4.4 migration guide requires a new exact-candidate receipt and regenerated
workflow before any publication decision.
