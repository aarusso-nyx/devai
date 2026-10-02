# Decision register

Current authority: the [Owner execution decision](execution-discipline.md)
supersedes preparation-only limits and repeated routine approvals. It authorizes
necessary campaign effects and designated chat coordination; exact effect
records, technical prerequisites and independently observed results still apply.
The historical decisions below remain accepted scope evidence.

Five Owner comments posted after the initial snapshot settle the following choices. They are scope/contract evidence, not new execution or publication authority.

| Issue | Owner decision                                                                                                                                                                                                                                       | Exact evidence                                                                                                      | Plan consequence                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| #237  | **Owner decision (2026-10-01): option (a).** DEVAI produces the inventory its own sensors expect, so F4:T4 and F4:T9 stay measured cells as ADR-SCR-0008 decides. No N/A declaration and no amending record for these cells.                         | [Comment 5940972412](https://github.com/aarusso-nyx/devai/issues/237#issuecomment-5940972412), 2026-10-01T21:27:25Z | Produce measured inventory (Owner option a)                           |
| #252  | **Owner decision (2026-10-01): refuse.** The inline `sense run --preset=<name>` form is not a supported selection. Selection and admission must refuse it consistently with one error code; `--preset <name>` remains the supported form.            | [Comment 5940972742](https://github.com/aarusso-nyx/devai/issues/252#issuecomment-5940972742), 2026-10-01T21:27:27Z | Owner rejects inline syntax; selection/admission use one refusal code |
| #233  | **Owner decision (2026-10-01): fix and upgrade.** Every high-severity advisory is resolved by upgrading or replacing the affected dependency; no Owner waiver is granted for this issue.                                                             | [Comment 5940973056](https://github.com/aarusso-nyx/devai/issues/233#issuecomment-5940973056), 2026-10-01T21:27:28Z | Upgrade/replace all high advisories; no waivers                       |
| #240  | **Owner decision (2026-10-01): confirmed.** The Architect writes the amending records (ADR-EVI-0001 IA-005 restated to the Owner's ruling; ADR-SCR-0008 sensor-to-cell pairing aligned with `law/policy/sensor-registry.json`) for Owner acceptance. | [Comment 5940973522](https://github.com/aarusso-nyx/devai/issues/240#issuecomment-5940973522), 2026-10-01T21:27:29Z | Two proposed amending records for exact Owner acceptance              |
| #253  | **Owner decision (2026-10-01): not planned.** ADR-CHK-0005 option A (structured `not-applicable` for `action-effects` and `cli-reference` in adopters) stands; option B is not pursued.                                                              | [Comment 5940974066](https://github.com/aarusso-nyx/devai/issues/253#issuecomment-5940974066), 2026-10-01T21:27:31Z | Not planned by Owner; option A stands; no option B implementation     |

The Owner choices above are settled. #237 explicitly forbids a new applicability amendment: ADR-SCR-0012 changes naming only.

| Accepted contract or later effect                                                               | Proposed artifact                | Required before              |
| ----------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------- |
| Accepted ADR-EVI-0004: restate IA-005 without changing canonical row/seal semantics             | ADR-EVI-0004                     | R-0601 close / R-0604 open   |
| Accepted ADR-SCR-0012: correct sensor-to-cell naming, retain both measured cells                | ADR-SCR-0012                     | R-0601 close / R-0603 open   |
| Accepted ADR-EVI-0005: newest-line recovery spelling and exact chain-append contract            | ADR-EVI-0005                     | CTG-0642                     |
| Accepted ADR-MDL-0003: host completion/isolation, byte contract and strict projection           | ADR-MDL-0003                     | CTG-0661                     |
| If cancellation/reconciliation safety cannot be proved, decide exact Pages concurrency contract | CTG-0622 Architect evidence      | Engineer mutation            |
| Select actual release version/candidate, receipt use/disposition and exact effect approvals     | release-handoff.md + OE-05/OE-06 | release use/publication      |
| Approve current Pages audit/control identity and deployment                                     | pages-handoff.md + OE-07         | deployment                   |
| Set live-review experiment caps and exact host/credential approval                              | live-review-preflight.md + OE-04 | any live provider invocation |

The four forward ADRs under law/adr now have status accepted following the explicit Owner decision. Accepted predecessor bytes are preserved; their full decisions and unchanged adversarial obligations are retained by the forward amendment.
#253 is an Owner-directed not-planned disposition: no CTG implements option B, no package-owned input feature is claimed. ADR-CHK-0005 option A remains binding.

Both recommended integration outcomes are accepted. Their concrete bounds and
current implementation gaps are in [integration-contract.md](integration-contract.md).
CTG-0624 specifies schema and fail-closed enforcement before a scoped pairing can
be used; no class-only law/CI pairing is installed during preparation. The
release verifier-section generator is planned explicitly because the current
ci-scaffold emits only ledger/attested-RC workflows. Engineer ownership and
Architect generated-output ownership remain separate.

PR discipline is settled: one cumulative remediation PR plus one post-release
repin PR. The accepted source-only procedure uses reviewed candidate checkpoints,
then actual main merge/release/post-publication repin. See integration-contract.md.
No release ancestry bypass or extra implementation PR is inferred.

Final revalidation observes #253 already closed not_planned by aarusso-nyx at 2026-10-01T21:27:31Z, event 32290441966. Preserve that externally performed disposition; no duplicate issue-state effect is required. The original scope is 22 issues, and 21 remain open. All five later Owner comments, including the now-closed issue, are retained in the complete comment refresh.

## Owner acceptance recorded during preparation

The Owner stated: “I Accept all four ADR proposed.” and “I Accept all recommended
arrangements for integrations. Incorporate these decisions on plans and make
then ready to start of work.” ADR-EVI-0004, ADR-SCR-0012, ADR-EVI-0005 and
ADR-MDL-0003 are accepted; OE-02/OE-03 record this decision, not implementation.
Both narrow integration outcomes are approved. The implementation-support
triplet CTG-0624 supplies path-scoped pairing enforcement and deterministic
release verifier restatements; no broad law/CI exception is permitted.

The final Owner instruction is: “Go with One cumulative remediation PR, plus one post-release repin PR”. The two-PR integration
contract is accepted; earlier one-PR deliberation is superseded. The scoped
source procedure is explicit in campaign-execution.json 1.4.0.

Current planned scope: 9 rounds, 20 CTGs, 46 tasks. The previous scope was 9,
19 and 43; only CTG-0624 (TASK-06210, TASK-06211, TASK-06212) was added.
This preparation grants local artifact updates and records the explicit contract
acceptances. Worker execution, commits, source publication, PR creation/merge,
issue effects, signing/export, release/Pages/settings and notifications still
require the applicable exact authority. Current source checkpoint state is in checkpoint-register.md; no actual round closure is inferred.

## Execution amendment and substantive proposals

Routine scope amendments, commits and checkpoints now proceed after distinct
review under the standing mandate. TASK-0611/0621/0622/0623/0641/0661 are ratified;
TASK-0624 is committed pending acceptance after central review under that mandate.
Only the central coordinator grants/releases round permits and integrates PR
branches; eight round chats follow the original dependency queue and the limits
of three active rounds and three inclusive active agents per round.

TASK-0624 acceptance does not settle its Pages cancellation/reconciliation or
soft rubric/threshold/producer/consumer scope gaps. The R-0602 Architect may
prepare concrete technical amendments under delegated authority and distinct
review. Keep cancellation disabled until safety is proved, preserve existing
trace failures, and escalate any genuine unresolved new behavior/risk choice.
Live isolation, exact release intent/receipt binding, protected availability and
independent DETRAN confirmation remain substantive preconditions; an authority
record never supplies their missing evidence.
