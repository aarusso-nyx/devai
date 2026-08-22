# Changelog

## 1.2.3 — 2026-08-22

- Repairs the stable `evidence record --kind test` authority path so the installed package can
  execute and record the exact caller-declared `--cmd` through the non-publishing local test-runner
  boundary. Commands that differ from the declared argument remain refused.
- Adds positive and fail-closed authority coverage, and requires the exact packed candidate to pass
  TEAT's governed `R-0013` unit-evidence command before publication.

## 1.2.2 — 2026-08-22

- Completes the packaged runtime-validator roster for every compatibility validator advertised by
  `@aarusso-nyx/devai`, so installed `sense run inventory_api` execution no longer depends on
  validator bytes that were present only in the DEVAI source checkout.
- Adds installed-package regression coverage for the public inventory sensor path. Before
  publication, the exact packed candidate must also pass TEAT's package-only verification; source
  tests or sibling-checkout resolution are not substitutes for that adopter proof.

## 1.2.1 — 2026-08-22

- Completes the installed-adopter schema boundary: the module-blueprint validator is generated,
  exported, and packaged, while `check --only schemas` validates adopter bindings without requiring
  DEVAI source-canon paths. DEVAI source-canon validation remains strict and unchanged.
- Makes bootstrap plan and reviewed apply materialize `law/policy/mutation-strength.json`, preserve
  explicit adopter overrides, and remain byte-idempotent. Documentation policy binding now accepts
  `docs.publish_target` and `docs.gh_pages_branch` without erasing unrelated adopter configuration.
- Preserves resolved authority-policy bytes and first-materialization provenance across repeated
  identical `init bind` calls. Tier3 Owner apply now honors the already-declared joint
  `law/glossary/**` Owner/Architect authority without widening any other permission or path.
- Adds the stable, deterministic, read-only `audit scorecard` facade. The public catalog is now
  exactly 44 actions: 23 stable, 10 preview, and 11 internal.
- Supports fresh `record/proofs/chain.json` genesis, append, verification, and doctor acceptance
  through package entry points; no legacy evidence-chain migration or fallback is introduced.
- Adds fail-closed native local evidence for exact commit and tree identity, `darwin/arm64`, named
  trusted actors, required unit, API, DB/PostGIS, browser E2E, mutation, and coverage jobs, a 24-hour
  maximum age, and forbidden policy-path mutation rejection. Wildcard trusted actors are rejected.
- Replaces live `devai-nyx/devai-verifier` reliance with an immutable package-owned verifier whose
  provenance digest is an externally protected trust input. CI scaffolds, workflow checks, release
  manifests, installed-package tests, and package assembly preserve the independent ledger proof.
- Executes the protected verifier materialization shell in regression tests for both ledger and
  release workflows, and resolves the installed candidate package version without invalid nested
  Bash quoting or a source-repository import fallback.
- Updates only vulnerable compatible transitives: `fast-uri` 3.1.4 to 3.1.5;
  `brace-expansion` 1.1.16, 2.1.2, and 5.0.8 to 1.1.18, 2.1.4, and 5.0.9; `js-yaml` 4.3.0 to 4.3.1;
  `nanoid` 3.3.16 to 3.3.18; and `postcss` 8.5.22 to 8.5.23.

## 1.2.0 — 2026-08-19

- Promotes the RC.3 functional contracts unchanged after an installed-package STYNX trial
  completed one Inspector-signed local RC closure with the exact discovered 32-package mutation
  roster and an independently verified protected evidence tag.
- Keeps mutation execution local while the default-branch verifier reconstructs task policy,
  validates exact candidate and tree identity, and posts `verified-local-rc` without executing
  adopter product commands.
- Preserves the exact 43-action catalog, schema 1.0/1.1 compatibility, task-scoped environment
  isolation, portable evidence checks, immutable release assets, and explicit host-boundary
  reporting.

## 1.2.0-rc.3 — 2026-08-19

- Compares persisted dependency-result identities canonically so unchanged multi-dependency tasks
  remain reusable after their canonical cache records are reloaded from disk.
- Adds adversarial coverage for dependency declaration order while preserving exact task keys,
  dependency closure, the 43-action catalog, and schema 1.0/1.1 compatibility.

## 1.2.0-rc.2 — 2026-08-17

- Isolates runtime task environments so each check node receives only its own declared
  allowlist instead of the graph-wide union, while preserving task-key and dependency identity.
- Pins the independent verifier that rejects credential-shaped evidence and workstation-specific
  absolute paths during export, bundle verification, publication, and remote verification.
- Verifies pull requests by exact commit and merged main or release tags by explicit byte-identical
  tree binding, with workflow, documentation, and release-script inputs bound into the RC task key.
- Preserves the exact 43-action catalog and schema 1.0/1.1 compatibility.

## 1.2.0-rc.1 — 2026-08-16

- Adds fail-closed trusted local RC evidence over immutable protected tags while preserving the
  exact 43-action public catalog and legacy schema 1.0 ledger verification.
- Binds every selected task, dependency result, declared output artifact, toolchain identity,
  environment identity, exact commit, and exact Git tree into portable schema 1.1 evidence.
- Independently derives and verifies adopter mutation rosters and thresholds; STYNX currently
  resolves to 32 packages without hard-coding that count.
- Generates a five-minute GitHub verifier that executes no candidate product command and reports
  exact-commit PR or byte-identical tree-equivalent main verification.
- Fails CI economy checks when a workflow directly or transitively reaches a configured local-only
  task, including bounded package-script aliases, while ignoring non-executable action metadata.
- Stabilizes authority-policy repository identity across linked worktrees.

## 1.1.7 — 2026-08-14

- Quotes the exact main-observation artifact directory before expanding the JSON roster so the
  generated GitHub Actions adapter passes shell analysis without changing its authenticated
  audit-ref boundary.

## 1.1.6 — 2026-08-14

- Generates a digest-bound GitHub Actions adapter that uses the optional read-only
  `DEVAI_REPO_TOKEN` for cross-repository DEVAI package installation and otherwise falls back to
  the repository-scoped `GITHUB_TOKEN`.
- Verifies the authentication fallback as an explicit adapter fact so credential-routing drift
  fails `doctor` instead of silently invalidating installed-package observation.

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
