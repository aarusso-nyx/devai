# `evidence render` and the rounds index

`devai evidence render` projects one evidence view from canonical records. It is read-only unless
`--out` is given together with `--write`; it never edits the records it reads. This page is the
reference for the `rounds` kind, which renders the canonical rounds index at
`record/derived/indexes/rounds.md`, and for the exact-membership rule that `round seal` applies
against that index. The governing record is
[ADR-EVI-0001](../../../law/adr/ADR-EVI-0001-canonical-closure-index.md), as amended by
[ADR-EVI-0004](../../../law/adr/ADR-EVI-0004-canonical-closure-acceptance-amendment.md);
the Owner ruling of 2026-10-01 (CMP-0004 guide, decision 6) fixes the row shape and order
below.

The index is a derived file under `record/derived/`. Constitution Article 6 reserves that tree for
the regeneration subsystem: no role writes it by hand, and this page, not a README beside the
file, is where its shape is described.

## Kinds

| `--kind`           | Source                                                     | Output                                                                                       |
| ------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `decisions`        | `law/adr/*.md` frontmatter                                 | The per-record decision ledger (unchanged by ADR-EVI-0001).                                  |
| `rounds`           | `record/proofs/compliance/closures/PC-NNNN.json`           | The rounds index: one row per phase closure, in the order defined below.                     |
| `round-narratives` | `work/rounds/*/record.md` bodies                           | The concatenation of round-record bodies that `rounds` produced before ADR-EVI-0001.         |
| `test-matrix`      | A test-result input directory (`--in`) and a configuration | The test matrix in `md` or `html` (unchanged; see the options the action help lists for it). |

`rounds` no longer means the narrative concatenation. A consumer that read the old output of
`--kind rounds` moves to `--kind round-narratives`, which keeps the same bytes that
`renderRoundRecords` produced before.

Usage:

```bash
devai evidence render --kind rounds --repo-root .                  # render to stdout, write nothing
devai evidence render --kind rounds --repo-root . --check          # compare with the committed file, write nothing
devai evidence render --kind rounds --repo-root . \
  --out record/derived/indexes/rounds.md --write                   # regenerate the committed file
devai evidence render --kind round-narratives --repo-root .        # the former concatenation
```

## The reader the renderer reuses

The `rounds` kind reads no round record and no hand-written file. It reuses the phase-closure
reader in
[`packages/evidence/src/closure/index.ts`](../../../packages/evidence/src/closure/index.ts):

- `readClosures(repoRoot)` reads every `PC-NNNN.json` under
  `record/proofs/compliance/closures`, refuses a file whose `id` differs from its file name,
  validates each record against
  [`phase-closure.schema.json`](../../../law/schemas/phase-closure.schema.json), and returns the
  records sorted by closure id.
- `computeLedger(records)` annotates each record with `superseded_by` when a later closure names
  it in `supersedes`. A closure with no `superseded_by` is **terminal** for its round.

The renderer adds the ordering and the rejections below on top of those two functions. It does
not define a second notion of supersession or a second validation of the closure schema.

## Row shape

One row per closure, five cells:

| Cell         | Value                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `closure`    | The closure id, `PC-NNNN`, equal to the file name without `.json`.                                                 |
| `round`      | The closure's `round_id`, `R-NNNN`.                                                                                |
| `supersedes` | The `supersedes` id when the closure corrects an earlier closure of the same round; otherwise the placeholder `-`. |
| `merged_as`  | The closure's `merged_as` commit sha, verbatim.                                                                    |
| `terminal`   | `yes` when no other closure supersedes this one (`superseded_by` is empty); otherwise `no`.                        |

Every closure is a row, including superseded ones, so the index carries the supersession
history the reader already validates. Exactly one row per round is `terminal: yes`.

### Bytes

The file is fixed to the byte level so that two renders of the same closures on two machines are
identical (IA-004):

- UTF-8, `\n` line endings, one trailing newline, no trailing whitespace.
- Line 1 is the heading `# Rounds index`, line 2 is empty, line 3 is the column header
  `| closure | round | supersedes | merged_as | terminal |`, line 4 is the separator
  `| --- | --- | --- | --- | --- |`, and every following line is one row.
- Cells are joined with `|`, with a leading `| ` and a trailing ` |`, and no column padding;
  the renderer never runs a formatter over the output, and `record/` is excluded from the
  repository formatter.
- No row contains free prose. Nothing other than the heading, the header, the separator, and the
  rows is written.

A rendered excerpt from the DETRAN closures fixture
(`tests/fixtures/closures/detran/`, twenty closures, two supersessions):

```text
# Rounds index

| closure | round | supersedes | merged_as | terminal |
| --- | --- | --- | --- | --- |
| PC-0001 | R-0003 | - | cf8f475eaf1951fa2ebb3c42d24f725c6581ea0e | yes |
| PC-0002 | R-0004 | - | a7e5e93398dee6d3dd6a979d04dc5bd9e3b9d913 | yes |
...
| PC-0008 | R-0010 | - | 1c24657b784c519cd243a7e6925a33b460c760de | yes |
...
| PC-0007 | R-0014 | - | 48d103fc36fa3b15a32e5dd5da11b6d729b3c596 | yes |
...
| PC-0017 | R-0017 | - | d5afcf9211373238d6eb7b8ad09188a342101a39 | no |
| PC-0018 | R-0017 | PC-0017 | d5afcf9211373238d6eb7b8ad09188a342101a39 | yes |
| PC-0015 | R-0018 | - | 4bd1d553478e1eb831353d30dd6769183c2b3990 | no |
| PC-0020 | R-0018 | PC-0015 | 4bd1d553478e1eb831353d30dd6769183c2b3990 | yes |
| PC-0016 | R-0019 | - | 673934fc0bb634403b2ae7cfc8abf250183c4777 | yes |
| PC-0019 | R-0021 | - | 1576708f8378817d5e3338953015f5acdb704e1e | yes |
```

## Order

The order is a function of the closures alone; neither file-system order nor render time enters
it:

1. Rounds are grouped and sorted by round id, ascending by the plain string order of `R-NNNN`
   (ids are zero-padded, so string order is numeric order).
2. Inside a round the rows follow the supersession chain from the first closure to the terminal
   one: the row with no `supersedes` first, then the closure that names it, and so on until the
   row marked `terminal: yes`.

So in the excerpt above `R-0010` (`PC-0008`) precedes `R-0014` (`PC-0007`) although its closure
id is larger, and `PC-0017` precedes the `PC-0018` that supersedes it.

## Rejections

The renderer rejects the whole render on the first of these conditions it meets; a rejected
render writes nothing, exits non-zero, and prints `devai evidence render: <message>` on stderr
with the offending closure file named (`PC-NNNN.json`):

| Condition                                                                     | Example                                                            | Acceptance |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------- |
| A closure file whose name differs from its `id`                               | `PC-0003.json` declaring `"id": "PC-0002"`                         | IA-001     |
| Two closures with the same `id`                                               | The same record under two file names                               | IA-001     |
| A `supersedes` link that names an id absent from the directory                | `"supersedes": "PC-0099"` with no `PC-0099.json`                   | IA-001     |
| A `supersedes` link that names a closure of another round                     | A closure of `R-0018` superseding a closure of `R-0017`            | IA-001     |
| A supersession cycle, including a chain that never reaches a terminal closure | `PC-0004` supersedes `PC-0005` and `PC-0005` supersedes `PC-0004`  | IA-002     |
| More than one terminal closure for one round                                  | Two closures of `R-0017`, neither naming the other in `supersedes` | IA-002     |

The first three conditions are already refused by `readClosures` or by the phase-closure schema
and keep their diagnostics; the renderer adds the crossed link, the cycle, and the ambiguous
terminal. A rejection is a measured outcome: it is never downgraded to a warning and no threshold
makes it pass.

## `--check`

`--check` renders the index to memory and compares the bytes with the committed
`record/derived/indexes/rounds.md`:

- Identical bytes: exit code 0, nothing written.
- Any difference, a missing committed file, or a rejected render: exit code non-zero, nothing
  written, and the reason on stderr. A single changed byte in the committed file is a difference
  (IA-004).
- `--check` is incompatible with `--out`; passing both is a usage error.

Regeneration is the explicit path: `--out record/derived/indexes/rounds.md --write`. The check
never repairs the file it checks.

## Freshness

`record/derived/indexes/rounds.md` is a rendered file. Adding, superseding, or correcting a phase
closure without regenerating the index makes the committed file stale, and the round-close checks
fail on that staleness in the same way they fail on any derived index that no longer matches its
source. The remedy is always the regeneration command above, never an edit of the file.

## The seal rule (exact membership)

`round seal` keeps its precondition that the round's `phase_closure` appears in the index, and
keeps the error code `ROUND_ARCHIVE_PHASE_LEDGER_MISSING`, but the test is exact membership
instead of substring presence (#169). The seal passes only when one row satisfies all three:

1. the `closure` cell equals the closure id being sealed, as a whole cell, not as a substring of
   a longer id and not as a mention in prose;
2. the row is `terminal: yes`; and
3. the `round` cell equals the round being sealed.

Each of the following therefore fails with `ROUND_ARCHIVE_PHASE_LEDGER_MISSING` (IA-003):

- the id appears only inside another id (`PC-0001` inside `PC-00010`);
- the id appears only in a sentence or any line that is not a row;
- the id is the `closure` cell of a row that is `terminal: no` (a superseded closure);
- the id is the terminal row of a different round.

The seal and closed-round integrity use the same exact-row predicate. Every row must have
canonical five-cell syntax, unique closure identities and a coherent same-round supersession
chain with terminal flags that agree with its links. A malformed row, duplicate, cycle,
disconnected chain or contradictory terminal flag invalidates membership even beside a
plausible target row. Integrity retains `ROUND_PHASE_CLOSURE_UNRESOLVED`; sealing retains
`ROUND_ARCHIVE_PHASE_LEDGER_MISSING` and its independent proof, decision, gate and artifact
preconditions.

The seal reads the committed index, not the closure directory, so the seal agrees with what a
reviewer reads. A stale index fails the seal until it is regenerated.

Against the DETRAN fixture the rule seals every round the adopter sealed: `R-0017` seals through
`PC-0018`, the terminal row of that round, and would not seal through `PC-0017`.

## Adopter note

DETRAN generated its first index with a local script, in closure-id order and without a terminal
column. By the Owner ruling of 2026-10-01 the canonical rendering above governs; IA-005 of
ADR-EVI-0001 is met when the DETRAN fixture yields the same rows (closure, round, supersedes,
`merged_as`) and seals every round the adopter sealed, not by byte identity with the adopter's
file. An adopter regenerates its index once with the command above and commits the result.

## Proof recovery and derived indexes

The accepted [newest-line recovery contract](./evidence-verify.md#accepted-recovery-options-proposed)
adds proposed options to `evidence record`, not to `evidence render`. Its only permitted
repair is appending one missing chain anchor for the newest physical proof line. It does
not regenerate or hand-edit `rounds.md`, change closure rows, rewrite historical proofs,
or replace a historical-gap declaration. Derived index changes still require the registered
renderer and the exact closure-membership and supersession checks above.

## See also

- [ADR-EVI-0001](../../../law/adr/ADR-EVI-0001-canonical-closure-index.md) — the record.
- [Rounds, tasks, and executors](./round-task-executors.md) — the round lifecycle that `seal`
  closes.
- [Loop](../../theory/framework/loop.md) — where the sealed round sits in the control loop.
- [CLI overview](./index.md) — the `evidence` workflow domain.
