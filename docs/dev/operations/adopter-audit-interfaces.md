# Adopter audit interfaces

These contracts target the developing DEVAI 2.5.0 minor release. Published
2.4.0 remains immutable. A declared policy or successful binding is not an audit
PASS: installed producer validation, independent regressions and protected
integration must establish the result.

The normative decisions are
[ADR-SCR-0016](../../../law/adr/ADR-SCR-0016-lossless-endpoint-observation-identity.md),
[ADR-SCR-0017](../../../law/adr/ADR-SCR-0017-declared-audit-producers-and-complete-results.md)
and [ADR-REL-0035](../../../law/adr/ADR-REL-0035-trust-published-verifier-2-4.md).

## Endpoint references

API inventory keeps distinct source declarations that share an HTTP method and
path. API, coverage, RBAC and HTTP evidence use the same observation identity:
`api:v1:` followed by URI-encoded canonical JSON of
`[method,path,controller,evidence]`. Portable source paths and sorted evidence
make it independent of walk order. This inventory does not assert that every
alternative source composition is mounted simultaneously.

Use exact inventory IDs in authored use-case `refs.endpointIds`. A legacy
`GET /health` reference remains valid when exactly one endpoint owns it. When
multiple endpoints own it, `AMBIGUOUS_ENDPOINT_REFERENCE` credits none of them;
the distinct endpoints stay unmapped until the reference is migrated explicitly.
Duplicate identities refuse with `ENDPOINT_IDENTITY_COLLISION`.

Qualified IDs include source lines. They identify observations rather than
stable runtime routes. Harmless line movement may therefore require regenerating
inventory and reviewing authored references. A stale qualified ID is unresolved;
DEVAI does not silently remap it to changed source evidence.

Inventory regeneration remains atomic across its planned bodies. An inner
producer failure publishes none and retains its concrete finding codes/messages
alongside the aggregate failure. Historical readings remain untouched.

## Conditional authorization diagnostics

`auth.required: true` records declared authentication/guard protection. It does
not prove that every permission branch has been resolved. RBAC retains unresolved
guard declarations and emits `RBAC_AUTHORIZATION_UNRESOLVED`; a synthetic guard
reference is not a concrete permission. Missing static permission metadata never
makes a guarded route public or invents an unconditional AND/OR permission set.

For example, a retention handler may require `privacy:read` for an absent/true
`dryRun`, `privacy:subject-rights` for false, and reject invalid values with 400.
Preserve those conditional obligations and negative witnesses. Current static
inventory reports unresolved permission semantics until a supported extractor
and representation can prove them.

## Optional policy sources

Declare complete optional `invariant_producers` and `reviewed_workflow_steps`
documents in your Architect-owned adopter policy. Their closed shapes are in
[invariant-producers.schema.json](../../../law/schemas/invariant-producers.schema.json)
and [reviewed-workflow-steps.schema.json](../../../law/schemas/reviewed-workflow-steps.schema.json).
Use the registered operation:

```sh
devai init bind --adopter-policy law/policy/adopter-policy.json --as-role architect --write
```

The resulting `.devai/config/invariant-producers.json` and
`.devai/config/reviewed-workflow-steps.json` are generated whole-file projections,
owned and digest-bound by the existing adopter receipt. Do not edit them by hand.
An absent block preserves a never-owned target. Removing a previously owned
block retires it to the installed empty default. Rebinding unchanged input is
idempotent; binding and rollback keep targets and receipt atomic.

Binding checks shape and intrinsic duplicates. Measurement checks the actual
candidate, tasks, annotations, source population and closure before execution or
credit. Merely declaring an unknown task or desired effect establishes nothing.

## Exact invariant producers

Each `bindings` entry names:

- `invariant_id`: the exact invariant.
- `subject`: a reviewed semantic obligation identifier.
- `taskId` and `population`: the exact annotated task and its matching output
  population.
- `requiredTestIds`: the nonempty subset of that task's complete native result
  population that must actually execute and pass for this subject.

Every binding for an invariant is required. Existing all-mode action obligations
remain required. A bound invariant cannot use generic action matches, another
subject's result or a successful exit code as evidence. Its fail-closed CI
producer and fresh passing measurement must agree on exact candidate/task,
descriptor/policy, selectors/source files, executable/runner, toolchain,
allowlisted environment, population and result custody.

## Reviewed workflow effects

Each `steps` entry names canonical YAML SHA-256, exact workflow/job/index
occurrences, step name, review, effect and the complete path/digest `files`
closure. Explicit `computed_imports` covers bind every reachable repository file
for computed imports/requires. Scripts, executable package/workspace config,
composite actions and imports remain part of closure. Changed or unreadable
inputs reopen review; unresolved reachability remains unknown.

The current adopter closure checker proves simple unquoted `node <file>` or
`tsx <file>` commands, and direct `pnpm`/`npm` named package scripts without extra
selectors/arguments, including their pre/post scripts. It follows literal
imports and explicitly covered computed imports, plus resolved configuration
without inherited `extends`. Unknown shell grammar, inherited working-directory
defaults, unsupported package selectors/hooks, composite actions and config
inheritance remain unknown until their complete execution closure can be proved.
Declaring an effect or empty file list cannot override that refusal.

Effects keep their existing meanings: `read-only` writes only workspace/runner
files or step outputs, `repository-write` changes repository branches and
`publication` writes release surfaces. Mixed jobs retain their strongest effect.
Reviewed entries cannot override package-owned effects or grant credentials,
permissions or approvals. Effect-specific concurrency and unknown-effect refusal
remain mandatory.

## Complete executable populations

The census includes `.test`, `.spec`, `.e2e` and `.wiring-spec` before JS, JSX,
TS, TSX, MJS or CJS extensions, with real multi-segment wildcard and recursive
glob semantics. Default roots include singular/plural package test directories,
colocated source tests and root test directories. Dependency/output/mirror
directories (`.git`, `node_modules`, `dist`, `build` and the registered
`.devai/worktrees` mirror path) are explicitly excluded. A directory named
`graft` alone is not evidence of a generated mirror. Declared missing/unreadable populations
do not silently disappear.

Direct sensors preserve explicitly configured external absolute read roots as
separate populations. The declared literal base resolves once to its physical
root, so system aliases such as macOS `/tmp` and `/var` remain supported; a glob
keeps its suffix and selector beneath the resolved base. Traversal is contained
beneath that physical root and refuses nested symlinks, missing/unreadable bases
and containment escapes. This makes no link-free claim about filesystem ancestors
outside the physical root. Existing display-path and basename-fallback behavior
remains compatible, and aliases do not count a physical file twice; the first
admitted display path is retained. An explicit literal file resolves its parent
only and still refuses a symlink at the file itself. These direct reads grant no
candidate custody. Candidate-bound tasks retain contained tracked
regular files and their no-link boundary, without the external-root alias
allowance, and require reviewed exact runner selection; broad ambiguous selectors
cannot infer a subset from output.

Mock classification uses actual AST calls and resolved ownership. Comments and
strings are not calls. Call-through observers, resolved external ports and valid
fault injection differ from replacing owned integration components. Integration
directories count alongside filenames. Preserve meaningful negative witnesses;
renaming tests or hiding mocks does not improve the evidence.

## Complete native results

Opt into `outputContract.resultPopulation` beneath explicit
`kind: "command-result"` and a nonempty `population`; see
[test-result-population.schema.json](../../../law/schemas/test-result-population.schema.json).
It declares native format, stable task `projectId`, selection evidence, transport,
complete executable files and complete expected test IDs. Standing supports
Vitest JSON and Playwright JSON with verified native collection and complete final
results from the same execution. Results-only JSON is insufficient.

Require `selectionEvidence` with `kind: "devai-native-collection"`, matching
`reporter: "vitest-v1"` or `"playwright-v1"`, and exact native `projectName`
(`""` for the default). The native project name is separate from `projectId`.
Initially the reporter must collect exactly one matching native project; unrelated
or multiple project results refuse rather than merge.

DEVAI verifies the installed package-owned reporter and actual native executable
closure, injects an internal nonce, and checks the reporter's preexecution
`devaiCollection` against final native results. Collection records planned files,
leaf identities and resolved project selection. Expected IDs and executable files
are comparisons, not runner selection proof. Dynamic configuration conservatively
binds all tracked candidate files as task inputs except the canonical planner
harness-mutated prefixes `.devai/state/`, `record/` and `scratch/`. Missing collection, a substituted
reporter, wrong nonce or unsupported execution cannot establish standing. No extra
planner command is inferred.

The portable input projection exclusions do not make arbitrary dynamic configs
self-contained. Additional native selection identity must bind and enforce the
actual transitive config/helper/plugin and read closure, including resolved
aliases, directory membership, dependency resolution and relevant environment.
Excluded state, untracked files or ambient HOME/PATH/TMPDIR cannot silently choose
a population or outcome. Unsupported filesystem, loader, network, subprocess or
config-hook reachability refuses; merely hashing the config or declaring its
imports is insufficient.

STYNX's shared factory illustrates this requirement: it reads threshold policy,
walks package sources for pure barrels, reads `STYNX_AGGREGATE_COVERAGE` and
installs a workspace fallback resolver. Those need actual bounded-read,
environment and dependency-resolution support. A static-import-only checker or
blanket filesystem ban cannot claim that factory supported. Playwright global
setup and web-server commands also need their admitted execution/effect closure.

Config admission requires an explicit `--config` path. It follows tracked relative
JS/MJS/CJS/TS/MTS/CTS imports and re-exports through a finite scanner. Package
imports are limited to `vitest/config`, `@playwright/test`, `typescript`,
`unplugin-swc`, `unplugin-swc/vite` and `@swc/core`. Node imports are limited to
fs/fs-promises, path, url and named `createRequire` from module. Runtime tracing
and operation guards still apply. Unknown packages/computed imports,
clock/random/Intl/network/global-reflection forms remain unsupported. TypeScript
access is limited to reviewed static AST helpers; CJS/dynamic/re-exported handles
and `ts.sys` remain unsupported.

The native environment is a closed bound snapshot. DEVAI supplies an empty
`NODE_V8_COVERAGE` and refuses caller overrides. Child snapshots may differ only
in reviewed native Vitest/Vite-generated values and numeric worker/pool IDs;
these are traced and checked against the same execution's resolved configuration,
not admitted merely by key name. The complete runtime projection contains exactly
`BASE_URL`, `DEV`, `MODE`, `PROD`, `FORCE_TTY`, `PLAYWRIGHT_TEST`, `FORCE_COLOR`
and `DEBUG_COLORS`. Vitest/Vite values must match the resolved configuration and
preserve the other initial values. Exact Playwright 1.60.0 may set
`PLAYWRIGHT_TEST=1`, `FORCE_COLOR=1` and `DEBUG_COLORS` to its initial value or,
when absent, `1`, preserving the other values. Esbuild may preserve the exact
initial projection. Missing, extra or mismatching values refuse.

Child/worker Node flags admit only `--experimental-import-meta-resolve`, explicit
`--conditions` values matching `[a-zA-Z0-9_.-]{1,128}`, and the reviewed Vitest
`suppress-warnings.cjs` require with SHA-256
`a5012da3d2027007781baecda154d343d8c7ad2327b79bec65b1b60a41f42dd1`.
Other flags or preloads refuse. Actual module
resolution edges and dependency instances are recorded and re-resolved. Stat
checks bind consumed fields, including descriptors; directory order and access
mode are preserved and revalidated.

Setup/global-setup/custom-provider path strings also need explicit supported
helper-file closure admission, followed by the same scanner and runtime trace.
They are not proven simply because the config file is admitted. For example,
STYNX's Playwright a11y global setup writes/resets `.test-results/a11y.json` and
`a11y.lock`; those writes need exact admitted effects. Computed helper paths,
unproved roots or unsupported writes remain unsupported. The read-only STYNX snapshot
`b42f8868843527c4dd99f5051775a0c61ba8eaef` uses V8 coverage; no custom
`CoverageProviderModule` was found in its tools/packages/reference source.

The initial Vitest provenance mode requires Node 24, Vitest 4.1.11, Vite 7.3.6 and
explicit `--configLoader native` plus `--config ./path/config.mjs` (or another
admitted extension). Bare config filenames refuse before execution because
Vite's native resolver can probe ambient ancestor package paths; DEVAI does not
rewrite the command. Vite 8 or the default/bundled loader refuses
standing. Native ESM configs need `import.meta.dirname` in place of
bundler-injected `__dirname`; unmodified STYNX compatibility is not promised.

| Transform dependency         | Admitted provenance mode                                                                                                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SWC 1.16.2                   | Source-string `transform`/`transformSync`, `swcrc: false`, `configFile: false`, `inputSourceMap: false`; no native plugins, experimental settings or cache roots. Presence of `baseUrl` or `paths` refuses the unobserved native resolver. Other native calls refuse except `getTargetTriple`. |
| fsevents 2.3.2/2.3.3 (macOS) | Initialization through a fresh frozen own-key export shim only; every callable export is denied. No watching is admitted.                                                                                                                                                                      |
| Rollup 4.64.5                | Guarded source-only parse/parseAsync and in-memory hash APIs.                                                                                                                                                                                                                                  |
| Esbuild 0.28.1/0.28.2        | Inline transform service protocol with `inputFS: false`; no build/native file operations. Greater-than-1-MiB disk spill remains UNKNOWN.                                                                                                                                                       |

Full-run filesystem/module observations are retained as raw trace plus SHA-256
metrics. Inputs must match candidate-tracked bytes or the resolved dependency
instance graph rooted in declared manifests. Implicit nameless module-scope
manifest presence/absence and bytes remain part of resolution provenance. Negative/stat/directory results are
rechecked. Closed framework discovery may replay only exact candidate-root
ancestor probes for `package.json`, `pnpm-workspace.yaml`, `lerna.json` and
`tsconfig.json` that establish absence (`ENOENT` or `false`). Positive outside-file
observations, other names/failures or changed results refuse; this is no general
ambient file grant. Excluded state/proofs reads, unsupported descriptor reads, streams,
watches or incomplete traces remain UNKNOWN. Custom coverage providers require
an observable JavaScript closure with no hidden I/O; their interface alone grants
no exception. This finite instrumentation supports cooperative tooling provenance
and does not claim a security sandbox.

The native Playwright manifest must be exactly version 1.60.0. Its output
directory must be explicitly scoped beneath the canonical
harness-mutated state namespace, such as `.devai/state/`; its default
`test-results` directory can dirty the candidate and receives no implicit write
permission. Browser, server and global-setup effects need exact separate
admission. An observed Playwright version or a parser fixture alone does not
establish an installed positive run.

Ordinary Node TAP remains diagnostic UNKNOWN: it lacks this complete collection
and may omit unambiguous per-test source provenance. Exit zero, a final count,
a file roster or guessed ordinal cannot manufacture missing native identities.

Test IDs are `test:v1:` followed by URI-encoded canonical JSON of
`[projectId,sourceFile,ancestorTitles,testTitle]`. Exact full expected IDs,
collected IDs, final IDs/counters/plans and the selected executable census must
agree. Raw stream and native collection/plan digests bind the parsed results.
Duplicate names cannot be rescued with an ordinal or line number.

Direct output is separate from Turbo transport. Turbo removes only the reviewed
project prefix at line starts; it never merges unrelated project streams or
proves the inner runner by prefix alone. Cache hits/replays are nonexecuted.
Skipped, todo, ignored, missing, duplicate, partial, ambiguous or truncated results
cannot become executed PASS. Retry attempts stay visible under their native
identity and final terminal outcome.

## Execution origin and population standing

Self-consistent native JSON and a matching nonce prove consistency rather than
origin. Only actual registered bound task execution can mint the internal
reading token with an immutable measured-body snapshot used to append
`sense.task.execute` in `record/proofs/chain.json`.
Post-execution mutation invalidates the token. After verified final instance
resolution that event binds the exact final artifact bytes,
current candidate and task; its native-only resolved authority covers exact chain append/atomic staging and
nonce-scoped provenance traces under explicit task write consent.
It is an internal ledger event, with no new CLI command or caller flag.

Standing requires this execution receipt before the matching generic record,
the persisted exact artifact, and passing native verification. `sense record`
cannot mint origin from authored JSON, repair a missing execution receipt or
refresh an old execution by re-recording. Missing origin requires fresh admitted
execution. Ordinary observations retain their existing pure measurement behavior. The
native operation may create `record/proofs`, atomically stage only its exact
`chain.json.tmp.<pid>.<time>` and rename it to `chain.json`; it may not write other
proofs. Transient traces are confined to
`.devai/state/native-config-traces/<internally-minted-nonce>` and owned cleanup.
Parent creation grants no sibling permission.

Trusted preload/loader instrumentation must cover config, worker, plugin and
setup collection stages, bind resolved dependencies, and recheck positive and
negative filesystem/stat/directory observations. An incomplete trace or
unsupported API/process mode refuses standing. Native config dependency lists
corroborate rather than replace the trace. This supports cooperative native
provenance; it is not a security sandbox against deliberately bypassing plugins.

Task readings retain separate current heads for each exact kind/task/population
within candidate custody. Scorecards keep all heads and use the worst applicable
outcome; a passing task cannot hide a failing or unresolved sibling. Missing
bound obligations stay unmeasured. Cross-task/population supersession refuses.
Legacy observations keep their existing per-kind selection.

## STYNX migration and release evidence

The finite native mode requires an adopter migration before it can establish
standing. This DEVAI campaign does not edit STYNX or claim unmodified compatibility.
For the inspected backend/shared-factory configuration:

1. Resolve and bind Node 24, Vitest 4.1.11, Vite 7.3.6 and supported transform
   dependency instances. A manifest range alone does not establish those bytes.
2. Replace config references to bundler-injected `__dirname` with native ESM
   paths such as `import.meta.dirname`. A helper that already defines its own
   local directory from `import.meta.url` does not need this semantic change.
3. Declare the exact native task, explicit config, native config loader and
   installed package-owned reporter. Bind the reviewed environment, including
   any `STYNX_AGGREGATE_COVERAGE` input; preserve coverage obligations and
   thresholds. Select one exact native project for each population.
4. Admit actual threshold-policy reads, source-directory membership, aliases,
   module-scope manifests and workspace resolution edges through the finite
   scanner and provenance trace. Unsupported helpers, setup writes or server
   commands require supported exact admission before any standing claim.
5. Review the complete collected executable files and native IDs, then execute
   and record through the registered origin/custody path. Retain all population
   heads and discharge every bound obligation; no measured subset substitutes
   for the whole declared population.

Before publishing 2.5, freeze source, manifests, workflows and their reviewed
execution closures, then validate the exact assembled/installed candidate with
independent positive and hostile native cases. Schema validation, a draft build
or a parser fixture is insufficient. The unconditional release checks, exact
candidate custody, protected evidence verification and publication controls remain
required. Unsupported populations stay explicit; a passing subset does not close
all seven audit gaps or establish a STYNX readiness scorecard.

## Trusted verifier migration

The source trusted pin advances to published `@aarusso-nyx/devai@2.4.0`, which
contains canonical verifier `ad790aea6f200412da79a3a1bfbaa03cbdb47a2d` and admits
supported `sensorKinds` task annotations. Verify the exact published package and
its complete provenance/file population first. Update only the verifier identity
in the schema-validated adopter-owned toolchain manifest, preserving repository
pins, runtimes and constants; no current init operation carries that edit.
Regenerate generated attested-RC workflows through supported host-adapter
binding/upgrade, then separately record and verify effective
repository/environment protected provenance values. DEVAI's own protected
workflow/checker source follows governed Engineer authoring and independent
review rather than an invented generator.

The exact new provenance is
`fc79da07d4d4dfa466548337a4944ae1b7e0bfdcf2f1c334b341bb1ad477cd4d`.
An embedded verifier, edited generated file or stripped annotation does not
switch the protected executable. Preserve earlier evidence and follow the
[release discipline](./release-discipline.md#the-verifier-source-boundary-and-the-order-of-a-repin)
for every later full repin.
