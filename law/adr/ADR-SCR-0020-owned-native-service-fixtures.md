---
id: ADR-SCR-0020
title: Finite owned service fixtures for native test populations
type: adr
status: accepted
date: 2026-10-11
authority: Architect
supersedes: []
provenance:
  - ADR-SCR-0017
  - ADR-SCR-0019
affected_rules:
  - law/policy/native-service-profiles.json
  - law/policy/native-service-backends.json
  - law/schemas/native-service-backends-policy.schema.json
  - law/schemas/native-service-profile.schema.json
  - law/schemas/native-service-profiles-policy.schema.json
  - law/schemas/test-result-population.schema.json
  - law/schemas/action-registry.schema.json
  - law/schemas/subprocess-effects.schema.json
  - law/policy/subprocess-effects.json
  - packages/cli/src/command-manifest.ts
  - packages/cli/src/authority/sense-selection.ts
  - packages/cli/src/commands/sense/task-selection.ts
  - packages/cli/src/commands/sense/task-binding.ts
  - packages/cli/src/native-input-provenance.ts
  - packages/cli/src/commands/sense/native-input-provenance.ts
  - docs/dev/operations/adopter-audit-interfaces.md
inspector_acceptance:
  - IA-001 -- A service declaration grants nothing without exact private task, candidate, artifact, environment and whole provisioning-plan binding; unsupported containment refuses before an effect.
  - IA-002 -- Actual PostgreSQL database and role mutations occur only within a fresh task-owned cluster, retaining real role, migration, RLS, transaction and cleanup assertions.
  - IA-003 -- Loopback and LocalStack transports reach only actual owned endpoints; an exact immutable image, finite Docker broker and complete terminal cleanup replace neither native tests nor SDK signing behavior.
  - IA-004 -- Real Chromium, every selected project and the complete original webserver/build/dependency graph require actual containment and artifact custody; browserless reporter support or an ambient server is insufficient.
  - IA-005 -- Service capabilities remain closed local-write fixtures; no generic Docker, network, database, host mount, shell or publication authority is inferred.
  - IA-006 -- Complete native populations and current execution origin/custody remain mandatory; missing startup, sealing, service identity or cleanup has no standing.
---

# Finite owned service fixtures for native test populations

## Status

Accepted forward contract for the authorized 2.6 adoption batch. The policy is
candidate status: schema validation alone does not enable a service, and an
unimplemented or incompletely verified profile refuses. Source enforcement,
installed positive and hostile cases and actual adopter measurements are
independent requirements. This decision supplies no adoption or provider PASS.

## Context

Actual STYNX privacy unit/wiring and integration populations include PostgreSQL,
HTTP and LocalStack. The PostgreSQL helper changes cluster-wide login roles as
well as creating databases; a new database on a shared cluster is insufficient
isolation. The unchanged object-store test uses real AWS SDK signing and an
actual LocalStack container. Actual resolved testcontainers is 12.1.0 and pg is
8.23.1; manifest ranges are not these resolved identities.

The reference-web Playwright graph additionally starts PostgreSQL and Redis,
checks real API readiness, builds/serves web bytes and may start fake OIDC. Its
API readiness includes PostgreSQL, Redis, JWKS and S3, with local S3/KMS inputs.
Global accessibility setup writes its real result files. Chromium's native
process effects are not observed by Node's preload. Supporting only browserless
JSON results cannot establish the complete browser workload.

## Decision

### Closed declarations and private plans

A native result population may opt into exactly one `serviceProfile` matching
`native-service-profile.schema.json`. The profiles are `postgres-http-v1`,
`postgres-http-s3-v1`, `postgres-redis-http-s3-kms-v1` and
`playwright-chromium-web-v1`. They require actual reviewed
immutable artifacts and toolchain references. Zero or placeholder digests refuse
semantic admission. No declaration accepts an endpoint, socket, secret, arbitrary
command, mount/root, origin token or caller-chosen capability.

The provisioner uses exactly the canonical `docker` toolchain key; the selected
task must declare that key. Its version probe is exactly `--version`, never a
caller-chosen provisioning command. The package-owned planner resolves that key to actual physical
executable bytes, independently verifies image/distribution identities and
constructs one immutable whole plan for the exact task/population, candidate,
input/dependency closure and environment. It chooses fresh nonce-owned resources,
actual endpoint identities and finite start/readiness/stop/cleanup operations.
These internal identities cannot be manufactured by public JSON. The exact plan
and effective child commands/environment belong to native execution identity.

A profile is admitted only if every requested backend and operation is
implemented and independently verified. No partial provisioning followed by an
unsupported native run, environment-based diagnostic fallback or broader
catch-all command is allowed. Preexisting resources are not silently adopted.
All image bytes must already be present and digest-verified; no image pull,
package/browser download, registry access or install occurs during measurement.

### Private supervisor API and consent boundary

The package-owned service supervisor exposes the internal asynchronous operation
`superviseNativeServiceTask(plan)`. It is not a public provider helper or a CLI
action. The invoking parent must first mint the exact supervisor process tuple
in its private binding table; a structurally valid plan, stdin document or nonce
alone cannot authorize that process. Its runnable asset receives only this
parent-owned plan and returns actual lifecycle/result facts on a separate
parent-only channel. The native child inherits neither that channel nor raw
engine access; its original stdout, stderr, exit status and signal are preserved.
A synchronous parent runner delegates the live broker event loop and bounded
cleanup to this supervisor rather than deadlocking a main-process broker.

Service selection before consent may mint only an immutable pending binding.
It validates the portable declaration, current candidate/source/input/dependency
snapshots, exact package/helper identities, active approved backend record and
closed profile capability set without creating containers, volumes, namespaces
or fixture resources. This pending binding authorizes no execution, supplies no
actual Linux plan or native-selection digest and carries no measured standing.
A Linux planning container is a provisioning effect even if its operations only
read inputs; it cannot be started through a read-only inspection exception.

After explicit `sense run --write` consent for the complete selected profile,
the privately bound package supervisor may create only the finite planned owned
Linux resources. Its trusted planner derives the actual task/predecessor recipe,
Linux Node/Git/compiler/executable identities, paths, dependency instances and
native selection inside the approved runtime. Before starting any adopter
workload, it verifies these facts against the pending binding's immutable
inputs and privately binds the complete effective child tuple. No host-native
plan is constructed and relabelled as Linux, and a serialized tuple cannot mint
this binding. A failed derivation or mismatch requires owned cleanup and refusal,
never workload execution, diagnostic fallback or broader provisioning.

The completed frozen plan binds schema version, nonce, physical repository, candidate
commit and tree, exact task/population, task-policy and input/dependency digests,
effective environment identity, selected profile, supervisor/broker bytes and
actual child executable/SHA/complete argv/cwd/environment. Bind the physical
Docker executable/SHA, engine socket physical path/device/inode and actual
engine ID/API/server version. Each image binds the requested reviewed RepoDigest
and actual platform-specific image ID/architecture/OS. Startup, execution,
cleanup and buffer limits are finite and part of the plan identity. Private
injected credentials and endpoints remain bound without being emitted as public
secrets. Unsupported profiles refuse before provisioning.

Before write consent, exact package-owned inspection may obtain actual engine
and image facts through only GET /info, GET /version and
GET /images/<exact-reviewed-image-reference>/json over the fixed bound local
engine socket. It requires a separate private inspection process binding minted
only after validating the closed request and physical helper/provisioner/socket
identities. Its descriptive capability is only `proc:owned-native-fixture` and
its effect is read. No fixture capability, provisioning, child native execution,
pull, arbitrary API request or socket exposure follows. The broker recognizes
this exact inspection tuple only under `sense run`; successful inspection never
substitutes for complete plan binding and later write consent.

Selection derives the closed profile capabilities before action consent.
`db:write` and the existing filesystem capabilities retain their respective
mutation boundaries; fixture capability names do not bypass them. The exact
supervisor process guard additionally requires selected `sense run`, local-write,
explicit `--write`, `proc:owned-native-fixture`, the precise profile capability
set and the private pending provisioning binding; the workload guard additionally
requires its completed actual Linux plan and child-tuple binding. No read-only process fallback applies
to that operation. The generic action's conservative capability declaration is
not a blanket fixture grant, and no ordinary member receives fixture authority.

The result binds the plan digest and nonce, actual child PID/start/end/status/
signal, ordered actual lifecycle observations and complete terminal cleanup.
The parent independently validates resource identity and absence, captures the
private ledger digest in the immutable measured body and only then considers
origin registration. Neither child stdout nor supplied result JSON can mint
that origin. Timeout/termination handling must still execute bounded owned
cleanup; an incomplete terminal ledger refuses standing.

Freshness of a pending binding rechecks the host-side candidate/tree, source,
descriptor/policy, input/dependency snapshot, package/helper and approved-record
identities without provisioning. Completion additionally requires independent
same-Linux reconstruction of the actual executable/selection/predecessor tuple,
authenticated private terminal evidence and verified owned cleanup. Only then
may the parent mint the completed measured binding and existing execution origin.
Neither pending selection nor a matching planning/result document is completion.

### Explicit authority amendments

The closed new capabilities are `fixture:postgresql`, `fixture:loopback-http`,
`fixture:localstack-s3`, `fixture:redis`, `fixture:redis-process-control`, `fixture:localstack-kms`,
`fixture:chromium` and `fixture:reference-web`.
`proc:owned-native-fixture` annotates only the privately bound host operation.
They derive local-write solely with the exact private service plan and explicit
write consent. `db:write` remains required for the real SQL mutations. Ordinary
native tasks gain none of these capabilities.

Add their exact literals to the source capability type and resolution whitelist;
derive them from the validated selected profile before consent. The broker must
check the private plan at every effect, not merely the public capability name.
Corresponding descriptive subprocess annotations must distinguish trusted host
provisioning from the candidate native command. No executable marker or generic
argv pattern becomes runnable. Update action/effect metadata and registered
materializations coherently before claiming supported admission.

Existing `net:*` remains remote-write. These finite fixture capabilities do not
reclassify generic network operations, grant publication, expose an ambient
Docker socket, or permit arbitrary processes, host mounts or databases. The
public CLI action set, role and ordinary effect boundaries remain unchanged.

### Finite service-fixture API

The package subpath `@aarusso-nyx/devai/native-service-fixtures` exposes only
`createNativeServiceFixtures()` with no arguments. The factory synchronously
requires the canonical private governed context; it has no diagnostic fallback.
The closed returned API has asynchronous `postgres()`, `redis()`,
`localstackS3()`, `localstackS3Kms()` and `verify()` operations. Each start creates
a fresh actual instance under the selected profile and approved plan's finite
per-kind instance/resource/time limits; there is no global/shared singleton or
implicit reuse. The profile policy lists exact permitted apiOperations; a S3-only
profile never admits KMS. Unselected operations refuse before provisioning.

The public return shapes are closed and contain only the following fields:

```ts
type Stop = () => Promise<void>;
type PostgresFixture = {
  host: '127.0.0.1';
  port: number;
  user: string;
  password: string;
  database: 'postgres';
  stop: Stop;
};
type RedisFixture = {
  host: '127.0.0.1';
  port: number;
  stop: Stop;
  pause(): Promise<void>;
  resume(): Promise<void>;
};
type LocalStackFixture = {
  endpoint: string;
  region: 'us-east-1';
  credentials: { accessKeyId: 'test'; secretAccessKey: 'test' };
  stop: Stop;
};
type NativeServiceFixtures = {
  postgres(): Promise<PostgresFixture>;
  redis(): Promise<RedisFixture>;
  localstackS3(): Promise<LocalStackFixture>;
  localstackS3Kms(): Promise<LocalStackFixture>;
  verify(): Promise<void>;
};
```

Ports are actual successful owned listener ports, not zero, an unchecked
reservation or an invented host mapping. A LocalStack endpoint is the actual
`http://127.0.0.1:<owned-port>` origin, with no path/query or outside authority.
Credentials are original local test inputs only and receive no outside-AWS
standing. Handles and their credential records are frozen; no private context,
resource control channel or origin token is returned. A repeated stop may finish
only from retained exact-instance successful cleanup/absence, never by adopting
or stopping another resource. Failed starts/stops/verification reject with their
actual failure and invalidate any dependent standing.

Each frozen handle exposes its actual owned namespace endpoint and an
asynchronous `stop()` closure for exactly that instance. PostgreSQL additionally
exposes its actual private login/database inputs; Redis exposes the actual TCP
endpoint; LocalStack exposes the actual HTTP endpoint, region and original test
credential inputs. These are required fixture inputs, not public evidence or
outside authority. No generic image, command, service selector, root, endpoint,
capability, token, Docker client, context installer or ledger registrar is
accepted or exposed. The host independently verifies ordered requests, actual
resource/readiness identities, successful operations and terminal cleanup;
returned handle fields or authored JSON cannot manufacture those facts.

This opt-in replaces only original fixture provisioning/endpoint lookup/stop
with finite package-owned operations. Retain every original real SQL, migration,
RLS, Redis, SDK, S3/KMS, signing, HTTP and test assertion. Actual createTestApp
requires PostgreSQL, Redis and LocalStack S3/KMS unless its original explicit
option disables LocalStack; the dedicated object-store test starts a separate
LocalStack S3 instance. The integration profile therefore includes both forms,
with separate fresh handles, rather than dropping Redis/KMS or sharing an
instance across original starts. HTTP/Supertest listeners remain real and have
actual process/scope/namespace/address/port/lifecycle observations.

Fresh simultaneous instances receive unique host-minted loopback ports within
the owned namespace. Their finite effective PostgreSQL/Redis/LocalStack listener
configuration and original readiness behavior are explicit plan facts. Returning
those actual endpoints does not fabricate host port publication or Docker
inspect metadata. Startup, native caller stop and failure propagation remain
observable; the host's mandatory terminal cleanup cannot hide a failed stop.

### Exact owned Redis process control

The existing reference API readiness test suspends the actual Redis process,
requires a down result within its unchanged timeout and then requires recovery.
Redis `CLIENT PAUSE`, quitting a client, synthetic connection errors or omitting
the test do not establish this failure model. The two existing shell-based Redis
cache cleanup helpers may instead use real `SCAN MATCH` and `DEL` commands on
the exact owned endpoint, preserving their complete prefix population, failures
and original rate-limit/idempotency assertions; they require no container exec.

Only a Redis-bearing profile may request `redis.processControl` with the literal
`pause-resume-v1`. Selection additionally requires an active backend's closed
`redisProcessControl` object containing `kind: 'pause-resume-v1'`,
`maxTransitionsPerInstance` and `maxPausedMs`. These finite limits belong to the
package-reviewed backend; no caller supplies limits. The private context always
contains `redisProcessControl`, with that exact object only when both selections
match and with `null` when control is unselected. The separate local-write
capability `fixture:redis-process-control` and `redis.pause`/`redis.resume`
operations derive before consent; `fixture:redis` alone grants neither.
Unimplemented control refuses the whole selected request before provisioning.

The frozen Redis handle's zero-argument asynchronous `pause()` and `resume()`
closures retain its exact private handle identity. With a null control context,
both refuse before an effect. No container ID, signal, process selector, command,
image or Docker object is exposed. The closed private request consists only of
`schemaVersion`, `nonce`, `scope`, `requestId`, `operation` and `handle`, with
operation `redis-pause` or `redis-resume`. A successful response contains those
same fields and `paused`, respectively `true` or `false`; consistent JSON alone
does not authenticate a response.

The supervisor serializes control and stop for each instance, checks its actual
owned container/image/namespace/start identity and live running/Paused state,
executes only the corresponding finite engine pause or unpause, and verifies the
actual resulting state before acknowledgement. Starting, stopping, stopped,
foreign-scope, unknown or non-Redis handles refuse. A repeated target-state
request succeeds only after independently verifying that same instance's current
identity and state; it neither invents a transition nor resets a pause deadline.
Actual transitions consume the backend's per-instance budget. A pause begins a
host-owned bounded deadline; candidate clock or requests cannot extend it.

Retain ordered private requests/results, actual pre/post state observations,
transition counts, deadlines and cleanup facts under the same immutable plan and
nonce. Independent replay reconciles these with the trusted parent exchanges;
it does not perform a new pause and pretend to observe the historical one.
Before stop or on timeout/termination, the host resumes an owned paused instance
and completes bounded stop/remove with verified absence. Cleanup runs even after
client failure, records its own operations separately and cannot erase that
failure or satisfy a missing workload recovery assertion. Missing acknowledgement,
state/identity disagreement, exceeded limit or incomplete cleanup refuses standing.
No generic Docker, signals, exec or network capability follows.

### Package-owned backend trust source

`law/policy/native-service-backends.json`, validated by
`native-service-backends-policy.schema.json`, is the only initial approval
catalogue. It ships with no records and candidate status: no backend is approved.
The request's closed `backendId` selector names an exact package-owned record,
not an adopter image or policy approval. Admission requires an active catalogue,
a unique active matching platform/profile record and implemented backend code.
Candidate/missing/ambiguous records refuse before provisioning. A registered
adopter projection may select a published record; it cannot add approved bytes.

A record binds reviewed recipe and containment policy, actual platform image ID,
complete runtime manifest, exact Node/Git and optional browser identities and
finite resource/instance/time limits. A genuine immutable registry RepoDigest
may be retained, but an unpublished prepared local image instead binds its actual
image ID and exact exported image archive digest. No invented RepoDigest or
registry publication is required merely for isolated local rehearsal. All
actual loaded image/runtime bytes must match the approved archive/manifest.

The generic base contains reviewed runtime/system/browser bytes, never baked-in
candidate code, candidate dependency state or DEVAI helper/replay payload. Those
are separately hashed readonly mounts in each private task plan, avoiding a
self-referential image/package-policy identity. Preparing them before measurement
does not grant a later install or writable dependency root. Activation requires
retained authentic native, independent replay, containment hostile and cleanup
proofs reviewed by Architect; valid schema fields alone are no such proof.

### Whole Linux execution backend

The selected implementation direction is a distinct `owned-linux-native-v1`
backend, not a host-native task with containerized services. Docker 20.10's
internal bridge/published-port failure does not authorize a normal bridge,
masquerade-only isolation, host-native socket bypass or a Docker exec TCP proxy.
A fresh package-owned anchor uses network mode `none`; every admitted task,
PostgreSQL/Redis/LocalStack service, API/web/OIDC server and browser joins only
that exact anchor's network namespace. Verify actual namespace identity and full interface name/address/flag roster
before execution and at terminal checks: lo is the sole UP interface, every
non-lo interface is DOWN, and there are no external addresses or IPv4/IPv6
unicast/default routes. Retain actual dormant tunnel interface facts instead of
pretending only a lo name exists. No published ports, host aliases, additional networks, raw
engine socket or unowned member is admitted. The outer task/browser container
has no capabilities, including NET_ADMIN, NET_RAW or SYS_ADMIN, privileged mode, host PID/IPC namespace or
inherited host descriptors. Unsupported namespace/containment behavior refuses.

A prepared immutable Linux runtime image is built and reviewed outside the
measurement, with exact Linux Node 24.20 and, for browser workloads, Playwright
1.60.0's actual browser/distribution closure. Package-owned task/replay helpers
and the TypeScript/dependency graph are separately bound readonly inputs, as
specified above. No package, image or browser install/download occurs
during the measured run. Match its image/platform ID, reviewed recipe and closed
containment policy against a host-approved backend record. Caller image/policy
hashes alone never approve a backend. A package-reviewed policy and executable
backend must enforce the actual mount, process, network and artifact limits;
`allow default` or a matching arbitrary adopter policy digest is insufficient.

Inputs are an exact immutable candidate/Git/input/dependency snapshot mounted
read-only at the bound Linux paths. Runtime/system bytes come only from the
reviewed image. Writable mounts/tmpfs are fresh, finite, nonce-owned and distinct
from candidate/runtime inputs; no host home, engine socket, arbitrary bind or
unrelated inherited descriptor enters the task. Bound service storage and
resource/time limits retain actual failure and cleanup behavior. The task and
browser are nonroot with the reviewed Chromium sandbox, finite seccomp/userns
requirements, private IPC and bounded shared memory; root Chromium, --no-sandbox
or ipc=host does not satisfy this profile.

The finite Linux backend may deny only `io_uring_setup` with `ENOSYS` before
kernel actuation to keep asynchronous user-memory writers outside the immutable
syscall-input mechanism. This is an explicit restriction of the exact reviewed
Node 24.20.0/backend/architecture recipe, not an observed absence of host kernel
support or a generic optional-probe normalization. The private tracer must skip
the original setup syscall, verify its exact syscall-exit result `-ENOSYS`, and
retain the original syscall/argument tuple, actual process birth identity,
policy denial and returned result in authenticated lifecycle evidence. A
successful setup, different return, missing entry/exit proof or prior unobserved
execution refuses the task; no ring may be created. No inherited or imported
ring descriptor is admitted. Initial descriptors and subsequent descriptor
creation/transfer must remain under the independently verified finite ownership
and close/deny boundary.

`io_uring_enter`, `io_uring_register`, Linux AIO, `userfaultfd`, `process_vm_*`
and `ptrace` remain sticky pre-actuation refusals from the first candidate
bootstrap and in every descendant; setup-only denial does not admit those
capabilities or any other suppressed syscall. Actual Node/libuv fallback must
perform the complete original workload with real I/O, unchanged populations,
assertions and failure semantics. A workload requiring ring semantics stays
unsupported or fails; it cannot receive fabricated execution or equivalent
performance credit. Ordinary host execution is unchanged. Bind the actual
restriction, tracer/ABI/helper bytes and architecture into the Linux recipe and
independent same-Linux replay. This clause grants no permission, active backend
record, namespace admission or standing: complete immutable kernel-consumed
input guards, process/descriptor forest and terminal/cleanup proofs remain
required before activation.

The finite Chromium sandbox design distinguishes outer-container privileges
from privileges confined to Chromium's own nested user namespace. The reviewed
Playwright 1.60.0 seccomp source at commit
`87bb9ddbd78f329df18c2b24847bc9409240cd07` has SHA-256
`cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`.
The examined diagnostic variant adds only an unconditional `chroot` syscall
allow rule and has SHA-256
`6404867645497c3b042af491105d1b4a87fdd932dd9bd12137c01a13d2f04216`.
This removes a seccomp denial; it grants no kernel capability. Actual outer
`chroot` must remain denied. The nonroot browser may initialize its reviewed
nested sandbox with user-namespace-local SYS_ADMIN, mapping only the outer
nonroot UID/GID to itself; it cannot gain privileges in the outer or host
namespace. Renderers must have zero effective capabilities, no-new-privileges
and the additional Chromium seccomp filter. Retain and independently verify the
complete actual process forest, namespace mappings, capability sets and filters;
do not assert that every utility/GPU process uses a renderer's nested sandbox.
Every process remains subject to the outer containment and bound input/output
limits. No caller policy, altered mapping, sandbox-disable flag or outer
capability grant is admitted by this diagnostic exception.

These two policy identities document the examined finite design, not approval
or activation. Approval must bind the exact actual launched browser executable
and its complete distribution: a `headless_shell` positive does not establish a
separately inventoried full Chrome executable's behavior. Independent same-Linux
replay, complete original task/server/artifact custody, containment hostile
checks and terminal cleanup remain required before any catalogue activation.

All actual service/HTTP traffic stays in that owned loopback namespace. A
wildcard listen is acceptable only inside this independently verified lo-only
namespace and cannot become a host/public listener. Endpoint records bind the
namespace as well as actual address/port and ownership. A finite reviewed client
adaptation may expose the actual shared-namespace endpoint where the original
client expects a published port; record this governed transport change explicitly.
Never fabricate Docker port-publishing metadata or replace actual engine inspect
facts. Preserve real SQL, SDK/signing, HTTP/browser calls, readiness, test IDs,
counters, thresholds and assertions. Unsupported client mapping assumptions
refuse rather than create a host proxy or egress exception.

Run independent package-owned provenance replay in the same exact pinned Linux
runtime at the same Linux paths, with readonly captured evidence and candidate
inputs, isolated from the finished native task. Linux executable/path/platform
identities stay Linux identities; a macOS validator cannot relabel or normalize
them into its own host tuple. The outer host independently verifies image,
mount/input/output rosters, namespace membership, actual lifecycle, private own
seals and completed cleanup. A separate host-owned replay channel supplies the
verified result; candidate stdout, authored evidence or a matching nonce cannot
mint a replay success or ordinary execution origin. Missing backend replay or
terminal proof remains UNKNOWN, not a cross-platform fallback.

This is a bounded design decision, not evidence that the backend is implemented
or Chromium is feasible on the present host. Native and independent replay
positive/hostile proofs remain prerequisites for each actual profile.

### PostgreSQL and HTTP

The initial provisioner uses exact `postgres:16-alpine@sha256:<reviewed digest>`
through the bound Docker toolchain and a private task-owned network/storage
lifecycle. Bind actual platform-specific image identity and the engine endpoint
and process identity; a tag alone or ambient DOCKER_HOST is insufficient.
Create a fresh exclusive cluster with private credentials and no host data
mounts, shared roles, database template or reused server. SQL may retain its real
DDL, migrations, direct role logins and cleanup within that owned cluster.

Where an original helper consumes STYNX_TEST_PG_HOST, PORT, USER and PASSWORD,
its governed adaptation obtains those inputs from the exact fresh fixture handle,
binding their effective values privately. Per-instance inputs cannot become a
shared global endpoint; refuse descriptor overrides and ambient socket fallbacks. Test-created database
names and role-password changes stay within the owned cluster. Never replace
queries, permissions, transaction behavior or assertions with synthetic results.

Loopback HTTP requires actual nonce-owned listeners and accepted connections,
including Supertest's ephemeral listener. Bind process/scope, actual local
address and port, direction, successful creation/connection and terminal close.
Outside the verified lo-only backend namespace, no wildcard/public bind is
admitted. No external DNS, public egress, Unix socket outside the private
broker, unrelated loopback service or inherited socket is admitted. Close races,
endpoint replacement and unowned reuse refuse. Fixture files, including the real
privacy app/privacy/pii-map.yaml, require a fresh private runtime root and exact
ordered file custody; no generic temporary-directory exception follows.

### LocalStack and the Docker boundary

The privacy S3 profile uses exact
`localstack/localstack:3.8.1@sha256:<reviewed digest>`, actual SERVICES=s3,
AWS_DEFAULT_REGION=us-east-1 and S3_SKIP_SIGNATURE_VALIDATION=0. Retain the real
AWS SDK, bucket/object bytes, signatures, tenant-key separation, tamper/expiry
checks and failure propagation. Only the actual owned namespace endpoint is
reachable; test credentials grant no outside AWS authority.

The host owns a fresh private Docker control plane. Candidate code receives
only the finite service-fixture API, never a Docker API client or engine/control
socket. Its original testcontainers fixture startup/endpoint lookup/stop migrates
to the explicit governed API; original SQL/SDK/test behavior remains. The
supervisor's host-only broker admits only finite version/ping/required metadata,
exact-image inspection, the exact declared container creation, owned inspect,
start, logs/readiness, stop/wait and remove operations. Every body, query, image,
network, port, environment and resource identity is checked. Only owned resources
are visible. Arbitrary exec, archive, host binds/devices, privileged operation,
host network/PID, arbitrary images, pulls, reused resources and global cleanup
are refused. Direct engine access cannot bypass this broker.

Disable testcontainers reuse and its unrelated cleanup sidecar in this governed
mode; the host owns mandatory cleanup instead. Preserve the test's own stop and
failure semantics. Add internal ownership labels and the documented exact owned-namespace endpoint
adaptation without dropping any original test operation or inventing a published
port. Bind these documented
effective provisioning changes. A required client operation absent from this
finite protocol is unsupported, not an excuse to forward the whole Docker API.

### Real browser and server graph

The browser profile requires actual Playwright 1.60.0 Chromium executable,
complete distribution/native asset closure and an enforced containment backend
whose executable/policy bytes are bound. Node-only observation or a disabled
browser sandbox is insufficient. The backend must confine native file reads to
its verified read-only distribution/runtime inputs and candidate/generated
assets, writes to owned finite artifact roots, processes to the bound browser
forest and network to actual declared owned endpoints. If the host cannot enforce
and attest these limits, refuse before browser launch. No generic host-network
or native-library allowance follows.

Retain all original Playwright projects as separately complete populations and
preserve exact project selection, config, global setup, assertions, browser
options, original build verification and prerequisite tasks. Server references
name exact existing descriptor task/population pairs, with complete executable,
import/config and nested child closure. At minimum the current API and web
servers are required; OIDC remains conditional on the original bound config.
The browser graph also binds actual Redis 7-alpine and LocalStack S3/KMS artifact
and fixture identities and verifies the original readiness requirements.

The package-owned service host starts and owns the reviewed server graph; an
existing ambient listener cannot satisfy reuseExistingServer. Any internal
webServer management override is explicit governed-mode behavior, bound in the
effective resolved config and independently checked against the unchanged
original server/build graph. Shell command chains are not accepted as an opaque
string: retain their exact typed prerequisite and process sequence or refuse.
Current localhost ports and readiness paths must agree with actual selected
configuration; arbitrary ports or generic ready exit codes do not substitute.

Actual traces, screenshots, video and accessibility results need finite artifact
custody tied to real native test IDs and reporter attachment facts. Existing
browserless output allowances do not automatically admit them. Bind complete
artifact rosters, bytes, actual writes/reads and cleanup; refuse escaping/linked
members, unowned overwrites and artifact-to-module/source credit. Current
accessibility .test-results files likewise require exact fresh ownership and
original semantic equivalence before any supported relocation or admission.

### Terminal evidence and standing

The parent owns a private lifecycle ledger binding each resource to its actual
creation, readiness, allowed transports, descendants and shutdown. Children and
native scopes still seal their own supported work; the service parent cannot
invent a child end. Require no live owned listeners/processes/containers or
residual database/storage resources before successful origin. Host cleanup on
failure prevents leakage but cannot turn a failed or incomplete run into PASS.

Retain immutable actual lifecycle/provenance bytes and bind their digests to the
same final measured body and existing private origin receipt. Generic records,
authored ledger JSON and diagnostic runs cannot mint service origin. Current
standing rechecks retained origin/custody, exact candidate/config/toolchain/image
identities, completed terminal lifecycle and absence of leaked resources. It does
not rerun mutable fixture queries and pretend they are the old execution.

For the owned Linux route, a current portable pending binding is an input to
verification, never an actual `TaskPlan` or execution proof. Resolve its current
candidate commit/tree, exact descriptor and annotated task/population, policy,
result contract, prerequisites, candidate/dependency snapshot artifacts,
package/helpers and selected approved backend identities without creating a
container. Do not derive a macOS command and compare it with `/workspace` Linux
paths, or call a host-native provenance verifier against those paths.

Require the exact final reading bytes in a completed protected
`sense.task.execute` origin and a subsequent valid `sense.readings.record`
custody entry for the same candidate. That origin must also bind the sealed
Linux supervisor receipt, actual derived Linux plan, retained native
output/trace/process/service evidence and independent same-Linux replay by exact
artifact digest, either directly or through the immutable measured body. A
diagnostic receipt, caller metrics, a matching nonce or a pending binding cannot
substitute. The protected producer captures immutable completion before origin;
post-execution mutation or replacing any retained artifact invalidates it.

Verification requires successful actual execution, complete own-scope seals,
successful independent reconstruction of the same actual Linux executable,
environment, selection, compiler and predecessor tuple, the full unchanged test
IDs/files/counters, and complete lifecycle/cleanup with no recorded failure.
Use that reconstructed Linux task for its command, task key, input digest and
prerequisite comparisons. Preserve the existing custody graph, per-population
aggregation, freshness limit and required invariant IDs. Missing, ambiguous,
stale, changed or incomplete proof remains unmeasured.

Execution-time replay of sealed immutable snapshots establishes those measured
execution facts; it is not a claim that mutable Linux host observations have just
been reread. Current host-visible candidate, policy, snapshot artifact,
package/backend and image/engine identities must still agree. Any requirement
for a current Linux-only observation remains unsatisfied until an independently
authenticated replay actually obtains it in the exact admitted runtime. Read-only
standing never hides container, volume or fixture creation; such replay requires
the existing explicit full-profile write consent. A historical receipt cannot
satisfy a required live reread, and inability to obtain one returns unmeasured.
The host-native route retains ADR-SCR-0017's existing verification semantics.

## Consequences

The unchanged real workloads can be admitted by finite owned fixtures without
making the compiler adapter a broad IO grant. The implementation is a service
host, private broker, native containment and lifecycle custody feature; schema
or parser support alone is insufficient. Unsupported environments are reported
honestly, without deleting wiring/integration/browser populations or weakening
thresholds, counters, RLS, signing or cleanup assertions.

This batch covers the exact privacy four-file unit/wiring, two-file integration
and six-file coverage union with all nine source bindings, and the complete
original browser projects and server graph. It adds no veraPDF/PDF-validator or
Cognito service profile. Their ordinary graphs, public fixture options and
existing mock-based unit tests remain intact; a native request needing those
unimplemented services refuses explicitly rather than dropping its cases.

Complete 45-cell acceptance preserves the two existing N/A cells and all 43 PASS
obligations, ordinary graphs and history windows. Cross-thread architectural
proposals supply useful evidence, not new human authorization or new universal
PASS gates. All workflow occurrences remain inventoried and every job's effect
must be known under current law; this decision does not replace that requirement
with a newly invented demand for adopter-reviewed closure on every remote action.

## Alternatives Considered

A shared cluster plus nonce database leaves cluster role mutations unconfined.
An ambient endpoint or Docker socket grants unrelated authority. Broad crypto,
child_process, network or ts.sys allowlists do not bound the actual workloads.
Skipping wiring, LocalStack, browser projects or ordinary gates would reduce the
required populations. All are rejected.

## Affected Rules

The canonical policy/schema and source insertion points are listed above.
`resultPopulation.serviceProfile` is an optional reference to the closed request
schema; its absence preserves existing native semantics. Runtime schema rosters,
capability derivation, broker guards, descriptive effect annotations and registered
materializations must be paired with actual implementation and independent
acceptance. No generated policy copy may be hand-edited to enable support.

## Inspector Adversarial Acceptance

Use the installed public native route with the complete actual privacy four-file
unit/wiring population, two-file integration population and six-file coverage
union. Prove original nine source bindings, maps, counters and thresholds. Test
wrong/mutated image/toolchain/engine identity, reused cluster/role, changed
endpoint, external DNS/socket, Docker arbitrary image/exec/mount/network/cleanup,
unsafe body/query, fake readiness and missing terminal cleanup. Refuse forged
resource or lifecycle facts even when their nonce is consistent.

For browser support run every original project and real server/build graph;
prove actual containment, browser/artifact identities, conditional OIDC and full
PostgreSQL/Redis/JWKS/S3 readiness. Test ambient server replacement, unsupported
nested shell/process effects, browser native escape, linked/escaping artifacts,
missing attachment and incomplete child/service seal. Positive fixtures and
hostile tests are required separately; no future design wording supplies PASS.

For Redis control retain the actual process-suspension/down-timeout/recovery
case. Test zero-argument/frozen exact-instance closures, absent control consent,
wrong nonce/scope/requestId/handle/kind, concurrent stop/control, repeated-state
verification, altered engine state, transition exhaustion, pause deadline,
termination while paused, resume failure and terminal absence. No client-level
pause or in-memory fallback supplies the real Redis result.
