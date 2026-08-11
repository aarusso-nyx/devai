# Sensor design notes

This directory contains operational definitions for registered sensor kinds. Each `<kind>.md` file answers five questions:

1. **Property semantics.** What does the T-axis property (Article 5) mean for this substrate?
2. **Operational definition.** What does the sensor concretely measure?
3. **PASS/REVIEW/FAIL boundaries.** Threshold values + reasoning.
4. **Adopter overrides.** Which pack-config keys let adopters tune?
5. **Out of scope.** Deferred concerns and the boundary of the current reading.

Every added sensor kind should include a design note here.

The 1-page template:

```markdown
# Sensor: <kind> → <substrate>×<property>

## Property semantics

(Quote Article 5 + extend per-substrate.)

## Operational definition

(What the sensor concretely measures.)

## PASS / REVIEW / FAIL boundaries

- **PASS:** ...
- **REVIEW:** ...
- **FAIL:** ...

## Adopter overrides

(Pack config keys.)

## Out of scope

(Deferred concerns.)
```
