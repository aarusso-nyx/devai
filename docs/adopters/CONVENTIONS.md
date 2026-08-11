# Adopter conventions

DEVAI adopters keep product contracts explicit, machine-readable, and close to the
code that consumes them.

## Repository layout

- Put durable engineering documentation under `docs/`.
- Put architecture decisions under `law/adr/`.
- Put JSON Schemas under `law/schemas/` or the adopter's documented contract
  directory.
- Put DEVAI configuration and local runtime state under `.devai/`.
- Keep generated evidence out of source directories.

An adopter may implement only the directories it needs. It should document any
project-specific layout in its own `AGENTS.md`.

## Identifiers

- Invariants use `INV-<DOMAIN>-<NNN>`.
- Architecture decisions use `ADR-<SCOPE>-<NNNN>`.
- Recipe invocations use one of the seven canonical recipe names plus an explicit
  variant.
- DEVAI commands use action IDs reported by `devai catalog actions`.

## Language

English is preferred for code-adjacent material and identifiers. User-facing
documentation may use the language of its audience. Keep each document internally
coherent.

See the [documentation layout](./docs-layout.md), [database layout](./database-layout.md),
and [language policy](./language-policy.md) for focused guidance.
