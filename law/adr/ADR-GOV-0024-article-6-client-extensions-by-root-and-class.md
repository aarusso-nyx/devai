---
id: ADR-GOV-0024
title: Article 6 admits client path extensions by declared root and path class
type: adr
status: proposed
date: 2026-09-30
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 6 (substrate authority-by-path), 1.0.1
  - law/constitution.md Article 9 (authority chain), 1.0.1
  - law/constitution.md Article 40 (constitution changes), 1.0.1
  - ADR-AUT-0001
  - ADR-CFG-0002
  - docs/dev/operations/multi-stack-path-authority-proposal.md
  - GitHub issue aarusso-nyx/devai#186 and the DETRAN report A3.4-path-policy-feasibility (R-0020)
affected_rules:
  - law/constitution.md
  - .devai/pin/constitution.md
  - law/schemas/adopter-policy.schema.json
  - docs/adopters/path-authority.md
inspector_acceptance:
  - IA-001 -- The amended constitution carries version 1.0.2 in its frontmatter title, its heading, and its Status block, and the text of every Article 6 core row is byte-identical to 1.0.1; a diff of Article 6 shows only the two amended sentences and the extension paragraph.
  - IA-002 -- A bound adopter policy that declares an authority block is refused by init bind, by Doctor, and by the runtime while the pinned constitution is 1.0.1 or lower, with the named code ADOPTER_AUTHORITY_CONSTITUTION_VERSION, and is admitted once the pin is 1.0.2.
  - IA-003 -- No extension can alter, narrow, or shadow a core row; an extension root equal to a core-table prefix (law, product, docs, record, tests, packages, scratch, work, .devai) is refused at compile time, and an extension rule with a core selector at a precedence at or above the core rule is refused by the materializer with AUTHORITY_POLICY_EXTENSION_NON_ADDITIVE.
  - IA-004 -- The framework's own pinned copy under .devai/pin/constitution.md equals law/constitution.md at 1.0.2 after the rebind, and the authority policy's constitution binding carries the 1.0.2 digest; Doctor reports the binding current.
---

# Article 6 admits client path extensions by declared root and path class

## Status

Proposed on 2026-09-30 from the multi-stack path authority proposal for
campaign CMP-0005. This record is a constitutional amendment under Article 9
and Article 40: it binds nothing until the Architect sets it `accepted`
before round R-0501 opens, and the Architect task of R-0501 applies the
amended text. Nothing here edits `law/constitution.md`; the amended text
lives in the Decision section.

Decided by the Owner on 2026-09-30, recorded in the proposal's "Decisions
taken by the Owner" table: Article 6 is amended (option A1, decision a), and
the new constitution version is 1.0.2, a patch, rather than the 1.1.0 the
draft recommended. The exact amended words below remain for the Owner's
approval under OE-01 of CMP-0005 before the Architect accepts the record.

## Context

Article 6 of constitution 1.0.1 decides authority "by a fixed path prefix of
at most two segments — a table lookup, never a wildcard rule with a default
remainder", lists the core rows, and ends: "Clients may extend the path
mapping for client-specific disciplines. Extensions are additive; the core
mapping is immutable at a given constitution version." Article 9 makes any
change touching Articles 6 to 10 a constitutional amendment with a new
version, and forbids a policy artifact from accomplishing it implicitly.

The DETRAN adopter (#186) is a multi-stack monorepo whose Owner approved
treating `{src, backend, frontend, apps, mobile, portal}/<segment>` as roots
where path classes take precedence over the root grant: source and local
implementation READMEs to Engineer, colocated `*.spec.*` and `*.test.*` files
and `test/` or `tests/` directories to Inspector, DDL and architectural
blueprints to Architect, canonical `docs/` to Architect. Under a root grant,
`apps/dashboard/web/src/example.ts` and `apps/dashboard/web/src/example.spec.ts`
share every prefix; only a class rule separates them, and a root grant with
class exceptions is exactly "a wildcard rule with a default remainder". The
current grammar therefore cannot express the approved matrix, and Article 9
forbids expressing it through a policy artifact alone.

The runtime already resolves filesystem authority by minimatch globs and
numeric precedence (`packages/authority/src/runtime/policy-resolver.ts`), the
core table already contains `packages/*/tests/` and the compiled rows
`**/test/**` and `**/tests/**`, and the materialized policy already carries an
`additive_extensions` list with per-extension digests and a non-additive
check (`policy-materializer.ts`, `AUTHORITY_POLICY_EXTENSION_NON_ADDITIVE`).
The normative text lags the mechanism; the amendment states the class model
the mechanism can enforce and keeps the core table immutable.

## Decision

The constitution advances from 1.0.1 to 1.0.2. The version appears in the
frontmatter `title`, the H1 heading, and the Status block; the frontmatter
`date` becomes the amendment date. Every core row of Article 6 is unchanged
byte for byte. Two sentences of Article 6 are amended and the extension
paragraph is replaced, as follows.

The sentence

> Authority is decided by a fixed path prefix of at most two segments — a
> table lookup, never a wildcard rule with a default remainder:

becomes

> Core authority is decided by a fixed path prefix of at most two segments —
> a table lookup, never a wildcard rule with a default remainder:

The paragraph

> Clients may extend the path mapping for client-specific disciplines.
> Extensions are additive; the core mapping is immutable at a given
> constitution version.

becomes

> Clients may extend the path mapping for client-specific disciplines through
> a declared, versioned, and bound extension. An extension names its roots
> explicitly; no root is inferred from a directory's existence, and a root
> never equals or contains a core-table prefix. Under a declared root,
> authority is decided by path class in a fixed order: the architecture class
> (schema definitions, blueprints, and the architectural specifications the
> extension names) is Architect; the test class (test directories and
> colocated test files) is Inspector; every remaining path under the root,
> including local implementation documentation, is Engineer. A class rule
> takes precedence over the root grant, the architecture class over the test
> class, and two extension rules that would grant different roles at the same
> precedence are ambiguous: the write is refused. Extensions are additive:
> they never alter, narrow, or shadow a core row, and the core mapping is
> immutable at a given constitution version. An extension is materialized only
> through a registered binding action from a validated, digest-bound source and
> is verified at every write; an extension whose source is absent, invalid, or
> unbound fails closed, and no grant survives it.

No other article changes. Article 40 continues to require an explicit
`devai init bind --constitution --write`; the framework rebinds its own pin in
the round that applies the amendment, and adopters rebind before they declare
an extension. The runtime refuses an extension while the bound constitution is
below 1.0.2 with the named code `ADOPTER_AUTHORITY_CONSTITUTION_VERSION`, so
the mechanism cannot outrun the norm.

## Consequences

Adopters with several application roots can express the Owner-approved class
matrix in a governed source instead of a hand-edited materialized file or a
blanket root grant. The grammar the constitution admits for extensions is now
the grammar the runtime enforces, with explicit precedence and explicit
refusal of ambiguity. Every adopter that wants an extension must rebind the
constitution, which is the existing Article 40 discipline. Adopters that
declare no extension are unaffected: the core rows, their compiled rules, and
their materialized policies do not change. The framework's own pin and
authority policy are rebound once, in R-0501, so the constitution digest in
`.devai/config/authority-policy.json` changes once.

## Alternatives Considered

Meeting the requirement additively inside the current grammar is rejected: an
extension table of fixed prefixes cannot separate `example.ts` from
`example.spec.ts` under the same directory, so tests and DDL would be granted
to Engineer with the root, which the adopter's Owner refused. Reading the
existing extension sentence as already admitting glob rules with precedence is
rejected: Article 9 forbids a policy artifact or extension from widening
Article 6 implicitly, and the issue itself asked for a versioned change. A
major version (2.0.0) is rejected because no core row and no existing binding
semantics change; 1.0.2 is offered to the Owner as the conservative
alternative. Editing the pinned copies of adopters is not this record's job:
Article 40 binds a constitution version explicitly.

## Affected Rules

- `law/constitution.md`: version 1.0.2; the two amended sentences and the
  extension paragraph of Article 6 as stated above.
- `.devai/pin/constitution.md`: the framework's own pin, rebound to 1.0.2 in
  R-0501 through `init bind --constitution --write`.
- `law/schemas/adopter-policy.schema.json`: the `authority` block the
  amendment admits (ADR-AUT-0003 declares its grammar).
- `docs/adopters/path-authority.md`: states the extension model in the words
  of the amended article.

## Inspector Adversarial Acceptance

Diff `law/constitution.md` between 1.0.1 and 1.0.2 and confirm that only the
two sentences and the extension paragraph of Article 6, the three version
markers, and the frontmatter date differ. Pin a fixture repository at 1.0.1,
bind an adopter policy with an `authority` block, and confirm `init bind`
refuses with `ADOPTER_AUTHORITY_CONSTITUTION_VERSION`; rebind the constitution
at 1.0.2 and confirm the same bind is admitted. Declare `law`, `docs`,
`packages`, and `.devai` as extension roots and confirm each is refused before
any rule is compiled. Construct an extension rule whose selector equals a core
selector at precedence 750 and confirm the materializer refuses it with
`AUTHORITY_POLICY_EXTENSION_NON_ADDITIVE`. Run Doctor on the framework after
the rebind and confirm `constitution-binding` and `authority-enforcement`
report current with the 1.0.2 digest.
