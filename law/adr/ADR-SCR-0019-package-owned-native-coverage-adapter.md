---
id: ADR-SCR-0019
title: Package-owned finite native coverage helper adapter
type: adr
status: accepted
date: 2026-10-11
authority: Architect
supersedes: []
provenance:
  - ADR-SCR-0017
  - ADR-SCR-0018
affected_rules:
  - packages/cli/src/native-coverage-adapter.ts
  - packages/cli/src/commands/sense/native-config-capabilities.ts
  - packages/cli/src/commands/sense/native-runner-selection.ts
  - packages/cli/src/native-input-provenance.ts
  - packages/cli/scripts/assemble-package.mjs
  - packages/cli/package.json
  - docs/dev/operations/adopter-audit-interfaces.md
inspector_acceptance:
  - IA-001 -- The installed adapter admits only closed declarative requests within host-owned candidate and dependency authority, with no exported original IO, compiler system, subprocess or private origin token.
  - IA-002 -- Bind actual TypeScript 6.0.3 resolution and every compiler host input, directory and absence observation; emit only the exact requested in-memory output set and refuse diagnostics or changing inputs.
  - IA-003 -- Read production outputs only after independent exact compiler emission equality, retaining original source, map, declaration and diagnostic identities without generic untracked-output permission.
  - IA-004 -- The sole git operation uses the exact bound executable and checkout with closed environment, returns actual rev-parse HEAD, and refuses command, head, executable, environment or checkout changes.
  - IA-005 -- Preserve original native coverage populations, source maps, counters, configuration, thresholds and provider checks; report output is finite and nonce-owned, with no invented browser, server, database or arbitrary coverage support.
  - IA-006 -- Diagnostic use establishes no native origin or standing; governed use requires complete native results, actual per-scope seals, immutable origin and current custody revalidation.
---

# Package-owned finite native coverage helper adapter

## Status

Accepted as an additive contract in the Owner-authorized DEVAI 2.6 campaign.
Implementation, hostile tests and actual installed adopter measurements remain
separate prerequisites. This decision supplies no provider or adoption PASS.

## Context

STYNX candidate `e20d01a7049c268d8cd096ef5b7a4b4a22254c74` uses a real
privacy-specific V8 provider. Its helper verifies exact source census, production
TypeScript emission, source maps, coverage conversion and changing inputs. Its
provider verifies resolved project/configuration/options and original thresholds,
then checks the final covered source census. Actual dependencies include
TypeScript 6.0.3 and `@vitest/coverage-v8` 4.1.11.

The helper currently reaches SHA-256, git HEAD and TypeScript system/compiler
APIs. Merely importing it from the shared config exceeds ADR-SCR-0017's finite
config language, including when native coverage is not selected. Hash-listing
arbitrary adopter JavaScript would not confine those capabilities. General
`node:crypto`, `child_process`, `ts.sys` or reflection exceptions would also
exceed the existing admission boundary. Untracked production output must not
become a trusted input merely because a helper claims it matches source.

## Decision

Expose the package export `@aarusso-nyx/devai/native-coverage-adapter` with named
factory `createNativeCoverageAdapter(options)`. It is a finite helper, not a new
CLI action or a general compiler/process/IO interface. The existing native
runner, private provenance instrumentation and custody mechanisms remain the
only source of governed native standing.

### Pure data helper exports

The same subpath may additionally expose exactly the synchronous named functions
`isProxy(value)` and `sameNativeData(left, right)`. They provide no IO, compiler,
context, token, output registration or standing. Capture required native
intrinsics before adopter imports; neither a general util namespace nor global
Reflect authority is admitted. `isProxy` returns the captured intrinsic Proxy
classification without reflecting on the value or invoking a trap.

`sameNativeData` compares primitives with Object.is, ordinary/null-prototype
own-data records and ordinary arrays. Preserve own string/symbol key identity,
descriptor flags, array length/holes and paired cyclic-reference identity;
property order alone does not change an ordinary record's equality. Reject
Proxies before any reflection, including when both operands are the same object.
Reject accessors, functions and unsupported exotic prototypes. Never invoke a
getter, toJSON, iterator, coercion or inherited/prototype method. A supported
data mismatch returns false; an unsupported value or exhaustion of the closed
64-depth/10,000-distinct-object-pair budget throws. These helpers do not weaken
the adopter's existing descriptor, mutation or source-map refusal semantics.

### Closed request and authority

The request is a plain own-data object with exactly `packageDir`, `config`,
`modules`, `includes` and `excludes`. Modules are nonempty ordinary arrays of
exact `{source, output}` records; source is a portable package-relative `.ts`
file and output a portable package-relative `.js` file, with its exact `.map`
companion. Includes/excludes retain the complete original source population.
Reject Proxy objects with a captured native Proxy check before reflection or
property inspection. Reject getters, accessors, extra keys, holes, duplicates,
ambiguous case aliases,
links, hardlink ambiguity and containment escapes. `config` identifies the
contained package compiler configuration, initially exactly `tsconfig.json`.
`packageDir` locates a package inside the admitted checkout; it does not choose
or expand the authority root.

The executing host owns candidate checkout/root, admitted commit/tree, complete
tracked input snapshot, dependency instance graph, environment, runtime scope and
permitted generated outputs. Caller options cannot supply these identities,
allowed dependency bytes or an origin token. Every requested source, config and
import must resolve within that host authority. Returning public evidence never
exposes a private registration capability or raw original IO handle.

### Finite API

The factory and every returned operation are synchronous. Source, census and
output paths are canonical portable package-relative paths. The adapter returns
only the following finite operations and detached evidence:

- `sha256(value)` hashes a detached string or Uint8Array using SHA-256. It exposes
  no hash object, mutable shared-buffer input, randomness, keys, signing or IO.
  A Uint8Array must be a genuine non-Proxy byte view and is copied immediately;
  SharedArrayBuffer and detached backing buffers refuse.
- `candidate()` returns the actual admitted 40-character lowercase hexadecimal
  git HEAD observation below.
- `sourceCensus()` returns the complete unique sorted source census for the
  unchanged includes/excludes.
- `compile({mode, source})` accepts only `production` or `coverage` and an exact
  admitted source. It returns detached `outputs: [{path, text, sha256}]` and
  diagnostics. Text is the actual UTF-8 compiler output; the digest hashes those
  exact encoded bytes. There is no caller-supplied host or emit callback.
- `readVerifiedOutput(path)` returns a detached canonical UTF-8 string only for
  an exact production JavaScript, map, declaration or declaration-map output
  already independently recomputed and verified against the physical build bytes.
- `verify()` rechecks the whole admitted snapshot, candidate, compiler,
  dependencies, resolution observations and output identities.
- `evidence()` returns detached measurement facts. It is neither an attestation
  supplied by the caller nor a substitute for origin/custody verification.

Any output-root identity exposed for provider configuration is chosen and minted
by the host, under the current nonce-owned runtime root. It is not an arbitrary
path supplied to a writer. Additional API operations or output forms require
explicit finite design and independent acceptance.

The detached evidence object has exactly `schemaVersion: "1.0.0"`, `mode`
(`diagnostic` or `governed`), `candidate`, `git`, `compiler`, `config`,
`sourceFiles`, `inputs`, `resolutionSha256` and `outputs`. Git facts are exactly
`path` and `sha256`: the independently resolved physical executable path and its
actual byte identity, not an ambient command name or an authority grant. Compiler facts are `version`,
`entrySha256` and `manifestSha256`. Config facts are `path`, `sha256`,
`productionOptionsSha256` and `coverageOptionsSha256`. Each input has `path`,
`sha256` and `origin` (`candidate` or `dependency`); each output has `path`,
`sha256`, `source` and `mode` (`production` or `coverage`). Source/output paths
are package-relative; input identities must resolve against the existing
host-bound candidate/dependency graph rather than convey caller authority.
The resolution digest binds the complete ordered actual positive/negative and
directory observation population, not an authored summary. All SHA-256 values
are lowercase 64-character hexadecimal identities; paths/arrays are canonical
and detached. These fields are normative implementation requirements, not
claims that the export or its private custody is already implemented.

### Compiler and generated input identity

Resolve TypeScript through the actual admitted package dependency edge and bind
its manifest, entry point and complete physical dependency bytes. Initially the
supported compiler is exactly 6.0.3. No root-level version label substitutes for
that resolution. The adapter owns its custom CompilerHost; it exposes no
`ts.sys`, default compiler host, arbitrary API namespace or inherited callback.

Every callback is closed: readFile, fileExists, directoryExists, readDirectory,
realpath, default-library path/location, current directory, case sensitivity,
newline, source acquisition and module/type resolution. Positive reads require
candidate-tracked bytes or the exact declared dependency instance graph.
Directories and negative probes are recorded with actual options, order and
results and revalidated. Config references, extends, aliases and compiler libs
must resolve through that same closure. Unsupported loaders/plugins, ambient
paths, writes, process/network access or unresolved host callbacks refuse.

Production compilation preserves the actual admitted parsed production options.
Coverage compilation uses the original finite conversion: ESNext modules,
Bundler resolution, separate source maps with inline source contents, no
inlined source map or declaration/declaration map, and ordinary JavaScript emit.
No other caller-supplied compiler options are admitted. Preserve original
compiler diagnostics; Error diagnostics throw and return no caller-creditable
outputs. Skipped emission, missing/extra/duplicate outputs and unexpected output
names likewise refuse. Emit remains in memory.

The production emission must independently reproduce every requested existing
JavaScript output and map and, where configured, declaration/declaration map.
Bind exact source/config/compiler/dependency bytes, production options and
output bytes before a build artifact receives generated-input credit. Read
identity is specific to that verified output and current scope, never a generic
`dist` exemption. A caller-supplied evidence object or matching authored hash
cannot register it. Recheck the physical output and all derivation inputs before
seal/origin and standing; a change invalidates the measurement.

Coverage maps retain original sources, mappings and counters. Materializing a
missing sourcesContent field requires exact unchanged canonical UTF-8 source;
no existing map field is rewritten to conceal a difference. Preserve the native
helper's production-versus-conversion distinctions and exact final source
census. Declaring the adapter cannot drop a source or native variant.

### Exact read-only git observation

The only admitted subprocess is actual `git rev-parse --verify HEAD`, with no
shell, extra argument, user option or configurable operation. Its physical
executable bytes and exact checkout/package cwd are independently bound by the
host, not ambient PATH or caller options. The environment is the closed native
execution environment, with no unreviewed GIT configuration/directory overrides.
Capture actual stdout/stderr/status. Successful canonical commit output must
equal the admitted candidate. Errors or another commit refuse.

Repeat the actual operation during verification and before governed seal/origin
and standing. Repository administration is consulted solely for this finite
identity check; it grants no arbitrary `.git` read/write or git command access.
There is no fabricated HEAD answer and no permission for unrelated children.

### Provider, pure data operations and owned reports

An adopter may migrate its helper to these finite operations while retaining
its provider's existing verification logic. Pure structural own-key, prototype
and property-descriptor inspection of plain configuration data is permitted
only through the reviewed bounded surface. It grants no global reflection,
function construction/evaluation, Reflect.apply/construct or mutable original
runtime handle. Arbitrary provider imports remain subject to closure admission.

The exact `@vitest/coverage-v8` 4.1.11 provider/runtime must match the actual
Vitest 4.1.11 edge and complete package closure. Provider initialization,
transformFile and generateCoverage retain the original project/configuration,
source census, production/native/conversion map, final counter and threshold
checks. The current STYNX provider is privacy-specific and is not a certificate
for every workspace project. An installed provider's successful exit or an
adopter evidence object does not independently establish these facts.

Coverage output needs its own finite host-owned namespace beneath
`.devai/state/native-config-traces/<nonce>/runtime`. Actual report and temporary
forms, operation order, successful full writes, reads, renames and cleanup must
be enumerated and independently accepted before use. No arbitrary state/output
exception follows from reserving that directory. Reports cannot become source,
module, compiler or transformed-input credit. Bind the emitted Istanbul/report
bytes and actual result/source census to the same execution and retain all
original coverage counters and thresholds. Unsupported report forms remain
UNKNOWN; no provider support is claimed before their real traces pass.

### Diagnostic versus governed use

Ordinary diagnostic use may construct a verified read-only snapshot for its
actual checkout and dependency graph. Its finite snapshot discovery may use
actual bound-executable `git rev-parse --show-toplevel`,
`git rev-parse --verify HEAD` and `git ls-files -z`, with closed arguments,
environment and physical-root validation. These discovery operations are not
available as a general subprocess API and do not expand governed HEAD-only
admission. It still checks all inputs and finite
operations; it grants no native origin, custody, host write authority or standing.
Governed use must obtain the private current execution context internally.
Public JSON, options, evidence or re-recording cannot mint that context.
An active governed native process with missing or mismatched private context
refuses; it cannot switch to diagnostic mode by changing environment, importing
another physical module instance or failing private registration. Diagnostic
fallback cannot create an unobserved IO channel inside a governed scope.

The adapter's package/export/runtime helper bytes are part of native selection
identity. Same-execution complete collection/results, immutable measured body,
private execution-origin registration, actual per-scope pending-IO completion,
own seals and current custody checks remain mandatory. Missing or mismatched
context/snapshots/outputs never fall back to caller assertions or cached source.

### Private kernel and replay boundary

The compiler kernel may accept internal read, metadata, resolution, git and
observation callbacks, but cannot capture or export original IO itself. The
canonical early preload alone constructs the governed factory with immutable
host-owned authority and captured original operations. Its public entry exposes
only the closed factory above. No public context installer, artifact registrar,
mutable global registry, environment payload or caller callback can install
privileged state. The active-scope refusal state is captured before adopter
imports and survives later environment changes or alternate physical imports.

For each private adapter instance, retain the closed request, ordered successful
compile operations, exact emitted identities, verified physical output reads
and final evidence under its actual nonce and scope. An adapter identifier or
trace row is a correlation fact, never a bearer capability. Own-scope sealing
must verify every live adapter before the scope's actual terminal record.
Missing, failed, extra or inconsistent instance operations invalidate standing.

The host independently reconstructs the requested compiler operations against
the exact bound candidate, Git executable, compiler and dependency graph. It
compares the full evidence, input/resolution observations, exact emission and
physical production outputs before granting read or module credit to a specific
generated artifact. Public evidence cannot substitute for this reconstruction.
Repeat current derivation and observation checks before origin and every
standing decision; an earlier valid trace is insufficient after input changes.
The entry, kernel, pure-data helper and preload byte identities belong to native selection.

Workspace packages retain their physical ownership: a node_modules link does
not turn untracked repository build outputs into external dependency bytes.
Their generated JavaScript and declaration inputs need independently verified
production derivations or an existing equally exact build-artifact custody
contract. No recursive workspace dependency receives a generic dist exemption.

### Scope of adoption acceptance

A factory split may remove unused native helper imports from ordinary unit and
integration configurations if unchanged resolved selection, transforms, aliases,
thresholds and ordinary gates are independently proved. It does not waive real
coverage-provider obligations or satisfy another test population.

The 43 PASS plus two existing N/A target retains every current cell, invariant
all-mode obligation, ordinary gate and actual history sample/window. Native
unit result standing is not coverage-depth, HTTP performance, browser or database
proof. Existing coverage report/population binding must be satisfied separately.

Real browser/webserver/database/container lifecycles require separate finite
profiles: actual executable/dependency/browser identities, endpoint/port and
fixture scope, closed environment, admitted start/stop operations, child/worker
lifetime, artifact custody and proven cleanup. They are pending requirements,
not waived obligations or implied by Playwright JSON support. Node TAP remains
diagnostic UNKNOWN unless a separate provenance-capable native adapter proves
its unchanged canonical checks and complete actual IDs.

Workflow extraction retains all physical occurrences. Intrinsic harness
coherence requires every job's effect to be proved under its complete workflow
population; known built-in classifications need not become adopter-reviewed
closures. Any remaining unknown affecting a job remains blocking. A separately
human-authorized target requiring complete executable closure for all 176
occurrences would add to roster enumeration and must be met honestly. A
cross-thread architectural proposal alone does not create that extra PASS gate. Remote actions,
composites, shell/config reachability and computed imports cannot receive empty
trusted files merely to make that target complete. No partial adopter rehearsal
or this adapter establishes overall readiness.

## Consequences

The actual provider can use finite package-owned compiler/identity operations
without a general adopter compiler, crypto, git or filesystem escape. Adopter
helper migration and equivalence tests are required; no unchanged unsupported
provider is silently admitted. Implementation may stop with a precise unsupported
operation; no advance coverage, native or release PASS is supplied.

## Alternatives Considered

General API allowlists or hash-listed arbitrary helper trust do not enforce
reachable inputs/effects and are rejected. Removing coverage/native variants,
lowering thresholds or substituting counters is rejected. Factory splitting
alone is insufficient for actual coverage obligations. A complete provider
replacement would increase semantic risk; retain its checked algorithms while
moving privileged operations into the finite package implementation.

## Affected Rules

The affected implementation paths and guide are listed in the front matter.
The approved public CLI action set is unchanged. Source effect declarations must
name only actual finite nested operations and current owned runtime state; no
general subprocess, filesystem, browser or database permission follows. Schemas
and materialized policies require coherent separate updates if implementation
introduces new declarative fields; this decision invents no deployment flags.

## Inspector Adversarial Acceptance

Test the exact installed export, source/helper/manifest closure and ordinary
no-standing path. Reject forged contexts, mutated options/evidence, exported
original IO, wrong candidate/git executable/env/argv/cwd, changed dependencies,
compiler options/hosts, getters/proxies/links/escapes, outside positive and
negative probes, changing directory order/membership, duplicate or extra emitted
outputs, stale build bytes/maps/declarations, source-map rewrites and missing
compiler errors. Prove actual production and conversion equivalence to STYNX's
unchanged helper on its nine privacy source bindings and complete six-file test
population, retaining standalone thresholds and aggregate semantics.

Preserve the provider's configuration/options mutation refusals, exact native
source census and real counters. Record every actual report operation under its
owned root; reject report-to-module/source credit or cross-namespace writes.
Exercise own-seal/origin/re-record/standing attacks and scope lifetime failures.
Only genuine installed positive and hostile cases can qualify this bounded
scope; browser/DB/Node-TAP/workflow requirements remain separately explicit.
