# Changelog

## 1.1.5 — 2026-08-14

- Adds fail-closed Owner authorization receipts for exact forbidden-action IDs at exact commits,
  allowing governed repositories to preserve reviewed history without broad waivers or hook bypasses.
- Rejects unknown actions, partial SHAs, non-Owner declarations, duplicate entries, and malformed
  receipt bytes while reporting applied and unused authorizations for auditability.

## 1.1.4 — 2026-08-13

- Scopes the `DEVAI_DB_TESTS` RC sentinel to task descriptors that explicitly declare it, keeping
  DEVAI's own release floor fail-closed without imposing a source-repository-only switch on
  adopters.
- Allows adopter RC graphs to bind and execute their real database URL and test-harness variables
  without adding an unused DEVAI-specific environment flag.

## 1.1.3 — 2026-08-13

- Authorizes only the exact routine declared by the selected in-progress task when `round run`
  crosses the local process boundary.
- Executes managed tasks inside their registered contained worktrees and leaves successful
  routines in `merging` for an explicit, evidence-bound `task finish` transition.
- Keeps resource-provisioned tasks `ready` until the round runner begins execution, and reports
  stable task dispatch errors without hiding their cause.
- Exercises the full managed-worktree start, run, evidence, finish, and cleanup loop from a packed
  installed package.

## 1.1.2 — 2026-08-13

- Includes `rgr.schema.json` in the packaged runtime validator roster so installed adopters can
  create and resolve governed reference gaps.
- Exercises the installed-package RGR create/resolve loop in the release smoke test.

## 1.1.1 — 2026-08-13

- Adds schema-valid task materialization to `task queue add --input`, closing the missing
  queue-to-start transition discovered by the installed-package STYNX governed pilot.
- Preserves existing queue identity during enrichment, makes replay idempotent, rejects
  conflicting task records, and reports a precise `TASK_NOT_FOUND` start failure.
- Keeps the public contract surface at exactly 43 actions; no effect or authority scope widens.

## 1.1.0 — 2026-08-13

- Promoted the RC7 functional contracts unchanged after exact installed-package STYNX validation.
- Ships the 43-action control-loop facade, adopter policy binding, workspace introspection, and
  verified local/GitHub host adapters with explicit host-boundary reporting.

## 1.1.0-rc.7 — 2026-08-13

- Prevented Git hook-local environment variables from redirecting auditor commands back into the
  adopter checkout.
- Proved that linked-worktree observation commits leave the adopter branch and worktree unchanged.

## 1.1.0-rc.6 — 2026-08-13

- Fixed post-merge lock, observation, and authority containment paths in linked Git worktrees.
- Added a full linked-worktree auditor fixture that proves observation completion and cleanup in
  the external Git administration directory.

## 1.1.0-rc.5 — 2026-08-13

- Fixed post-merge receipt verification in linked Git worktrees by resolving the exact Git administration directory.
- Added a real Git-pointer checkout fixture that verifies an exact signed merge receipt outside `repo/.git`.

## 1.1.0-rc.4 — 2026-08-13

- Fixed generated GitHub Actions observation workflow YAML by preserving the shell `printf` newline escape.
- Added pre-mutation and `doctor` validation of the generated workflow's YAML syntax.

## 1.1.0-rc.3 — 2026-08-13

- Fixed GitHub Actions adapter origin binding in linked Git worktrees.
- Resolved the repository slug from the exact common Git configuration without assuming `.git` is a directory.

## 1.1.0-rc.2 — 2026-08-13

- Fixed local hook installation and verification in linked Git worktrees.
- Bound post-merge keys and receipt issuers to the exact per-worktree Git administration directory.
- Preserved repository-local hook execution and strict authority containment for all other host paths.

## 1.1.0-rc.1 — 2026-08-13

- Fixes lazy-registry policy provenance so normal invocation, help, doctor, and binding use the
  same complete action catalog.
- Adds adopter-owned policy binding, workspace-aware introspection, verified local post-merge
  binding, and honest per-host enforcement reporting.
- Adds `audit observe` and `triage classify`, expanding the contract surface to 43 actions.

## 1.0.1 — 2026-08-12

- Persists the effective adoption profile explicitly in `.devai/config/project.json`.
- Reconciles a later explicit `--tier` across the bind and harness bootstrap writers while
  preserving adopter-owned project declarations.
- Completes partial project metadata with the required schema, project type, and authority mode.

## 1.0.0 — 2026-08-12

- Promotes the corrected 41-action, 59-sensor, seven-recipe surface to the stable 1.0 line.
- Makes fresh-repository adoption, binding, role-separated apply, packaged checks, hooks,
  recipes, recovery, and removal operational from the installed package boundary.
- Requires DB-enabled exact-candidate evidence, pinned external policy reconstruction, signed
  annotated tags, deterministic double-pack, SBOM validation, immutable Release assets, and
  registry-to-Release digest equality.
- Publishes stable packages through `latest` and keeps prerelease packages on `next`.

## 1.0.0-rc.6 — 2026-08-12

- Final public release candidate and installed-package adopter proof.
- Corrects release recovery, deterministic staging, GitHub Packages publication, and Pages
  deployment while preserving the canonical manifest identity.

## 1.0.0-rc.2 — 2026-08-11

- First public DEVAI release candidate from the pristine `aarusso-nyx/devai` lineage.
- Ships one package, `@aarusso-nyx/devai`, with the `devai` executable.
- Exposes exactly 41 actions, 59 sensors, and seven host-invoked recipes.
- Uses content-addressed local test reuse with independently verified remote receipts.
- Publishes the matching reference site at <https://aarusso-nyx.github.io/devai/>.
