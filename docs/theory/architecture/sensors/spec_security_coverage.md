# Sensor: `spec_security_coverage` → F1×T6

## Property semantics

**T6 Security and Privacy** (Constitution Article 5): "the artifact addresses confidentiality, integrity, availability, and privacy at a level appropriate to its responsibilities." For F1 (Spec), this means the authored spec substrate documents the three load-bearing security/privacy concerns:

1. **A written threat model.** Some `docs/dev/security/threat-model*.md` or equivalent under `docs/dev/security/`.
2. **A PII registry.** Adopters using the `pii_map` pattern declare PII fields explicitly; presence of at least one such migration row.
3. **An RBAC invariant.** At least one invariant of `domain: 'RBAC'` (or an equivalent governance-coded role/permission invariant).

## Operational definition

Three presence checks against the repo root:

- **Threat model present?** Any file under `docs/dev/security/` matching `threat-model*.md` (case-insensitive).
- **PII registry populated?** Greps `migrations/` (or pack-configured) for `INSERT INTO core.pii_map` (configurable table name). This presence-only sensor checks that the registry exists; it does not judge extraction quality.
- **RBAC invariant present?** Walks `law/invariants/*.json` and checks `domain === 'RBAC'`.

The three are reported in `metrics`; the SR `findings` cite each absent signal explicitly.

## PASS / REVIEW / FAIL boundaries

- **PASS:** all three signals present.
- **REVIEW:** 1-2 signals present (partial security/privacy spec coverage).
- **FAIL:** zero signals present (security/privacy concerns are entirely unaddressed in the spec substrate).

## Adopter overrides

- `extractor_params.spec_security_coverage.threat_model_globs: string[]` — override the threat-model file globs. Default `['docs/dev/security/threat-model*.md']`.
- `extractor_params.spec_security_coverage.pii_registry_table: string` — override the PII registry table name. Default `'core.pii_map'`.
- `extractor_params.spec_security_coverage.pii_migrations_globs: string[]` — override migration scan paths. Default `['migrations/**/*.sql', '**/migrations/**/*.sql']`.

## Out of scope

- **Threat-model quality.** The sensor checks _presence_, not _content_. An LLM-judge variant could grade the threat-model's coverage of STRIDE/LINDDUN — deferred to a future `spec_security_coverage_judge` kind.
- **PII completeness.** Whether every PII column is registered is an F4 concern covered by `inventory_adherence`.
- **Authorization correctness.** Whether RBAC invariants are enforced is an F3 concern covered by `test_security_coverage`.
