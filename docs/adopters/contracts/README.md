# Contracts — authoring rules

**Authority:** Architect. See [CONVENTIONS.md](../CONVENTIONS.md) for the adopter documentation conventions.

## What a contract is

A **contract** is the stable shape one part of the system exposes to other parts that mustn't depend on implementation internals. Three flavors:

- **API contracts** — HTTP/AsyncAPI/RPC route families. Producer is a service; consumers are SDKs and other services.
- **Data contracts** — JSON Schemas defining the on-wire / on-disk shape of an object that flows across team boundaries.
- **DDL contracts** — SQL DDL that downstream tools (replication, BI, other apps) compile against.

Contracts live at `docs/reference/contracts/` in each adopting repo. Per the docs-layout canon ([`../docs-layout.md`](../docs-layout.md)), `docs/reference/contracts/` is short-form only and is distinct from `law/schemas/` (internal request/response shapes).

## Per-contract file structure

Every contract file under `docs/reference/contracts/` contains, in order:

1. **Title** — `# <Contract Name>`.
2. **Authority** — which role issued (Architect, almost always).
3. **Stability** — one of `experimental`, `stable`, `deprecated`.
4. **Purpose** — one paragraph: what shape this contract pins, why a contract rather than a per-caller convention.
5. **Producer** — who writes / serves this contract. One service, one CLI, one repo.
6. **Consumers** — who reads. List concretely.
7. **Schema** — either inline (small contracts) or a link to `*.schema.json` / `openapi.json` / `asyncapi.yaml` in the same directory.
8. **Compatibility rules** — what changes are non-breaking, what changes require a new version.
9. **Examples** — at least one worked example. Three is better (happy path, edge case, error case).
10. **Change log** — append-only list of revisions: `vN — YYYY-MM-DD — summary`. Pre-stable changes use date-only markers.

Use [`TEMPLATE.md`](./TEMPLATE.md) verbatim as the starting point.

## Schema transports

| Transport               | When to use                                     | Filename pattern                                             |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| **JSON Schema 2020-12** | data contracts, config files, on-disk artifacts | `<name>.schema.json`                                         |
| **OpenAPI 3.1**         | HTTP API contracts                              | `openapi.json` (one per service) or `<service>.openapi.json` |
| **AsyncAPI 2.6**        | event-driven / pubsub contracts                 | `<topic>.asyncapi.yaml`                                      |
| **SQL DDL**             | database surface contracts                      | `ddl/<nn>-<name>.sql` (per the database-layout canon)        |

Pick the one that matches the wire format; do not author two transports for the same contract. If a contract carries both HTTP and an underlying data shape, ship the OpenAPI and have it `$ref` the JSON Schema for the body.

## Stability levels

| Level          | Compatibility commitment   | What can change                                         |
| -------------- | -------------------------- | ------------------------------------------------------- |
| `experimental` | none                       | any shape change permitted; readers MUST pin a version. |
| `stable`       | semver-style additive only | add fields, add enum values; never remove or rename.    |
| `deprecated`   | scheduled for removal      | no changes; consumers migrate to the named replacement. |

## Breaking changes require a new contract version + ADR

A breaking change is any of:

- removing a field, route, or schema;
- renaming a field, route, schema, or enum value;
- tightening a constraint (adding a `required` field, narrowing a `oneOf`, lowering a `maxItems`);
- changing the meaning of a field while keeping its name.

To ship a breaking change:

1. Open an ADR per [`../../meta/adr/README.md`](../../../law/adr/README.md) recording the _why_.
2. Ship a new contract file `<name>-v2.md` + `<name>-v2.schema.json`. Old version stays.
3. Mark the old contract `deprecated` and link to the replacement.
4. Bump consumers in a deliberate sequence.
5. Eventually delete the old contract — but only after all consumers have migrated.

A `schemaVersion` field inside a JSON Schema serves the same role at the data layer; bump it on any change a strict reader would reject.

## Worked stability / compatibility matrix

| Change                          | `experimental` | `stable`                              | Notes                         |
| ------------------------------- | -------------- | ------------------------------------- | ----------------------------- |
| Add optional field              | OK             | OK                                    | additive, always non-breaking |
| Add enum value                  | OK             | OK if all consumers tolerate unknowns | otherwise breaking            |
| Add `required` field            | OK             | breaking                              | tightens reader contract      |
| Rename field                    | OK             | breaking                              | ship `v2`                     |
| Remove field                    | OK             | breaking                              | ship `v2`, deprecate v1       |
| Change type (string → number)   | OK             | breaking                              | always                        |
| Loosen `pattern` regex          | OK             | OK                                    | wider acceptance              |
| Tighten `pattern` regex         | OK             | breaking                              | narrower acceptance           |
| Add HTTP route                  | OK             | OK                                    | additive                      |
| Add response field              | OK             | OK                                    | additive                      |
| Add request body required field | OK             | breaking                              | tightens producer requirement |

## Index pattern

Every `docs/reference/contracts/README.md` lists its contracts in an index. Sample:

```
## Contracts

| Contract     | Transport   | Stability    | Producer            |
|--------------|-------------|--------------|---------------------|
| test-result  | JSON Schema | experimental | `devai evidence record --kind test` |
| thresholds   | JSON Schema | stable       | adopter-owned       |
| audit-events | OpenAPI     | stable       | platform-audit      |
```

## Cross-references

- Template: [`TEMPLATE.md`](./TEMPLATE.md).
- ADR template (breaking changes): [`../../meta/adr/README.md`](../../../law/adr/README.md).
- Docs layout: [`../docs-layout.md`](../docs-layout.md).
- Database DDL conventions: [`../database-layout.md`](../database-layout.md).
- DEVAI's current contracts: [`../../docs/reference/contracts/`](../../reference/contracts).
