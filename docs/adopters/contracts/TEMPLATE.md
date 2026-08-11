# <Contract Name>

**Authority:** Architect.
**Stability:** experimental | stable | deprecated.
**Schema:** `<name>.schema.json` | `openapi.json` | inline below. Replace with a real link target when authoring.

## Purpose

<!--
One paragraph. What shape does this contract pin, and why a contract rather
than a per-caller convention? Cite the surfacing pain — duplicate
implementations, drift between services, audit requirement — that justified
publishing the shape.
-->

## Producer

<!--
The single source that writes / serves this contract. Name the package, CLI,
service, or repo. If "everyone", the contract is wrong — re-scope until you
can name one producer.
-->

## Consumers

<!--
List concretely. SDKs, services, sensors, reporters. If a consumer is
hypothetical ("future apps"), don't include it.
-->

## Schema

<!--
Either link to a sibling schema file:

  See `<name>.schema.json` (replace placeholder with real path).

…or inline a small contract:

  ```jsonc
  {
    "schemaVersion": "1.0.0",
    "field": "value",
    ...
  }
  ```

For HTTP contracts, document the route surface as a table:

  | Method | Path | Auth | Behavior |
  |--------|------|------|----------|
  | GET    | /resource | <permission> | <one-liner> |
-->

## Compatibility rules

<!--
What changes are non-breaking, what requires a new version.

For `stable` contracts, the default rules from `docs/adopters/contracts/README.md`
apply unless overridden here. State overrides explicitly.

For `experimental`, name the cut-off date / event after which the contract
will be promoted to `stable` and the compat rules become binding.
-->

## Examples

### Happy path

```json
{
  ...
}
```

### Edge case

```json
{
  ...
}
```

### Error case

```json
{
  ...
}
```

## Change log

- `v1` — YYYY-MM-DD — Initial publication.

<!--
- `v1.1` — YYYY-MM-DD — Added optional `<field>`.
- `v2` — YYYY-MM-DD — Breaking: renamed `<old>` → `<new>`. See ADR-<scope>-<nnnn>.
-->

## References

<!--
- Related ADRs: `../../meta/adr/ADR-<SCOPE>-<NNNN>-<slug>.md` (replace with real link).
- Related or replaced contracts
- External standards (RFC, ISO, ecosystem conventions)
-->
