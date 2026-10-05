# CLI reference

The release-candidate CLI contains 69 actions: 36 stable actions, 22 preview actions, and
11 internal plumbing actions. The nine public domains and their operator contracts are
documented in the [CLI overview](./cli/index.md). <!-- verify after merge -->

Use the installed binary for the exact candidate catalog and per-action help:

```bash
devai catalog actions --format json
devai catalog actions --help
devai check --help
```

Documentation never creates an alias or expands an action's authority.

## `round status`

`devai round status --round R-0003 --repo-root . --format json` reads one governed round in
place. Its contract is fixed by
[ADR-EVI-0003](../../law/adr/ADR-EVI-0003-sealed-round-lifecycle-read.md) (#175):

- **The governed lifecycle is always returned.** `lifecycle` carries the round id, the record
  path, the record frontmatter, and `location`, which is `active` or `closed`. A sealed round
  (one whose `work/rounds/<id>/close-state.jsonl` exists) reports `closed`. The read does not
  require an active task round.
- **The task summary is optional and never gates the lifecycle.** `tasks` is attached only when
  the task round is active. On a sealed round it is absent or marked inactive, and its absence
  never changes the exit code, which stays `0`.
- **Seal evidence is append-only and untouched.** The status read writes nothing:
  `close-state.jsonl`, the proof chain, and the tracking files are read only, and their bytes are
  identical before and after a status read.
- **`TASK_ROUND_INACTIVE` applies only to task dispatch.** `round run` and the task-dispatching
  actions still refuse a sealed round with `ACTION_PRECONDITION_UNSATISFIED` (exit 5) and the
  context payload `TASK_ROUND_INACTIVE`. A status read is not dispatch.
- **Failures keep their names.** A round that does not exist, or whose `close-state.jsonl` is
  malformed, fails with its existing named code and never reports `closed`.

The description of `TASK_ROUND_INACTIVE` on the [error code reference](./error-codes.md) is
generated from source by `scripts/generate-error-code-reference.mjs`; it is narrowed to dispatch
where the code is raised, not on this page. The reproduction that established this contract is
recorded on the [governance tracking page](../adopters/governance-tracking.md#post-seal-checkpoint).
