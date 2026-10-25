# REC-B1-A authored contract — return for review

**Contract authoring complete locally; binding and integration remain held.**
This additive return follows the [human approval receipt](approval-receipt.md).
Baseline is DEVAI `2df84159caabf869b866fb2a05e5b06be83295fb`, on local branch
`codex/u1-b1-approval-plan-20261024`. No commit, push, PR, merge or release occurred.

## Exact constitutional candidate

- Proposed version: **1.2.0**, a minor successor following the existing
  authority-expansion precedent. This is a constitutional version, not a selected
  package release version.
- Final UTF-8 source SHA256:
  `d5dfdc972161e0f848dd859be7bbfa510973c5c9a449a0f9e6b8960e4f5ac96a`.
- Predecessor 1.1.0 SHA256:
  `8353c3b81d38e0f9b913cbeb6762bc149605989c1b16f52d2c63ba9892f71270`.
- Historical 1.0.2 SHA256:
  `d7f8791f1d00a7247bced66bdcdf8b1af431bb57e49d03b6ddd7024cb52f957d`.

Only the two approved Article 6 paragraphs, the amendment date and three version
markers change. Exact removal reconstructs 1.1.0; the retained historical checks
then reconstruct 1.0.2. Every original authority row, Article 9, other article body
and accepted ADR remains unchanged. The source frontmatter retains its existing
active label, but this unintegrated proposed successor is not a bound runtime
contract. The existing bound pin remains 1.1.0 and was not edited.

ADR-GOV-0027 is authored with `status: proposed`, `supersedes: []`, and exactly two
subjects: the constitution and source-only proof-index contract. It grants no
accepted effective authority or supersession of ADR-GOV-0026. The unchanged
`renderDecisionIndex` generated its one new catalogue row; only the README
exception hash and resulting aggregate catalogue hash changed in adr-validation
policy. Historical exception entries and bodies remain byte-exact.

The new closed reference schema is source-only. It specifies the logical identity,
source/custody/phase, exact proof entry, Inspector consent and one-entry CAS shape;
it implements no host identity verification, real lock, target, action or adapter.
The Engineer companion adds exactly one name to SOURCE_ONLY_SCHEMAS. Counts are
134 canonical / 13 source-only / **121 unchanged runtime schemas**. Inspector ADR
census is 132 records / 133 scanned Markdown files / **642 unchanged effective
subject authorities**. No B1 runtime or U1 implementation has started.

## Validation standing

The Inspector reproduced authentic catalogue RED before the Engineer edit:
16 passed, three failures at the explicit catalogue mismatch. After that one-entry
change, focused verification across six approved test files and the existing ADR
catalogue freshness test yielded **118 passed, two failures**. A later correction
to preserve historical checks across eventual real 1.2.0 binding reran only the two
constitutional files: six passed and the same two held failures. The other 112
passing tests were unchanged. See the [independent review](inspector/final-review.json)
and [raw focused log](inspector/final-focused-tests.txt).

The new schema test also passed a focused 42-case rerun after three lint-only
idiom corrections. Targeted ESLint passed for all seven touched TypeScript files
(the initial run passed six; the corrected schema test passed on rerun). No
assertion or case was removed. Raw logs have byte-identical `.txt` review copies
because the repository ignores `.log` files.

The two visible failures are deliberate unresolved gates, not an overall GREEN:

1. Actual vendored pin 1.1.0 does not match proposed source 1.2.0.
2. The clean worktree's real `.devai/config/authority-policy.json` is absent; the
   preserved binding assertion fails reading it. No synthetic file was supplied.

Historical exact-digest checks, strict-schema shape and refusal tests, catalogue
census, proposed/non-effective ADR standing and deterministic index freshness pass.
The historical policy assertion now verifies the actual held-or-successor pin's
exact version/digest, so a genuine approved successor binding can satisfy both
history and current parity later. Nothing is skipped or made conditional on a
waiver. Independent review found no out-of-scope contract or runtime changes.

Dependencies were provisioned from the existing cache with offline, frozen-lockfile,
ignore-scripts installation: zero downloads, no lifecycle scripts or manifest/lock
changes. Only focused one-worker tests ran through the repository validation
runner. Formatting and whitespace checks cover the authored files. No build,
full-suite/coverage/RC, generator stack, local services or signed release lane ran.
`devai check --affected` remains unavailable without a built CLI; no built CLI was
created under this contract-authoring scope. It remains mandatory before later
integration, alongside exact-head required CI and source-effect authorization.

## Binding plan returned — not executable approval

The [binding plan](binding-plan.json) resolves existing registered actions and the
current target prestate, with exact prospective output copies under
[prospective-outputs](prospective-outputs/). These are review documents only; no
live pin/config was materialized and no private binding function was invoked.

The narrow supported sequence is `init bind --constitution`, then `init bind`
without a selector for the authority-policy materialization, each initiated by a
human Architect with separate explicit write consent after approval. The current
source calls for:

| Live target                           | Proposed effect                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `.devai/pin/constitution.md`          | Replace with the exact 1.2.0 source bytes and digest above                              |
| `.devai/constitution.md`              | Keep the existing pointer bytes unchanged; absent/changed pointer invalidates this plan |
| `.devai/config/project.json`          | Registered reconciliation, exact proposed bytes/digest in binding-plan.json             |
| `.devai/config/authority-policy.json` | Registered create; current exact after-digest is unresolved and binding is blocked      |

The project output would preserve adopter declarations and update constitution
version/digest plus `devai_version` to the current CLI source version 2.7.1. That
conditional source-version projection is not a new package release decision. Any
actual admitted candidate version/source change requires a fresh exact plan.

**The current supported dry plan cannot close the authority-policy after-digest.**
`init bind` without `--write` emits only `{ "plan": "authority-policy" }`; the
write path incorporates a real PID/UUID invocation, derived context and current
materialization timestamp into the output. The registered candidate bundle is
also not built/admitted here. No exact output digest or registered dry-run receipt
is fabricated. The plan marks this output NOT_BYTE_COMPLETE_NOT_APPROVABLE.

Before any binding, a subsequent exact proposal must close this preview/receipt gap
using a supported host guarantee or a separately approved planner change, admit an
exact candidate bundle containing the reviewed source, and return the full output
identities with fresh source/target guards. Such a planner change is outside the
approved three-path catalogue companion and was not made. This return provides
all presently resolvable exact bytes and the concrete blocker; it requests no
unknown-output binding grant.

No `--full` bind, extra operational/subprocess policy outputs, authority-session
state, proof/index/ref effect, manual config write, release or DETRAN operation is
included. Ordinary registered binding receipts are not proof-reconciliation
capabilities. Actual B1 enforcement still requires the separate B1-I-r2 gate.

## Remaining boundaries

Review the exact version/digest and authored changes now. Binding stays held until
the complete supported plan is reviewable and separately approved. Integration
stays held until binding closure, independent acceptance, current affected/required
checks and its own exact source authorization. The original REC-U1 implementation
plan remains a plan without execution approval. Runtime, source publication,
release and all DETRAN effects remain held: #211 unmerged, C6 blocked, S3 runtime
held, original criteria/history/local artifacts preserved.

The [authored-effects manifest](authored-effects-manifest.json) binds the actual
closed path population and the preserved machine-binding prestate. The separate
[return-artifact manifest](return-artifact-manifest.json) hashes this additive
review package; the original preparation manifest remains unchanged.
