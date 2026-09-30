---
id: ADR-AUT-0003
title: Governed adopter path authority by declared roots and path classes
type: adr
status: proposed
date: 2026-09-30
authority: Architect
supersedes: []
provenance:
  - ADR-GOV-0024
  - ADR-AUT-0001
  - ADR-CFG-0002
  - ADR-GOV-0007
  - law/schemas/adopter-policy.schema.json
  - law/schemas/authority-policy.schema.json
  - packages/cli/src/authority/policy.ts
  - packages/cli/src/authority/policy-additive-rules.ts
  - packages/authority/src/runtime/policy-resolver.ts
  - packages/authority/src/runtime/policy-materializer.ts
  - packages/authority/src/runtime/policy-loader.ts
  - docs/dev/operations/multi-stack-path-authority-proposal.md
  - GitHub issue aarusso-nyx/devai#186 and the DETRAN report A3.4-path-policy-feasibility (R-0020)
affected_rules:
  - law/schemas/adopter-policy.schema.json
  - law/policy/adopter-defaults/path-authority-classes.json
  - law/schemas/path-authority-classes.schema.json
  - packages/cli/src/authority/policy-adopter-extension.ts
  - packages/cli/src/authority/policy.ts
  - packages/cli/src/services/adopter-policy.ts
  - packages/cli/src/services/adopter-policy-binding.ts
  - packages/cli/src/commands/init/bind-adapters.ts
  - packages/authority/src/runtime/policy-resolver.ts
  - packages/cli/src/commands/doctor-policy-checks.ts
  - packages/cli/src/commands/doctor-install-checks.ts
  - packages/cli/scripts/installed-tarball-smoke.mjs
  - docs/adopters/path-authority.md
  - docs/adopters/install.md
  - docs/reference/error-codes.md
inspector_acceptance:
  - IA-001 -- With a bound policy declaring roots apps, backend, frontend, mobile, portal, and src and the architecture selectors **/ddl/**/*.sql and **/blueprints/**, real broker decisions read allow for Engineer and deny for Inspector and Architect on apps/dashboard/web/src/example.ts, backend/domains/ops/src/example.ts, apps/dashboard/web/README.md, and backend/domains/ops/README.md.
  - IA-009 -- Under the same bound policy, apps/dashboard/web/src/example.spec.ts and backend/domains/ops/tests/example.test.ts read allow for Inspector and deny for Engineer; backend/ddl/example.sql and backend/blueprints/ops.md read allow for Architect and deny for Engineer; and docs/index.md stays Architect only.
  - IA-002 -- A path outside every declared root reads UNCLASSIFIED_RESOURCE, a target that escapes the repository through .. or a symlink reads AUTHORITY_FS_SYMLINK_ESCAPE or AUTHORITY_FS_TARGET_INVALID before any rule is consulted, and a root declared but absent from the tree grants exactly what a present root grants, so nothing is inferred from a directory's existence.
  - IA-003 -- A source that declares a root with a separator, a dot segment, or a core-table prefix, two equal roots, a root that prefixes another, a selector that is absolute, contains .., a backslash, a brace, an extglob, or a leading root segment, a class outside the closed set, or an architecture class without selectors is refused by the schema or by the compiler with a named code and no rule is compiled; the same source refused at bind leaves the previous policy and receipt untouched.
  - IA-004 -- Binding the same source twice yields byte-identical authority-policy.json and adopter-policy-binding.json; changing one selector changes the extension digest, the resolved digest, and the receipt; removing the block removes the extension entry and every rule it compiled.
  - IA-005 -- After a bind, editing the source without rebinding makes every governed write read AUTHORITY_POLICY_DIGEST_MISMATCH and Doctor report policy-materialization-current and authority-enforcement as mismatches naming the rebind command; deleting the source makes the same checks report the source absent; in neither case does a stale grant survive.
  - IA-006 -- Two additive-extension rules that match one path at the same precedence with different human role sets read AMBIGUOUS_POLICY_MATCH at the resolver, and the compiler never emits such a pair from a valid source.
  - IA-007 -- An adopter policy without an authority block projects byte-identically to today, its authority policy keeps exactly one additive extension, and the framework's own binding is unchanged apart from the constitution rebind of ADR-GOV-0024.
  - IA-008 -- The packed tarball, installed in a disposable adopter, binds the reference source and reproduces IA-001 through IA-005 through the installed bin, never through workspace sources.
---

# Governed adopter path authority by declared roots and path classes

## Status

Proposed on 2026-09-30 from the multi-stack path authority proposal for
campaign CMP-0005. Binds nothing until the Architect sets it `accepted`
before round R-0501 opens, after the Owner approves ADR-GOV-0024. Extends the
adopter policy source of ADR-CFG-0002 with one block and the trusted authority
sources of the broker with one adopter-authored additive extension; the
immutable core of `policy-core-rules.ts`, the package extension
`devai-adopter-authority`, and the exact-effect ledger of ADR-AUT-0001 are
unchanged.

Decided by the Owner on 2026-09-30, recorded in the proposal's "Decisions
taken by the Owner" table: the source is a block in the adopter policy (b);
the precedence model is the fixed class ladder (c); roots are
adopter-declared (d); existing adopters are unchanged and the framework
declares no roots (e); a source edited after binding refuses every governed
write until rebind (h); a nested `docs` directory under a root is Engineer by
remainder and an adopter may name `**/docs/**` in its architecture class (i);
the harness subject of a class rule is bound to the class role (j). The
constitution gate threshold is 1.0.2 (decision a). The text below states the
decided design.

## Context

`init bind --adopter-policy` validates one adopter-owned source under
`law/policy` against `law/schemas/adopter-policy.schema.json` (closed:
`project`, `ci_economy`, `release_verification`, `domains`, `thresholds`,
`scorecard_na`, `glob_guards`) and projects it into six bound files with a
receipt of source and target digests (`adopter-policy.ts`,
`adopter-policy-binding.ts`). It then re-materializes
`.devai/config/authority-policy.json` (`bind-adapters.ts:249`). That policy is
built by `buildTrustedAuthoritySources` (`policy.ts`) from two package-owned
sources: the immutable core and the package extension
`devai-adopter-authority`, each with a canonical source document and digest,
listed in `additive_extensions`. The same builder is called by the broker
before every governed write (`broker.ts:260`), by `init bind` at commit time
(`broker.ts:1361`), by the session, and by Doctor
(`doctor-install-checks.ts:184`); the loader refuses a policy whose extension
digests differ from the freshly built ones
(`AUTHORITY_POLICY_DIGEST_MISMATCH`), and the materializer refuses a second
extension that duplicates an id or a rule id, or that carries a core selector
at or above the core precedence. No adopter-authored input reaches the builder
today, so the materialized policy of DETRAN carries no rule for `apps/` or
`backend/`, and the schema refuses any attempt to declare one.

The resolver classifies a target by every rule whose selector matches its
path, keeps the rules of the highest numeric precedence, and then filters by
action, subject, operation, and consent; rules of equal precedence and equal
effect union their subjects, and rules of equal precedence with different
effects deny `AMBIGUOUS_POLICY_MATCH`. Precedence is an enumerated integer
(500, 650, 700, 750, 800, 900, 1000). Package extension rules sit at 500 and
650; core rows sit at 650 to 900. The core Inspector rows `**/test/**` and
`**/tests/**` are compiled only from human Inspector write actions, and the
registry declares none, so in this checkout no compiled rule carries a human
Inspector subject on a filesystem selector; an Inspector test write through
the runtime is admitted today only by the harness subject of the Engineer
`packages/**` rule, which admits every initiator role.

## Decision

**Source.** `law/schemas/adopter-policy.schema.json` gains one optional closed
block, `authority`:

```json
"authority": {
  "extension_id": "detran.path-authority",
  "roots": ["apps", "backend", "frontend", "mobile", "portal", "src"],
  "classes": {
    "test": { "selectors": ["**/*.spec.*", "**/*.test.*", "**/test/**", "**/tests/**"] },
    "architecture": { "selectors": ["**/ddl/**/*.sql", "**/blueprints/**"] }
  }
}
```

`extension_id` is optional and defaults to `<policy_id>.path-authority`; it
must differ from `devai-adopter-authority`. `roots` is a non-empty set of
single path segments: no separator, no dot segment, no glob metacharacter,
not equal to and not a prefix of a core-table row (`law`, `product`, `docs`,
`record`, `tests`, `packages`, `scratch`, `work`, `.devai`, and the root
prose files), and no root a prefix of another. `classes` admits exactly two
keys. `test` is optional; when absent, its selectors are the package defaults
declared in `law/policy/adopter-defaults/path-authority-classes.json`
(validated by `law/schemas/path-authority-classes.schema.json`), which name
the four selectors shown. `architecture` has no default: an adopter that
wants Architect classes under its roots names them, so DDL coverage is
explicit and testable. Every selector is a root-relative minimatch glob under
the same restrictions the resolver imposes (`nobrace`, `noext`, no leading
`/`, no `..`, no backslash, no `//`, no trailing `/`), never starts with a
root segment, and is applied under every declared root. The block is
versioned by the source's `policy_version` like every other block, and
`init bind --adopter-policy` is its only materialization verb.

**Compilation.** A pure function
`packages/cli/src/authority/policy-adopter-extension.ts` turns a validated
block into an extension document `{ extension_id, extension_version, rules }`
with `extension_version` equal to the source `policy_version`. For each root
`R`, in the order declared, it emits, all with `origin: additive-extension`,
`effect: allow`, the filesystem operations `create`, `update`, `delete`,
`rename`, and the Engineer write verbs the registry declares (`round run`,
`task start`, `task finish`, as `adopter-engineer-packages` uses today):

- `adopter-path-root-<R>` and `adopter-path-root-<R>-tree` at precedence 500
  with selectors `R` and `R/**`; subjects the human Engineer and the harness
  machine subject initiated by Engineer only.
- `adopter-path-test-<R>-<n>` at precedence 700, one per test selector `S`,
  with selector `R/S`; subjects the human Inspector and the harness subject
  initiated by Inspector only.
- `adopter-path-architecture-<R>-<n>` at precedence 750, one per
  architecture selector, with selector `R/S`; subjects the human Architect and
  the harness subject initiated by Architect only.

The ladder is fixed: architecture over test over root, and the role of each
class is fixed, so precedence between any two rules of the extension is
proven by construction and no valid source can produce two rules of equal
precedence with different roles. Local implementation documentation
(`README.md` and any other file the classes do not name) is the root
remainder and is Engineer; canonical documentation is the core `docs/` row,
which the extension can neither name nor shadow. A nested `docs` directory
under a root is Engineer by remainder unless the adopter names it in the
architecture class. Compilation is deterministic: the same source bytes
produce the same rules in the same order, and the extension digest is the
SHA-256 of the canonical extension document.

**Constitution gate.** The compiler refuses a block while the bound
constitution version is below 1.0.2, with `ADOPTER_AUTHORITY_CONSTITUTION_VERSION`.
Every other refusal carries a named `ADOPTER_AUTHORITY_*` code
(`ROOT_INVALID`, `ROOT_CORE_PREFIX`, `ROOT_DUPLICATE`, `ROOT_NESTED`,
`SELECTOR_INVALID`, `SELECTOR_ROOTED`, `CLASS_UNKNOWN`,
`ARCHITECTURE_SELECTORS_REQUIRED`, `EXTENSION_ID_RESERVED`), is raised at
bind time before any target is staged, and is listed in
`docs/reference/error-codes.md`.

**Materialization and provenance.** `buildTrustedAuthoritySources` reads the
binding receipt `.devai/config/adopter-policy-binding.json`, loads the source
it names, validates it, and, when the source declares `authority`, appends
the compiled document as a second entry of `additiveExtensions` after
`devai-adopter-authority`. The materializer already computes the digest, the
duplicate checks, and the non-additive check; `additive_extensions` in
`authority-policy.json` therefore lists the adopter extension with its id,
version, and digest, and `resolved_digest_sha256` covers its rules. The
receipt gains an optional `authority_extension` object
(`extension_id`, `extension_version`, `digest_sha256`, `rule_count`) so the
projection and the authority policy name the same bytes. Binding twice is
byte-stable; a source without the block yields a policy with exactly one
extension, byte-identical to today.

**Enforcement and drift.** The broker, the session, and Doctor rebuild the
expected sources on every use, so a source edited after binding no longer
matches the materialized digests: the loader refuses every governed write
with `AUTHORITY_POLICY_DIGEST_MISMATCH` until `init bind --adopter-policy` is
rerun, and a receipt whose source is missing or invalid is refused with
`ADOPTER_AUTHORITY_SOURCE_UNAVAILABLE`. Doctor's `policy-materialization-current`
compares the receipt's `authority_extension` with a fresh compilation and
names the rebind command; `authority-enforcement` reports the adopter
extension's id, version, and digest and the mismatch reason. The resolver
additionally denies `AMBIGUOUS_POLICY_MATCH` when two `additive-extension`
rules of the highest matched precedence carry different human role sets, so
ambiguity is refused at run time as well as at compile time; unions among
core rules are unchanged.

**Migration.** Adopters without the block change nothing and rebind only for
the package version, as today. An adopter that wants roots rebinds the
constitution at 1.0.2, adds the block, bumps `policy_version`, and runs
`init bind --adopter-policy`; the installed smoke and the adopter package
contract test rehearse that sequence in a disposable clone with the reference
source above. The framework declares no roots of its own in this record.

## Consequences

An adopter's path authority becomes a governed, versioned, digest-bound source
that the same verb, the same receipt, and the same drift checks already cover
for the other adopter blocks. Broker decisions for the DETRAN matrix are real
rules, not documentation. A blanket `apps/**` grant is no longer the only
expressible shape, and a class rule cannot be silently overridden by a root
grant because precedence is fixed by class. The price is a second trusted
input to the policy builder, read on every governed write: an adopter that
edits its source without rebinding loses every governed write until it
rebinds, which is the fail-closed behaviour the issue asks for and Doctor
names. The materialized policy of every adopter that declares roots grows by
two rules per root plus one per class selector per root; for six roots and
six selectors that is forty-eight rules.

## Alternatives Considered

A separate governed file with its own bind flag is rejected because the
adopter policy already carries versioning, a receipt, atomic projection, and
Doctor coverage, and one verb keeps provenance in one receipt. Adopter-declared
numeric precedence is rejected because equal-precedence overlaps between
selectors are undecidable in general and would need a witness heuristic; a
fixed ladder proves precedence by construction. A fixed root set of six is
rejected because a seventh root would need a package release; the closed
grammar of a root is what keeps the extension safe, not its spelling.
Compiling the extension into the materialized file only, without re-reading
the source at run time, is rejected because the existing policy is never an
authority for its own replacement and the loader verifies extensions from
their source bytes. Widening `adopter-engineer-packages`'s any-initiator
harness subject to the new roots is rejected because it would admit an
Inspector or Architect harness write to source; the class rules bind the
harness subject to the class role.

## Affected Rules

- `law/schemas/adopter-policy.schema.json`: the optional closed `authority`
  block.
- `law/policy/adopter-defaults/path-authority-classes.json` and
  `law/schemas/path-authority-classes.schema.json`: the package default test
  selectors as a law source.
- `packages/cli/src/authority/policy-adopter-extension.ts`: the pure
  compiler, its ladder, and its refusal codes.
- `packages/cli/src/authority/policy.ts`: the adopter extension as the second
  additive extension of the trusted sources.
- `packages/cli/src/services/adopter-policy.ts`,
  `packages/cli/src/services/adopter-policy-binding.ts`,
  `packages/cli/src/commands/init/bind-adapters.ts`: bind-time refusal and the
  `authority_extension` receipt field.
- `packages/authority/src/runtime/policy-resolver.ts`: extension-tie denial.
- `packages/cli/src/commands/doctor-policy-checks.ts`,
  `packages/cli/src/commands/doctor-install-checks.ts`: drift reporting.
- `packages/cli/scripts/installed-tarball-smoke.mjs`: the packed rehearsal.
- `docs/adopters/path-authority.md`, `docs/adopters/install.md`,
  `docs/reference/error-codes.md`: the adopter contract and the codes.

## Inspector Adversarial Acceptance

Bind the reference source in a fixture repository pinned at 1.0.2 and drive
the broker for every row of the matrix in IA-001 and IA-009 with each of the three roles
as the human subject and as the harness initiator; confirm each allow and
each deny by code. Request writes to `vendor/x.ts`, `apps/../law/x.md`, and a
symlink under `apps/` that resolves outside the root; confirm the refusals of
IA-002. Feed each malformed source of IA-003 to `init bind --adopter-policy`
and confirm the named code and unchanged receipt bytes. Bind twice and diff
the two policies and receipts; change one selector, rebind, and confirm three
digests changed; remove the block, rebind, and confirm the extension entry and
its rules are gone. Edit the source without rebinding and confirm a governed
write reads `AUTHORITY_POLICY_DIGEST_MISMATCH` and Doctor names the rebind
command; delete the source and confirm `ADOPTER_AUTHORITY_SOURCE_UNAVAILABLE`.
Hand the resolver two additive-extension rules at 700 with different roles on
one path and confirm `AMBIGUOUS_POLICY_MATCH`. Pack the tarball, install it in
a disposable adopter, and repeat the bind and the matrix through the installed
bin.
