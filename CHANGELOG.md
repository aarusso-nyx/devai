# Changelog

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
