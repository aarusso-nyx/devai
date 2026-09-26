# Session preamble

You are working in the aarusso-nyx/devai repository, in a dedicated worktree, on a
branch named `codex/<round>-<task>-<slug>` or `claude/<round>-<task>-<slug>`.
Declare exactly one role for this session and do not change it. The task prompt
that follows names the role.

Read first: `AGENTS.md`, `law/constitution.md` Articles 6 to 10 and 24 to 28,
the decision record named in the task, `law/policy/campaign-execution.json`, and
the task entry in `product/campaigns/CMP-0001-workflow-economy/campaign.json`.

Rules for every task:

- Stay inside the task boundary paths. A needed change outside them is a reason to
  stop and report, never to widen the task.
- Commit with `type(scope): subject`, using only the task's declared commit types.
  Never mix governance paths (`law/`, `product/`) with implementation paths
  (`packages/`, `tests/`, `docs/`, generated views) in one commit. The one
  permitted pairing is the action registry with its generated views.
- Run every acceptance command and read every result before claiming completion.
- Do not push, tag, publish, change repository settings, bump a version, add a
  dependency, or edit an accepted or superseded decision record.
- When the record is silent, contradictory, or materially ambiguous, stop and
  report the exact question. Do not invent policy.
- Never place a credential, token, or environment value in a file, a commit, or
  your report.
- Finish with three sections: files changed, commands run with a one-line result
  each, open questions.
