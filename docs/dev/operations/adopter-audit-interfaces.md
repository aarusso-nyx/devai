# Adopter audit interfaces

DEVAI 2.5.0 publishes the audit interfaces below; its package remains immutable.
The developing 2.6.0 minor candidate adds the read-only workflow review inventory.
A declared policy or successful binding is not an audit PASS: installed producer
validation, independent regressions and protected integration must establish each
result.

The normative decisions are
[ADR-SCR-0016](../../../law/adr/ADR-SCR-0016-lossless-endpoint-observation-identity.md),
[ADR-SCR-0017](../../../law/adr/ADR-SCR-0017-declared-audit-producers-and-complete-results.md),
[ADR-SCR-0018](../../../law/adr/ADR-SCR-0018-read-only-workflow-step-inventory.md)
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

### Installed workflow review extraction (2.6 candidate)

Use the installed public read route:

```sh
devai sense inventory --slice workflows --repo-root . --format json
```

The `workflow-step-inventory` member value follows
[workflow-step-inventory.schema.json](../../../law/schemas/workflow-step-inventory.schema.json).
It lists contained `.github/workflows/*.yml` and `*.yaml` files in deterministic
order, each with its raw YAML `sha256` and physical step rows. Each step has
`job`, zero-based `index`, exact `occurrence`, `name`, canonical step `sha256`
and `closure`. Equal digests retain every occurrence. A complete closure lists
unique path-sorted `{path, sha256}` rows for contained regular executable,
import and configuration files; it never substitutes a partial file list.

Canonical step identity uses the existing parser: recursively sorted mapping
keys, preserved list order and parsed scalar values, then `JSON.stringify`
and UTF-8 SHA-256. It differs from the whole raw workflow digest. The exact
occurrence `.github/workflows/example.yml#job[0]` already matches adopter review
input; package-owned basename registry notation is separate and is not converted.

The extractor shares actual adopter selection and closure rules. Only verified
current bound computed-import covers may discharge dynamic reachability. There
is no caller-supplied review flag. Unsupported commands, inherited defaults,
actions, unresolved imports or invalid bindings stay `unknown`, with a reason;
an unknown closure has `files: null`. Workflow/YAML failures retain a diagnostic
workflow row when its identity is available. Any nested unknown gives top reason
`WORKFLOW_INVENTORY_INCOMPLETE`; no workflows gives `WORKFLOW_INVENTORY_EMPTY`.
The existing envelope reports REVIEW/exit 1; hard refusal or invalid invocation
remains exit 2. A complete extraction reports PASS/exit 0.

This route executes no workflow and writes no policy, readings or proofs. It
does not choose an effect or provide the required review rationale. Independently
review the complete roster before grouping matching digests into a reviewed
entry. Package-owned dispositions cannot grant missing adopter closure. Existing
slices and the existing `all` population remain unchanged; request `workflows`
explicitly.

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
rewrite config arguments. Vite 8 or the default/bundled loader refuses
standing. Native ESM configs need `import.meta.dirname` in place of
bundler-injected `__dirname`; unmodified STYNX compatibility is not promised.

| Transform dependency         | Admitted provenance mode                                                                                                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SWC 1.16.2                   | Source-string `transform`/`transformSync`, `swcrc: false`, `configFile: false`, `inputSourceMap: false`; no native plugins, experimental settings or cache roots. Presence of `baseUrl` or `paths` refuses the unobserved native resolver. Other native calls refuse except `getTargetTriple`. |
| fsevents 2.3.2/2.3.3 (macOS) | Initialization through a fresh frozen own-key export shim only; every callable export is denied. No watching is admitted.                                                                                                                                                                      |
| Rollup 4.64.5                | Guarded source-only parse/parseAsync and in-memory hash APIs.                                                                                                                                                                                                                                  |
| Esbuild 0.28.1/0.28.2        | Inline transform service protocol with `inputFS: false`; no build/native file operations. Greater-than-1-MiB disk spill remains UNKNOWN.                                                                                                                                                       |

Native generated caches are a same-execution output population, not an external
input allowance. The host creates only the fresh empty nonce-scoped
`.devai/state/native-config-traces/<internally-minted-nonce>/runtime` directory.
The closed environment internally supplies `TMPDIR` at that physical root and
`PWTEST_CACHE_DIR` at its `playwright` child, refusing descriptor overrides.
The trusted main-process begin event records the root and empty contents before
imports. This uses the existing exact native state operation and grants no
ambient `/tmp` permission or caller-selected cache root.

Only verified finite Vitest 4.1.11/Playwright 1.60.0 cache subdirectories,
hash-files and staging forms qualify. Actual Vitest context/project temporary
roots reported by the package-owned reporter must stay in the owned namespace.
Successful mkdir, full writes, renames and removals form an ordered cross-scope
virtual output ledger, retaining each live path/encoding/byte SHA-256 identity.
Each worker read needs a matching earlier live identity. An atomic `.tmp-*` to
`ssr` hash-file rename must carry the successful write into the target; the target
path alone earns no credit. Overwrites require ownership, and removal/replacement
invalidates the old identity. Links, escapes, unowned writes, preexisting files,
replayed caches, partial/future writes and ambiguous ordering refuse. Owned
cleanup is replayed; retained custody facts survive deletion. Nested framework
removal calls may share only the same active owned outer subtree's complete
intent/success pair. Metadata/read observations and the full outer snapshot stay
visible; context resets on completion/error. Other paths and failed/partial
cleanup gain no exemption.

Opting into native Playwright 1.60.0 `resultPopulation` also opts into DEVAI's
owned result directory. DEVAI supplies `--output` with this execution's exact
physical `runtime/playwright-results` directory beneath the fresh nonce root,
overriding config `outputDir`. Caller `--output` forms refuse. Ordinary tasks
keep their authored output selection. Tests depending on a configured output
location need migration or remain unsupported in this mode.

The authored task argv and portable identity are preserved; private execution
identity additionally binds the actual Node bytes, complete effective argv and
owned result root to the authorized process and immutable measured body. Every
selected project's reporter-resolved `outputDir` must equal that root. This
permits no general insertion of arguments or arbitrary state writes.

The result ledger is separate from the transform-cache ledger. It admits only
the exact result root, immediate directories named
`.playwright-artifacts-<decimal-integer>` or ASCII slugs matching
`[A-Za-z0-9_-]+`, and full writes of the root's `.last-run.json` metadata file.
Owned directory metadata/creation/cleanup and ordered result-file
write/removal must retain fresh/no-link custody. Other files, deeper
artifacts, unowned overwrites and every rename involving results refuse,
including cache-to-result/result-to-cache renames.
Result artifacts grant no `readFile`, executable, module or transformed-source
input credit. Only verified transform-cache `.js` identities can support the
Playwright transformed-source allowance. This finite mode does not claim browser
attachments or other browser-output support.

Exact Playwright 1.60.0 loader-transformed source has its own module-load digest;
the raw file read is recorded and verified separately. Raw candidate/dependency
bytes, resolution, complete exact loader/transform closure and fresh owned cache
custody remain required. Transformed bytes never replace raw input custody, and
a version match alone is insufficient. Other runners gain no transformed-load
exemption. Provenance UNKNOWN discards native executed-population measurements;
retained diagnostics cannot earn standing.

Full-run filesystem/module observations are retained as raw trace plus SHA-256
metrics. Inputs must match candidate-tracked bytes or the resolved dependency
instance graph rooted in declared manifests. Implicit nameless module-scope
manifest presence/absence and bytes remain part of resolution provenance. Negative/stat/directory results are
rechecked. Alongside bound resolution-manifest absence facts, framework discovery
has only these finite source-derived negative probe sets:

- Candidate-root ancestor `package.json`, `pnpm-workspace.yaml`, `lerna.json`,
  `tsconfig.json` and `jsconfig.json`: `readFile`/`stat`/`lstat` must return
  `ENOENT`, or `exists` must return `false`.
- Explicit task config path/basename candidates in task-cwd ancestor
  `node_modules`, with no suffix or `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`,
  `.jsx`, `.tsx`, `.json`, `.node`: only `stat`/`lstat` returning `ENOENT`.
- Exact resolved `playwright@1.60.0` package-root `test.js` and `lib/index.js`
  converted to literal file-URL `pathname` strings without percent-decoding:
  only `exists(false)`.

All negative-probe targets must remain absent on replay; they grant no positive
outside-file or ambient file permission.

Linux platform detection has a separate closed fact population for four exact
reviewed synchronous framework reads:

| Pinned caller                                       | Literal read              | Consumed fact                                                                              |
| --------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| Vite 7.3.6 `dist/node/chunks/config.js:15772:13`    | `/proc/version`, `utf8`   | Lowercase text excludes `microsoft`; actual `os.release()` must also exclude it.           |
| Playwright core 1.60.0 `lib/utilsBundle.js:5679:19` | `/proc/version`, `utf8`   | The same non-Microsoft predicate.                                                          |
| Playwright core 1.60.0 `lib/coreBundle.js:7669:48`  | `/etc/os-release`, `utf8` | Exact pinned parser's `id` and `version` from `ID`/`VERSION_ID`, without OS normalization. |
| SWC core 1.16.2 `binding.js:28:12`                  | `/usr/bin/ldd`, `utf-8`   | Actual text excludes `musl`; initial support is the successful GNU branch.                 |

The exact four installed and executing-source SHA-256 identities are recorded in
[ADR-SCR-0017](../../../law/adr/ADR-SCR-0017-declared-audit-producers-and-complete-results.md).
The paths `/proc/version` and `/usr/bin/ldd` must resolve to themselves.
`/etc/os-release` may resolve only to itself or the explicit
`/usr/lib/os-release` alias. That alias grants no general linked-file support.
The original read result/error passes through unchanged. A successful fact
separately binds the actual returned UTF-8 digest and an immediate original
raw-byte reread digest; equality is required, so invalid UTF-8 or changed bytes
cannot masquerade as raw identity. Digests and exact consumed values are
observations, not authored authority assertions.

A saved `util.getCallSites({sourceMap: false})` immediate frame must identify the
reviewed operation's actual V8 `scriptId`. A fresh private in-process inspector session for each query
synchronously retrieves that script's exact raw source and verifies its digest,
package/file and line/column. Filename/stack strings or disk bytes alone do not
defeat VM/source-URL impersonation. No wrapper/source-map normalization is
admitted. Original session constructor/method implementations are captured before
candidate imports and bound only to each privately created session;
only `Debugger.enable`/`Debugger.getScriptSource` are used. There is no
evaluation, listening endpoint, network connection or exposed session. Missing,
failed or asynchronous source lookup is UNKNOWN. Inspector live editing can
change a body while preserving its `scriptId`, and an existing debugger agent can
retain old source after changed code executes. Use a fresh private session for
every probe and every recorded fact's source requery before its own scope seals;
require the same reviewed raw-source hash. Never reuse a source cache or an
agent's retained snapshot. Each query connects, completes synchronous
enable/source lookup and disconnects in `finally`. Missing, asynchronous,
changed or incomplete checks refuse.

The preload may privately retain an unformatted `Error` captured during the
genuine probe with its pre-import captured constructor. This keeps the
authenticated caller script reachable through its own terminal checks. The
object stays private: never read or serialize `.stack`, invoke candidate
formatting, or use it as source or identity authority. Release it only after
terminal checks. Every source query still uses a fresh private session;
unavailable or changed source remains UNKNOWN, including failed retention. A
debugger agent's collected-source cache cannot supply the missing proof.

Facts bind nonce/scope and unique probe identity, actual PID/platform/architecture
and OS release, executing caller/source identity, exact literal API arguments,
physical target, raw/returned digests and predicate/fields. Each fact needs a
matching live recheck before its own scope seals, plus independent current-host
replay before execution-origin append and every later standing decision. Changed,
missing or duplicate facts/rechecks refuse. The shared probe helper's exact bytes
are also part of the installed native execution identity. This is measured
provenance under the immutable execution-origin contract, not a new public input
schema, action or inspector permission.

Candidate code reading the same paths gains no exception. Other callsites, API
arguments, physical targets, failed reads, Microsoft/musl branches,
container/cgroup/report/child-process fallbacks and further WSL inputs remain
diagnostic UNKNOWN. Observing them must not change native return values or
branch behavior. Initial normal-Linux support therefore does not claim WSL,
musl, browser or arbitrary host-file support.

Outside those finite facts, positive outside-file observations, other
targets/operations/failures or changed results refuse. Other excluded state/proof input reads refuse outside the preceding generated-output
ledger. Unsupported descriptor reads, streams,
watches or incomplete traces remain UNKNOWN. Custom coverage providers require
an observable JavaScript closure with no hidden I/O; their interface alone grants
no exception. This finite instrumentation supports cooperative tooling provenance
and does not claim a security sandbox.

The native Playwright manifest must be exactly version 1.60.0. Its result output
uses the internally bound fresh directory and finite ledger above. Neither the
default `test-results` directory nor arbitrary `.devai/state/` paths receive
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

Native workers use their own private scope/control port/shared acknowledgement.
Original `workerData` and transfer semantics are restored before candidate
imports. Before native `Worker.terminate`, the parent requests the worker's own
seal; only its preload can persist the actual end and acknowledge after supported
I/O completes or observably drains. The parent wait is bounded to five seconds.
Missing acknowledgement, pending/unobserved I/O or termination without closure
remains UNKNOWN. Normal worker exit also needs actual worker-owned terminal
evidence; a parent termination event cannot invent it. Each child loader still
requires its own separate seal, and post-seal hooks/I/O refuse.

Exact Playwright 1.60.0 async ESM loaders require the bound package-owned
bootstrap/preload and original loader/package closure. Each isolated scope
imports preload dynamically before dynamically importing the original loader,
while preserving its initialization data, hooks and port transfers. Static
re-exports, arbitrary registration targets and adopter-created loaders do not
qualify. Registration creates a private child scope and separate control
port/shared acknowledgement buffer; an inherited owner-scope clone refuses.
Forwarded hooks track active work. Normal parent termination requests a seal;
only quiescent hooks and completed supported I/O can persist the preload's actual
end and acknowledge it. Private I/O initiation/completion accounting must drain
pending operations observably or refuse; termination cannot hide an unfinished
callback or promise behind an acknowledgement. The parent wait is bounded to
five seconds, and post-seal hooks/I/O refuse.
A real begin and persisted seal must close each main/worker loader scope and
prove observation flush. Normal exit cannot stand in for a missing acknowledgement.
Missing stages, termination without closure or timeout remain UNKNOWN.

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

The separately inspected STYNX dependency range `@swc/core ^1.15.41` resolves
in its lock/install to core 1.16.2, with unplugin-swc 1.5.9, Vitest 4.1.11,
Vite 7.3.6 and esbuild 0.28.1. Actual Vite-resolved Rollup 4.60.4 differs from
the admitted 4.64.5, and the privacy config still uses `__dirname`. Those facts
require reviewed migration and installed verification. A matching core version
alone proves no standing; an actual core 1.15.41 remains unsupported. The workflow
inventory adds no native version admission.

For the 2.6 candidate, freeze source, manifests, workflows and their reviewed
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
