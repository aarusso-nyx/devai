# Multi-stack path authority campaign

The plan that implements the two records of the
[multi-stack path authority proposal](../multi-stack-path-authority-proposal.md)
lives at
[`product/campaigns/CMP-0005-multi-stack-path-authority/campaign.json`](../../../../product/campaigns/CMP-0005-multi-stack-path-authority/campaign.json).
Its structure is `law/schemas/campaign.schema.json`; its semantics are
`law/policy/campaign-execution.json`; the vocabulary, escalation, and the
round open and close procedures are those of the
[workflow economy campaign guide](../workflow-economy-campaign/README.md) and
the [harness convergence campaign guide](../harness-convergence-campaign/README.md).
The campaign answers issue #186 for the DETRAN adopter and is `proposed`:
the Owner answered its decisions on 2026-09-30 (section 4); nothing opens
until the Owner approves the exact amended words (OE-01) and the Architect
accepts the records.

The two records are ADR-GOV-0024 (the Article 6 amendment, constitution
1.0.2) and ADR-AUT-0003 (governed adopter path authority) under `law/adr/`,
both proposed at the time of writing. The proposal's "Decisions taken by
the Owner" table, mirrored in OE-01, binds every task.

## 1. Rounds and the outcome each must move

| Round  | Records                    | Outcome                                                                                                                                                                                                                                   |
| ------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-0501 | ADR-GOV-0024, ADR-AUT-0003 | `law/constitution.md` is 1.0.2 and the framework pin is rebound; the adopter policy schema admits the `authority` block; a pure compiler emits the fixed ladder and refuses every malformed source and a constitution below 1.0.2 by code |
| R-0502 | ADR-AUT-0003               | `init bind --adopter-policy` writes the compiled block as the second additive extension with receipt provenance, byte-stable; the broker decides the DETRAN matrix as real rules; extension ties are denied                               |
| R-0503 | ADR-AUT-0003               | Doctor names a drifted, unbound, or missing source with the rebind command; the migration is documented; the packed tarball reproduces the matrix in a disposable adopter; the release is published                                       |

Each round is one coupled triplet. Tests are written by the inspector before
the engineer implements and may be red at the inspector's merge.

## 2. Owner effects

| Effect | Before | What                                                                                                                                                                                                      |
| ------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OE-01  | R-0501 | Approve the exact amended Article 6 words of ADR-GOV-0024 (the decisions are answered, section 4); the Architect then accepts both records                                                                |
| OE-02  | R-0503 | Publish the immutable release that carries R-0501 to R-0503 (1.8.0, decided) from the exact packed artifact the rehearsal verified, and tell DETRAN the version so CTG-0005 can pin, rebind, and rehearse |

## 3. Running the campaign locally

Follow the workflow economy guide for opening rounds, running tasks, and
closing rounds. Rules specific to this campaign:

- Before R-0501 opens, record OE-01 on the ledger (the Owner's approval of
  the amended words), set both records to `accepted`, and set the campaign to
  `accepted`. Every prompt reads the proposal's decisions table; a task that
  finds a record and an answer in conflict stops and reports rather than
  choosing.
- Each task runs in its own worktree from the base the policy names
  (architect from `main`, inspector from the architect head, engineer from
  the inspector head), with the preamble pasted first and the task prompt
  second, and the prompt's sha256 pinned on the task at start. One
  orchestrator may run a wave's three tasks on one branch as separate
  role-declared sessions and open one pull request from the engineer's head.
- Serialized admission is in force (the merge queue Owner effect of CMP-0003
  resolved by its fallback): at most one pull request in `pre_merge` at a
  time.
- Before every acceptance command that invokes `bin.js`, run
  `pnpm run build && pnpm run release:bootstrap` so the check runner is
  compiled from the checkout.
- After each merge, update the ledger (`plan(campaign)` as `DEVAI Owner`) and
  run `node scripts/check-campaign.mjs`.
- R-0503 cannot close until OE-02 is performed; the round's tasks merge
  first, the release is rehearsed and published from that head, then the
  round closes.
- CMP-0004's CTG-0411 and this campaign's CTG-0521 both touch the authority
  broker sources; do not run them concurrently.

## 4. Decisions taken by the Owner (2026-09-30)

| Decision | Question                                      | Answer                                                                            |
| -------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| (a)      | Amend Article 6, and the constitution version | Amend; version 1.0.2 (patch; the draft recommended 1.1.0)                         |
| (b)      | Source of the extension                       | `authority` block in the adopter policy                                           |
| (c)      | Precedence model                              | Fixed class ladder: architecture 750, test 700, root 500                          |
| (d)      | Root set                                      | Adopter-declared under a closed grammar                                           |
| (e)      | Migration and framework dogfood               | Existing adopters unchanged; the framework declares no roots                      |
| (f)      | Release                                       | One release, 1.8.0, after R-0503 (OE-02)                                          |
| (g)      | Tiers, efforts, budgets                       | CMP-0003 pattern                                                                  |
| (h)      | Source edited after binding                   | Refuse every governed write until rebind                                          |
| (i)      | Nested `docs` directories under a root        | Engineer by remainder; an adopter may name `**/docs/**` in its architecture class |
| (j)      | Harness subject of class rules                | Bound to the class role                                                           |

The proposal keeps the rejected options and their consequences. OE-01 stays
unperformed on the ledger until the Owner approves the exact amended words of
ADR-GOV-0024, which is the constitutional act the effect names.

## 5. Round log

No round has opened.
