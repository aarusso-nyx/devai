# Changelog

## 2.3.0 — 2026-10-08

DEVAI 2.3.0 lets the check runner run independent plan nodes in parallel, and splits the pull-request
gate into two partition jobs behind the single required check `devai-release-gate` (CMP-0007). Both
gate cells read PASS on main e43e8db9:

- F5:T7 at a 786 s median, against the new 900 s target;
- F5:T9 at 121 of 121 final heads green, under its new per-pull-request definition.

No commit since v2.2.0 carries the breaking marker, and the range includes features, so the commit
grammar's bump floor is minor. The action set stays at 69. Three adopter migration entries cover the
adopter files this release changes.

- Adopter migrations (`init upgrade` from 2.2.0):
  - `MIG-2.3.0-subprocess-effects-pr-list` (rebind). The subprocess effects registry declares the
    read-only `gh-pr-list-all` template, every token literal:
    `gh pr list --state all --limit 1000 --json closedAt,headRefName,headRefOid,mergedAt,number,state`.
    Rebinding subprocess effects materializes it.
  - `MIG-2.3.0-parallel-check-scheduling` (opt-in). Nothing changes until the repository commits a
    `test-task-exclusivity.json`.
  - `MIG-2.3.0-green-main-final-head` (opt-in). Nothing changes until the `harness_green_main`
    declaration sets `outcomeUnit`.
- Parallel check execution (ADR-CHK-0007, #352, #353, #360):
  - **Workers.** `check --run` accepts `--task-workers <n>` (1 to 16). Without it,
    `DEVAI_CHECK_TASK_WORKERS` sets the count. A set but empty variable is refused with
    `CHECK_RUNNER_WORKERS`, and so is any other invalid value, before a node starts. The default is
    `min(4, CPUs)`.
  - **Sequential runs.** Only `--affected`, `--preflight` and `--local` run with more than one worker.
    `--rc`, `--release-intent` and protected runs stay sequential.
  - **Same results.** Reports and receipts list nodes in plan order. Per-task timeouts are unchanged,
    and a failure cancels nothing. The node set and verdict equal a sequential run's.
- Shared state is declared in `test-task-exclusivity.json`, beside `test-tasks.json`, against the new
  `test-task-exclusivity.schema.json`:
  - each node lists the `exclusive` and `shared` keys it holds;
  - a node with no entry conflicts with every node, so a repository without the file runs one node at
    a time;
  - output-path overlap and a shared `DEVAI_DB_URL` also serialize;
  - a malformed file, a non-file entry, or a declaration naming an unknown node is refused with
    `CHECK_RUNNER_EXCLUSIVITY`;
  - the runner reads the file as committed at the planned commit, never from the working tree.

  The file stays out of `test-tasks.json`, so release export and certification read the descriptor
  unchanged (ADR-CHK-0006).

- `test-task-descriptor.schema.json` is now closed at the top level and on each task. A misspelled or
  unknown task property is refused instead of ignored (#353).
- Partitioned gate (ADR-CHK-0007 rule 11, #355):
  - **Flags.** `check --run --affected|--local` accepts `--partition-include <ids>` or
    `--partition-exclude <ids>`.
  - **Same plan.** Both partitions plan the same nodes with the same digests.
  - **Reports.** Each report lists every node as owned, prerequisite or `partitioned-out` (outcome
    `SKIPPED`). The verdict covers owned entries only, and a partitioned run writes no receipt.
  - **Refusals.** A partition under `--rc`, `--release-intent` or a protected run, both flags
    together, or an unknown node id is refused with `CHECK_RUNNER_PARTITION`.
  - **DEVAI's own gate.** It runs `gate-cli` (`test:cli`) and `gate-rest` (everything else) in
    parallel. The aggregator job `devai-release-gate` passes only when the two reports own every
    planned node exactly once, as PASS.
- `harness_green_main` gains the optional `outcomeUnit` (ADR-SCR-0014, #366):
  - `run`, the default, keeps the ADR-SCR-0010 population.
  - `pull-request-final-head` counts each merged, closed or open pull request once. Its outcome is
    the latest completed, non-cancelled run on its final head, matched by head branch and sha. The
    minimum sample then counts pull requests.

  DEVAI declares the second unit, so F5:T9 measures the gate per candidate rather than per push.

- `harness_performance` passes F5:T7 at a median below 900 s, up from 600 s; p95 and the REVIEW
  bounds are unchanged (CMP-0007 decision D6, #356). This is a package default: an adopter keeps it
  unless its `extractor_params.harness_performance.thresholds` override sets another value.
- The `ci-economy` path-filters advisory exempts push workflows that check nothing out (#363).
- Repository process for DEVAI's own source (no adopter effect):
  - **Rebase-only update branch (ADR-CHK-0008, #358).** `update-pull-request-branches.yml` rebases
    open pull requests onto main through a GitHub App (#363). It does nothing until the App is
    provisioned.
  - **Commit-range check (#362).** It refuses merge commits in a pull-request range. It also checks
    each commit's author against the author-path table and its committer against the admitted list,
    which includes the update-branch App.
  - **Pre-push preflight (#361).** It is opt-in: install it with `pnpm run hooks:install -- --pre-push`.
  - **Bootstrap cache (#357).** A gate cache hit that lacks its compiled `dist` rebuilds, completing
    #247.
- Self-scorecard `SC-20261007T203104-001` (#349) has no FAIL cell. Its F4:T4 REVIEW came from one
  unclaimed inventory surface, `packages/cli/src/error-code-prefixes.ts`. The trace now claims it
  under INV-CORE-001 (#350).
- The consumer install guidance names the published 2.2.0 (#348). It moves to 2.3.0 after
  publication.
- Release: this release is verified by the trusted local-RC verifier `@aarusso-nyx/devai@1.9.0`,
  unchanged.

## 2.2.0 — 2026-10-07

DEVAI 2.2.0 turns every backlog, task, round and tracking failure into a schema-valid refusal envelope
that carries its own code, and declares each error code's class and exit instead of guessing them.
`audit observe` gains `--previous`. The commit grammar's bump floor since v2.1.0 is minor because of
that new option (ADR-REL-0027); no commit carries the breaking marker. The action set stays at 69, and
no adopter configuration changed, so this release has no adopter migration entry and `init upgrade`
from 2.1.0 only restamps the bound version.

- Adopter-visible exit changes. Under `--format json` the action wrapper used to replace these codes
  with `ACTION_INVOCATION_REFUSED`, `ACTION_PRECONDITION_UNSATISFIED` or `ACTION_OUTPUT_CONTRACT_VIOLATION`
  (exit 7); the envelope now carries the command's own code, and the process exit equals the envelope
  exit (#338, #342, #343):
  - backlog: `BACKLOG_ITEM_NOT_FOUND`, `BACKLOG_ITEM_ALREADY_RESOLVED` and
    `BACKLOG_ORIGIN_COMMIT_UNAVAILABLE` exit 5 (precondition) instead of 1; every other backlog code
    keeps exit 2;
  - backlog, task, round and tracking: a failure keeps its own code only when it is a DEVAI code
    (a prefix the error-code reference scans); an unanticipated error (a malformed item, an opaque
    throw, or a host error such as `ENOENT: no such file` from `round close --input`) is
    `BACKLOG_OPERATION_FAILED`, `TASK_OPERATION_FAILED`, `ROUND_OPERATION_FAILED` or
    `TRACKING_OPERATION_FAILED` with exit 6 (infrastructure) instead of 2, with the original text in
    `context.message` (#343);
  - `operation`, `detail`, `removal` and `uncertain` move into the envelope `context`, and a composite
    `CODE:detail` keeps `CODE` with the detail in `context.code_detail`;
  - `init plan --mode <invalid>` refuses `INIT_INTERACTIVE_MODE_INVALID` with exit 4 (invalid-input);
    it used to throw instead of refusing.
- `devai backlog show <id>` and `devai backlog resolve <id>` route through the installed binary; the
  router refused the documented positional id with `ROUTE_UNEXPECTED_ARGUMENT` (#338).
- Error-code reference: each code's class and exit is declared from its emitter (literal envelope
  constructors, the action-output wrapper, the authority renderer, the router and the task, round
  and tracking throw sites) and checked by a contract test against the emitting code and
  `error.schema.json`; a code raised only inside a message reads `per action`. The reference now scans
  the `BACKLOG`, `MODEL`, `TRACKING`, `GIT` and `HOST` prefixes (1120 codes), so the `GIT_*` and
  `HOST_RECEIPT_*` codes raised by round and task operations stay their own codes in the refusal
  envelope (#343).
- Audit observation (#335, #341): `audit observe` links each bundle to the nearest observed ancestor
  in the evidence chain and computes its additions and completions against it; `--previous <sha or
SC- id>` names the previous observation (`AUDIT_OBSERVE_PREVIOUS_*` refusals). A replay keeps the
  recorded link, so it stays byte-identical.
- Coverage (#336, #340): a reused coverage report is bound to the candidate commit, the full-suite
  producer run and its digest; a stale or partial report is discarded and the producer reruns
  (`COVERAGE_REPORT_UNBOUND`). With the 2.1.0 coverage-guard fix, F3:T2 reads PASS.
- The documentation site's build-time dependencies override the patched `proxy-addr`, `shell-quote`,
  `tinypool`, `compression`, `source-map-js`, `joi` and `postcss-selector-parser` releases (#339,
  shipped in 2.1.0 after its notes were written).
- Release: this release is verified by the trusted local-RC verifier `@aarusso-nyx/devai@1.9.0`,
  unchanged.

## 2.1.0 — 2026-10-07

DEVAI 2.1.0 closes the follow-ups filed against 2.0.0 (#285–#299 and the issues found since):
experimental agent attempts are confined by the provider sandbox, locks, records and the worktree
registry are published without replacement, and the post-merge host adapter keeps its
checkout-bound state out of tracked configuration. No commit since v2.0.0 carries the breaking
marker and the range includes features, so the commit grammar's bump floor is minor. The action
set stays at 69.

- Adopter migration `MIG-2.1.0-post-merge-local-state` (#266, #291): the post-merge attestation
  (checkout path, hook path, HMAC over the checkout key) moves to
  `<git-dir>/devai/post-merge-host-adapter.json`, and the tracked
  `.devai/config/post-merge-host-adapter.json` becomes a path-free declaration. `init upgrade`
  converts a committed attestation: the checkout holding the key moves it into its git directory,
  keeping `installed_at_head` while it still verifies, and every other checkout only rewrites the
  declaration. `doctor` reports `POST_MERGE_ADAPTER_NOT_BOUND_HERE`,
  `POST_MERGE_ADAPTER_UNVERIFIABLE_HERE` and `POST_MERGE_ADAPTER_DECLARATION_LEGACY`; the codes
  `POST_MERGE_ADAPTER_NOT_APPLICABLE_HERE` and `POST_MERGE_ADAPTER_LOCAL_STATE_PRESENT` are retired.
- Provider sandbox (ADR-MDL-0008, amends ADR-MDL-0005, #290): `codex-cli` attempts run with
  `--sandbox workspace-write` rooted at the attempt worktree and no network, `claude-cli` attempts
  with `--restricted` and a fail-closed sandbox setting. The broker rebuilds and asserts the whole
  confinement argv, dispatch refuses `EXPERIMENTAL_SANDBOX_UNAVAILABLE` before any lock or
  worktree on a runtime that cannot be confined, and each attempt's evidence records the
  `sandbox` descriptor.
- Atomic no-replace publication (ADR-AUT-0005, #286, #287, #293): a governed `link()`-based
  publication effect backs create-only records, the experimental activation lock, fresh resource
  locks (#310) and recipe adapter files. Every change to `.devai/state/worktrees.json` runs under
  a published registry lock (`WORKTREE_REGISTRY_BUSY`, `WORKTREE_REGISTRY_LOCK_STALE`, never taken
  over). `init apply harness` publishes `.devai/state/state-root.json`, and `round dispatch`
  refuses `EXPERIMENTAL_STATE_ROOT_UNINITIALIZED` until it exists: an adopter using experimental
  dispatch runs `init apply harness` once.
- Lock lifecycle (#285, #288, #296): a task left waiting outside a dispatch holds its locks on a
  seven-day waiting lease; completion, `task finish` and `round ratify --decision accept` first
  prove that every declared lock is still the task's own. An unconfirmed process-group
  termination writes a durable quarantine record under `.devai/state/lock-quarantine/` that holds
  the task's locks. Release receipts are created exclusively and fsynced, and orphaned receipts
  are removed at reconciliation.
- Review reserve and campaign agents (ADR-MDL-0009, #297): with more than one worker, one is
  reserved for an admissible inspector or auditor task of the same generation. A campaign task may
  declare an agent `executor`, and `campaign materialize` checks its discipline, runtime, effort
  and model before writing (`CAMPAIGN_AGENT_*`).
- `task finish` on an agent task resolves every merge-evidence reference against the verified
  evidence chain, refuses records bound to another task or round, and a retry from `merging`
  must match the recorded completion (`TASK_MERGE_EVIDENCE_REQUIRED`, `TASK_COMPLETION_CONFLICT`,
  #319).
- `backlog add` (#306, #307): the stored origin role is the admitted invocation role
  (`BACKLOG_ROLE_MISMATCH`, `BACKLOG_ROLE_REQUIRED`); the round projection write is declared in
  the registry and a retry with the same `--request-id` completes a missing projection event.
- Recipe adapter install (#313, #317): targets are rechecked without following links before each
  write, files are published without replacement under `.devai/state/recipe-adapters.lock`, and a
  failure rolls back only what the install created, by identity. An escape outside the repository
  is reported (`RECIPE_INSTALL_ESCAPE_DETECTED`) and never deleted.
- Review bridge (#249, #321): hosts start in an empty private workspace with the agent
  environment allowlist; a completed `claude` structured reply is accepted; the strict reply
  projection is shared. Codex reviews first check the installed binary and its disabled features
  (`MODEL_BRIDGE_CODEX_INCOMPATIBLE`) and run with `agents.enabled=false`, so no sub-agent tools
  are offered (#332); the offline `scripts/codex-review-probe/` captures the tools a review is
  offered without a provider call, and is rerun after a codex upgrade. The adopter authority policy adds
  `adopter-remote-sense-run-llm-1`, so the `llm_judge` host CLI invocation under `sense run` is
  classified; adopters re-bind the authority policy (`init upgrade` does so).
- Sensors and scorecard: `inventory_regeneration` binds to the git tree at a clean HEAD and
  refuses `INVENTORY_REGENERATION_SNAPSHOT_CHANGED` (#294); a failed coverage producer names the
  failing test files (#236); `harness_coherence` proves workflow effects through a closed
  concurrency grammar and a reviewed-step registry (#325); the pull-request preflight adds
  fail-closed producers for INV-DEVAI-010 and INV-HARNESS-010 (#235), using the new
  `sense inventory --packs-root` flag; `stack-adapter.schema.json` joins the runtime schema
  roster. The third and fourth self-scorecards, `SC-20261006T141503-001` (#237, #320) and
  `SC-20261006T215814-001` (#333, PASS 36, REVIEW 4, FAIL 1, UNKNOWN 1, N/A 3), are recorded.
- Invariants and dead code (#295): eight new invariant records claim the previously unclaimed
  inventory surfaces; unreachable CLI `docs` and utils modules are removed, and
  `evidence render --out` writes only under `.devai/state/render`.
- Codex token accounting counts cached input once (#289). The check runner's per-task default is
  30 minutes and `release-prerequisites` passes `--task-timeout-ms 1800000` (#299).
  Load-sensitive tests run in a serial lane with one deadline per bounded case and process-group
  kills (#246, #324), with a 64 MiB capture cap per bounded child (#337); durations use a
  monotonic clock. The error-code reference now covers the `BACKLOG_*` and `MODEL_BRIDGE_*`
  codes.
- Release: this release is verified by the trusted local-RC verifier
  `@aarusso-nyx/devai@1.9.0`, unchanged from 2.0.0.
- Known limitations: DEVAI asserts the provider sandbox flags but does not observe the provider's
  kernel sandbox, and provider temporary directories stay writable. The Codex review tool surface
  is verified offline for codex-cli 0.157.1; a codex upgrade needs a probe rerun (#332).

## 2.0.0 — 2026-10-05

DEVAI 2.0.0 marks the governed orchestrator: the round runner becomes a bounded controller with
deterministic admission and race-free locks, and an Owner can opt a repository into experimental
agent execution. Worktree capacity matches `max_workers` within a round; admission across
concurrent rounds is not yet serialized (see the known limitations below). No commit since v1.9.0
carries the breaking marker, so the commit
grammar's bump floor over this range is minor; the major version is the Owner's decision, taken
because adopters see changed round-runner behavior and a new class of governed operations. A
repository that never writes an activation record keeps the supported serial runner, under the
stricter lock and controller rules below.

- Adopter-visible changes to `round run` (`law/policy/round-execution.json`, ADR-MDL-0006):
  - Runtime locks cover every declared `(substrate, module)` pair (Constitution Article 25), taken
    all-or-nothing in canonical order and renewed during a dispatch, so an F2 and an F3 lock on one
    module no longer conflict and a displaced lock fails the task (`TASK_RESOURCE_LOCK_LOST`).
  - A second controller for one round refuses with `TASK_ROUND_CONTROLLER_BUSY`. A crashed
    controller is reclaimed only when it provably died on this host.
  - A lock-denied task returns to `ready` with priority +1, and the third consecutive denial
    escalates it (`TASK_RESOURCE_LOCK_DENIED`, `TASK_RESOURCE_LOCK_DENIED_REPEATED`).
  - Admission is deterministic: topological generation, discipline, priority and identifier set the
    order, a dependent runs only after a durably `completed` upstream record, and malformed or
    drifted records and duplicate identifiers refuse before anything runs.
  - `round run --workers <n>` opts into up to four same-generation, resource-disjoint tasks
    (`TASK_GENERATION_BARRIER`, `TASK_WORKER_CAP_INVALID`); the default stays one.
  - Every action except the experimental ones refuses the `--experimental` flag
    (`AUTHORITY_DECLARATION_NOT_APPLICABLE`).
- Lock-claim protocol (#280): lock, controller and denial records change by a claimed
  compare-and-swap on the exact observed record, so a takeover, a renewal or a reclamation can no
  longer overwrite another holder's record. A live claimant is never displaced: on this host only
  a dead process or a later boot proves one gone, and anything else refuses with
  `TASK_RECORD_CLAIM_STALE` until a person removes the named file. Each dispatch attempt opens a
  durable lock fence, and the next run judges the fences a stopped runner left: a lock lost in
  between withdraws a completion or escalates the task (`TASK_RESOURCE_LOCK_LOST`, reported as
  `reconciled`), and a malformed fence refuses the run (`TASK_LOCK_FENCE_INVALID`).
- Experimental agent execution (ADR-MDL-0005, ADR-MDL-0006): the Owner records an expiring
  activation with `round dispatch activate`, and `round dispatch --write --experimental` runs
  admitted engineer and inspector agent tasks through `claude-cli` or `codex-cli`. Each task
  gets a prompt composed deterministically from `AGENTS.md`, a packaged role charter, the task
  record and its recipe (a task without `recipe_name` refuses with `PROMPT_RECIPE_REQUIRED`), up to
  three attempts at the requested model and one at the next tier, each in a fresh worktree with an
  Article 6 write-scope check and a hash-linked journal. Usage evidence is version 2, so a missing
  counter or cost is never recorded as zero. Results await human review and carry
  `experimental: true`; nothing is pushed, merged or retried automatically.
- Agent hardening: provider processes run with an explicit environment allowlist, malformed or
  truncated provider output never passes (`AGENT_CLI_OUTPUT_MALFORMED`,
  `AGENT_CLI_OUTPUT_TRUNCATED`), a failed journal write after the provider started stops its
  process group (`AGENT_CLI_SPAWN_RECORD_FAILED`), a routine task that times out is escalated
  (`TASK_ROUTINE_TIMED_OUT`), and a process group still alive after SIGKILL is reported as
  `PROCESS_GROUP_TERMINATION_UNCONFIRMED` instead of being cleaned up under a running writer.
- Campaigns and completion (ADR-GOV-0025, ADR-MDL-0007): `campaign status` projects a campaign
  plan onto runtime state and names drift; `campaign materialize` writes an open round's tasks
  through the single queue; `round ratify` records the Owner's or Architect's decision on reviewed
  work, separate from merge. An agent task completes through `round ratify --decision accept`, the
  human merge, then `task finish --evidence EV-…`.
- Recovery (Owner-only, `--write --experimental`): `round dispatch dispose --task T --as retry|escalate`
  and `--quarantine-journal` clear uncertain, blocked or damaged experimental work through a
  recorded disposition, and `round dispatch deactivate` withdraws the activation with a
  withdrawal record. `task escalate` on an agent task also takes the round controller. Retained
  review, blocked and uncertain worktrees hold no worktree capacity.
- Known limitations:
  - Experimental execution (opt-in and non-promoting; the full list is under "Known limitations of
    experimental execution" in `docs/reference/cli/round-task-executors.md`): write-scope checks
    compare worktree snapshots, so runtime filesystem enforcement belongs to the host sandbox and
    the provider's containment is recorded as requested, never as verified; the state root must
    exist first (`init apply harness`); and concurrent writers of one record, and the worktree
    registry across processes, are not yet serialized.
  - Locks: a lock is not renewed while a task waits outside a dispatch, in `merging` or
    `awaiting_human_review`, so a one-hour lock can expire and another task may take the module;
    and a completion recorded outside a runner dispatch with `task finish` is not fenced against a
    lock takeover.
- `init upgrade` (#264): an Architect plans, and with `--write` applies, the move from the bound
  `devai_version` to the installed version from the shipped migration manifest. It refuses an
  undeclared key retirement before any write, rolls everything back if a post-check fails, and
  records `.devai/config/upgrade-receipt.json`; a second run is a no-op.
- Doctor (#265, #266): `docs-ia.workflow-page-set` honors `docs.ia.path_overrides`; a post-merge
  binding made in another checkout is reported as not applicable there only when this checkout
  holds no post-merge state of its own, otherwise it is verified and refused; host-adapter
  configs that lag the installed version warn (`POST_MERGE_ADAPTER_VERSION_LAG`,
  `GITHUB_ACTIONS_ADAPTER_VERSION_LAG`) through the new optional `CheckResult.warnings` field.
- Scorecard gate invariants (ADR-SCR-0013, refs #235): the pull-request preflight step ends with
  two fail-closed producers, `sense run trace_resolution` and `audit scorecard --at <head>`. The
  invariant-alignment sensor now reads a here-document fed to a program as that program's input,
  observes the exact-head scorecard at the candidate, and binds a stored reading through the
  receipts that name its current bytes; `sense record` appends one digest-bound receipt per
  candidate head. The measured F5:T4 verdict comes from the next recorded scorecard.
- Scorecard inventory (ADR-SCR-0012, #237): `sense run inventory_regeneration` regenerates
  DEVAI's own F4 inventory from the clean HEAD commit (the combined manifest, the dependency
  graph and the coverage matrix under `.devai/state`), publishes the set atomically, and reads
  `up-to-date` on a repeat. `inventory_adherence` reads UNKNOWN with
  `INVENTORY_ADHERENCE_INPUT_INVALID`, `INVENTORY_ADHERENCE_INPUT_STALE` or
  `INVENTORY_ADHERENCE_NO_SURFACES` rather than measure the wrong subject, so F4:T4 and F4:T9
  stay measured cells with no N/A declaration.
- Release: this release is verified by the trusted local-RC verifier
  `@aarusso-nyx/devai@1.9.0`; the ledger and release lanes restate that verifier version, and
  the publishable closure admits stable majors above 1.
- The action set grows from 61 to 69: `round dispatch activate`, `round dispatch`,
  `campaign status`, `campaign materialize`, `round ratify`, `round dispatch dispose`,
  `round dispatch deactivate`, `init upgrade`. The runtime schema roster adds the
  experimental-execution, activation, dispatch-journal, prompt-composition, campaign and
  adopter-migrations schemas.

## 1.9.0 — 2026-10-03

- Sense and audit (CMP-0004): every new reading file gets its own chain entry and the sweep runs
  in two ordered passes; the auditor resolves readings from the bound checkout store; the harness
  population is sampled through the admitted `gh run list` shapes; `test_coverage_depth` measures
  the declared local population and reads a refused or nested producer as UNKNOWN
  (`COVERAGE_PRODUCER_REFUSED`, `COVERAGE_PRODUCER_RECURSION`, #242); the Pages journal verdicts
  and the build precedence are read by the drift sensor.
- Evidence (ADR-EVI-0002, ADR-EVI-0005): every proof line is cross-checked against the chain with a
  gated anchor baseline and Architect historical-gap declarations; the rounds index is rendered
  from phase closures with `--check`; `evidence record` recovers an unanchored newest line after
  validating prior anchors (#239).
- Loop: round seal and closure resolve membership from exact terminal rows of the rounds index
  (#238).
- Review bridge (ADR-MDL-0003): structured replies need an affirmative completion, and a provider
  json body must agree with the reply text.
- CLI: `action_effect_inference` reads UNKNOWN with `ACTION_EFFECT_INFERENCE_INPUT_MISSING` in an
  adopter without the effects policy (#254); a refused `sense run` process names the sensor and
  `.devai/config/sensor-inputs.json` (#241); the inline `sense run --preset=<name>` form is refused
  with `SENSE_SELECTION_INVALID` (#252).
- Release: the evidence verifier is re-vendored from devai-verifier `8b215d70` with the
  release-intent certify export (ADR-REL-0031); this release is verified by the trusted local-RC
  verifier `@aarusso-nyx/devai@1.5.4`, and after publication the pin moves to
  `@aarusso-nyx/devai@1.9.0` (#243).
- Pages publication is split into a cancellable read-only `prepare-site` job and a serialized
  journal-bound `publish-site` job (ADR-REL-0034, #234).
- The error-code reference covers every package source (#250); the thresholds schema bounds
  freshness windows to 1–8760 hours; dependency audit is clean, with `lint-staged` 17 and no
  `libxmljs2` (#233).

## 1.8.0 — 2026-09-30

- ADR-GOV-0024: constitution 1.0.2 amends Article 6 so an adopter repository may declare client
  extensions by root and path class; the core path rows are unchanged and the framework declares
  no roots (#186).
- ADR-AUT-0003: an optional closed `authority` block in the adopter policy names the roots, the
  test selectors (package defaults `**/*.spec.*`, `**/*.test.*`, `**/test/**`, `**/tests/**`), and
  the architecture selectors; `init bind` compiles it on the fixed ladder root 500 (Engineer),
  test 700 (Inspector), architecture 750 (Architect) into a second additive extension, records it
  as `authority_extension` in the binding receipt, refuses a malformed block with named
  `ADOPTER_AUTHORITY_*` codes before any target is staged, refuses every governed write until
  rebind when the source drifts, and refuses an extension tie as `AMBIGUOUS_POLICY_MATCH` (#186).
- ADR-AUT-0004: each class carries the registered write verbs derived from the action registry
  (root `task start`; test `check`; architecture `init apply architect`, `release export`,
  `round plan`, `round seal`); the action registry is unchanged (#186).
- Doctor reports adopter extension drift as a set of reason ids (`AUTHORITY_EXTENSION_DRIFT`,
  `AUTHORITY_EXTENSION_UNBOUND`, `AUTHORITY_EXTENSION_SOURCE_MISSING`) with the rebind command; the
  installed package ships the adopter defaults and the authority broker, and the installed smoke
  proves the class-verb matrix from the tarball.
- Retain immutable `@aarusso-nyx/devai@1.5.4` as the trusted local-RC verifier provider; the
  verifier payload is unchanged.

## 1.7.0 — 2026-09-30

- ADR-SCR-0011: admit every sweep read kind in the packaged `SensorReading` schema
  (`decision_record_integrity`, `decision_citation_resolution`, `archive_immutability`,
  `round_record_integrity`), keep the five schema-only legacy values as legacy, declare the
  registry-schema admission invariant with an intentionally-unsupported marker refused before a
  sensor starts, and keep the file enum as the runtime authority (#184).
- ADR-REL-0033: prove the scorecard readings route from the packed artifact in a disposable
  adopter (`release:packed-adopter`); the scorecard store rejects unparseable and schema-invalid
  readings with named codes instead of counting them (#185).
- ADR-EVI-0003: `round status` reads a sealed round's lifecycle without an active task round,
  validates the close state, and attaches the task summary only when the task round is active;
  `TASK_ROUND_INACTIVE` applies to dispatch only (#175).
- ADR-CHK-0005: every check member declares where it applies; a framework-only member reports a
  structured `not-applicable` result in an adopter, `action-coverage` evaluates the detected
  scope and reports an empty population explicitly, the repository kind comes from the bound
  adopter-policy receipt and fails closed when unbound (#187).
- ADR-CHK-0003, ADR-CHK-0004: a planning lane validates plan-class pull requests with the check
  runner restored from cache and the campaign check, and integration is serialized by the
  campaign checker while the merge queue is unavailable (#166).
- ADR-CFG-0002, ADR-GOV-0020, ADR-GOV-0022: `init bind` projects owned keys from the ownership
  matrix and lands the binding atomically, `CLAUDE.md` is the `@AGENTS.md` import with skills
  generated from one canonical source, and validated append-only registry maintenance is exempt
  from the forbidden-actions scanner (#68, #70, #67).
- ADR-GOV-0023, ADR-MDL-0001, ADR-MDL-0002: campaign review mode with schema-validated model
  replies read through one shared extractor, and versioned model tier defaults pinned at task
  start.
- ADR-REL-0030, ADR-REL-0032, ADR-GOV-0021: merged gated release jobs with the control commit
  shown before the first stop, resumable Pages publication from the deployments journal, one
  reference page per workflow under a completeness gate, and a generated decision catalogue
  (#165, #167, #162).
- Self-scorecard sensing: `sense run` resolves declared inputs and surfaces for the bound sensors,
  runs the declared unit, integration, e2e, perf, and type-check argv without a shell, reads the
  canonical readings store, and records all-skipped cells N/A by declaration.
- Retain immutable `@aarusso-nyx/devai@1.5.4` as the trusted local-RC verifier provider; the
  verifier payload is unchanged.

## 1.6.0 — 2026-09-26

- ADR-CHK-0002: declare toolchain identity in one manifest that workflows and preflight probes
  consume, replacing pins scattered across scripts and CI (#95).
- ADR-GOV-0017: classify every tracked path into one change class declared in law, giving commits
  and checks a shared, closed vocabulary (#96).
- ADR-GOV-0018, ADR-REL-0027: require semantic commit messages under a closed type grammar, forbid
  commits that cross change-class families, and retire the unused changeset mechanism in favor of a
  commit-derived version-bump floor (#97).
- ADR-REL-0028: declare a prerelease channel ladder of alpha, beta, and rc rungs, each with its own
  dist-tag and required verification capability (#98).
- ADR-GOV-0019: add a repository backlog action family with an opt-in GitHub Issues projection (#99).
- ADR-CHK-0001: execute preflight probes as task DAG nodes with a `BLOCKED` outcome, reducing the
  pull-request workflow to a three-step lane (#100).
- ADR-SEC-0001: declare a credential requirements manifest and probe presence, scope, and expiry
  through the consuming tool's own status command without reading values (#101).
- ADR-CFG-0001: author the init plan through schema-driven prompts that replay as the existing
  bind and apply actions and print the exact argv they executed (#102).
- Record the CMP-0001 workflow-economy campaign contract and its activation plan with accepted
  records and model tiers (#92, #94).
- Retain immutable `@aarusso-nyx/devai@1.5.4` as the trusted local-RC verifier provider; the
  verifier payload is unchanged.

## 1.5.7 — 2026-09-26

- Bind check-runner task keys to the descriptor as authored in `test-tasks.json`. Mutation
  retirement still removes mutation tasks from selection, but the descriptor digest no longer
  hashes the stripped copy, so an adopter that keeps an optional manual `test:mutation` node gets
  the same RC task policy the package-owned verifier reconstructs, and local RC export no longer
  fails with `POLICY_DIGEST_MISMATCH`.
- Task keys change once for descriptors that contain retired mutation tasks; all other
  descriptors keep identical keys.
- Retain immutable `@aarusso-nyx/devai@1.5.4` as the trusted local-RC verifier provider; the
  verifier payload is unchanged.

## 1.5.6 — 2026-09-22

- Materialize the immutable proof commit as an inert archive before strict bundle verification so checkout-owned Git administration is excluded without weakening bundle population checks.
- Preserve every versioned proof file in that archive, keeping undeclared ordinary files fail-closed under `BUNDLE_POPULATION_MISMATCH`.
- Preserve verifier failures in release summaries when the structured diagnostic is emitted on stderr and stdout is empty.
- Retain immutable `@aarusso-nyx/devai@1.5.4` as the trusted local-RC verifier provider.

## 1.5.5 — 2026-09-22

- Promote immutable `@aarusso-nyx/devai@1.5.4` as the trusted local-RC verifier provider so
  generated adopter workflows use the released zero-artifact snapshot correction.
- Prove a zero-artifact protected proof still verifies after Git materializes the proof checkout
  without an empty `artifacts/` directory.
- Preserve exact population, digest, signer, package, release-source, and provenance checks while
  rejecting every undeclared artifact.

## 1.5.4 — 2026-09-21

- Materialize the verifier's empty artifact snapshot root so valid RC schema 1.1 bundles with an
  exact zero-artifact population pass both pre-tag verification stages.
- Preserve fail-closed rejection of undeclared, missing, digest-drifted, or unsafe artifacts while
  adopting canonical `devai-verifier` commit `8174749` and its exact provenance.
- Retain immutable `@aarusso-nyx/devai@1.5.1` as the trusted local-RC verifier provider.

## 1.5.3 — 2026-09-21

- Bound clean committed-snapshot hashing by querying immutable Git object sizes and reading blobs
  in deterministic batches, without increasing the protected 64 MiB subprocess ceiling.
- Keep the closed Git-read grammar fail-closed for malformed or truncated size/content responses.
- Exercise an installed package against a clean 70 MiB committed snapshot and prove RC execution
  plus task-policy digest equivalence with the per-file worktree path.
- Retain immutable `@aarusso-nyx/devai@1.5.1` as the trusted local-RC verifier provider.

## 1.5.2 — 2026-09-20

- Roll over generated trusted-local-RC workflows to the exact immutable
  `@aarusso-nyx/devai@1.5.1` provider package: authenticated registry metadata,
  tarball SHA-1 and SRI, signed-release commit/tree, verifier provenance, and source commit.
- Bind the verifier's policy-declared 26-file population rather than a historical fixed count,
  while preserving the exact five evidence binary mappings and fail-closed drift checks.
- Regenerate and test the canonical scaffold so its package materialization validates the complete
  1.5.1 provider identity before extraction or verifier execution.

## 1.4.5 — 2026-08-30

- Bind generated trusted-local-RC workflows to immutable `@aarusso-nyx/devai@1.4.4`, the first
  package that actually contains portable composed-mutation verifier source `37e75a5c`.
- Keep package metadata, release commit/tree, verifier provenance, and generated workflow checks
  mutually consistent so adopters fail before RC execution instead of after evidence publication.
- Correct the 1.4.4 migration guide's intermediate verifier SHA to the released source identity.
- Prove from the signed provider tag and immutable release commit that its packaged provenance
  contains the declared verifier source and exact 21-file population.
- Document the separately authorized protected-provenance rollover and mark new 1.4.4 adoption as
  superseded by 1.4.5.

## 1.4.4 — 2026-08-30

- Make ordinary task identity portable across hosts by excluding ambient executable paths.
- Verify governed composed mutation evidence strictly and bind the canonical verifier provenance.
- Add a non-writing export preflight so destination and signing failures surface before RC execution.

## 1.4.3 — 2026-08-29

- Supersedes the unpublished `v1.4.2` rehearsal candidate after npm rejected the non-ASCII
  adopter-directory basename as an inferred package name.
- Preserves the real space and non-ASCII installation path while creating an explicit,
  deterministic npm adopter manifest with a portable package name.

## 1.4.2 — 2026-08-29

- Binds release-intent versions to the exact base and candidate package-manifest bytes declared by
  `version_source`, failing closed for unresolved or inconsistent monorepo release units.
- Completes the MINOR, MAJOR, and LTS capability floors and adds bounded failure classifications
  for unsuccessful release-verification checks.
- Exercises the installed release tarball in a path containing spaces and non-ASCII characters,
  closing the v1.4 portability contract with real release-workflow evidence.

## 1.4.1 — 2026-08-29

- Supersedes the unpublished `v1.4.0` rehearsal candidate after a fresh Linux release runner
  demonstrated that type-aware lint requires workspace build declarations.
- Builds the exact tagged workspace before independently rerunning formatting, lint, typecheck,
  schema/generated integrity, closure, package smoke, and documentation checks.

## 1.4.0 — 2026-08-29

- Adds schema-validated, candidate-bound release intent and adopter release-verification profiles
  with independent SemVer-transition and support-intention axes, capability union, fail-closed risk
  escalation, and explicit mutation dispositions.
- Extends the existing `check` task runner with additive release preflight and certification stages,
  exact preflight-receipt verification, affected/dependent selection, and unchanged legacy
  `affected`, `local`, and `rc` behavior.
- Adds exact per-roster-entry mutation reuse identities, opt-in release-policy materialization,
  DEVAI's self-profile, and one stable `devai-release-gate` PR status without adding a public action
  or publication permission.
- Enforces the unconditional formatting, lint, type, schema/generated, secret, path-portability,
  package-boundary, and exact-candidate floor in local hygiene, profile preflight, and independent
  CI. Signed-tag rehearsal, protected-ledger verification, and explicit `publish: true` remain
  separate boundaries.

## 1.3.3 — 2026-08-28

- Aligns the package-owned evidence verifier with the check runner by excluding only the exact
  harness-mutated `.devai/state/`, `record/`, and `scratch/` prefixes from reusable task-policy
  identity and affected-path classification.
- Adds one optional, non-attesting pull-request preflight lane for build, lint, typecheck, and the
  cheap local closure without protected environments, secrets, variables, evidence publication,
  or execution of the attested RC closure.
- Repairs CI-economy cancellation validation so the ordinary `pull_request` conditional form is
  accepted while unsafe or non-cancelling forms continue to fail closed.

## 1.3.1 — 2026-08-27

- Repairs the installed-tarball release rehearsal sensors to require the governed 48-action
  catalog introduced in 1.3.0. The immutable `v1.3.0` rehearsal correctly failed before any
  package, Release, registry tag, or Pages publication occurred.

## 1.3.0 — 2026-08-27

- Adds opt-in GitHub Issues governance tracking. Tracking is disabled by default, and a
  repository with no binding behaves exactly as 1.2.13 did: no tracking state, no network call,
  and no readiness effect. Enabling it takes an Architect repository binding and then an explicit
  Owner activation per round, which also authorizes the bounded remote publication it performs.
- Records every governed finding and mediated action locally first, append-only, with
  content-derived identities chained per authority session so independent worktrees keep separate
  chains instead of a fabricated global order. Correction is a new appended supersession; recorded
  bytes are never edited, and delivery state is stored apart from evidence so no remote
  acknowledgement can alter it.
- Treats GitHub as an output-only, rebuildable projection. Batches post idempotently by a stable
  marker, issue comments and labels grant no authority, and an unreachable remote is reported as
  projection health rather than as a governed verdict. Publication is redacted through the
  `public-safe-v1` disclosure profile, which withholds payload content and publishes digests in
  its place.
- Derives CI reconciliation authority from the Owner activation instead of a declared role,
  refusing any caller-supplied identity or consent flag and executing inside an effect scope
  narrower than a live Owner session.
- Adds four preview actions — `round tracking enable`, `round tracking status`,
  `round tracking sync`, and `round tracking disable` — taking the public action surface from 44
  to 48.

## 1.2.13 — 2026-08-25

- Repairs the generated trusted-local-RC verifier workflow so adopters materialize the exact
  authenticated `@aarusso-nyx/devai@1.2.12` verifier package in runner-temporary storage instead
  of falling back to the adopter's `packages/cli` tree.
- Validates the package name, version, tarball identity, release commit and tree, archive safety,
  provenance, declared 21-file verifier population, and five evidence binaries before execution.
  Package authentication remains step-scoped to `PACKAGES_READ_TOKEN`, with no `github.token`
  fallback, lifecycle-script execution, candidate-product execution, or permission widening.

## 1.2.12 — 2026-08-24

- Makes Doctor validate adopter-policy binding receipts and deterministically reconstruct bound
  policy materialization, while preserving canonical behavior for repositories without a binding
  and failing closed on malformed, stale, forged, unsafe, or incomplete bindings.
- Makes signed version-tag pushes non-publishing rehearsals and restricts Release finalization,
  GitHub Packages publication, and Pages deployment to an explicit workflow dispatch with
  `publish: true` for the exact rehearsed tag.

## 1.2.11 — 2026-08-24

- Preserves the approved positional operands for `round gap show`, `round gap resolve`, and
  `evidence redact` while retaining v1.2.10's fail-closed rejection of stray arguments on
  option-only commands.
- Restores the installed-tarball RGR smoke and advances the immutable release after the v1.2.10
  tag-triggered build correctly failed before publication.

## 1.2.10 — 2026-08-24

- Excludes `.devai/state/`, `record/`, and `scratch/` at the task-snapshot boundary so glob
  selectors never consume harness writes, while source and `.devai/config/` changes still
  invalidate cached results.
- Makes missing-policy remediation sequence-aware, adds the explicit `init bind --full`
  bootstrap, rejects stray `check` positionals, and suggests nearby canonical member names.
- Documents scoped cache selectors, the reserved `test:local-full` closure root, and the RC
  database prerequisite; local-root refusals now link directly to that contract.
- Generates a drift-checked error-code reference from runtime diagnostic and exit-taxonomy
  sources.
- Stages a CycloneDX SBOM with every deterministic package pair and binds its subject SHA-256 to
  the tarball, makes an authorized signed tag the end-to-end publication trigger with manual
  dispatch retained for idempotent recovery, and gates publication on a fresh npm adopter run on
  Ubuntu.

## 1.2.9 — 2026-08-24

- Corrects the published landing-page package version and binds it to the package manifest with a
  regression test.
- Makes the post-deployment Pages check retry successful-but-stale responses with cache-busting
  requests before accepting the live release.

## 1.2.8 — 2026-08-24

- Requires Git work-tree targets for initialization without adding a Git subprocess capability,
  resolves adopter-owned build commands, and preserves linked-worktree `.git` files.
- Makes lint and test-file typechecking independently attested RC gates alongside coverage,
  enforces zero ESLint warnings, and changes the RC task-policy digest. The exact-candidate ledger
  attestation must be re-issued before tagging.
- Separates fork pull-request preflight from protected ledger secrets, gives check-task refusals
  stable structured exit semantics, and removes stale task, containment, and stub-package drift.
- Restores documentation-governance provenance in one adopter-facing location, documents all nine
  rule identifiers and severities, and records the unavailable predecessor ADR corpus as known debt.

## 1.2.7 — 2026-08-23

- Makes schema-valid adopter task descriptors the process authority while retaining exact argv,
  shell-free execution, repository-contained working directories, executable resolution, and
  executable-digest cache binding.
- Aligns tier diagnostics with bootstrap profiles, detects materialized-policy drift, and emits
  actionable structured authority refusals with distinct gate-failure exit semantics.
- Isolates typecheck output from packaged runtime files and makes OpenAI, Anthropic, and PostgreSQL
  clients optional with typed missing-dependency remediation.

## 1.2.6 — 2026-08-22

- Preserves exact-main observation provenance for user-owned private repositories through the
  immutable GitHub Actions artifact digest and an explicit capability receipt, without claiming
  that unavailable GitHub artifact attestation succeeded. Eligible repositories continue to
  require GitHub attestation and fail closed when it is missing.

## 1.2.5 — 2026-08-22

- Requires the protected adopter `PACKAGES_READ_TOKEN` secret for generated exact-main GitHub
  Packages installation, with an explicit missing-secret failure and no package-authentication
  fallback to the repository-scoped `GITHUB_TOKEN`.

## 1.2.4 — 2026-08-22

- Stabilizes adopter authority across developer, CI, container, and disposable-checkout paths by
  deriving `repository_id` from the schema-valid project `name` before using the Git directory
  fallback. Moving or independently cloning a bound adopter no longer changes its authority bytes.
- Adds checkout-path regression coverage and requires the exact packed candidate to pass TEAT's
  governed `R-0013` unit-evidence command from a differently named disposable checkout before
  publication.

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
