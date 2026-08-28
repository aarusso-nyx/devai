---
'@aarusso-nyx/devai': patch
---

Amends this repository's workflow contract to permit one optional, non-attesting
pull-request preflight lane alongside the two required RC workflows. The preflight
lane runs lint, typecheck, and the cheap local closure on an untrusted runner with
`contents: read`, no job environment, no secret access, pinned actions, and no
artifact upload; a new mechanical contract rejects any preflight workflow that
reaches the attested RC closure or contains evidence-path content. Remote CI still
does not rerun the attested closure, and no preflight result produces, substitutes
for, or supplements a candidate receipt. No published action, schema, sensor, or
authority contract changes, and the RC task-policy digest is unchanged.
