# REC-B1-A-P1 — bounded authority-policy preview closure

**PROPOSED — PREPARATION ONLY; IMPLEMENTATION NOT APPROVED.** This document label
allocates no managed task or round. The current human request authorizes this
packet, not its proposed code, tests, binding or integration effects. Runtime,
release and DETRAN effects remain held. The [source observation](source-observation.json)
and [closed path inventory](path-inventory.proposed.json) bind the actual reviewed
source. The [acceptance matrix](acceptance-matrix.md) is required future assurance,
not executed tests.

## Concrete decision proposed

Implement an **opt-in, same-invocation, exact-byte review for creating an absent
authority-policy file**, including a read-only projection of the separately planned
constitution binding. Retain the existing policy schema, materialization provenance,
authority checks and normal binding branches.

This is an explicit interface proposal: it is an **armed local-write invocation
with a zero-filesystem-effect review phase**, not a read action or a no-consent dry
run. It requires both existing Architect identity and `--write` consent before
constructing a real, attributable artifact, then a second exact confirmation before
any publication. The current plain no-write `init bind` remains an advisory plan;
it must not claim to preview future nonce-bearing bytes. Choosing this live review
model and its create-only scope requires explicit approval of this packet. No
interface or constitutional interpretation is silently changed.

Recommended future spelling, **not available now**:

```text
devai init bind --review-authority-policy --after-constitution \
  --target <exact-target-root> --as-role architect --write --format json
```

The full future implementation envelope is **19 human-authored paths: four
Architect, nine Engineer and six Inspector**, plus one separately enumerated
generated error-reference output. No live invocation is approved by implementing
this interface. Testing its publication branch may write only disposable fixtures
under a separately approved implementation/assurance run.

## Verified gap and relevant current behavior

The unchanged registered action is `init bind`, local-write, binding machine,
Architect initiation, explicit write consent. Current no-write output is only
`{ "plan": "authority-policy" }` (`commands/init/index.ts:104–121`). The broker
constructs a `cli-<pid>-<uuid>` invocation and the materializer incorporates actual
principal declaration/context, invocation identity and `materialized_at` into policy
bytes (`authority/broker.ts:634–647,1589–1737`; authority runtime
`policy-materializer.ts:175–245`). Regenerating in a later invocation changes those
bytes and digest. A semantic policy hash cannot substitute for the whole artifact
SHA256: `unchangedAuthorityPolicy` intentionally ignores materialization fields for
legacy no-op detection, which is different from exact-byte review.

The current clean DEVAI worktree has a real 1.1.0 pin, a pointer and project file;
its authority-policy target is absent. Its adopter-policy receipt **is present**,
pointing to `law/policy/devai-adoption.json`; neither that receipt nor its source
has a bound authority extension/block. They are preserved inputs, not discarded
because no extension exists. `upgrade.lock` is absent at observation time; absence
is not a lease. Current upstream main remains `2df84159...`; working contract
changes from REC-B1-A remain unintegrated.

The constitutional candidate remains **1.2.0**, SHA256
`d5dfdc972161e0f848dd859be7bbfa510973c5c9a449a0f9e6b8960e4f5ac96a`.
A preview from the current 1.1.0 pin would bind the wrong constitution. This packet
therefore closes the **prospective-input** gap as well as freezing volatile output
bytes. Nothing in it permits an earlier constitution write just to discover the
policy output.

## Exact proposed protocol

### 1. Selection and admission

Require both new selectors together, direct `--as-role architect`, existing
`--write`, JSON output and a real attached terminal. The pending invocation must
belong to the same trusted host/worktree throughout. Reject `--authority-session`,
`--machine-actor`, `--round`, `--publish`, `--experimental`, `--plan`, `--dry-run`,
`--human`, a non-JSON format, and every other bind selector (`--full`, constitution,
operational law, subprocess effects, adopter policy, host adapter, tracking adapter
or tracking repository). Reject `--tier`, file replay/output options, unknown flags,
duplicate conflicting selectors and any automatic/non-terminal fallback. Check
selection/terminal requirements before generating the artifact or touching a file.

Require an existing contained no-symlink target/config directory and an absent
`authority-policy.json`. Reject an existing file even when semantically equal;
legacy update/no-op behavior remains available only through its separate existing
branch and authorization. This proposal never overwrites a target. Refuse any
existing upgrade lock, including a stale lock, without removal or takeover. No
lock is acquired while waiting for review.

The first bounded supported population is the observed no-authority-extension
case. Retain and verify any existing no-extension adopter receipt and its exact
source. A receipt with `authority_extension`, an actual source `authority` block,
unknown/missing/invalid bound source, or host-integrated mode stops for a separate
closed packet. This is not permission to omit or downgrade an extension. The
existing real project must retain its declared `cli-only` host mode.

### 2. Trusted prospective input projection — zero writes

Use only the **admitted installed candidate's canonical constitution bytes** and
its actual runtime package identity. A working checkout file, caller JSON,
arbitrary source path, alternate root, fake clean HEAD or virtual filesystem is
not an authority source. The exact candidate package/source/assets must be admitted
and returned independently before any live run; this packet authorizes no build,
packaging, installation or release.

Compute the same prospective pin bytes and `reconcileProjectConfig` output that
registered `init bind --constitution` would produce. Do not write them. The pointer
must already exist and remain byte-identical. Preserve adopter declarations,
existing receipt/source and every other input. Bind both real-before and exact
prospective-after hashes for the two permitted predecessor outputs:

- `.devai/pin/constitution.md` — proposed canonical 1.2.0 bytes above.
- `.devai/config/project.json` — exact registered reconciliation, including the
  actual candidate CLI version; no invented future package version.

The earlier source-version-2.7.1 projection has project SHA256
`e6c405d15131ffbad5be96ccf0597397b3c9d582dc7c020cee57043796500f87`.
It is conditional historical planning evidence, not a release choice. A different
actual candidate identity requires a new exact full plan and human review.

The pure source projection must share existing rule builders and canonicalization;
it must not duplicate, change or filter core/additive permissions. Ordinary
`authorityBindings` continues to read actual bound bytes. The prospective path is
private, closed and labelled **non-authorizing data**. No mutation decision may be
derived from prospective bindings. If sharing the builders needs another path,
stop for an exact scope amendment rather than introducing a generic override.

Bind a complete consumed-input snapshot: installed candidate assets/registry/rule
and validator source identity, logical/physical repository/worktree identity,
HEAD/index/source identity where read, pin/project/pointer, adopter receipt/source,
host mode, parent directory identity, target absence and lock absence. Record
presence as well as byte hashes. At entry accept either the recorded predecessor
state, or an already completed **exact approved** successor state for a fresh
review after interruption. No other pin/project mutation is an allowed transition.

### 3. Prepare and display the exact artifact once

Within the real invocation, retain the actual Architect declaration, invocation
identity, consent and artifact-construction time. Construct one schema-valid
candidate through the unchanged authorization/materialization checks, using the
private prospective source projection **only for artifact construction**. This
may consume a real issuer-private materialization authorization in memory; it
creates no persistent authority and issues no filesystem publication decision.

Freeze canonical policy bytes by defensive copy, byte length, whole-byte SHA256,
and the existing materialization digest. The candidate records the real artifact
construction time; it is not relabelled as the later disk-publication time. The
actual publication time belongs only in the final stdout result. Do not replace
random IDs, omit provenance fields, normalize away entropy or patch the clock.

Keep the artifact in a host-owned, invocation-local, single-use review handle.
No serialization, export, caller object or JSON digest can recreate that handle.
Do not expose a raw writer or reusable broad capability to the command handler.
No filesystem decision receipt is held across the human wait.

Emit a closed JSON ready payload through the existing action envelope:

- `kind`, `schema_version`, `status=awaiting-exact-confirmation`;
- exact action/selector, host-owned invocation ID and logical/physical identity;
- candidate package/source/asset identities and constitution version/digest;
- full before/prospective-after input manifest and allowed precursor transition;
- fixed target `.devai/config/authority-policy.json`, `operation=create`;
- canonical bytes as base64, exact `size_bytes`, SHA256 and encoding declaration;
- existing publisher's internal staging recipe and durable output effect census;
- expiry deadline, `grants_authority=false`, and `plan_sha256` over the canonical
  ready payload excluding `plan_sha256` itself.

No printed field is a grant. The fixed confirmation string is
`CREATE <plan_sha256> <artifact_sha256>`. Prompt on stderr; keep ready/completion
JSON envelopes on stdout. Confirmation is case-exact, has no default, and must
match the **live** handle. `--write` alone never publishes in this new mode.

### 4. Waiting and the separately authorized precursor

Emit the entire report before **any** binding write. A separately authorized
operator may later execute the already reviewed registered constitution-binding
step while this process remains waiting. The preview command never runs it,
acquires its authority, fabricates its receipt or treats matching file bytes as
human approval. Source-bound external execution custody and actual role/consent
remain required under the applicable host-enforcement boundary.

The review handle permits only the exact two-file predecessor transition shown
in the report. It is invalidated by any other source/package/receipt/index/HEAD/
pointer/host-mode change. Pending or partially completed precursor state does not
permit policy publication. This is an ordered two-action protocol, not a claimed
atomic transaction across both actions. Cancellation/crash after the separately
approved precursor leaves that genuine state intact and all remaining gates held;
there is no automatic rollback or manufactured completion.

The proposed review wait is capped at **300,000 ms**, measured monotonically from
ready emission. It is a new review-session lifetime, explicitly proposed here,
not an extension of a decision receipt TTL, validation timeout or DETRAN budget.
Expiry/EOF/cancel/wrong confirmation closes the handle without any new file
operation. A new run creates a new identity/digest and needs fresh confirmation.

### 5. Final verification and create-only publication

After exact confirmation, re-read **actual** sources and require the approved
successor pin/project bytes, unchanged pointer/receipt/source/host/package inputs,
no upgrade lock and the same contained directory/target identity. Recompute actual
trusted rules and compare them with the frozen candidate's source/rules/constitution
identities. Prospective bindings never authorize this step. Require fresh ordinary
filesystem authority from the actual current bindings, original live Architect
identity and consent, through the existing broker and boundary. Retain the normal
short decision-receipt TTL; do not reuse a pre-wait mutation receipt or enlarge it.

Do not call the materializer again or regenerate nonce/time-bearing bytes. Re-hash
the retained byte buffer and entire plan. In a synchronous final-check/publication
section with no further prompt/await, publish exactly that buffer through the
existing guarded `publishFileNoReplaceSync` effect at the fixed target. Require
`create` classification and reject any additional semantic target or raw writer.
Current path classification already treats that primitive as create-only. No
new authority target kind, capability, action or policy schema is required.

Two concurrent reviews may exist without a wait-time lock; after their independent
confirmations the no-replace publication permits at most one create. A loser never
clobbers or deletes the winner. A concurrent upgrade/foreign writer is never
cancelled or taken over. Cooperative lock/source guards do not assert control over
arbitrary external edits after the final boundary; live admission must report and
satisfy the host-enforcement boundary required by Article 6. If stronger source
linearizability requires another lease/lock or adapter, return that exact packet;
do not claim the single-file publication primitive supplies it.

On success, report the observed file bytes/digest and publication identity, then
close the handle and issuer. Same-handle duplicate confirmation cannot publish
again. Across process death, there is no resumable apply token. The existing target
must be inspected; a new review refuses existing targets even if equal. Normal
legacy retries are not silently substituted for this reviewed protocol.

### 6. Existing publisher's crash semantics and bounded effects

Reuse ADR-AUT-0005's primitive unchanged. Before link, failure leaves no target.
After link, the target is complete; cleanup/directory-fsync failure produces
`AUTHORITY_PUBLISH_CLEANUP_INCOMPLETE`, without a durability claim. A crash may
leave the publisher-owned hidden staged link. Preserve its identity/receipt; do
not rollback/delete the published target or an unowned staged file. Cleanup after
uncertain publication is a separate explicitly scoped action, not automatic
retry or a new broad directory sweep. Never wrap indeterminate publication in
rollback code that deletes a completed target.

| Phase                                                 | Exact effect allowance                                                                                                                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry, projection, ready, wait, cancel/expiry/refusal | Reads, stdout/stderr and invocation-local memory only; no files, directories, locks, counters, state, journal, proof, ref or index changes                                                    |
| Separately approved precursor                         | Pin/project effects from the independently reviewed constitution plan only; this command does not execute them                                                                                |
| Confirmed successful review publication               | One guarded create of `.devai/config/authority-policy.json` with the displayed exact bytes                                                                                                    |
| Publisher internals after confirmation                | Existing `.devai/config/.authority-policy.json.<pid>-<uuid>.publish-staged` lifecycle, owner-only unlink, file/directory fsync under the same registered effect; no separate filesystem grant |
| Completion/uncertainty                                | Stdout/stderr status/identity only; no durable review receipt, extra proof, lock or auto-cleanup                                                                                              |

The internal staged basename is allocated by the unchanged trusted publisher at
publication, not a persistent policy artifact or caller path. Its exact bounded
recipe is disclosed; its future UUID is not misreported as known in the preview.
The reviewed durable policy bytes/digest never contain or depend on that basename.
A requirement for another output, lock, journal or cleanup path stops for an
amendment; no wildcard effects are inferred.

## Closed implementation, contract and generated scope

The [19-path inventory](path-inventory.proposed.json) is the complete proposed
human write envelope. Four Architect paths cover proposed ADR-AUT-0008, generated
ADR index, its exact policy checksum repin, and the init workflow narrative. Nine
Engineer paths cover selection/options, terminal orchestration, private capability
access, broker, private review state and shared actual/prospective source builders.
Six Inspector paths cover the new protocol plus existing branch/async/census
regressions. Extra paths require an exact amendment.

ADR-AUT-0008 is free in the observed checkout; it is a proposed name, not allocated
by this packet. Recheck current main/local files before authoring. Preserve
ADR-AUT-0001/0003/0005, ADR-GOV-0026, proposed ADR-GOV-0027 and all prior accepted
bodies byte-exact. No Constitution change is proposed here. A proposed new ADR
adds one record/file but no accepted effective authority; derive final census
rather than changing 642 effective subjects by arithmetic.

Machine-generated source outputs proposed for later authorized implementation:

- `law/adr/README.md` through unchanged `renderDecisionIndex` (already counted);
  repin only its exception SHA and aggregate catalog digest.
- `docs/reference/error-codes.md` through unchanged error-code generator, reflecting
  only actual new refusal literals. Never hand edit the table or generator to hide
  a code. Existing error-code reference tests are validation targets, not extra
  human write grants.

No action-registry entry/effect/capability, generated action view, authority-policy
schema, runtime schema roster, authority runtime API, release-host API or generic
filesystem primitive is changed. No package manifest/lock/version, dist, pin,
config binding, proof/index/ref, release workflow or adopter source path is granted.
Installed help/options/contract checks remain required after a separately approved
build/package plan; no package assembly is implied by this implementation proposal.

## Approval and return wording

**Approve the design choices and bounded implementation only, if desired:**

> Approve REC-B1-A-P1's exact live, same-invocation authority-policy create-review design, including its armed --write plus separate exact confirmation, private canonical after-constitution projection, 300000 ms review lifetime, and existing guarded atomic no-replace publication. Author and implement only its 19 named Architect/Engineer/Inspector paths and two enumerated generated projections, under Inspector-first independent assurance and disposable-fixture writes only. Preserve historical checks and all existing authority/consent/schema/receipt semantics. Return reviewed source identities, actual complete preview bytes/digests, effects, negative/race/crash evidence and installed-package qualification requirements before any live use. This approves no live preview launch, constitution or policy binding, source publication/integration, U1/B1 runtime operation, release, or DETRAN effect.

This wording is a proposal, not a receipt. It specifically selects the live review
alternative; it does not relabel the no-consent dry-run as exact or authorize
arbitrary existing-policy updates.

After approved implementation, return **P1-RETURN** with exact authored path and
source hashes, proposed/accepted ADR standing, unchanged protected contracts,
focused RED/GREEN and independent review, generated output closure, exact candidate
bundle/admission plan and a disposable fixture's complete ready/publication
receipts. The new mode is not ready for live invocation until separately approved.

Before any live binding, obtain separate authority to launch the armed review
without confirming; return its actual whole-byte report and exact precursor plan.
Only a later explicit approval of those concrete identities can authorize the
precursor and final confirmation. No effect happens because a packet, schema,
fixture or implementation passes. Integration, release, DETRAN D1-L/recovery,
#211 merge, C6 and S3 runtime remain independent holds. Prior unresolved binding
assertions remain visible; this preparation does not turn them GREEN.
