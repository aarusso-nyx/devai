# TASK-0641 exact terminal closure membership contract

Current execution authority is the [standing Owner decision](execution-discipline.md).
It supersedes earlier preparation-only and repeated routine authorization text;
exact evidence, role boundaries, substantive unresolved contracts and actual
performance gates remain. The task-entry narrative below is historical checkpoint evidence. Its old
permission stops are superseded; inspections, contracts, failures, actual models
and original approvals remain preserved. It does not describe a fresh human
review of later candidates.

Role: Architect. Campaign CMP-0006, round R-0604, wave CTG-0641.
This document defines the TASK-0642 Inspector and TASK-0643 Engineer reference.
It is a proposed source checkpoint for human review, not implementation, a
runtime closure, or a passing wave gate.

## Authority and exact source

The accepted [ADR-EVI-0004](../../../../law/adr/ADR-EVI-0004-canonical-closure-acceptance-amendment.md)
retains exact closure membership, deterministic canonical rendering, refusal
identities and immutable supersession history. Its amendment changes only
IA-005: equal canonical closure rows and sealing constitute adopter acceptance;
Portuguese workaround byte identity is not required. The
[constitution](../../../../law/constitution.md), Articles 6-10 and 41, preserves
role separation and append-only proof custody. Neither document is amended here.

- Worktree: `/Users/aarusso/.codex/worktrees/cmp0006-task0641/devai`.
- Branch: `codex/R-0604-TASK-0641-closure-membership`.
- Source HEAD: `970514e90ebbdb0d2f6d7de6722619585715c973`.
- Source tree: `98fc52ce988c3ce679276e9ed3e13d0d26bf93fb`.
- Fetched and remotely checked main: `180a122787193f9bdfce9b7f4cd5600e85ae7854`.
- Task prompt SHA-256: `a9b3927a4602d96befb091299143f1846b71554004d681d5cd67f66736e22f21`.
- The source dependency is R-0601 only; CTG-0641 has no wave predecessor.
  TASK-0611 HEAD `30ebdf41f1d73927696e43676c21d982afc60fe6` was human-ratified
  with `PASS. go ahead`. TASK-0621 HEAD
  `fb3ea266ca00e882afa34c5440cf46f0722de623` and TASK-0622 source HEAD above
  are ratified source history, not additional R-0604 dependencies or merges.
- All 77 manifest entries and the exact task prompt matched at entry. The
  source coordinator records the adopted whole-wave reservation, disjoint
  concurrent scopes, predecessor receipts and pinned model-tier map 1.0.0.
  Requested execution resolves to `codex-cli:gpt-6-astra` at high effort;
  the actual chat started as `gpt-6.1-sol` at high effort, with no override.
  The proposal reports that difference rather than asserting runtime conformity.

Only this document is authored by TASK-0641. Its local coordination evidence
lives under `.git/cmp-0006-source-pending/TASK-0641` in the Git common directory.
Campaign state, policies, schemas, tests, source, historical records and sibling
repositories remain read-only. The four ratified dependency-test files and their
27 PASS / 76 FAIL baseline are preserved; those failures belong to CTG-0621 and
never excuse a failed acceptance check here.

## Observed gap and owned implementation seams

These spans were verified in the exact source checkout after Graft lookup:

| Source span                                                               | Present behavior                                                                                   | Required contribution                                                              |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/loop/src/governance-ledger/index.ts:397-453`                    | Closed records resolve `phase_closure` with `includes`, at line 439.                               | Replace substring acceptance with the shared membership predicate.                 |
| `packages/loop/src/round-lifecycle/index.ts:240-248`                      | Private `hasTerminalIndexRow` accepts any five-cell match with `yes`.                              | Consume the shared predicate instead of keeping a second parser.                   |
| `packages/loop/src/round-lifecycle/index.ts:250-306`                      | Sealing independently checks proof identity, decisions, merged head, gates and required artifacts. | Preserve those checks, their order and refusal identities.                         |
| `packages/loop/src/governance-ledger/render.ts:1-6`                       | Ledger helpers depend on record parsing, not round lifecycle.                                      | House the shared pure parser and predicate in this already-reserved module.        |
| `packages/evidence/src/closure/index.ts:333-453`                          | Typed rows, supersession validation and canonical five-cell rendering already exist.               | Read-only format and history reference; do not change this package.                |
| `packages/loop/tests/unit/round-archive-history-boundaries.test.ts:36-43` | The helper writes a prose-only `PC-0007` ledger before committing a closed fixture.                | Inspector substitutes canonical rows without weakening archive-history assertions. |

The shared helpers live in `governance-ledger/render.ts`, exported there and
imported directly by the two consumers. Proposed internal names are
`parseClosureIndexRows` and `hasTerminalClosureIndexRow`. Neither helper imports
round lifecycle or reads files, runs Git, writes state, or throws caller-specific
refusals. No new module, package dependency, public CLI action, flag, schema or
export through the package public barrel is needed. Existing renderer behavior
and `round-narratives` remain unchanged.

## Parser contract

`parseClosureIndexRows(index: string)` returns a discriminated result: either
an immutable sequence of typed five-cell rows or an invalid result. An invalid
result is never an empty successful parse. The membership predicate maps invalid
or empty input to false. Parse every row before accepting a match; do not return
true at the first plausible row and overlook a later contradiction.

Each data row occupies one LF-delimited physical line with the existing literal
shape `| closure | round | supersedes | merged_as | terminal |`. Require the
exact prefix (pipe then space), suffix (space then pipe), separators (space,
pipe, space) and exactly five cells. Do not
trim, case-fold, normalize IDs, decode Markdown, match substrings, or silently
repair malformed rows. A title and the canonical column-header/separator lines
are presentation and never rows; neither heading text nor ordinary prose is
closure membership. Title wording and presence of presentation headers are not
additional membership preconditions. A table-shaped data line with malformed
syntax or cells invalidates parsing rather than being dropped beside a valid row.
A candidate data line starts with a pipe after optional indentation, or starts
with a closure-ID-looking cell followed by a table separator; indentation and a
missing leading/trailing delimiter are errors, not permission to ignore the line.
This is the canonical index format, not a general Markdown table parser.

| Cell         | Accepted representation                                                  | Typed meaning                                                                                                            |
| ------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `closure`    | Exact `PC-` plus four decimal digits.                                    | Closure identity; unique throughout the parsed rows.                                                                     |
| `round`      | Nonempty exact cell text, without pipe, CR/LF or surrounding whitespace. | Round identity; retain case and bytes. Do not impose an `R-NNNN` pattern: phase-closure schema admits other round names. |
| `supersedes` | `-` or an exact closure identity.                                        | `null` or the preceding closure ID; never a terminal marker.                                                             |
| `merged_as`  | `-` or a lowercase 40/64-digit hexadecimal SHA.                          | Preserve the existing historical placeholder or merged head. `-` never invents a merge.                                  |
| `terminal`   | Exactly `yes` or `no`.                                                   | Boolean terminal state; no truthiness, aliases or compound text.                                                         |

Use the existing `ClosureIndexRow` shape as the type reference. Parsing a
historical `merged_as: -` is allowed as rendering allows it; current sealing
still independently demands the proof/record merged identity it already checks.
The parser does not add proof reads to governance integrity or attest that a
rendered merged head equals a proof. Those remain separate proof and freshness
obligations. The table representation does not widen the phase-closure schema.

## Membership and supersession agreement

`hasTerminalClosureIndexRow(index, closureId, roundId)` is true only when parsing
succeeds, the queried closure ID is valid and the exact queried round is nonempty,
and the following row-graph conditions all hold. These are the existing canonical
renderer semantics applied to the rows both readers consume:

1. Every closure identity occurs once. Repeated identical rows are also ambiguous;
   a second copy under another round cannot establish the queried closure.
2. Every non-null `supersedes` names a row in the same round, is not self-reference,
   and has at most one successor. Absent targets, cross-round links and forks fail.
3. Each represented round has exactly one acyclic supersession chain covering all
   its rows, from its sole root to its sole terminal row. Disconnected chains,
   cycles, multiple roots or multiple terminal rows fail. Sorting is a renderer
   obligation; readers derive the graph without making physical row order a gate.
4. A row is marked `yes` exactly when no row supersedes it. Every predecessor is
   marked `no`. Thus a terminal row may itself supersede an earlier row; requiring
   its own `supersedes` cell to be `-` would incorrectly reject corrected closures.
5. The sole terminal row of the queried round has `closure === closureId` and
   `round === roundId`. An exact closure in a nonterminal row, a wrong round, an
   ID prefix, or text in any other cell cannot satisfy this conjunction.

An incoherent parsed index fails membership; a good-looking target row cannot
mask contradictory history elsewhere in the same index. This agrees with the
canonical renderer's rejection of an invalid closure set. No historical proof
is rewritten to make the index coherent: corrections append superseding records
and the registered renderer derives a fresh index.

## Consumer and refusal contract

`roundRecordIntegrity` retains its directory traversal, schema findings and
closed-only applicability. For each closed round it passes the cited closure
string and the actual round-directory identity (`name`) to the shared predicate.
No closure is resolved by coercing a missing/non-string field into meaningful
text. Missing index, absent/invalid citation, malformed rows, wrong identity,
nonterminal membership or ambiguity produce the existing
`ROUND_PHASE_CLOSURE_UNRESOLVED` finding at that round's `record.md`. Retain its
existing message form, including `(none)` for an empty citation. Do not mark the
record closed, read new proof inputs, or substitute a new refusal code.

Sealing calls the same predicate at its current ledger-precondition position.
A false membership result retains `ROUND_ARCHIVE_PHASE_LEDGER_MISSING`. Earlier
record, decision, proof and proof/record mismatch refusals retain precedence;
later gate/artifact checks remain mandatory. A terminal row is necessary, never
sufficient for sealing. No new successful write path or authority scope follows
from sharing the predicate.

Archive-history checking runs even when closure membership fails. Retain
`ROUND_ARCHIVE_MUTATED` findings, including a mutation later restored byte for
byte. Draft/scaffold history before first closure stays permitted; unrelated
later commits stay unrelated. Reading integrity writes nothing. A refused seal
leaves the active/closed locations, index, proof chain, closures and close state
unchanged. Successful sealing preserves its existing authorized lifecycle writes.

## Inspector acceptance matrix

Use minimal real canonical rows in the two owned test files. `C` denotes queried
`PC-0007`, `R` denotes `R-9999`; valid merged cells may use the existing SHA
fixture or `-` where historical rendering is the subject. First supply valid
proof/record/decision prerequisites when reaching the sealing ledger check.

| Case                                                                                              | Required membership result                                                              |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| One exact `C / R / - / SHA / yes` row                                                             | True.                                                                                   |
| `C` is the terminal successor of one or more `no` rows; all links resolve                         | True for `C`; false for every predecessor.                                              |
| Historical `merged_as: -`, or a supported non-`R-NNNN` round name                                 | True with the corresponding exact query; retain independent current seal preconditions. |
| Reordering otherwise coherent rows or unrelated narrative text                                    | Same result; renderer freshness still compares canonical bytes separately.              |
| Absent/empty index, header only, bare `C`, heading/prose mention                                  | False.                                                                                  |
| Longer closure/round cell, wrong round, or `C` only in `supersedes`                               | False.                                                                                  |
| `C` occurs only as `no`, even if a different terminal closure exists                              | False.                                                                                  |
| Four/six cells, missing delimiters, extra cell whitespace, CRLF, invalid ID/SHA or terminal token | False, including malformed data beside a valid target row.                              |
| Duplicate identical target, same closure in two rounds, two `yes` rows                            | False regardless of ordering.                                                           |
| A row is `yes` although another row supersedes it, or a sink is `no`                              | False.                                                                                  |
| Missing/cross-round supersession target, self-link, fork, cycle or disconnected chain             | False; no early-match shortcut.                                                         |

For every negative integrity case assert the existing unresolved code and path;
for sealing negatives assert the existing ledger refusal when reached. Exercise
the actual consumer entry points, not only a copied test predicate. Show that
both consumers use one implementation, with no substring fallback. Preserve
archive mutation/restoration, draft history, unrelated commits, immutable proof
bytes and refusal precedence assertions. The Inspector may add stronger cases
but never replace negative coverage with a permissive fixture or skip/todo/only.
The separate Inspector session owns tests; the Engineer implements against them.
Existing read-only seal-membership and canonical closure tests remain compatibility
references and are not a grant to modify additional paths.

## Validation and review boundary

TASK-0641 installs its task-local pinned toolchain/dependencies, builds and runs
`release:bootstrap` before its declared CLI `adrs`, `schemas` and `docs-links`
checks. It runs affected document formatting/lint applicability and whitespace
checks. Raw commands, results, counterexamples, exact candidate tree and patch
are retained in its own source coordinator; no runtime evidence is hand-authored.
These design checks do not establish implementation acceptance. Full Vitest,
coverage, RC gates and live providers are outside this dispatch.

After separate human review, a proposed single-file commit is
`docs(operations): define exact terminal closure membership`, attributed with
`Role: Architect` and the task/round/campaign identifiers. The document is docs
class in the implementation family, so `law(adr)`/`law(sensors)` are not valid
substitutes merely because the content specifies a contract. Local commit and
checkpoint ratification remain separately authorized. The human integrates
reviewed role contributions into the one cumulative remediation PR; no per-wave
PR, round closure, `merged_as`, external publication or downstream dispatch is
established by this document.
