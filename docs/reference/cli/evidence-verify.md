# `evidence verify` and proof-line anchoring

`devai evidence verify --scope chain` checks `record/proofs/chain.json`: the sequence, the
previous-hash links, each record's manifest hash, and the head. Under
[ADR-EVI-0002](../../../law/adr/ADR-EVI-0002-proof-line-anchoring.md) it also cross-checks the
chain against every physical proof line under `record/proofs/work`, in both directions. This
page is the reference for that cross-check: the anchoring rules, the append-only baseline the
first verification writes, the governed historical declaration, the crash-recovery rule, and
the labels the verification result carries. The manifest hashing, link, and head rules of the
chain are unchanged by that record.

`record/proofs/` is machine-written (Constitution Article 6). No role edits a proof line, a chain
entry, or the baseline by hand, and the README beside those files is not where their shape is
described; this page is. The verifier refuses to run on a working tree that has modified an old
line or an old chain entry (`PROOF_HISTORY_MODIFIED`).

Usage:

```bash
devai evidence verify --scope chain --repo-root .                  # verify; a JSON receipt on stdout
devai evidence verify --scope chain --repo-root . --human          # the same, human-readable
devai evidence verify --scope chain --show-head --repo-root .      # also print the chain head
devai evidence verify --scope chain --repo-root . --write          # first run only: also write the baseline
```

`evidence verify` is a read by default (Owner decision of 2026-10-01), and it stays `read` in the
[action registry](../../../law/policy/action-registry.json). It prints a JSON receipt on stdout
unless `--human` is given. The one write it can perform is the first baseline write, and that is
authorized only by `--write` consent at invocation, gated in the authority layer the same way
`docs decisions render --out` is, not by a write effect on the action: see
[The baseline](#the-baseline).

## What an anchor is

A chain entry that `evidence record` appends after a proof line anchors that line. Historical
entries carry the anchor as `notes` of the form `round_id=<id>` and `proof_sequence=<n>`; that
form is kept for readers. New anchors additionally carry three structured fields on the chain
entry, written by `appendVerbEvidence` in
[`packages/evidence/src/evidence/verb-evidence.ts`](../../../packages/evidence/src/evidence/verb-evidence.ts):

| Field            | Value                                                                       |
| ---------------- | --------------------------------------------------------------------------- |
| `proof_path`     | The canonical path of the proof epoch file that holds the line (see below). |
| `proof_sequence` | The one-based position of the line inside that file.                        |
| `proof_sha256`   | The SHA-256 of the line bytes.                                              |

A new anchor whose `proof_sha256` differs from the bytes of the line it names fails
verification (IA-004).

## The anchoring rules

The rules below are defined by
[`packages/evidence/src/evidence/proof-epoch.ts`](../../../packages/evidence/src/evidence/proof-epoch.ts)
and applied by the cross-check in
[`packages/evidence/src/evidence/chain.ts`](../../../packages/evidence/src/evidence/chain.ts).
Every anchor must resolve to exactly one physical line; an anchor that resolves to no line, to
more than one line, or to a line whose digest differs fails the verification with the anchor
and the line named.

### Canonical path

The path of a proof epoch file is `record/proofs/work/<kind>/<round_id>.jsonl`, relative to the
repository root, where `<kind>` matches `^[a-z0-9][a-z0-9_-]*$` and `<round_id>` matches
`^R-[0-9]{4}$`. The path uses forward slashes only, carries no dot segment (`.` or `..`), and
has no leading slash. An anchor whose path contains a backslash or a dot segment resolves to no
line and fails; it is never normalized into a match (IA-005).

### Sequence namespace

The sequence namespace is the epoch of one file. `proof_sequence` is the one-based position of
the line within its file, equal to the `sequence` field the line itself carries, and it never
crosses files: sequence `1` of `R-0002.jsonl` and sequence `1` of `R-0003.jsonl` are different
lines. A sequence beyond the last line of the named file resolves to no line and fails (IA-005).

### Newline handling

A line is the bytes between the previous newline (or the start of the file) and the next
newline, exclusive of the newline. A file whose last byte is not a newline is truncated: it is
reported as such, and no anchor into it resolves (IA-005). An empty line is a defect of the
epoch, not a line.

### Byte hashing

The line digest is the SHA-256 of the line bytes as defined above: the physical UTF-8 bytes of
the JSON text, without the terminating newline. It is not the line's internal `line_hash`
field, which hashes the canonicalized JSON object, and it is not the hash of the whole file.
Changing one byte of an anchored line makes the verification fail naming that line (IA-002).

## The baseline

Historical anchors carry no digest. They are checked against a baseline that the first
verification under ADR-EVI-0002 writes to `record/proofs/anchor-baseline.json`, validated by
[`proof-anchor-baseline.schema.json`](../../../law/schemas/proof-anchor-baseline.schema.json):

| Field                     | Value                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `record`                  | `ADR-EVI-0002`.                                                                                |
| `cutoff`                  | The timestamp of the first verification, the one that wrote the baseline. Never changed.       |
| `entries[].path`          | The canonical path of the line's file.                                                         |
| `entries[].sequence`      | The line's position inside that file.                                                          |
| `entries[].sha256`        | The line digest.                                                                               |
| `entries[].anchor_status` | `anchored` when a chain entry anchored the line at observation; otherwise `orphaned`.          |
| `entries[].observed_at`   | The timestamp of the verification that appended the entry; the first entries carry the cutoff. |

The baseline is append-only. A later verification may append entries for lines that were not
yet present, and may never change or remove an entry. One changed byte in the baseline file
makes the verification fail naming the entry (IA-002). The baseline is a committed file under
`record/proofs`; the commit that carries it is a machine write, not a hand edit.

### Writing the baseline

Writing the baseline is the one write `evidence verify` performs, and it is gated by write
consent (Owner decision of 2026-10-01). The action stays `read` in the registry; the write is
authorized only by `--write` at invocation, following the `docs decisions render --out`
precedent:

- Without a baseline and without `--write`, the verification fails with
  `PROOF_ANCHOR_BASELINE_MISSING`; its message names `--write`, nothing is written, and the
  chain is not reported as valid.
- With `--write`, the first verification writes `record/proofs/anchor-baseline.json` with every
  line observed, `cutoff` equal to that verification's timestamp, and each entry's `observed_at`
  equal to the cutoff. Later verifications run as reads against the committed file.
- `--write` on a later run appends only entries for lines not yet present; it never rewrites one.

### The cutoff rule

The cutoff separates eligible lines from later ones:

- An entry observed at the first verification (`observed_at` equal to `cutoff`) is eligible for
  a historical declaration.
- An entry observed after the cutoff was recorded under ADR-EVI-0002 and is never eligible; a
  declaration that names it is rejected as `POST_CUTOFF`, and the line stays an orphan.

## The historical declaration

Every physical line under `record/proofs/work` must have exactly one direct anchor or one
governed historical declaration. A line with neither is an orphan and fails verification. The
only remedy for an orphan is a declaration; an orphan is never re-anchored by a synthetic chain
entry, and an old entry is never edited to add a digest.

A historical declaration is a proof line of kind `historical-gap`, appended through
`evidence record --kind historical-gap`, whose payload validates against
[`proof-orphan-declaration.schema.json`](../../../law/schemas/proof-orphan-declaration.schema.json):

- it is itself directly anchored in the chain, with a `proof_sha256` digest;
- it names each orphan by canonical `path`, `sequence`, and line `sha256`;
- it carries the Architect's authorization as the declaring decision
  (`authorization.role` is `Architect`; `authorization.decision` names the record or contract
  in which the Architect authorized it); only the Architect authorizes a historical orphan
  declaration (maintainer decision 10);
- it repeats the baseline `cutoff`, and applies only to lines whose baseline entry was observed
  at the first verification: only lines recorded before the first verification under
  ADR-EVI-0002 are eligible, and a line observed after the cutoff is `POST_CUTOFF`.

A declaration acknowledges a gap; it never restores provenance. The lines it names read as
`historical gap acknowledged` in the verification result and stay listed under that label.

A declaration is rejected, and the orphans it names remain failures, when it (IA-003):

| Condition                                                        | Outcome                                             |
| ---------------------------------------------------------------- | --------------------------------------------------- |
| names a line whose baseline entry was observed after the cutoff  | rejected as `POST_CUTOFF`; the line stays an orphan |
| lacks the Architect authorization                                | rejected; every named line stays an orphan          |
| omits the line digest of a named orphan                          | rejected; every named line stays an orphan          |
| is not itself anchored with a digest                             | rejected; every named line stays an orphan          |
| names a line whose current bytes differ from the declared digest | the line fails verification naming the mismatch     |

The verifier also refuses to run at all, before any declaration is read, when the working tree
has changed an old proof line or an old chain entry: `PROOF_HISTORY_MODIFIED`. Nothing is
written, the baseline is left untouched, and the remedy is to restore the committed bytes, never
to re-anchor or re-declare the changed line.

## Crash recovery: `UNANCHORED_NEWEST_LINE`

`evidence record` writes in two steps: the proof line, then the chain entry. When the newest
line of an epoch has no anchor and no declaration, the verifier reports it as
`UNANCHORED_NEWEST_LINE` with the remediation of appending the missing chain entry through
`evidence record`, which computes the digest from the existing line bytes, appends that one
chain entry, and writes nothing else; the proof line itself is not rewritten (IA-004). Only the newest line of an epoch qualifies: an older unanchored line is a historical
gap when a declaration covers it and a failure otherwise.

## The verification result

The result keeps the existing sequence, link, hash, and head findings, which still fail on their
own defects (IA-002), and adds the line-level cross-check:

| Label                         | Meaning                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| anchored                      | The anchor resolves to exactly one line whose digest matches.                                |
| orphan                        | A line with no anchor and no declaration; a failure, with the path and sequence named.       |
| `historical gap acknowledged` | A line named by an accepted historical declaration; listed, never counted as restored.       |
| `UNANCHORED_NEWEST_LINE`      | The newest line of an epoch with no anchor; a failure with the remediation above.            |
| unresolved anchor             | An anchor that resolves to no line, to more than one line, or to a line with another digest. |
| `POST_CUTOFF`                 | A declaration rejection: it named a line observed after the baseline cutoff.                 |
| `PROOF_HISTORY_MODIFIED`      | A refusal to verify: an old proof line or chain entry changed in the working tree.           |

A failing cross-check is a measured outcome: no threshold or reading makes an orphan pass, and
an acknowledged gap is reported on every verification, not only the first.

## Adopter note

The DETRAN baseline supplied for ADR-EVI-0002 (`tests/fixtures/proof-baseline/detran-r0020/`,
byte-exact) holds 119 proof lines in nineteen rounds, 67 with a direct anchor and 52 without,
with no duplicate anchor. Against it, `evidence verify --scope chain` fails before the
historical declaration with every one of the 52 orphans listed, and passes after it with the
declaration itself directly anchored and the 52 lines labelled `historical gap acknowledged`
(IA-001). The adopter's own contract for that declaration fixes the orphan identities by
canonical path, sequence, and line digest in the same terms as the schema above.

## See also

- [ADR-EVI-0002](../../../law/adr/ADR-EVI-0002-proof-line-anchoring.md) — the record.
- [`evidence render` and the rounds index](./evidence-render.md) — the other derived evidence
  surface under `record/`.
- [Rounds, tasks, and executors](./round-task-executors.md) — the round whose epoch the lines
  belong to.
- [CLI overview](./index.md) — the `evidence` workflow domain.
