# Path authority for multi-stack roots

Constitution 1.0.2 amends Article 6 so that core authority is decided by a fixed path prefix of at
most two segments, a table lookup, and a client may extend that mapping for client-specific
disciplines through a declared, versioned, and bound extension
([ADR-GOV-0024](../../law/adr/ADR-GOV-0024-article-6-client-extensions-by-root-and-class.md)).
The extension is the optional `authority` block of the adopter policy source, declared by
[ADR-AUT-0003](../../law/adr/ADR-AUT-0003-governed-adopter-path-authority.md) and admitted by
[`law/schemas/adopter-policy.schema.json`](../../law/schemas/adopter-policy.schema.json). It is
materialized only through `init bind --adopter-policy`, the same verb, receipt, and drift checks
that cover every other block of the source ([Install and adopt](install.md)).

Adopters that declare no block are unaffected: the core rows, their compiled rules, and their
materialized policies do not change. The framework declares no roots of its own.

## The extension model, in the words of the amended article

An extension names its roots explicitly; no root is inferred from a directory's existence, and a
root never equals or contains a core-table prefix. Under a declared root, authority is decided by
path class in a fixed order: the architecture class (schema definitions, blueprints, and the
architectural specifications the extension names) is Architect; the test class (test directories
and colocated test files) is Inspector; every remaining path under the root, including local
implementation documentation, is Engineer.

A class rule takes precedence over the root grant, the architecture class over the test class,
and two extension rules that would grant different roles at the same precedence are ambiguous:
the write is refused. Extensions are additive: they never alter, narrow, or shadow a core row,
and the core mapping is immutable at a given constitution version. An extension is materialized
only through a registered binding action from a validated, digest-bound source and is verified
at every write; an extension whose source is absent, invalid, or unbound fails closed, and no
grant survives it.

Canonical documentation stays the core `docs/` row, which the extension can neither name nor
shadow. A nested `docs` directory under a root is Engineer by remainder unless the adopter names
it in the architecture class, for example with `**/docs/**`.

## The block

```json
{
  "schemaVersion": "1.0.0",
  "policy_id": "detran.devai-adoption",
  "policy_version": "1.1.0",
  "authority": {
    "extension_id": "detran.path-authority",
    "roots": ["apps", "backend", "frontend", "mobile", "portal", "src"],
    "classes": {
      "test": { "selectors": ["**/*.spec.*", "**/*.test.*", "**/test/**", "**/tests/**"] },
      "architecture": { "selectors": ["**/ddl/**/*.sql", "**/blueprints/**"] }
    }
  }
}
```

The block is closed. Its grammar:

| Key                    | Required | Meaning                                                                                                                                                                                                                                                                                            |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension_id`         | no       | Identifier of the compiled additive extension. Defaults to `<policy_id>.path-authority`; must differ from the package extension `devai-adopter-authority`.                                                                                                                                         |
| `roots`                | yes      | A non-empty set of single path segments: no separator, no dot segment, no glob metacharacter, not equal to and not a prefix of a core-table row (`law`, `product`, `docs`, `record`, `tests`, `packages`, `scratch`, `work`, `.devai`, and the root prose files), and no root a prefix of another. |
| `classes.test`         | no       | `{ "selectors": [...] }`. When absent, the selectors are the package defaults in `law/policy/adopter-defaults/path-authority-classes.json`, which name the four selectors shown above.                                                                                                             |
| `classes.architecture` | no       | `{ "selectors": [...] }`. There is no default: an adopter that wants Architect classes under its roots names them, so DDL coverage is explicit and testable. An architecture class without selectors is refused.                                                                                   |

Every selector is a root-relative minimatch glob under the restrictions the resolver imposes
(`nobrace`, `noext`, no leading `/`, no `..`, no backslash, no `//`, no trailing `/`), never
starts with a root segment, and is applied under every declared root. The block is versioned by
the source's `policy_version` like every other block: to add, change, or remove it, edit the
source, bump `policy_version`, and rebind.

## The fixed ladder

The bind compiles the block into one additive extension whose rules sit on a ladder fixed by
class. For each declared root `R`, in the order declared:

| Precedence | Rule ids                                              | Selector       | Role                                                      |
| ---------- | ----------------------------------------------------- | -------------- | --------------------------------------------------------- |
| 750        | `adopter-path-architecture-<R>-<n>`, one per selector | `R/<selector>` | Architect, and the harness subject initiated by Architect |
| 700        | `adopter-path-test-<R>-<n>`, one per selector         | `R/<selector>` | Inspector, and the harness subject initiated by Inspector |
| 500        | `adopter-path-root-<R>`, `adopter-path-root-<R>-tree` | `R`, `R/**`    | Engineer, and the harness subject initiated by Engineer   |

Architecture wins over test, and test over the root grant, so `apps/dashboard/web/src/example.ts`
is Engineer while `apps/dashboard/web/src/example.spec.ts` beside it is Inspector and
`backend/ddl/example.sql` is Architect. The role of each class is fixed, so no valid source can
produce two rules of equal precedence with different roles; the resolver still denies
`AMBIGUOUS_POLICY_MATCH` if two extension rules of the highest matched precedence ever carry
different human role sets. A path outside every declared root reads `UNCLASSIFIED_RESOURCE`, and
a root declared but absent from the tree grants exactly what a present root grants.

## Binding and drift

Rebind the constitution at 1.0.2 first (`init bind --constitution --write`, the Article 40
discipline), then add the block, bump `policy_version`, and run
`init bind --adopter-policy <file> --as-role architect --write`. The receipt
`.devai/config/adopter-policy-binding.json` gains an `authority_extension` object
(`extension_id`, `extension_version`, `digest_sha256`, `rule_count`), and
`.devai/config/authority-policy.json` lists the extension in `additive_extensions` with the same
digest. Binding the same source twice is byte-stable; removing the block removes the extension
and every rule it compiled.

The broker, the session, and `doctor` rebuild the expected sources on every use. A source edited
after binding refuses every governed write with `AUTHORITY_POLICY_DIGEST_MISMATCH` until the bind
is rerun; a receipt whose source is missing or invalid refuses with
`ADOPTER_AUTHORITY_SOURCE_UNAVAILABLE`. `doctor` reports the drift under
`policy-materialization-current` and `authority-enforcement` and names the rebind command. No
stale grant survives either case.

## Refusal codes

Every refusal is raised at bind time, before any target is staged, and leaves the previous policy
and receipt untouched. The codes are listed in the
[error-code reference](../reference/error-codes.md).

| Code                                                | Raised when                                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ADOPTER_AUTHORITY_CONSTITUTION_VERSION`            | A block is declared while the bound constitution is below 1.0.2.                                    |
| `ADOPTER_AUTHORITY_ROOT_INVALID`                    | A root carries a separator, a dot segment, or a glob metacharacter.                                 |
| `ADOPTER_AUTHORITY_ROOT_CORE_PREFIX`                | A root equals or prefixes a core-table row.                                                         |
| `ADOPTER_AUTHORITY_ROOT_DUPLICATE`                  | Two declared roots are equal.                                                                       |
| `ADOPTER_AUTHORITY_ROOT_NESTED`                     | One declared root is a prefix of another.                                                           |
| `ADOPTER_AUTHORITY_SELECTOR_INVALID`                | A selector is absolute or contains `..`, a backslash, a brace, an extglob, `//`, or a trailing `/`. |
| `ADOPTER_AUTHORITY_SELECTOR_ROOTED`                 | A selector starts with a declared root segment.                                                     |
| `ADOPTER_AUTHORITY_CLASS_UNKNOWN`                   | A class outside `test` and `architecture` is named.                                                 |
| `ADOPTER_AUTHORITY_ARCHITECTURE_SELECTORS_REQUIRED` | The architecture class is declared without selectors.                                               |
| `ADOPTER_AUTHORITY_EXTENSION_ID_RESERVED`           | `extension_id` equals `devai-adopter-authority`.                                                    |
| `ADOPTER_AUTHORITY_SOURCE_UNAVAILABLE`              | The receipt names a source that is missing or invalid at a governed write or in `doctor`.           |
