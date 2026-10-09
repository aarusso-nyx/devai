# Sensor: `harness_coherence` → F5×T3

## Property semantics

**T3 Coherence** (Constitution Article 5) for F5 (Harness): "do the workflows agree with each other?" Concretely: do all workflows pin the same versions of common actions (e.g. `actions/checkout`), apply consistent permissions discipline, and follow a uniform structural style?

## Operational definition

Across all workflows, detect inconsistencies:

1. **Action-version drift.** For each `<owner>/<repo>` used by ≥ 2 workflows, are all `@<ref>` values identical? If not → drift incident.
2. **Permissions discipline.** Count workflows with vs without a top-level `permissions:` block. If both groups are non-empty → discipline incident.
3. **Concurrency discipline.** Same check for `concurrency:` block. (Less critical than permissions; info-level only.)

`incoherence_score = drift_incidents + permissions_mixed + concurrency_mixed`.

## PASS / REVIEW / FAIL boundaries

- **PASS:** `incoherence_score === 0`.
- **REVIEW:** `1 ≤ incoherence_score ≤ 3`.
- **FAIL:** `incoherence_score > 3`.

## Adopter overrides

- `extractor_params.harness_coherence.max_review_incoherence: number` — REVIEW/FAIL boundary. Default `3`.

## Out of scope

- **Node-version pinning per workflow.** Requires deeper `with:` parsing — defer.
- **Reusable workflow extraction recommendations.** That's idiomaticity (F5×T5).

## Concurrency effect proof (#325)

Concurrency semantics depend on each job's proved effect. Under ADR-REL-0034 an unproved
effect stays a finding. Steps the closed analysis cannot prove are listed in a reviewed-step
registry (`packages/sensors/src/harness/reviewed-workflow-steps.ts`):

- Each entry names one step by the sha256 of its canonical YAML.
- Each entry records the sha256 of every repository file the step executes: local action
  definitions, named scripts, the `package.json` files consulted, and the package scripts
  reached through npm `pre`/`post` hooks, nested runs, and `pnpm -r`.
- The analysis recomputes those hashes from the candidate tree. A changed, missing, or
  unresolvable file reads unknown.

Every input of the registry is an input of `test:sensors` in `test-tasks.json` (#376), so
`check --affected` selects the registry test whenever a change could break it:

- each repository file that any entry pins by digest, declared one `exact` selector per
  path;
- every workflow file and local action, through one `prefix` selector on `.github/`,
  because a step's canonical YAML is pinned too.

A guard test fails when the registry pins a path that no `test:sensors` selector matches, so
a new pin cannot outrun the declaration. A version roll changes pinned `package.json`
files, which therefore selects `test:sensors` and asks for the re-pinned digests in the same
pull request. A change that touches only a pinned file, such as a documentation-site
dependency bump, no longer passes the gate without the registry test.

A superseding concurrency group must be keyed by the run's own subject on every event the
workflow accepts: its ref, its commit, the pull request number on pull request events, or
the merge-queue head on merge-queue events.

Residual: steps that run scripts from the `release-control/` checkout of
`DEVAI_PROCESS_CONTROL_COMMIT` are hashed against the candidate tree's copy of those
scripts. That commit is pinned, and the release-control flow rehearses it separately; this
sensor does not read it.
