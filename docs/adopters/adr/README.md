# ADR template & authoring rules

**Authority:** Architect. See [CONVENTIONS.md](../CONVENTIONS.md) §5 for the identifier convention.

## What an ADR is

An **Architecture Decision Record** captures one durable structural decision: a choice that constrains future code, schemas, or processes, and whose _why_ is not obvious from the artifact alone. ADRs are write-once: once accepted, never edited; superseded by a new ADR if reversed.

ADRs live at `law/adr/` in each adopting repo. One ADR per decision.

## ID format

`ADR-<SCOPE>-<NNNN>`:

- `SCOPE` — short capitalized tag identifying the area: `FE-CONTRACTS`, `BACKEND-AUTH`, `INTEGRATION-ADAPTER`, `GOV`, `DB`. Choose narrowly — `BE` is too broad; `BE-SESSIONS` is right.
- `NNNN` — zero-padded 4-digit sequence within the scope. Independent counters per scope.
- Examples: `ADR-FE-CONTRACTS-0001`, `ADR-BACKEND-AUTH-0003`, `ADR-DB-MIGRATIONS-0001`.

Filename: `ADR-<SCOPE>-<NNNN>-<lowercase-kebab-slug>.md`. e.g. `ADR-FE-CONTRACTS-0001-frontend-completeness-contract-pins.md`.

## Required sections

Every ADR contains, in order:

1. **YAML front matter** (optional but recommended): `adr_id`, `title`, `status`, `date`, `authors`, `tags`.
2. **Title heading** — `# ADR-<SCOPE>-<NNNN> — <title>`.
3. **Authority** — which role authored (typically Architect).
4. **Status** — `Proposed`, `Accepted YYYY-MM-DD`, `Rejected YYYY-MM-DD`, or `Superseded by ADR-... YYYY-MM-DD`.
5. **Context** — what situation produced the need for this decision. Cite the surfacing artifact (ticket, audit report, scorecard cell).
6. **Decision** — the choice, stated affirmatively. "We will X" / "X is the canonical form". One paragraph if possible.
7. **Consequences** — what falls out: invariants that emerge, future work that gets unblocked, downsides, debt accepted.
8. **Alternatives considered** — what else was on the table and why it lost.
9. **References** — links to relevant invariants, contracts, and decisions.

Use [`TEMPLATE.md`](./TEMPLATE.md) verbatim as the starting point.

## Status lifecycle

```
                            ┌─→ Accepted YYYY-MM-DD ─→ (eventually) Superseded by ADR-... YYYY-MM-DD
Proposed (draft, in review) ┤
                            └─→ Rejected YYYY-MM-DD
```

- `Proposed` is the only status for which an ADR may still be edited. Once `Accepted` or `Rejected`, the body is immutable.
- A `Superseded` ADR keeps its body intact and adds a one-line note at the top pointing forward.
- Never delete an ADR. Even rejected ADRs are archive: the _why we didn't_ is as load-bearing as the _why we did_.

## One ADR per decision

If a single change touches three orthogonal decisions, ship three ADRs. If one decision needs three sub-clauses, that's still one ADR. The rule of thumb: each ADR should be supersedable on its own.

## Where ADRs live

`law/adr/` in the adopting repo. Per the docs-layout canon ([`../docs-layout.md`](../docs-layout.md)), this is short-form only: not `docs/theory/architecture/decisions/`, not `decisions/`.

Maintain one current index at `law/adr/README.md`. Adopters may use the scoped ADR convention above without maintaining a separate root decision log.

## Worked example — index entry

```
## Accepted Decisions

- ADR-FE-CONTRACTS-0001 — Frontend Completeness Contract Pins
  (ADR-FE-CONTRACTS-0001-frontend-completeness-contract-pins.md)
- ADR-FE-FLOW-PUBLISH-0003 — Flow Draft and Publish Contract
  (ADR-FE-FLOW-PUBLISH-0003-draft-publish-contract.md)

## Superseded

- ADR-DB-MIGRATIONS-0001 — Single-Schema Tenancy
  (ADR-DB-MIGRATIONS-0001-single-schema-tenancy.md)
  — superseded by ADR-DB-MIGRATIONS-0007.
```

## Cross-references

- Template: [`TEMPLATE.md`](./TEMPLATE.md).
- Contracts authoring (breaking changes trigger a new ADR): [`../../docs/reference/contracts/README.md`](../../reference/contracts/README.md).
- Identifier convention: [CONVENTIONS.md](../CONVENTIONS.md) §5.
- Docs layout: [`../docs-layout.md`](../docs-layout.md).
