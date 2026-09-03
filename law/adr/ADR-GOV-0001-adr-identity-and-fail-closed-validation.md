---
id: ADR-GOV-0001
title: Scoped ADR identity and fail-closed recursive validation
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 6 (substrate authority-by-path)
  - law/constitution.md Article 9 (authority chain)
  - law/constitution.md Article 39 (explicit uncertainty over false precision)
  - law/constitution.md Article 41 (evidence)
affected_rules:
  - law/schemas/adr-v2.schema.json
  - law/schemas/adr-validation-policy.schema.json
  - law/policy/adr-validation.json
inspector_acceptance:
  - IA-001 -- A record whose frontmatter omits id is rejected. No id is derived from the filename, the directory, or a position in a sequence.
  - IA-002 -- A Markdown file added anywhere under law/adr/, including a nested directory and including a .MD extension, is scanned. Adding it without a conforming record or a catalog entry fails the scan.
  - IA-003 -- Editing the bytes of a catalogued exception fails the scan. The pinned sha256 does not migrate to the new content and the exception does not survive the edit.
  - IA-004 -- Adding, removing, or repointing a catalog entry without updating catalog_digest_sha256 fails. A tampered catalog is visible as a policy diff, never a silent acceptance.
  - IA-005 -- A file the scanner cannot read or parse fails the scan. An unreadable file never counts as an absent finding or a pass.
  - IA-006 -- A supersedes entry naming an unknown identity fails. A superseding record cannot manufacture a predecessor.
  - IA-007 -- Superseding ADR-014 leaves ADR-014 byte-identical. Any change to its digest is a failure of this decision, not an update to it.
---

# Scoped ADR identity and fail-closed recursive validation

## Status

Accepted. Binding on every Markdown file under `law/adr/`.

## Context

The pre-v2 ADR contract identified records by a global integer sequence
(`ADR-NNN`) and validated only files whose names matched that sequence in the
top level of `law/adr/`. Three properties follow from that design and all three
are defects.

A global sequence couples unrelated decisions: two Architects working in
separate domains contend for the same next number, and a gap check reports a
numbering failure for a decision that was merely never written. The `id` was
recoverable from the filename, so a missing `id` was not clearly a failure.
Worst, the scan was a filter rather than a census: a Markdown file that did not
match the filename pattern — a draft, a stray note, a record in a nested
directory, a file named with an uppercase extension — was silently invisible to
validation. Invisibility read as compliance.

`law/adr/README.md` is directory prose and is not a record. `ADR-014` is a real
pre-v2 record whose bytes are preserved. Both must remain in the directory
without either being validated as a v2 record or being erased from the census.

## Decision

ADR identity is `ADR-<SCOPE>-<NNNN>`, where `<SCOPE>` is one or more
hyphen-separated uppercase alphanumeric area segments and `<NNNN>` is a
four-digit sequence numbered within that scope. `id` is mandatory in
frontmatter and is never derived. The scope is declared exactly once, inside
the identity, and is not restated in a separate field.

Lifecycle is exactly four values: `proposed`, `accepted`, `rejected`,
`superseded`. Only `accepted` is binding.

Validation is a fail-closed recursive census, not a filter. Every Markdown file
at any depth under `law/adr/`, matched case-insensitively on extension, is
resolved to exactly one of two outcomes: it is a conforming v2 record, or it is
an exact entry in the exception catalog. Anything else — an unmatched file, an
unreadable file, unparseable frontmatter, a duplicate identity, a filename that
does not begin with its own id — fails.

The exception catalog is exact. Each entry pins one repository-relative path and
the sha256 of that file's bytes; there is no glob, no prefix, and no directory
exception. The catalog carries `catalog_digest_sha256`, a digest over its own
canonical form, so membership cannot change without the policy changing. It has
exactly two entries: `README.md` as directory prose, and
`ADR-014-release-verification-profiles.md` as a preserved pre-v2 record.

Supersession is recorded forward and only forward. A superseding record lists
the identities it supersedes; the superseded record is never edited. The v2
frontmatter contract therefore has no `superseded_by` field at all, which makes
the byte preservation of `ADR-014` a structural property rather than a
convention someone must remember.

## Consequences

Scopes number independently, so concurrent Architect work does not contend and a
gap in one scope is not a validation event in another.

The census is total. A new Markdown file under `law/adr/` is a decision to
either write a conforming record or amend the catalog under Architect authority;
it is never a quiet addition.

The two catalogued files are pinned to their current bytes. Editing either one
is a deliberate policy change: the sha256 must be updated and the catalog digest
recomputed, both in `law/policy/adr-validation.json`, in the same change.

`ADR-014` remains byte-identical and unvalidated against the v2 record schema.
It is superseded semantically by `ADR-REL-0001`, which asserts the supersession
from its own frontmatter.

The legacy validator in `packages/spec` matches `ADR-[0-9]{3,}-*.md` and does not
see v2 filenames. Until it is replaced, v2 records are governed by this policy
and not by that code path. This is a stated gap, not a claim of coverage.

## Alternatives Considered

**Keep the global integer sequence and add a scope field.** Rejected: two
sources of scope truth diverge, and the contention and gap-check defects remain.

**Validate only files matching the record filename pattern, as today.**
Rejected: it is precisely the filter-not-census defect. A file that fails to
match is the case most worth reporting.

**Record supersession on the superseded record via `superseded_by`.** Rejected:
it requires editing a record to supersede it, which forbids preserving the bytes
of a superseded record and invites an agent to rewrite history it lost against.

**Allow directory- or glob-scoped exceptions.** Rejected: a directory exception
is a standing hole that grows silently. An exact path plus content digest cannot
widen without an Architect edit.

## Affected Rules

- `law/schemas/adr-v2.schema.json` — new v2 frontmatter contract.
- `law/schemas/adr-validation-policy.schema.json` — new validation-policy contract.
- `law/policy/adr-validation.json` — new canonical validation policy and exception catalog.
- `law/adr/ADR-014-release-verification-profiles.md` — preserved byte-for-byte; catalogued, not edited.
- `law/adr/README.md` — preserved byte-for-byte; catalogued as non-record prose.

## Inspector Adversarial Acceptance

Acceptance is demonstrated by attacks that must fail closed, not by a passing
directory. Each `inspector_acceptance` entry in this record's frontmatter names
one attack. The Inspector demonstrates IA-001 through IA-007 against a fixture
tree, and demonstrates that removing the exception catalog entirely fails the
scan rather than passing it with two unmatched files.
