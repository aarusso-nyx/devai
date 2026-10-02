# CMP-0006 uninterrupted execution discipline

Effective Owner steering recorded on 2026-10-02. This is the direct human
source-development mandate for aarusso-nyx/devai CMP-0006. It supersedes earlier
preparation-only permission and per-candidate authorization text in campaign
prompts and guides. It expires when CMP-0006 closes or is abandoned. Accepted
product contracts, role boundaries and actual evidence obligations remain binding.

## Exact Owner decision

```text
OWNER DECISION:

Change execution discipline to:

Auto accept proposals. Do not stop waiting for trivial authorizations and checkpoints ratification. Aim for uninterrupted work. Optimize to reduce time-to-ready.

Spawn ROUNDS on their own codex sessions, under Devai project. Open eight sessions and carefull plan to maximize throughput. Run no more than 3 rounds at same time; with no more than 3 agents per round at same time.

You are AUTHORIZED to accept, perform, execute whatever you need to reach this campaign completion with minimal human intervention, besides eventually open decisions.

Update plans to fit such decisions
```

## Later-round concurrency amendment

The Owner additionally instructed on 2026-10-02
(`CMP0006-OD-CONCURRENCY-20261002`):

```text
change settings to allow up to 4 rounds at same time, with at most 5 tasks each round for next rounds after 602/604/606
```

R-0602, R-0604 and R-0606 retain their initial ceilings: three simultaneous
rounds and three concurrent task/agent slots per round. When the first eligible
later round receives its permit, the global ceiling becomes four active rounds,
counting any remaining initial rounds. R-0603, R-0605, R-0607, R-0608 and R-0609
use five concurrent task/agent slots per round; initial rounds retain three. Count coordinators,
workers, reviewers and nested agents together; five is a concurrency ceiling,
not a limit on the total planned tasks. An optional clarification of the Owner's
word “tasks” is pending; this stated interpretation applies unless corrected.
Central records the phase transition; original dependency edges remain unchanged
and a source-phase completion is not a formal runtime round closure. Dependencies and complete wave locks still determine
which work can run. Effective capacity is the minimum of these ceilings and
actual host capacity; the current child-agent interface advertises four slots
including its coordinator, so it cannot dispatch a fifth agent merely because
the plan permits five. This amendment expires with CMP-0006.

## Early architecture preparation

On 2026-10-02 the Owner instructed (`CMP0006-OD-EARLY-ARCH-20261002`):

```text
Ok, start 603 and 605 architecture tasks
```

Central may grant preparation-only permits for TASK-0631 in CTG-0631 and
TASK-0651 in CTG-0651 from its exact accepted source checkpoint and ratified
R-0601 entry. These are the only exceptions to waiting for round-wide source
predecessors before Architect preparation. Each worker may author only its
existing Architect-owned law/docs paths in an isolated worktree, with the entire
first-wave lock population acquired and fresh prefix-overlap checks. Count both
rounds toward the later-phase four-round ceiling; initial rounds retain three
inclusive slots and later rounds five, bounded by actual host capacity.

Retain every round/wave/task dependency edge. This exception grants no Inspector
or Engineer dispatch, later-wave work, generator/runtime effect or final gate
waiver. Preserve known schema/catalogue and other failures. A reviewed design may
be recorded only as a provisional preparation checkpoint until its original
predecessors complete and the design is refreshed, independently reviewed and
validated against their exact composed candidate before downstream handoff.
Release a frozen reviewed preparation lease when idle; reacquire complete locks
before any refresh. Central alone integrates contributions and grants subsequent
permits. The exception expires at that qualified downstream handoff or campaign
closure/abandonment, and does not apply to any other task.

## Standing authority and acceptance

Routine scope proposals, prompt/boundary amendments within the campaign, coherent
commits and source checkpoints proceed under this standing Owner authority after
distinct review of the concrete result. The central coordinator or round
coordinator records acceptance with the mandate reference, actual reviewer,
exact commit/tree/base, role/task/wave, owned diff, prompt digest, real executor
identity, commands and all results. Do not label this as a fresh human review or
fabricate a human actor. Do not request repeated permission for routine work.
A genuine new behavior or risk tradeoff that remains unresolved is reported to
the Owner with a concrete proposal; independent work continues.

Architect checkpoints establish design, Inspector checkpoints establish
counterexamples, and Engineer checkpoints require declared implementation
acceptance. Declared Inspector RED evidence may advance only to its Engineer;
it never passes final admission. Acceptance of a design with recorded unresolved
obligations does not resolve those obligations. Every final task gate and the
unconditional floor must pass on the exact cumulative candidate. Revalidate
affected evidence whenever its content-addressed inputs change. Preserve every
failure and counterexample; no test weakening, threshold workaround or synthetic
PASS is permitted.

Campaign/schema `review.mode` stays `human`. This is the Owner's direct source
maintainer procedure, outside DEVAI runtime autonomy. It enables neither an
experimental controller nor automated runtime dequeue, ratification or fabricated
proofs. Default runtime and adopter lifecycle contracts remain unchanged.

## Round sessions, queue and limits

Create eight Architect coordinator chats under the Devai project, one each for
R-0602 through R-0609. The central campaign chat alone grants and releases round
slots and integrates cumulative PR branches. The initial phase permits three
rounds and three agents per round; the later phase permits four rounds and five
concurrent task/agent slots per round, as defined above. Count coordinators, role
workers, reviewers and all nested agents together. Existing task chats
must be idle or counted. Creating a queued chat grants no execution slot.
Queued chats register, acknowledge their assignment and become idle; they perform
no dependent source work, tests or worker dispatch until the central coordinator
sends a start message with the exact entry candidate and permit.

| Queue                          | Entry condition                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial R-0602, R-0604, R-0606 | Ratified R-0601 source checkpoint and disjoint complete wave scopes                                                                             |
| R-0603                         | Completed reviewed R-0602 source phase; next available round slot                                                                               |
| R-0605                         | Reviewed source phases R-0602, R-0603, R-0604 and R-0606                                                                                        |
| R-0607                         | Reviewed source phases R-0602 through R-0606; actual release gates follow PR-A integration                                                      |
| R-0608                         | Actual R-0607 closure and immutable shipping publication                                                                                        |
| R-0609                         | Reviewed R-0608 checkpoint for bounded candidate accounting; final observations/closure wait for actual R-0608 integration, closure and effects |

The original round/wave/task dependencies remain intact. When an active round
finishes its eligible source work or is blocked on a genuine decision, freeze its
reviewed state and release its permit for the next eligible round. A queued round
can have an existing chat without being active. Report completion or a meaningful
blocker to the central chat so it can advance the queue without polling loops.

Separate Architect, Inspector and Engineer child sessions in isolated task
worktrees are authorized. Every session keeps one declared role and exact owned
paths. Coordinators never implement code or tests under their Architect role.
Acquire the entire declared wave lock set before writing; overlapping prefixes
serialize. Release locks only at a frozen reviewed checkpoint and exact handoff.
Reopen and review a completed contribution explicitly before modifying it.
The phase-specific agent ceiling does not bypass predecessor checkpoints. Useful concurrent
work is a coordinator, a ready role worker and a distinct reviewer with disjoint
write authority. Reviewers do not share the working agent's conversation when
performing a soft-gate evaluation.

Coordination messages between the central chat and these eight round chats are
explicitly authorized. Round coordinators may communicate with the central chat
and these designated round chats; unrelated chats and recipients need their own
authority. TASK-0691 prepares campaign.json/revalidation.json patch proposals for central
application; it does not compete for canonical planning writes.
Only the central coordinator integrates reviewed single-family,
role-attributed commits into PR-A and PR-B. No task opens a separate PR; serialized
one-PR-at-a-time admission remains in force.

## Models, toolchain and bounded execution

Retain the original repository tier-map pin and record the actual runtime/model,
effort and instance independently. Default desktop models are permitted for
external source authoring under this operational exception; this does not claim
that an unlisted actual model conforms to the pinned registry or change product
model policy. Actual runtime/live-review evidence remains bound to supported
registry identities and independent evaluator/isolation requirements. Never
rewrite a historical pin to conceal a mismatch.

Use verified available Git 2.47.3 where the campaign toolchain pin requires it,
and record the executable identity actually used. Do not relabel Git 2.54.0 as
2.47.3. Resolve missing prerequisites and verify source/main movement before
continuing dependent work; expected campaign integrations get explicit new-head
reconciliation and affected checks.

Run cheap affected checks first and reuse exact fresh evidence. Costly load,
sweep, live-provider and RC work is authorized when necessary, with a concrete
bounded plan naming exact inputs, tool/provider identities, scope, time/output/
cost limits appropriate to that operation and stop conditions before execution.
This mandate grants no numerical waiver or unlimited retries. Preserve all
attempts and stop on an exhausted bound or unsupported operation. Keep formatting,
lint, type integrity, schema/generated consistency, secret/path checks, package
boundaries and exact candidate identity mandatory. Build and release:bootstrap
from the task checkout before invoking bin.js.

## Effects and completion

Necessary campaign effects, including push, the two PRs and merges, receipt
signing/export, exact-tag rehearsal, package/release publication, Pages deployment,
protected-variable updates, final observations, the prepared DETRAN notice and
evidenced issue closure, are authorized by the Owner's standing instruction.
Prepare concrete exact single-use effect records before each execution, binding
its destination, candidate/artifact, scope and preconditions; retain observed
receipts afterward. The authorization record is not a claim of performance:
`performed_at` is recorded only after the described effect or accepted fallback
has actually occurred. Do not infer new unrelated repository-setting changes.

Credentials, supported no-tool/no-MCP controls, signing custody, protected
approvals and required `publish:true` configuration remain technical gates.
Do not expose credentials or bypass protection. PR-A must actually merge before
shipping from main under the existing trusted verifier. PR-B derives all repin
identities from immutable publication. No checkpoint sets `merged_as`, closes a
round or supplies a future merge SHA. Canonical verifier and DETRAN remain
read-only; the authorized notice must obtain independent adopter confirmation.
No worker can manufacture that evidence. Preserve #253's `not_planned` closure
and reconcile arrivals/reopens before claiming the backlog is empty.

TASK-0624's committed design can be accepted under the new mandate after distinct
review. Its Pages and soft-gate scope gaps remain substantive: retain
noncancellation until cancellation/reconciliation safety is proved, preserve
existing trace failures, and prepare concrete rubric/threshold/producer/consumer
scope proposals under delegated Architect authority. Acceptance of this source
design alone proves neither INV-HARNESS-006 nor deployed Pages safety.

## Entry checkpoint snapshot

TASK-0611, TASK-0621, TASK-0622, TASK-0623, TASK-0641 and TASK-0661 have ratified
source checkpoints. TASK-0624 has now been accepted under the standing Owner mandate after
central review; its original unresolved obligations remain recorded. Completed contributions are integrated locally on
the central planning branch; no main merge, release or formal round closure is
claimed. Use the exact archived checkpoint receipts, rather than stale planned
ledger fields, for source handoffs. See [checkpoint register](checkpoint-register.md).
