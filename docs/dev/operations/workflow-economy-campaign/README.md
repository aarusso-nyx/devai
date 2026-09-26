# Workflow economy campaign

The plan that implements the nine records indexed in
[workflow economy proposals](../workflow-economy-proposals.md) lives at
[`product/campaigns/CMP-0001-workflow-economy/campaign.json`](../../../../product/campaigns/CMP-0001-workflow-economy/campaign.json).
Its structure is `law/schemas/campaign.schema.json`; its semantics are
`law/policy/campaign-execution.json`. This page is the human guide.

## Vocabulary

- **Campaign.** An ordered set of rounds implementing an explicit set of
  accepted decision records under one mandate.
- **Round.** The smallest set of waves that closes with one merged head and,
  when the task descriptor changed, one attestation re-issue.
- **Wave.** One coupled task group in the sense of Constitution Article 24:
  an Architect, an Inspector, and an Engineer task in pipeline order, or one
  single-role task. Waves in a round run in parallel when their lock scopes
  are disjoint.
- **Task.** One role, one session, one branch, one pull request, one boundary.

## Opening a round

1. The Architect sets each of the round's records to `accepted` in a
   `law(adr)` commit, after the Inspector acceptance items are agreed.
2. Confirm every round in `depends_on` is `closed`.
3. Set the round to `open` in the campaign document, in a `plan(campaign)`
   commit, and run `pnpm run campaign:check`.

## Running a task

1. Confirm the round is open: its records are accepted and its upstream
   rounds are closed. Confirm the wave is open and the task's upstream task
   is merged.
2. Open a session with the task's discipline declared. Paste
   `prompts/preamble.md`, then the task's prompt file, verbatim.
3. Record the prompt file's sha256 on the task before work starts.
4. When the pull request is open and the acceptance commands pass, set the
   task to `pre_merge`. After merge, record `pull_request` and `merged_as`.
5. After the last task of a round merges, run the universal close checks and
   the round's `close_checks` on the merged head, perform any owner effect the
   round requires, re-issue the attestation when the round says so, and record
   the closure.

The campaign document is the ledger. Update it after every merge and every
close in a commit of type `plan(campaign)`, and run `pnpm run campaign:check`
before committing it.

## Closing a round

1. Run the universal close checks (`adrs`, `schemas`, `docs-links`,
   `format:check:all`, `action-registry:check`) and the round's
   `close_checks` on the merged head.
2. Perform and date every owner effect the round requires.
3. When `attestation_reissue` is true, record the new task-policy digest in
   the round closure and re-issue the RC attestation for it as described in
   [release discipline](../release-discipline.md) before any release plan
   uses that head.
4. Set the round to `closed` with its `closure` block in a `plan(campaign)`
   commit.

## Self-dogfood limits

This is DEVAI's own repository. Every session is human-invoked, one role per
session, no backlog dequeue, no self-dispatch, no remote effect. The campaign
is executed as maintainer-driven pull requests; materializing a round into a
governed round record is optional and follows the mapping in the policy.

## Known discrepancies to resolve in flight

- `law/policy/round-execution.json` orders coupled tasks inspector first;
  Constitution Article 24 and the cross-role documentation order Architect
  first. The campaign follows the constitution. TASK-0121 reconciles the
  policy.
- `packages/loop/src/loop/backlog.ts` names the round task queue. The
  repository backlog of ADR-GOV-0019 uses a distinct module name.
