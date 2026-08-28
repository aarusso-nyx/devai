---
'@aarusso-nyx/devai': patch
---

Align the package-owned evidence verifier with the check runner by excluding the
exact harness-mutated `.devai/state/`, `record/`, and `scratch/` prefixes from
reusable task-policy identity and affected-path classification.
