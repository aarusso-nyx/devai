# Documentation layout

Adopters should use the smallest `docs/` tree that makes their product contracts
easy to find. Recommended directories are:

- `docs/eng/` for engineering specifications;
- `docs/arch/` for architecture descriptions;
- `docs/adr/` or `law/adr/` for architecture decisions, according to the repository's
  declared convention;
- `docs/contracts/` for outward-facing contracts;
- `docs/ops/` for operational runbooks;
- `docs/user/` for user-facing documentation;
- `docs/security/` for threat models and controls.

Do not maintain parallel directories for the same purpose. Record project-specific
choices in the adopter's `AGENTS.md` and keep links from stable documents pointed at
other stable documents.

See [adopter conventions](./CONVENTIONS.md), [ADR authoring](./adr/README.md), and
[contract authoring](./contracts/README.md).
