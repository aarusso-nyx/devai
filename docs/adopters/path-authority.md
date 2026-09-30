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

The test defaults are a law source, not a constant of the package:
[`law/policy/adopter-defaults/path-authority-classes.json`](../../law/policy/adopter-defaults/path-authority-classes.json),
validated by
[`law/schemas/path-authority-classes.schema.json`](../../law/schemas/path-authority-classes.schema.json)
under the same selector grammar. The schema admits the test class only, so no architecture
default can be declared there, and its selectors are compiled under every root an adopter
declares exactly as an explicit `classes.test` would be.

## The fixed ladder

The bind compiles the block into one additive extension whose rules sit on a ladder fixed by
class. For each declared root `R`, in the order declared:

| Precedence | Rule ids                                              | Selector       | Role                                                      | Registered write verbs                                               |
| ---------- | ----------------------------------------------------- | -------------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| 750        | `adopter-path-architecture-<R>-<n>`, one per selector | `R/<selector>` | Architect, and the harness subject initiated by Architect | `init apply architect`, `release export`, `round plan`, `round seal` |
| 700        | `adopter-path-test-<R>-<n>`, one per selector         | `R/<selector>` | Inspector, and the harness subject initiated by Inspector | `check`                                                              |
| 500        | `adopter-path-root-<R>`, `adopter-path-root-<R>-tree` | `R`, `R/**`    | Engineer, and the harness subject initiated by Engineer   | `task start`                                                         |

Architecture wins over test, and test over the root grant, so `apps/dashboard/web/src/example.ts`
is Engineer while `apps/dashboard/web/src/example.spec.ts` beside it is Inspector and
`backend/ddl/example.sql` is Architect. The role of each class is fixed, so no valid source can
produce two rules of equal precedence with different roles; the resolver still denies
`AMBIGUOUS_POLICY_MATCH` if two extension rules of the highest matched precedence ever carry
different human role sets. A path outside every declared root reads `UNCLASSIFIED_RESOURCE`, and
a root declared but absent from the tree grants exactly what a present root grants.

The verbs of a class rule are fixed by
[ADR-AUT-0004](../../law/adr/ADR-AUT-0004-class-write-verbs-for-adopter-path-authority.md): a
class rule carries exactly the registered write actions by which its class role performs
governed workspace writes, that is every entry of `law/policy/action-registry.json` whose effect
is not `read`, whose authority contract carries the capability `fs:workspace`, and whose subject
is the human subject admitting the role or the harness subject initiated by exactly that role.
The sets are derived from the registry by one function, not written as a list, and a contract
test freezes them at the values above, so a registry change that would admit a verb to a class
fails a test instead of granting silently. `round run` and `task finish` appear on no extension
rule: neither carries `fs:workspace`, so neither can reach a root path. The extension digest
covers the verb sets, so a package whose registry changes a set makes the bound extension drift,
which `doctor` reports and `init bind --adopter-policy` repairs. The registry itself admits no new
role or initiator for any action under this record.

## Decision matrix

The rows below are the inspector acceptance of ADR-AUT-0003 (IA-001, IA-009, and IA-002) under
the reference block above: the roots `apps`, `backend`, `frontend`, `mobile`, `portal`, and `src`,
the default test class, and the architecture selectors `**/ddl/**/*.sql` and `**/blueprints/**`.
Each cell is a real broker decision under the bound policy, never documentation alone. The role
columns name the human subject; the harness subject initiated by the same role reads the same
outcome, because every class rule binds its harness subject to the class role. An allow reads
`POLICY_ALLOW` and names the matched rule ids.

Every cell is decided under the registered verb of the column's role, presented exactly as the
registry declares it and with no substituted subject
([ADR-AUT-0004](../../law/adr/ADR-AUT-0004-class-write-verbs-for-adopter-path-authority.md)
IA-001 to IA-003): the Engineer column under `task start`, the Inspector column under `check`,
and the Architect column under `round seal`. Because a class rule carries only its own role's
verbs, a request under another class's verb is refused at the class precedence with
`AUTHORITY_ACTION_DENIED`, naming only the rules of that precedence and never a lower grant; the
resolver never falls through. A cross-role request under a class verb, for example `task start`
declared by the Inspector or `check` declared by the Engineer, is refused at the declaration
boundary with `AUTHORITY_HUMAN_ROLE_DENIED` before any rule is read, because the registry's
subject for the action does not admit the session role. The core `docs/` row admits the
Architect verbs only, so `task start` and `check` there read `AUTHORITY_ACTION_DENIED`.

| Record | Path                                                                                                                          | Engineer (`task start`)               | Inspector (`check`)                   | Architect (`round seal`)              | Decided by                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| IA-001 | `apps/dashboard/web/src/example.ts`                                                                                           | allow `POLICY_ALLOW`                  | deny `AUTHORITY_ACTION_DENIED`        | deny `AUTHORITY_ACTION_DENIED`        | `adopter-path-root-apps-tree` (500)                                                      |
| IA-001 | `backend/domains/ops/src/example.ts`                                                                                          | allow `POLICY_ALLOW`                  | deny `AUTHORITY_ACTION_DENIED`        | deny `AUTHORITY_ACTION_DENIED`        | `adopter-path-root-backend-tree` (500)                                                   |
| IA-001 | `apps/dashboard/web/README.md`                                                                                                | allow `POLICY_ALLOW`                  | deny `AUTHORITY_ACTION_DENIED`        | deny `AUTHORITY_ACTION_DENIED`        | `adopter-path-root-apps-tree` (500): local documentation is remainder                    |
| IA-001 | `backend/domains/ops/README.md`                                                                                               | allow `POLICY_ALLOW`                  | deny `AUTHORITY_ACTION_DENIED`        | deny `AUTHORITY_ACTION_DENIED`        | `adopter-path-root-backend-tree` (500): local documentation is remainder                 |
| IA-009 | `apps/dashboard/web/src/example.spec.ts`                                                                                      | deny `AUTHORITY_ACTION_DENIED`        | allow `POLICY_ALLOW`                  | deny `AUTHORITY_ACTION_DENIED`        | `adopter-path-test-apps-1` (700) over the root grant                                     |
| IA-009 | `backend/domains/ops/tests/example.test.ts`                                                                                   | deny `AUTHORITY_ACTION_DENIED`        | allow `POLICY_ALLOW`                  | deny `AUTHORITY_ACTION_DENIED`        | `adopter-path-test-backend-2` and `adopter-path-test-backend-4` (700), one role, unioned |
| IA-009 | `backend/ddl/example.sql`                                                                                                     | deny `AUTHORITY_ACTION_DENIED`        | deny `AUTHORITY_ACTION_DENIED`        | allow `POLICY_ALLOW`                  | `adopter-path-architecture-backend-1` (750) over the root grant                          |
| IA-009 | `backend/blueprints/ops.md`                                                                                                   | deny `AUTHORITY_ACTION_DENIED`        | deny `AUTHORITY_ACTION_DENIED`        | allow `POLICY_ALLOW`                  | `adopter-path-architecture-backend-2` (750) over the root grant                          |
| IA-009 | `docs/index.md`                                                                                                               | deny `AUTHORITY_ACTION_DENIED`        | deny `AUTHORITY_ACTION_DENIED`        | allow `POLICY_ALLOW`                  | `core-architect-docs` (650): the core row, which the extension never names               |
| IA-002 | `vendor/x.ts`, outside every declared root                                                                                    | deny `UNCLASSIFIED_RESOURCE`          | deny `UNCLASSIFIED_RESOURCE`          | deny `UNCLASSIFIED_RESOURCE`          | no rule matches; nothing is inferred from the directory                                  |
| IA-002 | a target that resolves outside the repository through `..` (for example `apps/../../x.md`) or through a symlink under `apps/` | refused `AUTHORITY_FS_SYMLINK_ESCAPE` | refused `AUTHORITY_FS_SYMLINK_ESCAPE` | refused `AUTHORITY_FS_SYMLINK_ESCAPE` | the path canonicalization, before any rule is consulted                                  |
| IA-002 | a target that is empty or is not a path                                                                                       | refused `AUTHORITY_FS_TARGET_INVALID` | refused `AUTHORITY_FS_TARGET_INVALID` | refused `AUTHORITY_FS_TARGET_INVALID` | the path canonicalization, before any rule is consulted                                  |
| IA-002 | `portal/src/example.ts`, with `portal` declared but absent from the tree                                                      | allow `POLICY_ALLOW`                  | deny `AUTHORITY_ACTION_DENIED`        | deny `AUTHORITY_ACTION_DENIED`        | `adopter-path-root-portal-tree` (500): exactly what a present root grants                |

A deny under a class verb names the rules of the matched precedence only: the Engineer deny on
`apps/dashboard/web/src/example.spec.ts` names `adopter-path-test-apps-1`, never the 500 root
grant beneath it. A `..` target that stays inside the repository, for example `apps/../law/x.md`,
canonicalizes to `law/x.md` and is decided by the core `law/` row, never by the `apps` root.
Editor and shell writes are outside the runtime: no host-enforcement adapter is declared for
them, and Article 6 requires DEVAI to report that boundary rather than imply control, so the
matrix speaks only for writes the runtime brokers.

## Migration

Adopters without the block change nothing: their source, receipt, and materialized policy are
untouched by ADR-AUT-0003 and ADR-AUT-0004, and they rebind only for a package version, as
today ([Upgrading DEVAI](install.md#upgrading-devai)). An adopter that wants roots performs the
sequence below once, in this order, with the pinned package that carries the records; every step
is a governed write of the Architect role and leaves the previous pair untouched if it refuses.

1. **Rebind the constitution at 1.0.2.** The compiler refuses a block with
   `ADOPTER_AUTHORITY_CONSTITUTION_VERSION` while the bound constitution is below 1.0.2, so the
   Article 40 rebind comes first and commits on its own:

   ```bash
   pnpm exec devai init bind --target . --tier tier1 --constitution --as-role architect --write
   ```

2. **Add the block.** Declare `authority` in the adopter source under `law/policy` with the roots
   and, where wanted, the classes of [The block](#the-block); an omitted `classes.test` takes the
   package defaults, and an architecture class is named or absent, never empty.

3. **Bump `policy_version`.** The block is versioned by the source like every other block, and the
   compiled `extension_version` is that version; a source whose version does not move is a source
   the bind cannot distinguish from the bound one.

4. **Bind the source.** The bind validates the block, compiles the extension, and writes the six
   projected targets, the receipt with `authority_extension`, and `authority-policy.json` with the
   second `additive_extensions` entry, as one atomic pair:

   ```bash
   pnpm exec devai init bind --target . --adopter-policy law/policy/devai-adoption.json --as-role architect --write
   ```

   A refusal names one code of the [refusal codes](#refusal-codes) and changes no byte.

5. **Read Doctor.** Run `pnpm exec devai doctor --format json` and read
   `policy-materialization-current` and `authority-enforcement`: both `ok`, the receipt's
   `authority_extension` and the policy's second entry naming the same id, version, and digest, and
   `rule_count` equal to two rules per root plus one per class selector per root. A finding reads
   as the [Doctor findings](#doctor-findings) table states and is repaired by the command it
   names, never by an edit under `.devai/config`.

6. **Commit the pair.** Commit the source, the receipt, and every materialized target together
   with the package pin, so a clone binds to the same bytes and Doctor reads current on checkout.

To change roots or selectors later, edit the source, bump `policy_version`, and repeat steps 4
to 6; to retire the extension, remove the block and do the same, which removes the
`authority_extension` field, the second `additive_extensions` entry, and every rule the block
compiled. Between an edit and its rebind every governed write is refused, as
[Binding and drift](#binding-and-drift) states.

An extension bound before ADR-AUT-0004, that is under the R-0502 rules that carried the Engineer
verbs on every class rule, rebinds once with the package that carries the record: the verb sets
are part of the compiled bytes, so the bound extension drifts against the installed package,
Doctor reports `AUTHORITY_EXTENSION_DRIFT`, and step 4 with an unchanged source repairs it. No
adopter bound such an extension before the release of CMP-0005.

## Binding and drift

Rebind the constitution at 1.0.2 first (`init bind --constitution --write`, the Article 40
discipline), then add the block, bump `policy_version`, and run
`init bind --adopter-policy <file> --as-role architect --write`. Binding the same source twice is
byte-stable; removing the block removes the extension and every rule it compiled.

The receipt `.devai/config/adopter-policy-binding.json` gains an `authority_extension` object
naming the compiled extension: its id, its version (the source `policy_version`), the SHA-256 of
the canonical extension document, and the number of rules it compiled. For the reference block,
six roots, four test selectors, and two architecture selectors compile to forty-eight rules:

```json
{
  "authority_extension": {
    "extension_id": "detran.path-authority",
    "extension_version": "1.1.0",
    "digest_sha256": "<sha-256 of the canonical extension document>",
    "rule_count": 48
  }
}
```

`.devai/config/authority-policy.json` lists the same extension in `additive_extensions`, after
the package extension `devai-adopter-authority` and with the same digest, and its
`resolved_digest_sha256` covers the compiled rules. After binding, an adopter sees two entries:

```json
{
  "additive_extensions": [
    {
      "extension_id": "devai-adopter-authority",
      "extension_version": "1.0.0",
      "digest_sha256": "<digest of the package extension>"
    },
    {
      "extension_id": "detran.path-authority",
      "extension_version": "1.1.0",
      "digest_sha256": "<the digest the receipt names>"
    }
  ]
}
```

The receipt and the policy therefore name the same bytes. A source without the block yields a
receipt without `authority_extension` and a policy with exactly one entry, byte-identical to a
bind before ADR-AUT-0003.

The broker, the session, and `doctor` rebuild the expected sources on every use. A source edited
after binding refuses every governed write with `AUTHORITY_POLICY_DIGEST_MISMATCH` until the bind
is rerun; a receipt whose source is missing or invalid refuses with
`ADOPTER_AUTHORITY_SOURCE_UNAVAILABLE`. `doctor` reports the drift under
`policy-materialization-current` and `authority-enforcement` and names the rebind command. No
stale grant survives either case.

## Doctor findings

Two Doctor checks cover the extension, and both are read from `devai doctor --format json` under
`result.value.checks`. `policy-materialization-current` reads the receipt, recomputes the
projection from the source, and compares the receipt's `authority_extension` with a fresh
compilation of the bound source; it lists what it found under `info.reason_ids` and the repair
under `info.remediation_commands`. `authority-enforcement` rebuilds the trusted authority sources
from the same receipt and compares `additive_extensions` and `resolved_digest_sha256` of
`.devai/config/authority-policy.json` with the rebuilt provenance; it reports
`info.policy_binding` as `current` or `mismatch`, names the adopter extension's id, version, and
digest, and names the extension when the mismatch is the extension's. The three
`AUTHORITY_EXTENSION_*` ids below are the extension findings in the terms ADR-AUT-0003 states
(the receipt's `authority_extension` against a fresh compilation, naming the rebind command), as
the Doctor deliverable of campaign CMP-0005 names them; the ids that already cover the source and
the projected targets fire on the same states and are listed with them, because Doctor reports
what it finds and an adopter repairs by the command named, not by the id.

| Check                            | Finding                              | Read when                                                                                                                                                                                                                                                                                   | Remediation                                                                                                                          |
| -------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `policy-materialization-current` | `AUTHORITY_EXTENSION_DRIFT`          | The receipt carries `authority_extension` and a fresh compilation of the source yields another id, version, digest, or rule count: the block was edited after the bind, or the installed package compiles the block differently (a registry change to a class verb set, a package default). | `devai init bind --target . --adopter-policy <source> --as-role architect --write`                                                   |
| `policy-materialization-current` | `AUTHORITY_EXTENSION_UNBOUND`        | The receipt and the source disagree about whether an extension exists: the source declares a block the receipt does not carry, or the receipt carries one the source no longer declares, in either case without a rebind.                                                                   | `devai init bind --target . --adopter-policy <source> --as-role architect --write`                                                   |
| `policy-materialization-current` | `AUTHORITY_EXTENSION_SOURCE_MISSING` | The receipt carries `authority_extension` and the source it names is absent, so no compilation can be compared; governed writes read `ADOPTER_AUTHORITY_SOURCE_UNAVAILABLE` in the same state.                                                                                              | Restore the source at the receipt's `source_path`, then the rebind command above                                                     |
| `policy-materialization-current` | `SOURCE_DIGEST_MISMATCH`             | The source bytes differ from `source_digest_sha256` in the receipt: any edit after the bind, inside or outside the block; governed writes read `AUTHORITY_POLICY_DIGEST_MISMATCH` in the same state.                                                                                        | The rebind command above, after bumping `policy_version` when the block changed                                                      |
| `policy-materialization-current` | `SOURCE_MISSING`                     | The source the receipt names is absent or cannot be resolved beneath `law/policy`.                                                                                                                                                                                                          | Restore the source, then the rebind command above                                                                                    |
| `policy-materialization-current` | `SOURCE_POLICY_INVALID`              | The source no longer validates against the adopter policy schema or cannot be materialized, for example a block that now names a nested root or an empty architecture class.                                                                                                                | Correct the source so the bind accepts it, then the rebind command above                                                             |
| `policy-materialization-current` | `FRAMEWORK_VERSION_MISMATCH`         | `devai_version` in `project.json` differs from the installed package: the package was upgraded without the rebind, which also leaves the extension compiled by the previous package.                                                                                                        | The rebind command above, after the operational-law and subprocess-effects rebinds of an upgrade                                     |
| `authority-enforcement`          | `policy_binding: mismatch`           | `additive_extensions` or `resolved_digest_sha256` of `authority-policy.json` differ from the sources rebuilt from the receipt; when the extension entry is the one that differs, the finding names it with its id, version, and digest.                                                     | The rebind command above; a mismatch that names no extension is repaired by `devai init bind --target . --as-role architect --write` |

A finding never passes and never reads as a transport failure: Doctor exits `1` with the verdict
`review`, and the command it names is the whole repair. `ADOPTER_AUTHORITY_DEFAULTS_UNAVAILABLE`
is not a drift: the package default test selectors are a law source that ships in the package
(`law/policy/adopter-defaults/path-authority-classes.json` under the installed `dist/`), so an
installed bin that cannot resolve them is a damaged installation, repaired by reinstalling the
pinned package, not by a rebind.

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
