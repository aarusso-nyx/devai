# Cheap local checks and receipt-only CI

DEVAI's test DAG behaves like a content-addressed build graph. A task key binds its Git
blob inputs, dependency keys, canonical executable and arguments, working directory,
toolchain, allowlisted environment, and output contract. Commit identity and file mtimes
do not invalidate identical content.

## Local development

Plan or explain the affected closure from an exact base:

```bash
devai check --affected --task-plan --base <exact-base-commit> --format json
devai check --affected --explain --base <exact-base-commit> --format json
```

Execute it only with the required local-write consent:

```bash
devai check --affected --run --base <exact-base-commit> \
  --as-role inspector --write --format json
```

Only PASS results are reusable. A changed source, test, helper, configuration, lockfile,
dependency key, toolchain, allowlisted environment value, command, or output contract
invalidates the affected closure. Unknown paths widen through the policy's declared
`test:local-full` fallback rather than silently selecting nothing. Known paths select only
their matching leaf tasks and dependent closure. FAIL, timeout, killed, aborted, and malformed
results are never reusable.

Dirty-tree iteration may populate the ignored local cache, but it cannot produce a candidate
receipt. `--local` always uses the complete cheap cached closure and does not produce a receipt.
A clean affected or RC execution may produce an unsigned candidate receipt only when the tree
is unchanged before and after execution and the commit/tree binding is exact.

## Change classes and the class selector

Every tracked path belongs to exactly one change class, and the class decides which
checks a change engages ([ADR-GOV-0017](../../law/adr/ADR-GOV-0017-change-class-taxonomy.md)).
The vocabulary is closed and declared in law at `law/policy/change-taxonomy.json`, validated by
`law/schemas/change-taxonomy.schema.json`: `law`, `spec`, `plan`, `code`, `tests`, `docs`,
`ci`, `toolchain`, and `generated`. Each class carries a family (`governance`,
`implementation`, or `infrastructure`), the check members it engages, and the Constitution
Article 6 authority row it maps onto; the taxonomy never contradicts that table. A commit may
carry one class, or one of the declared `pairings`; today the only pairing is `law` with
`generated`, because the action registry and its generated views, and a law policy and its
materialized copy under `.devai/config/`, must land together.

The mapping from path to class is a binding, and the binding is adopter policy with a law
default. `law/policy/adopter-defaults/change-taxonomy-binding.json` is the starting binding
for a conventional layout; DEVAI's own binding lives at `.devai/config/change-taxonomy-binding.json`.
A binding is an ordered list of `{ "selector": { "kind", "pattern" }, "class" }` entries with
the same `exact`, `prefix`, and `glob` selector grammar as the task descriptor. A binding may
only assign paths to law classes; it may not add, rename, or merge a class. Two entries that
match the same path are a load error, never a precedence rule, so prefer disjoint prefixes
and use exact entries for root files. Check the binding against the tracked tree with:

```bash
git ls-files | node scripts/classify-paths.mjs \
  --binding .devai/config/change-taxonomy-binding.json --require-all
```

The script prints every unclassified path and exits non-zero on an overlap, an unknown class,
or, with `--require-all`, any unclassified path. The taxonomy policy is materialized to
`.devai/config/change-taxonomy.json` byte for byte, and `scripts/check-policy-materialization.mjs`
fails on drift.

The task descriptor gains a fourth selector kind, `class`, whose pattern is one of the nine
class names. A node that declares `{ "kind": "class", "pattern": "plan" }` selects every path
the binding assigns to `plan`, so plan-only, law-only, and docs-only changes reach their class
nodes instead of widening to the `test:local-full` fallback. The fallback remains for genuinely
unclassified paths: unknown paths still widen, never vanish.

## RC gate

`devai check --rc --task-plan` selects the fixed release-candidate closure. The RC profile
runs one coverage node after generation and build. For the stable 1.0 candidate that node
collects 106 files and 926 tests exactly once, including database, E2E, performance, and
containment tests, and
enforces floors of 70% statements, 60% branches, 70% functions, and 70% lines. The narrower DB,
E2E, performance, and containment scripts are diagnostic slices, not additional RC gates.

## Remote verification

Remote CI does not rerun the attested RC closure. It may execute the unconditional
release floor and a profile-selected DAG as a non-attesting preflight signal on
pull requests. A transient preflight receipt coordinates that run but is not a
candidate receipt, attestation, or publication authority; it is not uploaded and
cannot supplement the protected ledger. A green preflight proves only that those
commands exited zero on an untrusted runner. Declare what must never run remotely with
`ci_economy.attested_rc.local_only_nodes`; `check --only ci-economy` fails closed on any
workflow that reaches a declared local-only node, directly or through an npm-script alias.

The package-owned `devai-evidence-export` entry point first
validates the clean local receipt and exact results from the protected signing environment, then
signs the canonical receipt outside the candidate repository. CI checks that export with the
immutable verifier in the exact installed DEVAI package, an allowlisted,
non-revoked Ed25519 public key, the exact repository/commit/tree, the approved task-policy
digest, and the complete required-node closure. Missing, stale, malformed, unknown, FAIL, or
ABORTED nodes reject the receipt.

This boundary is intentionally honest: a trusted local signature attests that the signer
claims the bound tasks and results. Cryptography detects tampering and identity mismatch; it
does **not** prove that the signer actually executed the commands. Trust in execution remains
a human and signer-operational decision.

## Remote workflow posture

Pull-request workflows cancel superseded runs and use Linux runners. A workflow that
also runs on push to a protected branch conditions the cancellation on the event —
`cancel-in-progress: ${{ github.event_name == 'pull_request' }}` — so superseded
pull-request runs stop while a branch-gating run on main is never cancelled. They do not
combine pull-request, push, and scheduled product-validation triggers. Path filters
are appropriate only for content the gate does not consume; tested documentation and
policy inputs remain unfiltered. Concurrent suites that use PostgreSQL need isolated
ephemeral databases or serialized database-heavy work rather than inflated timeouts.

A preflight lane, where a repository runs one, is untrusted and non-attesting by
construction: pull-request trigger only, `contents: read`, no job environment, no secret
reference, pinned actions, no artifact upload, and no path from its result into the evidence
chain. It is a contradiction check that runs before a signer spends time on a candidate, not
a second source of truth.

The `ci_economy` project configuration selects the full or staged enforcement profile.
Its optional `local_evidence` declaration is fail-closed: a missing declaration never
accepts claimed local evidence, and policy-sensitive changes always force the protected
remote path.
