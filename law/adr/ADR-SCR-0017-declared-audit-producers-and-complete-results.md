---
id: ADR-SCR-0017
title: Declared audit producers, reviewed effects and complete executable results
type: adr
status: accepted
date: 2026-10-10
authority: Architect
supersedes:
  - ADR-SCR-0012
  - ADR-SCR-0015
  - ADR-SCR-0013
provenance:
  - ADR-CHK-0008
  - ADR-CFG-0002
  - ADR-SCR-0008
affected_rules:
  - law/schemas/adopter-policy.schema.json
  - law/schemas/test-task-descriptor.schema.json
  - law/schemas/invariant-producers.schema.json
  - law/schemas/reviewed-workflow-steps.schema.json
  - law/schemas/test-result-population.schema.json
  - law/policy/subprocess-effects.json
  - law/policy/adopter-defaults/invariant-producers.json
  - law/policy/adopter-defaults/reviewed-workflow-steps.json
  - law/policy/sensor-notes/test_idiomaticity.md
  - law/policy/sensor-notes/harness_coherence.md
  - packages/cli/src/services/adopter-policy.ts
  - packages/cli/src/services/adopter-policy-binding.ts
  - packages/cli/src/commands/init/bind-adapters.ts
  - packages/cli/src/commands/sense/adapter-readers.ts
  - packages/cli/src/commands/sense/task-selection.ts
  - packages/cli/src/authority/broker.ts
  - packages/cli/src/commands/sense/task-binding.ts
  - packages/cli/src/commands/sense/reading-instance.ts
  - packages/cli/src/commands/sense/record.ts
  - packages/cli/src/commands/sense/declared-invariant-producers.ts
  - packages/loop/src/scorecard/latest.ts
  - packages/loop/src/scorecard/inputs.ts
  - packages/loop/src/loop/scorecard.ts
  - packages/sensors/src/harness-invariant-alignment.ts
  - packages/sensors/src/harness-invariant-alignment-evidence.ts
  - packages/sensors/src/harness/reviewed-workflow-steps.ts
  - packages/sensors/src/test-idiomaticity.ts
inspector_acceptance:
  - IA-001 -- Project, rebind, retire and verify both optional documents through registered whole-file ownership; absence preserves unmanaged files, tampered receipts refuse and rollback remains atomic.
  - IA-002 -- Discharge every exact invariant/subject obligation with passing complete candidate/task results and fail-closed CI invocation; wrong subject, invariant, task, population, selectors, environment, candidate or swallowed failure aligns nothing.
  - IA-003 -- Admit only exact reviewed YAML occurrences and complete executable/import closure; changed package scripts, config, literal imports, computed imports, permissions or effects reopen review and never default to read-only.
  - IA-004 -- Distinguish actual owned-component substitution from comments, strings, call-through observers, external-port replacement and valid fault injection; integration directories and every executable suffix remain visible.
  - IA-005 -- Discover the complete selected executable corpus with arbitrary-depth and multiple-wildcard globs, preserving declared external direct read roots while candidate-bound populations remain contained, tracked and link-free; missing/unreadable populations refuse.
  - IA-006 -- Require host-verified package-owned Vitest/Playwright native collection and complete final results from one declared execution with direct or reviewed Turbo transport; results-only, missing, duplicate, skipped, cached, truncated, ambiguous or mismatched IDs/files/counters cannot be executed PASS. Node TAP remains diagnostic UNKNOWN.
  - IA-007 -- Authored or cloned native JSON, even with internally consistent nonce/results, cannot mint execution origin; require a prior exact host execution receipt, reject missing or mismatched receipts and never refresh origin through generic re-recording.
  - IA-008 -- Retain each current kind/task/population head, refuse cross-partition supersession, aggregate all populations with worst outcome winning and leave missing bound obligations unmeasured; preserve legacy per-kind selection.
---

# Declared audit interfaces

## Status

Accepted for the Owner-authorized STYNX-supported campaign targeting DEVAI 2.5.0
MINOR. New optional adopter interfaces are additive. Existing inputs and direct
read populations remain compatible. This forward record changes only the
overlapping subjects declared above; every other contract of ADR-SCR-0015 and
ADR-SCR-0013 remains in force, including immutable candidate custody, exact task
admission, effects and registered configuration ownership. This record also
supersedes the ADR-SCR-0008 obligations carried by ADR-SCR-0012 only for
the explicit native task execution-origin
receipt exception below; ordinary observations and generic recording retain
their existing write and ordering contracts.

## Context

Published 2.4.0 demonstrates six audit interface gaps beside the endpoint defect
handled by ADR-SCR-0016. Adopters cannot declare exact invariant producers or
reviewed workflow effects. Raw mock matching and incomplete file/glob walkers
misclassify or omit real suites. Native task parsing loses prefixed results and
does not prove complete executed test IDs. The independently trusted 1.9.0
verifier rejects an annotation admitted by the now-published 2.4.0 package.
Changing thresholds, deleting variants, stripping annotations or narrowing the
measured population would conceal these gaps.

## Decision

### Registered optional projections

The closed adopter policy adds optional complete `invariant_producers` and
`reviewed_workflow_steps` documents, validated by their corresponding schemas.
Registered `init bind --adopter-policy --write` projects them to
`.devai/config/invariant-producers.json` and
`.devai/config/reviewed-workflow-steps.json`, respectively. The existing binding
receipt binds source and exact target digests; doctor, upgrade, rollback and
atomic binding cover the same ownership population.

ADR-SCR-0015's whole-file rules apply independently to both targets. An absent
never-owned block preserves an unmanaged file and omits ownership. Removing a
previously verified owned block materializes the installed canonical empty
document and records its digest. It neither retains retired overrides nor
deletes the target. Rebinding identical bytes is idempotent. No file-existence
heuristic, caller-created context or manual generated-config edit establishes
authority. New defaults are empty bindings/steps, not implicit adopter trust.

### Exact invariant obligations

Each producer binding names `invariant_id`, a reviewed semantic `subject`, exact
`taskId`, matching `population` and a nonempty `requiredTestIds` subset. Duplicate
invariant/subject pairs, unknown invariants or tasks, wrong annotations or
populations and IDs outside the task's complete result population refuse. The
subject labels an obligation; task input selectors and measured result custody
bind its source bytes. A label itself proves no observation.

Every binding for an invariant is required. Existing `measurable_via_mode: all`
obligations remain required as well; adding a producer does not waive an action.
A bound invariant cannot fall back to generic action-name matching or another
invariant's evidence. Alignment requires both its exact executable fail-closed
CI producer and fresh passing result evidence for the requested candidate.
`continue-on-error`, swallowed failures or nonbinding control flow cannot prove
the gate. In-process read-only observations retain their existing scope and
cannot impersonate a task execution.

Custody binds the candidate commit/tree, source policy and projection receipt,
task descriptor/policy and node, selectors and selected source files, executable
and runner bytes, toolchain, allowlisted environment, population, native plan,
raw streams and complete results. Prior-candidate, stale, cross-task or changed
inputs cannot discharge an obligation. Historical reading bytes and chain
prefixes remain immutable. All execution continues through existing task and
subprocess admission, including explicit write/effect requirements; this schema
does not introduce another execution path.

Binding validates closed shapes and intrinsic duplicate pairs, paths and
occurrences without reading a candidate source/task snapshot. Measurement and
task admission perform the candidate-dependent checks above before execution
or credit. A successfully bound document alone proves no execution or readiness.

### Execution origin and immutable standing

Matching nonce, collection, results and digests demonstrate consistency, not
execution origin: a caller can author internally consistent JSON. Only the
registered bound native process path may mint an internal reading token in a
module-private WeakMap after actual admitted execution and verification. The
token captures an immutable measured-body snapshot and the exact binding at
execution, rather than trusting the later mutable object. Before appending, the
host compares the final instance against that snapshot, allowing only the
registered immutable-instance resolution of `id` and `supersedes`, and rechecks
the current binding. Post-execution mutation of status, metrics, raw results,
nonce or any other measured byte invalidates the token. Parsed, cloned or
caller-supplied JSON cannot obtain it. It carries no transferable caller flag.

After resolving the final immutable reading instance (including final ID and
supersession), the trusted path verifies/consumes that token and appends one
`sense.task.execute` event to existing `record/proofs/chain.json`. This is an
internal ledger event, not a new public CLI action. The receipt binds the exact
final canonical reading artifact path and raw-byte SHA-256 to the current
candidate and task. Those bound reading bytes include the task/population,
input/descriptor/policy/executable/reporter/selection identities, raw streams and
internally minted collection nonce. Changing a bound byte or resolving another
instance invalidates the token/receipt association. Completed execution is not
necessarily a passing result.

This is a narrow product-law exception to ordinary observation purity and
ADR-SCR-0008's rule against chain-before-file custody: an execution-origin
receipt may precede generic persistence, but is not itself artifact custody.
It runs only under explicit bound-task local-write consent. The resolved native
member adds `fs:proofs` for this exact origin append and `fs:f5-state` for the
transient provenance capture below, beside existing `fs:workspace` and
`proc:declared-sensor-task`. The `declared-native-sensor-task` subprocess annotation
is descriptive, not a generic executable/argv admission. Ordinary bound tasks and
read observations gain neither capability. The host must verify the native
binding before resolving these capabilities, and before every scoped write.
No public action or initiator role is added; framework self-dogfood roles remain
subject to their existing resolved effect matrix.

Proof writes require an internal origin-operation guard. It permits only creation
of `record/proofs` when absent, create/update of `record/proofs/chain.json`, and
the exact exclusive staging file `record/proofs/chain.json.tmp.<pid>.<time>`
created by the trusted atomic chain writer and renamed only to that chain. The
chain's existing verified prefix is preserved. Parent-directory creation conveys
no sibling authority. Other proof paths, arbitrary temporary names, deletion or
unbound writes refuse; `fs:workspace` is not broadened to cover proofs.
Ordinary in-process observations remain pure. Generic `sense record`
continues to persist the file before its `sense.readings.record` event and cannot
mint or repair an execution receipt from input JSON.

Standing requires a valid execution receipt preceding the matching generic
record in the verified chain, exact final artifact bytes, current candidate/task
identity and the complete native result checks. Neither receipt alone is
standing. A missing execution receipt requires a new admitted execution; generic
re-recording cannot create origin, refresh execution time or make stale evidence
fresh. Historical bytes, timestamps and chain prefixes stay immutable. Interrupted
writes remain explicit incomplete evidence, never inferred success.

### Population-partitioned current readings

For task-bound readings, the supersession partition is exact
`[sensor kind, taskId, population]` within the requested candidate's verified
custody. A predecessor from another task or population cannot be superseded or
silently removed. Every partition retains its unique current head; missing,
dangling, cyclic or ambiguous edges remain refused. Legacy observations without
a task binding retain their existing per-kind partition and selection rules.

Scorecards retain all current task population heads and aggregate them with the
worst applicable outcome winning. A passing population cannot replace or hide
a failing, unresolved or unmeasured sibling. Each declared invariant/subject
obligation still requires its own exact standing result; an absent bound task or
population remains unmeasured even when another population of the same kind
passes. No timestamp sorting, convenient single head or generic action fallback
collapses these obligations.

### Reviewed workflow effects

Adopter entries reuse the existing reviewed step fields: canonical YAML SHA-256,
exact workflow/job/index occurrences, step name, review, effect, path/digest
`files` and explicit `computed_imports` covers where needed. Keys are closed.
Canonical occurrences and file paths are unique and the executable closure is
complete, path-sorted, contained, regular-file and link-free. Consumers verify
the current candidate's bytes, including package scripts and workspace/package
configuration, composite actions, literal imports/requires and the complete
reviewed reachability of computed imports. Package installation hooks and
configuration that can execute code are part of that review. An extra cover
cannot hide an omitted executed file; unresolved reachability remains unknown.

Conflicting package/adopter entries refuse; an adopter cannot override core
classification or trust solely by filename. Missing, changed or unreadable
closure, YAML, occurrence or permission inputs reopen review. Existing meanings
remain: read-only may write workspace/runner/output files, repository-write
changes repository branches, and publication changes external release surfaces.
Mixed effects retain the strongest effect. Effect-specific serialization,
approval environments, permission checks and unknown-effect refusal remain
mandatory. Classification grants no effect or credential authority.

### Complete executable census

The shared test census recognizes `.test`, `.spec`, `.e2e` and `.wiring-spec`
before `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs` or `.cjs`. Existing admitted variants
remain readable. Integration classification recognizes directories as well as
basenames. Multiple wildcard segments and arbitrary-depth `**` use real glob
semantics, deterministic deduplication and portable paths, not first-segment
approximation. Default roots include singular/plural package test directories,
colocated package source tests and root `test`/`tests` directories.

Dependency/output/mirror directories are excluded explicitly: `.git`,
`node_modules`, `dist`, `build`, and the registered `.devai/worktrees` mirror
path. Another generated worktree mirror requires an explicitly identified
supported path; the directory name `graft` alone does not establish a mirror.
This exclusion is census hygiene, not permission to omit declared source tests
or silently discard a selected population. Explicit missing, unreadable,
escaping or linked populations produce a finding/refusal. An absent optional
default root is not a declared empty success.

Direct sensors preserve supported explicitly configured external absolute read
roots as separately declared populations. Resolve the explicitly declared literal
base once to its physical root, including a root or ancestor alias such as macOS
`/tmp` or `/var`; translate any glob suffix onto that physical base without
changing its selector. Traversal then remains contained beneath that physical
root, admits regular entries and refuses nested symlinks. Missing or unreadable
base resolution and containment escapes produce a finding/refusal. This does not
assert that filesystem ancestors outside the physical root are link-free and
must not require a census of those ancestors. Preserve established display-path
and basename-fallback compatibility; aliases of the same physical file do not
multiply the population, and the first admitted display path is retained. For an
explicit literal file, canonicalize its parent only and refuse a linked file
itself; this allowance does not turn file symlinks into regular inputs. Such a direct read is not candidate custody.
Task/adopter-bound census instead requires contained candidate-tracked regular
files without this external-root alias allowance, with exact task
selectors and reviewed runner selection/configuration. Broad selectors whose
selected runner population cannot be proved refuse until made precise; output
alone cannot choose a convenient subset.

### Semantic integration classification

Actual AST calls and resolved import ownership establish substitution. Comments
and strings are not calls. A call-through observer is distinct from replacing
owned behavior. Resolved external-port replacements and valid fault-injection
negative witnesses remain legitimate; replacing an owned component still emits
the existing integration finding. Unresolved ownership is explicit uncertainty,
not an invented external boundary. Do not rename/hide tests or mocks, discard
negative witnesses or relax thresholds to achieve a result.

### Complete native results

An opt-in closed `outputContract.resultPopulation` is supported only beneath
explicit `kind: command-result` and nonempty `population`. It declares format,
project namespace, native selection evidence, direct/Turbo transport, complete
executable files and complete expected test IDs. It does not admit mutation or
protected generated namespace census. Existing canonical verifier kinds remain
unchanged.

Standing requires `selectionEvidence.kind: devai-native-collection`, reporter
`vitest-v1` or `playwright-v1` matching the format, and an exact native
`projectName` (including the empty default name). This native name is distinct
from the stable task `projectId` namespace. Initially exactly one native project
may be collected; unrelated or multiple projects refuse rather than merge.

The host resolves the known package-owned reporter export relative to the
installed CLI and verifies the actual native executable, reporter bytes and
execution closure. It injects a fresh internal nonce into the process environment;
the descriptor cannot choose or override this nonce. Before execution the native
reporter records its resolved selection and collected source files/test identities.
Its final native JSON retains these facts as `devaiCollection` with schema
version, reporter, nonce, planned files, test rows (file, ancestors, title and
native project), and resolved project selection. These facts and final results
must belong to the same declared execution. Native collection is compared with
the declared executable roster and expected IDs; neither that roster nor equality
to `task.inputPaths` proves actual runner selection. Dynamic configuration binds
all tracked candidate repository files conservatively into the task input closure,
excluding exactly the canonical planner harness-mutated prefixes
`.devai/state/`, `record/` and `scratch/`. The source and verifier projection must
agree on these exclusions; no additional path is omitted by inference.
Unknown runner/reporter execution or incomplete collection refuses standing.
These exclusions preserve the existing portable input projection; they do not
prove arbitrary dynamic configuration self-contained. Native-specific selection
identity additionally binds the actual admitted configuration/helper dependency
and read closure, without changing historical portable task keys. Repository
static imports (including resolved aliases), re-exports and selected plugin/setup
modules are followed transitively. Filesystem reads and directory membership,
loader/resolver targets, selection-affecting environment and configuration hooks
must be proved contained within exact candidate-bound inputs or independently
verified native dependency bytes. Untracked, excluded-state or ambient inputs
(including HOME/PATH/TMPDIR) cannot influence selection or success without explicit
admission and additional exact identity. A declared closure, module digest or
matching native collection alone does not enforce this boundary.

Adopter filesystem/network/subprocess/dynamic-loader capabilities are refused
unless a supported mechanism actually constrains their reachable inputs and
effects and binds their exact identities. Pure path calculations and closed
helper factories may remain supported. Known bounded repository data reads and
source-directory traversal need proof of bytes and complete membership, not an
unconditional `node:fs` exemption. TypeScript config access is limited to the
reviewed static AST helpers; CJS/dynamic loading, re-exported TypeScript handles
and `ts.sys` are unsupported. Native framework dependencies are admitted
only under their verified execution closure; importing a framework does not
exempt arbitrary adopter plugin code. Unsupported reachability refuses before
execution/standing. No ambient discovery, extra planner argv or authored count
establishes a plan.

Package-owned provenance instrumentation may create transient traces only under
`.devai/state/native-config-traces/<internally-minted-nonce>`. The host binds the
nonce and exact trace artifacts; parent creation grants no sibling writes and
cleanup is restricted to the current operation's owned artifacts/directory.
These traces are inputs to verified result custody, not independent standing.
The instrumentation identity, supported Node version/mode and observed API set
are closed. An early trusted preload/native loader observation path must cover
configuration, workers, plugins and setup through collection, and bind actual
resolved dependency instances. It captures successful reads and negative
existence/stat/directory membership observations and rechecks them before credit.
Native `configFileDependencies` corroborates that trace; it cannot replace it.
Missing stages or unsupported I/O, loader or process capabilities remain unknown
and refuse standing. This is provenance instrumentation for cooperative native
tooling, not a security sandbox against deliberately bypassing plugin code.

Exact Playwright 1.60.0 asynchronous ESM loader registration requires a
package-owned bootstrap with independently bound bootstrap/preload bytes and the
original exact loader/package closure. A fresh isolated trace scope must import
the trusted preload dynamically before importing the original loader dynamically;
a static re-export does not establish this order. Original `initialize(data)`,
hooks and transferred Playwright ports retain their semantics. Only the verified
pinned loader target qualifies; this does not admit adopter `module.register`,
arbitrary dynamic loaders or a source-hash-only exception.

Native workers also require privately minted child scopes and a separate
control port/shared acknowledgement buffer. Original `workerData` and its
transfer semantics must be restored before candidate imports; provenance control
metadata cannot replace or leak into the candidate's worker input. Before an
explicit native `Worker.terminate`, the parent requests the worker's own seal.
Only the worker preload may persist its actual terminal observation and
acknowledge after supported I/O is complete or has observably drained. The parent
wait is bounded to five seconds; failure refuses standing rather than treating
termination as a successful end. Normal worker exit still requires its own actual
terminal evidence. A worker acknowledgement cannot replace a child loader's
separate seal, and post-seal hooks/I/O remain refused.

Every asynchronous loader registration mints a private child scope and a
separate control port/shared acknowledgement buffer, preserving the original
Playwright data and transferred port. An inherited owner-scope clone refuses.
The forwarded hooks account for their starts/completions. On normal parent
termination, the private control requests a seal; only quiescent hooks and
completed supported I/O may invoke the preload's actual terminal persistence and
then acknowledge through the shared buffer. Supported callback/promise I/O
requires private initiation/completion accounting; pending-at-seal operations
must drain observably or refuse, never disappear behind an acknowledgement.
The parent waits at most five seconds for that acknowledgement.
This is an actual loader-owned terminal event, not a worker-end record invented
by the parent.

Every loader scope requires a real begin and persisted terminal seal; completion
must prove observation flush and refuse post-seal hooks/I/O. Normal exit cannot
replace a missing acknowledgement. Main and worker loader scopes need separate
closure evidence. Missing registration/begin/seal, termination without closure,
acknowledgement timeout or incomplete observation remains UNKNOWN and contributes
no native executed-population measurements.

The finite configuration scanner requires an explicit `--config` path; default
config discovery is not standing. It recursively checks tracked relative
`.js`/`.mjs`/`.cjs`/`.ts`/`.mts`/`.cts` imports and re-exports. Admitted package
specifiers are only `vitest/config`, `@playwright/test`, `typescript`,
`unplugin-swc`, `unplugin-swc/vite` and `@swc/core`. Admitted Node imports are
`node:fs`, `node:fs/promises`, `node:path`, `node:url` and named `createRequire`
from `node:module`. That capability allowlist still requires the runtime trace
and finite operation guards; it grants no hidden I/O exemption. Unknown package
or computed import forms, clocks/randomness, `Intl`, network and global reflection are
unsupported rather than accepted as arbitrary dynamic configuration.

Native execution starts with a closed bound environment snapshot; it does not
inherit ambient HOME/PATH/TMPDIR implicitly. `NODE_V8_COVERAGE` is suppressed
with the host's own empty value and a descriptor override is refused. Child
execution preserves the snapshot and provenance preload, except reviewed native
Vitest-generated flags: `VITEST`/`TEST` true, `VITEST_MODE` RUN, `NODE_ENV` test,
and numeric worker/pool IDs. Runtime traces retain the full eight-key projection
`BASE_URL`, `DEV`, `MODE`, `PROD`, `FORCE_TTY`, `PLAYWRIGHT_TEST`, `FORCE_COLOR`
and `DEBUG_COLORS`. Vitest/Vite values must agree with the same execution's
resolved native configuration while preserving the other initial values.
Playwright 1.60.0 may set `PLAYWRIGHT_TEST` and `FORCE_COLOR` to `1`, with
`DEBUG_COLORS` equal to its initial value when present and otherwise `1`; the
remaining projection must stay unchanged. Esbuild may preserve the exact initial
projection. A recognized key name alone is not admission; a missing, additional
or mismatching projection value refuses.

Node child/worker flags admit only `--experimental-import-meta-resolve`, explicit
`--conditions` values matching `[a-zA-Z0-9_.-]{1,128}`, and `--require` of the
reviewed Vitest `suppress-warnings.cjs` bytes with SHA-256
`a5012da3d2027007781baecda154d343d8c7ad2327b79bec65b1b60a41f42dd1`.
Other flags, preloads and environment changes refuse. Actual import
resolution edges and manifest dependency instances are recorded and re-resolved,
not inferred only from a lockfile or the configured root package.

Stat provenance binds the fields actually consumed, including access through
property descriptors, through observed values. Directory observation preserves
actual order as well as membership; access checks bind the requested mode.
Revalidation must reproduce those facts. Recording merely a generic successful
stat/read or sorting away consumed directory order is insufficient.

Selected setup/global-setup/custom-provider file strings are executable closure
roots rather than ordinary import syntax. They require explicit supported helper
root discovery, the same tracked-file capability/trace checks and agreement with
native resolved configuration before support is claimed. Computed or otherwise
unproved helper roots remain unsupported. Their filesystem writes and server or
subprocess effects require their own existing exact admission; read provenance
does not grant those effects. No broad setup/provider exception is inferred.

The initial Vitest provenance mode is finite: Node 24, Vitest 4.1.11 and Vite 7.3.6,
with explicit `--configLoader native` and an explicit relative `--config ./path/config.mjs`
(or another admitted config extension). A bare config filename refuses before
execution because native Vite resolution can probe ambient ancestor package
paths; DEVAI does not rewrite argv. Vite 8 and default/bundled config loading
refuse standing. Configurations must use native ESM path semantics (for example
`import.meta.dirname`); compatibility with bundler-injected `__dirname` is not
inferred. STYNX's existing shared/backend configurations require migration and
installed verification before support can be claimed.

The observed native transform boundary is also closed. SWC 1.16.2 permits only
source-string `transform`/`transformSync` with `swcrc: false`, `configFile: false`
and `inputSourceMap: false`, without native plugins, experimental settings or
cache roots. The presence of SWC `baseUrl` or `paths` also refuses because their
native resolver is not observed; other native calls refuse except
`getTargetTriple`. Rollup 4.64.5 permits
only guarded source-string parse/parseAsync and in-memory hash APIs. Esbuild
0.28.1/0.28.2 permits only the observed inline transform service protocol with
`inputFS: false`; build/native file operations refuse. Inputs that trigger
esbuild's greater-than-1-MiB disk spill remain UNKNOWN. Unsupported options,
versions or incomplete observation do not fall back to untraced execution.
On macOS, reviewed fsevents 2.3.2/2.3.3 initialization is permitted only through a
fresh frozen own-key export shim; every callable export is denied, so this does
not admit watching or later native activity.

Native generated intermediates are a separate same-execution output population,
not an exception admitting external input files. The host creates only the exact
fresh empty `.devai/state/native-config-traces/<internally-minted-nonce>/runtime`
directory under the existing native-only trace operation. The closed environment
internally sets `TMPDIR` to this physical root and `PWTEST_CACHE_DIR` to its
`playwright` child; descriptor overrides of either key refuse. Before imports,
the trusted main-process begin event binds the exact physical root and its empty
contents. This grants no ambient `/tmp` write, caller-selected cache root or new
public action.

Only verified finite Vitest 4.1.11 and Playwright 1.60.0 cache subdirectory,
hash-file and staging-file forms may qualify beneath that owned root. The
package-owned reporter's actual Vitest context/project temporary directories must
agree with this namespace; reported paths alone prove neither ownership nor
freshness. Links, escapes, unrelated metadata access and unowned writes refuse.
The trusted ordered cross-scope trace records successful mkdir, full-file write,
rename and removal operations. The host replays their exact paths, encodings and
byte SHA-256 in a virtual output ledger, retaining only each live file identity.

A worker read must match a preceding successful full write or a successful rename
that carries that write's identity into the consumed target. Vitest's `.tmp-*`
to `ssr` hash-file transport requires this exact rename proof; a final target
path alone is insufficient. Overwrites require ownership of the prior live
identity; no unowned overwrite is admitted. Removal or replacement invalidates
the previous live identity. Future writes, ambiguous order, partial/unobserved
writes, preexisting files and cache replay cannot establish provenance. Cleanup
is confined to the operation's owned roots/artifacts and is replayed rather than
rechecked as if removed generated files were current inputs. Nested internal
cleanup calls may share one outer removal intent/success envelope only within
the same active owned subtree. Preserve every metadata/read observation and the
complete outer snapshot/completion; reset the scoped context on completion or
error. Other paths/operations still undergo their ordinary checks. Partial or
failed cleanup does not manufacture a successful removal. Raw output-custody
facts and the exact producer/transform closure survive cleanup and are bound into
the final execution provenance.

For exact Playwright 1.60.0, loader-transformed module source is recorded separately
from the raw file-read observation. The raw candidate/dependency bytes, resolved
module identity, exact loader/transform dependency closure, fresh owned cache
custody and transformed-source SHA-256 must all be bound to this execution.
A transformed digest cannot replace raw input verification, and a version match
alone cannot establish transform provenance. This finite allowance applies only
to the admitted runner; another runner or an unproved transform remains UNKNOWN.
On provenance failure, native executed-population measurements are discarded;
diagnostic trace custody alone grants no standing.

Full-run filesystem results and module observations remain in raw trace bytes
and a SHA-256 bound into the final reading metrics. Each input must match exact
candidate-tracked bytes or the independently resolved dependency-instance graph
from declared root manifests, including the presence/absence and exact bytes
of implicit nameless module-package-scope manifests used during resolution. Negative existence, stat and complete directory
observations are revalidated against current inputs. Alongside the exact retained
resolution-manifest absence facts, closed framework discovery admits only these
source-derived negative probe sets:

- Candidate-root ancestor `package.json`, `pnpm-workspace.yaml`, `lerna.json`,
  `tsconfig.json` and `jsconfig.json`: `readFile`/`stat`/`lstat` with `ENOENT`,
  or `exists(false)`.
- Exact explicit-task-config-derived candidates beneath each task-cwd ancestor's
  `node_modules`: the config path without its leading `./`, or its basename,
  followed by no suffix or `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.jsx`,
  `.tsx`, `.json`, `.node`. Only `stat`/`lstat` with `ENOENT` qualifies.
- For the independently resolved exact `playwright@1.60.0` package root, only
  `test.js` and `lib/index.js` converted to their literal file-URL `pathname`
  strings, without percent-decoding: only `exists(false)` qualifies.

Every such target must still be absent when replayed. Positive outside-file
observations, another target/operation/failure or a changed result refuse. These
sets grant no ambient file-read authority. Other excluded state or proof input reads refuse; only the preceding
same-execution generated-output ledger qualifies for its narrow read allowance. Unsupported file-descriptor reads, streams, watches or other
unobserved APIs remain UNKNOWN. A custom `CoverageProviderModule` is permitted
only when its actual JavaScript closure is observable through this same path and
has no hidden I/O; the interface name alone grants no exception.

Supported standing formats are Vitest JSON (`testResults`, `assertionResults`
and consistent final native counters) and exact Playwright 1.60.0 JSON
(suites/specs/tests/results plus consistent final stats), accompanied by the
verified collection above. Playwright result artifacts must use an explicitly
admitted output directory within the canonical harness-mutated state namespace;
its default repository `test-results` directory is not implicitly admitted.
Browser, server and global-setup effects require their own exact admission.
Ordinary Node TAP lacks the required complete native
collection and unambiguous per-test source provenance. It remains diagnostic
UNKNOWN even with exit zero and a final plan; a guessed file, ordinal or authored
roster cannot manufacture these facts. A future native Node event capability
requires its own explicit contract and implementation.

Each leaf ID is `test:v1:` followed by `encodeURIComponent` of canonical JSON
`[projectId,portableSourceFile,ancestorTitles,testTitle]`. Ancestor titles are an
ordered array. Decode/re-encode must agree exactly. No ordinal or line fallback
disambiguates duplicate names. Full expected IDs equal both the complete native
collection ID set and final ID set, while each invariant's required IDs are a
subset. Collected files, selected candidate-tracked census, per-file results and
native counters/plans must all agree. Empty, missing, duplicate, extra,
ambiguous or truncated populations cannot yield executed PASS.

Turbo removes only the exact reviewed project prefix at physical line starts;
this transport transformation alone proves no inner execution. The actual inner
native runner and reporter must satisfy the same verification. Cache hits/replays
are recorded as nonexecuted. Skip/todo/ignored results cannot be credited as
executed passes. Retry attempts remain visible under one native identity and its
final terminal outcome. Raw stream and native collection/plan digests are retained
with parsed result/census custody. Exit zero, a population label or a summary line
alone never proves test success or completeness.

### Trusted verifier migration

The existing full-repin order remains mandatory. Published 2.4.0 contains the
canonical `ad790aea6f200412da79a3a1bfbaa03cbdb47a2d` verifier compatibility
change. After independently verifying that published archive's source, digest,
provenance, binary map, exact file population and signatures, the trusted policy
may advance coherently to that release under ADR-REL-0031 and ADR-CHK-0006.
Generated workflow and schema-validated adopter toolchain migration, together
with the separately recorded protected
provenance variable update must agree. Embedded compatibility alone never
switches the trusted executable. No annotation stripping, partial repin, vendor
hand-edit or canonical verifier publication is needed solely for `sensorKinds`.

## Consequences

The seven gaps have explicit acceptance boundaries. Unsupported or incomplete
native output stays visible, even when a command exits zero. A schema or this
record alone is not closure: actual installed producers, hostile regressions,
independent custody review and protected integration must pass before release.
Neither a measured subset nor a new interface guarantees a STYNX scorecard.

## Alternatives Considered

Generic action matches, authored assertion counts, exit-zero aggregates,
filename trust, default read-only effects and output-derived source subsets
overstate evidence. Arbitrary planner subprocesses widen execution. Removing
existing external direct read roots would be an incompatible change. Stripping
task annotations or editing generated policy would bypass the missing supported
migration rather than repair it.

## Affected Rules

The new schemas close optional producer/effect/result interfaces. Existing
adopter binding and consumers implement registered projection and exact custody.
Shared census and semantic classification preserve complete executable facts.
Sensor notes document their measurement meaning. Historical ADR bytes, package
artifacts, test assertions, thresholds and protected release boundaries remain.

## Inspector Adversarial Acceptance

Discharge IA-001 through IA-008 using real runner fixtures and separate installed
package regressions. Include complete STYNX taxonomy witnesses, omitted files
and assertions, multi-wildcard roots, spaces/non-ASCII roots, same-action wrong
subject/task results, changed executable/import closure, comments/strings,
owned substitutions, external faults, Turbo cache replay and native truncation.
Include self-consistent forged native payloads, cloned reading tokens, missing or
late execution receipts, post-execution measured-body mutation, transitive
excluded-state imports/reads, unbound environment and directory membership,
re-record freshness attempts, multiple same-kind task
heads, cross-population edges and an absent bound obligation beside a passing one.
Include Vite 8/default-loader refusal, native-ESM path migration, unsupported
SWC options/calls, esbuild disk spill, incomplete worker/setup traces and hidden
coverage-provider I/O. Preserve all negative witnesses and historical evidence. Report unsupported
formats/populations explicitly rather than claiming all seven gaps closed.
