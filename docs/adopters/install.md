# Install and adopt

DEVAI 1.5 is distributed through GitHub Packages as one package:
`@aarusso-nyx/devai`. Pin the exact version selected by your maintainers; do
not rely on a moving dist-tag.

Prerequisites are Node.js 24 or newer, Git, and a project-local package manager.
The GitHub token needs the `read:packages` scope only for installation.

GitHub Packages requires npm authentication even when the package is public. Create
a GitHub token with read-only package access, expose it to the shell, and keep only
the variable reference in the project `.npmrc`:

```bash
export NODE_AUTH_TOKEN=<github-token-with-read-packages>
printf '%s\n' '@aarusso-nyx:registry=https://npm.pkg.github.com' \
  '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' > .npmrc
```

Do not commit the token or replace `${NODE_AUTH_TOKEN}` with its value.

```bash
pnpm add --save-dev --save-exact @aarusso-nyx/devai@1.5.4
pnpm exec devai catalog actions --format json
```

## Required credentials

DEVAI declares the credentials an adoption needs in
`law/policy/adopter-defaults/credential-requirements-binding.json`, validated by
`law/schemas/credential-requirements.schema.json`. The binding carries names, kinds,
scopes, and consumers only; it never holds a value. DEVAI verifies presence, shape, and
scope through the consuming tool's own status command and never reads, stores, or
generates a credential value. The adopter starting set is:

| Name                  | Kind               | Scope           | Consumer                                                              | Absence |
| --------------------- | ------------------ | --------------- | --------------------------------------------------------------------- | ------- |
| `NODE_AUTH_TOKEN`     | environment        | `read:packages` | `pnpm add --save-dev --save-exact @aarusso-nyx/devai`                 | block   |
| `PACKAGES_READ_TOKEN` | repository secret  | `read:packages` | `.github/workflows/devai-ledger-verify.yml`, job `verify-attested-rc` | block   |
| `GH_TOKEN`            | gh auth (optional) | `issues:write`  | `round tracking sync`                                                 | degrade |

`NODE_AUTH_TOKEN` is the shell variable the project `.npmrc` references during
installation. `PACKAGES_READ_TOKEN` is the repository or protected-environment secret the
generated local-RC verifier workflow passes as `NODE_AUTH_TOKEN`; the post-merge
observation workflow, when bound, reuses it. `GH_TOKEN` stands for the local `gh` session
(keyring login or variable) that projects round state onto GitHub issues; without it
tracking sync reports unauthenticated and writes nothing. Add an entry to the binding for
every further secret your own workflows reference.

## 1. Preview

`init plan` is read-only. It describes the files and role-owned segments that an
adoption would create or update.

```bash
pnpm exec devai init plan \
  --target . \
  --tier tier1 \
  --introspect \
  --format json
```

Review the target, tier, existing-file decisions, and every projected operation.
Planning does not authorize an apply.

If you would rather answer prompts than assemble the flags below by hand, `init plan --interactive`
drives the same plan from the configuration schemas and ends by printing the exact non-interactive
commands it ran, so the record stays a replayable command. See
[Interactive configuration](interactive-configuration.md) for the two modes and what each refuses.

`doctor` is also safe before binding. Its missing-binding findings are a structured
`review` result, not a transport failure.

## 2. Bind the selected adoption

Bind the installed package contracts before applying the projection. These commands
resolve canonical sources from the installed package, persist `profile` and
`devai_version`, and materialize the runtime authority policy explicitly.

```bash
pnpm exec devai init bind --full --target . --tier tier1 --as-role architect --write
```

`--full` is the blessed fresh-repository bootstrap. Under one Architect declaration and one
write consent it performs the same four binding segments in order and emits a result for each:
Constitution, operational law, subprocess effects, then the derived authority policy. It does
not run any `init apply` projection.

For stepwise diagnosis or recovery, the equivalent sequence is:

```bash
pnpm exec devai init bind --target . --tier tier1 --constitution --as-role architect --write
pnpm exec devai init bind --target . --operational-law --as-role architect --write
pnpm exec devai init bind --target . --subprocess-effects --as-role architect --write
pnpm exec devai init bind --target . --as-role architect --write
```

An adopter may own one validated policy source under `law/policy`. The source can add client
domains, partially override thresholds, declare exact scorecard N/A cells and glob guards, and,
under a constitution bound at 1.0.2 or later, declare the optional `authority` block that
extends Article 6 with adopter roots and path classes
([Path authority for multi-stack roots](path-authority.md)); it cannot replace core or framework
domains. An adopter adding the block for the first time follows the
[migration sequence](path-authority.md#migration) of that page, constitution rebind first, and
reads the two Doctor checks it names through its
[Doctor findings](path-authority.md#doctor-findings) table. Binding records the source path and
digest and updates the resolved configuration atomically:

```bash
pnpm exec devai init bind \
  --target . \
  --adopter-policy law/policy/devai-adoption.json \
  --as-role architect \
  --write
```

Invalid schemas, source paths outside `law/policy`, immutable-domain collisions, or incomplete
writes leave the prior resolved configuration unchanged.

### What `--adopter-policy` owns in `project.json`

The other five bound files are projected whole from the source and the installed canonical
defaults. `.devai/config/project.json` is shared: `init bind --constitution` pins the constitution
and profile, `init bind --tracking-adapter` binds tracking, and you may declare keys of your own.
An ownership matrix, declared once in the CLI and stated here, settles which `project.json` keys
the adopter-policy bind owns
([ADR-CFG-0002](../../law/adr/ADR-CFG-0002-owned-configuration-projection.md)). The bind replaces
an owned key with the value the source declares, as a whole, and retires it when the source no
longer declares it. It never reads or writes a key the matrix does not name.

| `project.json` key           | Source in `law/policy/devai-adoption.json` | Members                                                                                                     | Absent from the source                                                                                                                                                  |
| ---------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/project_type`              | `project.project_type`                     | one of `runtime-host`, `platform-package`, `docs-archive`, `framework`                                      | Kept as it stands: the project schema requires it and a required scalar cannot be retired, so a source without `project.project_type` leaves the current value in place |
| `/repo`                      | `project.repo`                             | `kind`                                                                                                      | Retired                                                                                                                                                                 |
| `/docs`                      | `project.docs`                             | `builder`, `build_command`, `output_dir`, `publish_target`, `gh_pages_branch`, `custom_domain`              | Retired                                                                                                                                                                 |
| `/docs/ia`                   | `project.docs.ia`                          | `collapsed_sections`, `path_overrides`                                                                      | Retired                                                                                                                                                                 |
| `/ci_economy`                | `ci_economy`                               | `profile`                                                                                                   | Retired                                                                                                                                                                 |
| `/ci_economy/local_evidence` | `ci_economy.local_evidence`                | `manifest_path`, `max_age_hours`, `required_jobs`, `allowed_platforms`, `forbidden_paths`, `require_docker` | Retired                                                                                                                                                                 |
| `/ci_economy/attested_rc`    | `ci_economy.attested_rc`                   | `profile`, `transport`, `tag_prefix`, `binding`, `required_check`, `failure_mode`, `local_only_nodes`       | Retired                                                                                                                                                                 |
| `/devai_version`             | the installed `@aarusso-nyx/devai` version | machine-managed version string                                                                              | Not applicable; every bind stamps it                                                                                                                                    |

Every other key is an adopter declaration or the output of another bind segment: `schemaVersion`,
`name`, `profile`, `adopted_at`, `constitution`, `invariant_filters`, `feature_flags`,
`authority_enforcement`, `governance_tracking`, and any key a later schema admits. The
adopter-policy bind never reads them from the source and never removes them; they survive every
bind byte for byte. The bootstrap's own reconciliation of `project.json` follows the same matrix, so
`init apply` and `init bind` never disagree about which keys are owned.

### Retiring a declaration

Absent means retired, for owned keys only. Delete the key or block from the policy source, bump
`policy_version`, and rebind with the command above; that is the only path. The bind removes the
key from `project.json` instead of carrying the old value forward, so `doctor` stops evaluating a
declaration nobody holds. Before ADR-CFG-0002 the bind deep-merged the source over the current
file and a retired block never left (issue #68); the only recovery was a hand edit to a generated
file, which the adoption contract forbids.

The projection and its receipt are one atomic write. The bind resolves every target and
`.devai/config/adopter-policy-binding.json` first, stages them, and renames them into place
together, so an interrupted bind leaves either the previous complete pair or the new complete
pair, never a projection without its receipt. After an interruption, rerun the same command;
there is nothing to repair by hand.

The receipt is the retirement report. Beside the source digest and the digest of every
materialized target, it lists the owned keys the bind retired as JSON pointers under
`retired_keys`, and the bind result echoes the receipt. A whole key is reported as `/ci_economy`;
a nested block retired on its own is reported by its row in the matrix, for example
`/ci_economy/local_evidence`.

```json
{ "retired_keys": ["/ci_economy"] }
```

A bind is idempotent. Against an unchanged source and an unchanged `project.json` it writes no
byte to any target and records an empty `retired_keys`, so a second bind is observable only
through its unchanged receipt.

When the source declares the `authority` block, the receipt also carries `authority_extension`:
the `extension_id`, `extension_version`, `digest_sha256`, and `rule_count` of the additive
extension the bind compiled from that block, the same id and digest that
`.devai/config/authority-policy.json` lists under `additive_extensions`. A source without the
block yields a receipt without the field. The field and the matrix it stands for are described in
[Path authority for multi-stack roots](path-authority.md).

`doctor` keeps the receipt honest through `policy-materialization-current`: it recomputes the
projection from the source and the current `project.json` and compares every digest the receipt
carries with the file on disk. A receipt whose digests no longer match, because the source moved,
a target was edited, or a declaration was added to `project.json` by hand after the bind, is a
failure until the next bind rematerializes it. When the source declares the `authority` block,
the same check compares `authority_extension` with a fresh compilation of the block, and
`authority-enforcement` compares the extension entry of `authority-policy.json` with the sources
rebuilt from the receipt; each finding, its reason id, and its remediation command are listed in
[Doctor findings](path-authority.md#doctor-findings). The remedy is always a rebind, never an
edit to `.devai/config`.

### Upgrading DEVAI

Bump the pinned package version, then plan the upgrade. `init upgrade` reads the bound
`devai_version` from `.devai/config/project.json` and the installed version, and lists every
adopter-facing change between them from the migration manifest the package ships,
[`law/policy/adopter-migrations.json`](../../law/policy/adopter-migrations.json) (one entry per
release from 1.6.0, validated by `law/schemas/adopter-migrations.schema.json`). Without `--write`
it writes nothing:

```bash
pnpm exec devai init upgrade --target . --as-role architect --format json
```

The plan reports, under `plan`:

- `releases`: the manifest entries above the bound version and at or below the installed one, each
  change with its kind, decision records, and the bind segments that refresh it;
- `changed_files`: every file the upgrade would create or update, with its segment;
- `retired_keys` and `refusals`: owned `project.json` keys the adopter-policy rebind would retire
  because the source no longer declares them;
- `replaced_defaults`: adopter declarations that replace a package default which changed in range,
  such as a source `scorecard_na` that omits the F4:T5 cell added in 1.7.0;
- `stale_version_stamps`: `devai_version`, the host adapter `package_binding.version`, the
  `.devai/constitution.md` pointer, and the tracking binding when they name an older version (the
  tracking binding is reported, not refreshed);
- `obligations`: new requirements and whether they are `satisfied`, `satisfied-by-upgrade`, or
  `pending`: constitution 1.0.2, the `thresholds.soft_gate` block, the proof-anchor baseline with
  its `historical-gap` declarations, and the adopter-policy receipt the check members classify by.

The upgrade fails closed on anything that needs an Owner or Architect decision. A retirement of an
owned key the source does not declare refuses the plan (verdict `review`) and refuses `--write`
before any byte is written with `INIT_UPGRADE_RETIREMENT_UNDECLARED`, naming the key, for example
`ci_economy.attested_rc` that the deep merge before 1.7.0 preserved. Declare the key in the source
and bump `policy_version`, or retire it deliberately with `init bind --adopter-policy`, then rerun.
The constitution is rebound only on request: add `--constitution` once the Architect has reviewed
the amendment.

Apply the reviewed plan with `--write`:

```bash
pnpm exec devai init upgrade --target . --as-role architect --write --format json
```

It runs the bind segments in the canonical order: constitution (with `--constitution`), operational
law, subprocess effects, adopter policy, authority, the bound host adapters, then the CI verifier
workflow that `init apply harness --include ci` generates. The order matters: operational law
writes `domains.json`, `glob-guards.json`, `scorecard-na.json`, and `thresholds.json` from the
package, and the adopter-policy projection then lands over them, so `policy-materialization-current`
never sees a stale projection. The configuration set lands through the bind journal as one atomic
write; the doctor checks `policy-materialization-current`, `authority-enforcement`, and
`constitution-binding` then run, and unless all three pass every byte the upgrade wrote is restored
and it refuses with `INIT_UPGRADE_POSTCHECK_FAILED`. On success it records
`.devai/config/upgrade-receipt.json` beside the binding receipt: the from- and to-versions, the
applied migration ids, the retired keys (always empty), every changed file with its digest, the
refreshed stamps, the obligations, and the post-check results. Cite it from the adoption decision
record.

The upgrade is idempotent: a second run at the same version reports `no-op` and writes nothing.
Review the diff and commit the refreshed materialization with the package update. Materialized
policy is a versioned snapshot, not a link; installing a newer package does not silently rewrite
adopter-owned repository files. Do not hand-edit `.github/workflows/devai-local-rc-verify.yml`;
`doctor` treats bytes that differ from the installed generator as stale.

The individual segments remain available for stepwise diagnosis, in the same order:

```bash
pnpm exec devai init bind --target . --operational-law --as-role architect --write
pnpm exec devai init bind --target . --subprocess-effects --as-role architect --write
pnpm exec devai init bind --target . --adopter-policy law/policy/devai-adoption.json --as-role architect --write
pnpm exec devai init bind --target . --as-role architect --write
pnpm exec devai init apply harness --target . --include ci --force
```

The core CLI installs without model-provider or PostgreSQL clients. Install `openai` for the
Codex API bridge, `@anthropic-ai/sdk` for the Claude API bridge, and `pg` for database-backed
inventory, runtime probes, or translation-isolation checks. When one is absent, only the feature
that needs it returns a typed precondition with the exact install command.

## 3. Apply role-owned segments

Run only the segments your reviewed plan calls for. Each mutation requires its
declared role and `--write`.

```bash
pnpm exec devai init apply architect --target . --tier tier1 --as-role architect --write
pnpm exec devai init apply owner --target . --tier tier1 --as-role owner --write
pnpm exec devai init apply harness --target . --tier tier1 --as-role architect --write
```

Use `--force` only after reviewing the exact replacement described by a fresh plan.
Optional hook material is selected explicitly with `--include hooks` and the
corresponding hook/command options shown by `--help`. The default hook invokes the
project-local `./node_modules/.bin/devai`, never a presumed global executable.

### Instruction files

On the `tier3` profile the architect segment writes one instruction contract and one
import ([ADR-GOV-0020](../../law/adr/ADR-GOV-0020-canonical-instructions-and-host-projections.md)):

- `AGENTS.md` carries the guidance every host reads. `doctor` (check `agents-claude-sync`)
  requires it to reference Constitution Article 6, name the five roles Owner, Architect,
  Inspector, Engineer, and Auditor, and name the reading-order sources `README.md`,
  `law/constitution.md`, `law/adr`, and `law/schemas` (or their `docs.ia.path_overrides`
  targets).
- `CLAUDE.md` contains exactly one line, `@AGENTS.md`. That is the Claude Code import
  form: the imported file is expanded into context at launch, and Claude Code never loads
  an `AGENTS.md` twice, whichever project-instructions setting a session uses. The same
  check fails on any other `CLAUDE.md` content, including a copy of `AGENTS.md`.

Edit `AGENTS.md` and nothing else; the projection of a recipe under `.claude/skills/` is
generated the same way (see [Recipes](../reference/recipes/README.md)).

Version floor: Claude Code reads `AGENTS.md` natively from v2.1.277 (v2.1.281 for sessions
that could not load it before, such as Amazon Bedrock or telemetry-disabled sessions), so a
host at that release would load the contract with no `CLAUDE.md` at all. The import stays
until every maintainer host has reached that floor; its removal is a later decision record,
not this one. Verified against the published Claude Code documentation on 2026-09-29.

Guidance preservation under `--force`: `init apply --force` never overwrites `AGENTS.md`,
`CLAUDE.md`, or a `README.md` under `law/` once the file differs from the template the
bootstrap would write. A fresh plan reports `replace` for every existing file the execution
will overwrite and never `create` or `skip-exists` for such a file, so the plan and the
execution report agree before the first byte is written, and a preserved file is named as
preserved in the execution report. Before this rule the plan said `skip-exists` while
`--force` overwrote the guidance (issue #70).

After the package and policy are bound, install each selected host adapter through the binding
facade. When both are required, bind them in this order, from the checkout that will run the
post-merge hook:

```bash
pnpm exec devai init bind --target . --host-adapter github-actions --as-role architect --write
pnpm exec devai init bind --target . --host-adapter post-merge --as-role architect --write
```

This order holds in every checkout, for three reasons:

- Each host-adapter bind selects its adapter as the host-policy identity
  (`authority_enforcement.adapter_config` in `.devai/config/project.json`) and re-materializes
  `.devai/config/authority-policy.json`.
- The post-merge attestation, `.devai/config/post-merge-host-adapter.json`, records the absolute
  path of the checkout that bound it, its hook, a signature by a key kept in that checkout's git
  directory, and the digest of the authority policy. It verifies only in that checkout and only
  against the policy it pinned, so the post-merge adapter is bound last.
- The GitHub Actions adapter is the CI-verifiable one: every checkout, including the runner of
  `devai-main-observation.yml`, verifies it from the tracked workflow and configuration and the
  `origin` remote. `doctor` verifies the post-merge binding in full in the checkout that made it.
  In every other checkout it reports `POST_MERGE_ADAPTER_NOT_APPLICABLE_HERE` and rests authority
  enforcement on the GitHub Actions adapter instead; when that adapter is not bound or does not
  verify there, it fails with `POST_MERGE_ADAPTER_UNVERIFIABLE_HERE` and names the commands to
  run in the bound checkout. Any post-merge state a checkout carries itself (a key, a receipt
  issuer, or a DEVAI post-merge hook) makes doctor verify the binding there instead. A Husky
  repository tracks `.husky/post-merge`, so every one of its clones carries the hook, and doctor
  refuses the binding in each clone but the one that made it.

Do not bind GitHub Actions last to make it the selected identity. That bind re-materializes the
authority policy after the post-merge attestation pinned it, so the post-merge adapter's merge
receipts are refused as `HOST_RECEIPT_STALE`, and `doctor` warns
`POST_MERGE_ADAPTER_BINDING_STALE` in the bound checkout; rebinding the post-merge adapter
restores the order above. After a DEVAI upgrade, rebind both adapters in the same order: while a
host-adapter configuration binds an older package, `doctor` warns
`GITHUB_ACTIONS_ADAPTER_VERSION_LAG` or `POST_MERGE_ADAPTER_VERSION_LAG` and names the command.

The GitHub adapter authenticates exact-main observations with GitHub OIDC. Its workflow may write
only `refs/devai/post-merge/<sha>`, and only after both the dispatch input and repository consent
variable authorize publication. Neither adapter claims control over arbitrary editors or shell
commands. Configure the adopter repository or protected environment secret
`PACKAGES_READ_TOKEN` with read-only access to the DEVAI package. The generated, digest-bound
workflow requires that secret for package installation and fails before installation when it is
absent. It never falls back to the repository-scoped `GITHUB_TOKEN`; credentials remain
environment-only.

GitHub artifact attestations are unavailable for user-owned private repositories outside their
supported plan boundary. For that exact repository shape, the generated workflow records the
limitation explicitly and preserves provenance through the immutable Actions artifact ID, URL and
service-provided SHA-256 digest, plus a separately uploaded receipt. Other repository shapes keep
GitHub attestation mandatory and fail closed if it is not produced. An artifact-digest receipt
never claims that GitHub attestation succeeded.

Core files and requested includes are preflighted before the first write and applied
as one rollback-capable transaction. A preflight conflict writes nothing. If the
process is forcibly terminated, inspect the fresh `init plan`, remove only files that
match that plan and were created by the interrupted attempt, then rerun the segment.

### Record forbidden-action receipts without bypassing the hook

The pre-push hook runs `devai check --only forbidden-actions --strict` over the outgoing commits.
When it reports a finding the Owner has reviewed and authorized, record that decision as a receipt
in `law/policy/forbidden-action-authorizations.json`; the receipt format and its fail-closed rules
are on [Exact forbidden-action authorizations](forbidden-action-authorizations.md). Never bypass the
hook with the no-verify flag: the flag is itself a finding (`FORBID-NO-VERIFY`), and the flow below
needs no bypass.

1. Read the finding from the check output: its `forbidden_id` and the full 40-character commit
   SHA in `ref`. A receipt binds exactly that pair.
2. Obtain the Owner's authorization for that exact action and commit.
3. As the Architect, append one receipt per finding to the `authorizations` array of
   `law/policy/forbidden-action-authorizations.json`; create the file from the example on the
   authorizations page when it does not exist yet. Change nothing else in the file and nothing
   else in the commit.
4. Commit and push. The hook re-runs the check: the receipts apply to the original findings and
   the receipt commit itself produces none.

The receipt commit is clean because the canonical `forbidden-actions.json` policy declares the
registry maintenance-exempt from `FORBID-MUTATE-INVARIANTS`
([ADR-GOV-0022](../../law/adr/ADR-GOV-0022-authorization-registry-maintenance.md)). The
`FORBID-MUTATE-INVARIANTS` entry carries one `maintenance_exemptions` item naming the registry
`path`, its `schema`, the `append-only` change shape, and the `/authorizations` collection. The
scanner reads the parent's and the commit's version of the registry from the commit's own trees,
never from the working tree, and classifies the change as maintenance only when both conditions
hold:

- the resulting file validates against `law/schemas/forbidden-action-authorizations.schema.json`;
- the change is append-only: every receipt in the parent's version is present in the commit's
  version with identical bytes and in the same order, zero or more receipts follow them, and
  `schemaVersion` and every other root member are unchanged.

Maintenance produces no `FORBID-MUTATE-INVARIANTS` finding in either inspection pass, neither the
name-status pass that synthesizes a `git add <path>` line for every changed path nor the patch
pass. Everything else keeps its finding, so no receipt ever covers the commit that introduces it:

- removing, editing, or reordering an existing receipt, or changing `schemaVersion` or a root key;
- a resulting file that fails the schema, including an unknown field or a partial SHA;
- any other `law/`, `product/`, `record/`, or `.devai/config/` path in the same commit, which is a
  finding for that path;
- a commit message that matches a forbidden pattern.

Withdrawing an unused receipt is therefore not maintenance. Make it in its own Architect-owned
commit; when the check reports that commit, record the Owner's receipt for it the same way.

Adopters do not edit `.devai/config/forbidden-actions.json` to obtain the exemption: the
declaration ships in the canonical policy and reaches the repository through
`init bind --operational-law` as a byte-identical materialization. Releases that predate
ADR-GOV-0022 (1.6.0 and earlier) report the receipt commit as a finding (#67); upgrade rather
than bypass.

## 4. Diagnose and inventory

```bash
pnpm exec devai doctor --repo-root . --format json
pnpm exec devai sense inventory --slice pack --repo-root . --adopter-root . --format json
```

Diagnosis and inventory are observations. A PASS applies only to the exact inputs
and freshness bound represented by its result.

For one exact commit, the Auditor facade regenerates the complete non-promoting observation in
one operation. Deterministic triage accepts one schema-valid SensorReading and records its route;
an inconclusive reading always escalates to a human.

```bash
pnpm exec devai audit observe --repo-root . --at <full-sha> --as-role auditor --write --format json
pnpm exec devai triage classify --repo-root . --input <reading.json> --as-role inspector --write --format json
```

### Which check members apply to an adopter

Every `devai check` member declares where it applies
([ADR-CHK-0005](../../law/adr/ADR-CHK-0005-check-member-applicability.md)); the
declarations and the result contract are on
[Check suites](../reference/cli/check-suites.md#where-a-member-applies). In an adopter:

- `action-coverage` evaluates your repository: the actions your invariants claim through
  `measurable_via` and the actions referenced in your tree. With no action in scope it reports
  `review` with `CHECK_MEMBER_POPULATION_EMPTY`, never an empty pass.
- `action-effects`, `cli-reference`, and `prompt-overlays` read only the framework's own policy
  and catalogue. They return the structured not-applicable result, `status: "na"` with
  `CHECK_MEMBER_NOT_APPLICABLE`, and are unmeasured in an adopter until a later record declares a
  package-owned input mode. Do not copy `law/policy/subprocess-effects.json`,
  `law/policy/documentation-information-architecture.json`, or `tests/config/tsconfig.effects.json`
  into your repository to turn them green.
- Every other selector, and the `ledger-local` and `ledger-rc` suite members, reads your
  repository or your explicit inputs and executes. A source it needs that is missing, such as
  `docs/` for `docs-links` or `test-tasks.json` for the ledger members, is that member's own
  failure with its named code; it never becomes not-applicable.

DEVAI identifies the repository kind from the bound configuration, not from the directories
you have: your tree is an adopter when `.devai/config/adopter-policy-binding.json` carries a
`policy_id` other than the framework's own `devai.devai-adoption`. Keep your `policy_id` in your
own namespace. That receipt is written only by `init bind --adopter-policy <file>`; the
`--constitution`, `--operational-law`, `--subprocess-effects`, and plain `init bind` steps above
do not create it. An adopter bound only through those steps is unclassified and fails closed:
`action-coverage` and every `self` member return `CHECK_REPOSITORY_KIND_INVALID`, and nothing
defaults to adopter or to not-applicable, so bind an adopter policy before you test the
classification.

Test the classification once after binding and again after each upgrade. Run each of the three
members through `--only`, read `status`, `code`, and `value.repository_kind` from the result, run
each command twice and compare the outputs byte for byte, and confirm with `git status --porcelain`
that nothing was created beneath the root:

```bash
pnpm exec devai check --only action-effects --repo-root . --format json
pnpm exec devai check --only cli-reference --repo-root . --format json
pnpm exec devai check --only action-coverage --repo-root . --format json
```

The first two return `na` with `repository_kind: "adopter"` and `kind_evidence` naming the
binding receipt; the third returns `pass`, `fail`, or the explicit empty-population `review`.

## 5. Declare the adopter test DAG

DEVAI does not guess a project's build or test commands. Create and review the
adopter-owned `test-tasks.json` first; see [Task DAG configuration](test-tasks.md).
Then affected planning is available:

```bash
pnpm exec devai check --affected --task-plan --base <exact-base-commit> --format json
```

Without the descriptor, `check --affected`, `--local`, and `--rc` return the dedicated
`CHECK_TASK_DESCRIPTOR_MISSING` precondition diagnostic and never invent commands.

## Remove DEVAI

First remove hook marker blocks (or the whole DEVAI-created hook if it contains no
other project logic). Then remove `.agents/skills/devai-*`, `.claude/skills/devai-*`,
the reviewed DEVAI-owned `.devai/` materialization, and empty generated
`record/proofs`, `record/derived/inventory`, and `scratch/worktrees` directories.
Preserve non-empty evidence, inventory, project configuration, and shared hook content
until a maintainer has archived or deliberately disposed of it. Finally remove the
package dependency and the GitHub Packages `.npmrc` entry if nothing else uses it.
