# Testing operations

## Ordinary development

Select tests from the content-addressed task descriptor instead of repeatedly sweeping the
repository:

```bash
devai check --affected --task-plan --base <exact-base-commit> --format json
devai check --affected --run --base <exact-base-commit> \
  --as-role inspector --write --format json
devai check --affected --status --base <exact-base-commit> --format json
```

`--explain` reports why a node was selected, reused, or invalidated. Task keys bind Git blob
content, dependency keys, canonical runner/argv/cwd, toolchain, allowlisted environment, and
output contract. They do not bind mtimes or commit SHA, so identical content can reuse a PASS.
Known changed paths select matching leaf tasks and their dependent closure. Unknown or dynamic
paths select the declared `test:local-full` fallback and therefore the complete cheap closure.

`devai check --local` selects that complete cheap closure directly. It consists of generation,
the workspace build, lint, typecheck, the package and root test leaves, and the aggregate marker.
Each unchanged PASS node can be served from the ignored content-addressed cache. The current closure is 16 nodes
and its Vitest leaves collect 94 files.

Never reuse FAIL, timeout, killed, aborted, malformed, or incomplete output. Dirty-tree runs are
useful for iteration but cannot produce a candidate receipt. The local profile is deliberately
non-attestable; a clean affected or RC run may emit an unsigned receipt when the repository stays
unchanged throughout execution.

## Release-candidate gate

```bash
pnpm run build
pnpm run authority:materialize
DEVAI_DB_TESTS=1 DEVAI_DB_URL=<reachable-test-database> \
  devai check --rc --task-plan --format json
DEVAI_DB_TESTS=1 DEVAI_DB_URL=<reachable-test-database> \
  devai check --rc --run --as-role inspector --write --format json
```

`authority:materialize` deterministically creates the ignored
`.devai/config/authority-policy.json` from the bound Constitution. The RC task key binds its
SHA-256 through the allowlisted `DEVAI_AUTHORITY_POLICY_SHA256` identity. This keeps the generated
authority session out of Git while allowing the package-owned `devai-evidence-policy` entry point to reconstruct the
same three-key task-policy schema. Missing materialization fails with
`CHECK_AUTHORITY_POLICY_REQUIRED`; it must never be bypassed with a hand-authored policy.

The fixed RC closure has lint, typecheck, and `test:coverage:rc` as its three required
sibling gates. Their generation and build dependencies are included transitively; coverage
depends on build but does not own the lint or typecheck gates. The coverage node
collects the complete Vitest population exactly once and enforces coverage floors of 70%
statements, 60% branches, 70% functions, and 70% lines. The narrower database, E2E, performance,
and containment scripts remain available as diagnostic slices; they are not additional required
RC nodes. The rc.2 baseline was 104 files and 899 Vitest-collected tests. The stable 1.0 candidate
collects **106 files and 926 tests** via `vitest list --json`; release records must recount the
exact publication candidate rather than copying this development census. RC planning and
execution refuse unless `DEVAI_DB_TESTS=1`; its value and `DEVAI_DB_URL` are bound into the RC
task key along with the authority-policy SHA-256. A reachable disposable database is required,
and the release record must include the
number of collected DB cases. The stable candidate collects **9 DB cases** inside the 926-test
population. Real provider credentials are always explicit opt-in; ambient
credentials must not create accidental cost or nondeterminism.

## Receipt verification

The package-owned `devai-evidence-export` entry point validates the unsigned clean affected/RC
receipt and exact result set when invoked from the protected signing environment outside the
candidate repository. The exported evidence is valid only for its
exact repository, commit, tree, task-policy digest, required-node closure, signer, and revocation
state. The immutable package-owned verifier rejects missing, stale, malformed, unknown, FAIL,
or ABORTED nodes. A trusted signature proves integrity and signer identity, not that execution
actually occurred.

Pull-request verification requires the exact signed commit. After GitHub creates a merge commit,
main verification may reuse that receipt only in explicit `exact-tree` mode and only when the
merged tree is byte-identical. Release-tag verification uses the same exact-tree rule; any changed
byte requires a new local RC receipt.

## Packed-adopter rehearsal

The adopter path-authority extension of
[ADR-AUT-0003](../../../law/adr/ADR-AUT-0003-governed-adopter-path-authority.md) and
[ADR-AUT-0004](../../../law/adr/ADR-AUT-0004-class-write-verbs-for-adopter-path-authority.md)
is proved on the published package, never on workspace sources: the installed smoke
(`pnpm --filter @aarusso-nyx/devai run pack:smoke`, which runs
`packages/cli/scripts/installed-tarball-smoke.mjs`) and the adopter package contract test
(`packages/cli/tests/unit/adopter-package-contract.test.ts`) both perform the rehearsal below in
a disposable clone, and the release workflow runs the smoke against the exact tarball it
publishes. A rehearsal that resolves the broker, a schema, a policy, or
the default test selectors from the workspace proves nothing about the package and is a defect of
the rehearsal.

1. **Pack the tarball.** `pnpm run build`, then `pnpm pack` in `packages/cli`, or pass the exact
   candidate with `--tarball <absolute-path> --sha256 <digest>`. The packed file list must carry
   `law/policy/adopter-defaults/path-authority-classes.json` under `dist/`: the default test
   selectors are a law source of the package, and an installed bin that cannot resolve them reads
   `ADOPTER_AUTHORITY_DEFAULTS_UNAVAILABLE` at the bind.
2. **Install it in a disposable clone.** A fresh git repository under a temporary root, with the
   tarball added as its only `@aarusso-nyx/devai` dependency and the lockfile committed; every
   later command runs the installed `bin.js` from that clone's `node_modules`, and
   `devai --version` is checked against the packed version before anything else.
3. **Bind the constitution at 1.0.2, then the package law.** In order:
   `init bind --tier tier1 --constitution`, `init bind --operational-law`,
   `init bind --subprocess-effects`, and the plain `init bind`, each `--as-role architect --write`.
   The constitution gate is real: a source with the block bound before this step reads
   `ADOPTER_AUTHORITY_CONSTITUTION_VERSION` and leaves no receipt.
4. **Bind the reference source.** Write the reference block of
   [Path authority for multi-stack roots](../../adopters/path-authority.md#the-block) into
   `law/policy/adopter-policy.json` of the clone and run
   `init bind --adopter-policy law/policy/adopter-policy.json --as-role architect --write`. Assert
   the receipt's `authority_extension` (`detran.path-authority`, the source `policy_version`, a
   digest, `rule_count` 48) and the second `additive_extensions` entry of
   `.devai/config/authority-policy.json` with the same id, version, and digest. Bind twice and
   assert both files byte-identical.
5. **Run Doctor through the installed bin.** `doctor --repo-root <clone> --format json` must read
   `policy-materialization-current` and `authority-enforcement` `ok` with
   `policy_binding: current`. Then edit the block without rebinding, remove the block without
   rebinding, and delete the source, and assert after each that Doctor reports the reason id and
   the rebind command the [Doctor findings](../../adopters/path-authority.md#doctor-findings)
   table names, as a `review` verdict and never as a pass or a transport failure; rebind between
   probes so each starts from a current receipt.
6. **Drive the matrix through the installed bin.** A probe loads the broker from the installed
   package and requests each row of the
   [decision matrix](../../adopters/path-authority.md#decision-matrix) under the registered
   entries exactly as registered, never with a substituted subject: `check` declared by the
   Inspector, `task start` declared by the Engineer, `round seal` declared by the Architect. At
   least the Inspector allow and the Engineer deny on a test path and the Architect allow and the
   Engineer deny on an architecture path are asserted by code and by matched rule id, and a deny
   under a class verb names no rule of a lower precedence. The drift refusals are driven the same
   way: a governed write after an edit reads `AUTHORITY_POLICY_DIGEST_MISMATCH`, and after the
   source is deleted reads `ADOPTER_AUTHORITY_SOURCE_UNAVAILABLE`.

The smoke asserts the packed file list, the receipt field, the second extension entry, one allow
and one deny of the matrix, and the Doctor verdict, so `pack:smoke` fails when a published package
cannot enforce the extension; the contract test carries the full matrix and the drift states.

### What DETRAN repeats before claiming enforcement

The rehearsal above proves the package with the reference source in a fixture. It proves nothing
about a candidate repository, whose roots, selectors, and tree are its own. Before DETRAN, or any
adopter, states that path authority is enforced on its candidate, it repeats the sequence there,
with the pinned release and its own source, and keeps the results with the candidate:

- Pin the released version the campaign names, rebind the constitution at 1.0.2, and run the
  operational-law and subprocess-effects rebinds of an upgrade, as
  [Upgrading DEVAI](../../adopters/install.md#upgrading-devai) states.
- Declare its own `authority` block, with the roots its tree actually carries and the architecture
  selectors it wants covered (DDL, blueprints, and any nested `docs` it wants Architect), bump
  `policy_version`, and bind it with `--adopter-policy` through the installed bin; commit the
  source, the receipt, and every materialized target together.
- Read Doctor `ok` on both checks, then edit the source without rebinding and read the finding
  and the rebind command, so the drift path is seen to fail closed on that repository and not only
  in the fixture; rebind afterwards.
- Drive its own matrix: one existing path per root remainder, per test selector, and per
  architecture selector, plus one path outside every root and one nested `docs` path, under the
  three registered verbs, and record each code and matched rule id beside the row it stands for.
  A row that reads other than the page predicts is a finding to report, never a row to reword.
- State the boundary with the claim: the runtime brokers governed writes through its own actions,
  and no host-enforcement adapter is declared for editor or shell writes, so the claim is
  enforcement of governed writes, not of every write to the tree.

A candidate that cannot complete a step, for example a package whose tarball lacks the defaults
source or a Doctor finding that no rebind clears, is blocked on that step and reports it against
the package, not worked around with a hand edit under `.devai/config`.
