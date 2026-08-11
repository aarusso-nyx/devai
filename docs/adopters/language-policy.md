# Language policy — adopter guide

**Authority:** Architect, issued cross-repo via [CONVENTIONS.md](./CONVENTIONS.md) §3 (2026-05-22).

## Rules

- **English is preferred** for all engineering, architecture, ADRs, contracts, schemas, ops runbooks, and code-adjacent docs.
- **Portuguese (pt-BR) is accepted**, especially for user-facing materials and DETRAN / gov-br references where the local audience is the source of truth.
- **Mixed languages within a single file** are allowed only when a quoted reference (statute, regulation, screen label, user prompt) is intrinsically Portuguese.
- **Identifiers** — file paths, slugs, schema keys, code symbols — MUST be English. No `docs/operacoes/` or `database/migrations/criar_tabela_usuarios.sql`.
- **Coherency** within a document: don't switch languages mid-section without quoted context.

## Where each language fits

| Surface                                                                                                                                                      | English    | Portuguese                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | --------------------------------- |
| `docs/eng/`, `docs/theory/architecture/`, `law/adr/`, `docs/reference/contracts/`, `law/schemas/`, `docs/dev/operations/`, `docs/dev/security/`, `docs/gov/` | preferred  | only for quoted gov-br references |
| `docs/user/` (personas, training, demo, release notes)                                                                                                       | acceptable | preferred when audience is pt-BR  |
| Code, schemas, identifiers                                                                                                                                   | required   | not permitted                     |
| Commit messages, PR descriptions                                                                                                                             | required   | not permitted                     |

## FAQ

**Q: Can I write an ADR in Portuguese?**
A: Prefer English. If a translation is genuinely needed (e.g. the decision affects a pt-BR-only audience), ship both versions and link them; the English version is the canonical one for cross-repo references.

**Q: Are user-facing release notes English or Portuguese?**
A: User-audience decides. Portuguese is accepted (and often preferred) for `docs/user/` material aimed at a pt-BR audience. The release-notes file itself lives under an English-named path.

**Q: Are commit messages English?**
A: Yes. Commit messages are identifier-adjacent — they show up in `git log`, in code review tools, and as the input to changelog generators. Keep them English.

**Q: A DETRAN regulation is intrinsically Portuguese — can I quote it?**
A: Yes. Quoted references (statute text, screen labels, user prompts that ship in pt-BR) are exempt from the coherency rule. Quote, then continue in English with translation.

## Cross-references

- Authority: [CONVENTIONS.md](./CONVENTIONS.md) §3.
- Docs layout: [`docs-layout.md`](./docs-layout.md).
