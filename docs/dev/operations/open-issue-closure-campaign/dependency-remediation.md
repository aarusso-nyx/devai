# TASK-0621 dependency remediation design

Current execution authority is the [standing Owner decision](execution-discipline.md).
It supersedes earlier preparation-only and repeated routine authorization text;
exact evidence, role boundaries, substantive unresolved contracts and actual
performance gates remain. The task-entry narrative below is historical checkpoint evidence. Its old
permission stops are superseded; inspections, contracts, failures, actual models
and original approvals remain preserved. It does not describe a fresh human
review of later candidates.

Role: Architect. Campaign CMP-0006, round R-0602, wave CTG-0621.
This is a source design and live dependency inventory, not an implementation or
an admission result. The Owner grants no waiver.

## Exact entry and authority

- Worktree: `/Users/aarusso/.codex/worktrees/cmp0006-task0621/devai`.
- Branch: `codex/R-0602-TASK-0621-dependencies`.
- Repository: `https://github.com/aarusso-nyx/devai.git`.
- Predecessor HEAD: `30ebdf41f1d73927696e43676c21d982afc60fe6`.
- Predecessor tree: `b222fbaff0701a573b6abf31964a664772cfe1c1`.
- Fetched `origin/main`: `180a122787193f9bdfce9b7f4cd5600e85ae7854`.
- Human checkpoint ratification: direct message `PASS. go ahead`, after the
  exact TASK-0611 commit/tree report. This satisfies the source dependency;
  it does not describe R-0601 as merged or closed.
- Original TASK-0621 entry prompt SHA-256:
  `c25b581563f5dcacaf8757cfa5e507fb4257d865fd475c8bf4275decef6b0893`.
- Full wave locks acquired in the Git common-directory source coordinator.
  The complete model-tier policy 1.0.0 map is pinned on that coordinator's
  TASK-0621 task object, with architect/high and ceiling architect. This is
  source coordination, not hand-authored runtime execution evidence.
- All 22 original issue identities, bodies, titles and paginated comments were
  refreshed at entry without decision drift. Twenty-one remain open; #253
  retains its observed closed/not-planned disposition.
- The original entry owned this document alone. The human mandate holder then
  approved the exact bounded amendment and three local docs/plan commits with
  the direct message `approved`. This contribution additionally owns only the
  six planning paths listed below; that grant expires at its Architect checkpoint.
  All packages, tests, scripts, policies and other campaign paths remain read-only.

## Live audit evidence

On `2026-10-02T01:51:24.411661+00:00`, `pnpm audit --json` completed with exit 1
under a 60-second subprocess bound. Node was v24.15.0 and pnpm was 9.15.0.
The audit used the exact unchanged predecessor manifests and lockfile after
`pnpm install --frozen-lockfile --ignore-scripts`.

Raw stdout is retained in the source coordinator at
`/Volumes/Thiamat II/stech/devai/.git/cmp-0006-source-pending/TASK-0621/audit.json`.
Its SHA-256 is
`98d80cdedc7891af71918e60b0e0dbc7e503305a84cae774df5b11c366fb4dd5`.
The file is diagnostic command output, not a registered reading or proof.
Freeze it with the source handoff; do not replace the rejected baseline with a
later passing audit. The Inspector embeds attributable minimal fixtures in its
owned test rather than inventing a separately owned fixture file.

Audit metadata reports critical 0, high 8, moderate 12, low 0 and info 0, over
438 dependencies. The advisory map contains 18 entries: eight high and ten
moderate. The two Vitest-family entries each contain two findings; the map-entry
count and metadata population are different measures. There are four distinct
high GHSA identifiers across fast-uri and three brace-expansion version lines.
`muted` is empty. These are measured results, not frozen acceptance counts;
every later candidate must rerun the live audit and inventory any new advisory.

The table reproduces IDs, installed versions, vulnerable/patched ranges and
distinct dependency-path counts from the audit. GitHub advisory links provide
primary upstream references; registry availability was separately checked.

| Audit ID | Upstream advisory                                                        | Severity | Installed coordinate     | Vulnerable range    | Patched range | Distinct paths |
| -------- | ------------------------------------------------------------------------ | -------- | ------------------------ | ------------------- | ------------- | -------------- |
| 1240104  | [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) | high     | `brace-expansion@1.1.18` | `<1.1.20`           | `>=1.1.20`    | 27             |
| 1240105  | [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) | high     | `brace-expansion@2.1.4`  | `>=2.0.0 <2.1.6`    | `>=2.1.6`     | 119            |
| 1240107  | [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) | high     | `brace-expansion@5.0.9`  | `>=4.0.0 <5.0.11`   | `>=5.0.11`    | 7              |
| 1240108  | [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) | high     | `brace-expansion@1.1.18` | `<1.1.19`           | `>=1.1.19`    | 27             |
| 1240109  | [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) | high     | `brace-expansion@2.1.4`  | `>=2.0.0 <2.1.5`    | `>=2.1.5`     | 119            |
| 1240111  | [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) | high     | `brace-expansion@5.0.9`  | `>=4.0.0 <5.0.10`   | `>=5.0.10`    | 7              |
| 1239943  | [GHSA-qw65-cvwx-89v3](https://github.com/advisories/GHSA-qw65-cvwx-89v3) | high     | `fast-uri@3.1.6`         | `>=3.0.0 <3.1.7`    | `>=3.1.7`     | 154            |
| 1239946  | [GHSA-58mr-gqgx-xq4g](https://github.com/advisories/GHSA-58mr-gqgx-xq4g) | high     | `fast-uri@3.1.6`         | `=3.1.6`            | `>=3.1.7`     | 154            |
| 1193684  | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) | moderate | `@vitest/mocker@4.1.10`  | `>=2.1.0 <4.1.11`   | `>=4.1.11`    | 10             |
| 1240100  | [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) | moderate | `brace-expansion@1.1.18` | `<1.1.21`           | `>=1.1.21`    | 27             |
| 1240101  | [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) | moderate | `brace-expansion@2.1.4`  | `>=2.0.0 <2.1.7`    | `>=2.1.7`     | 119            |
| 1240103  | [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) | moderate | `brace-expansion@5.0.9`  | `>=4.0.0 <5.0.12`   | `>=5.0.12`    | 7              |
| 1240091  | [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) | moderate | `fast-uri@3.1.6`         | `>=3.0.0 <3.1.8`    | `>=3.1.8`     | 154            |
| 1239948  | [GHSA-rpw4-54j3-4h4q](https://github.com/advisories/GHSA-rpw4-54j3-4h4q) | moderate | `ip-address@10.5.0`      | `<=10.5.0`          | `>=10.5.1`    | 2              |
| 1239949  | [GHSA-2vr4-cq9g-pvrc](https://github.com/advisories/GHSA-2vr4-cq9g-pvrc) | moderate | `ip-address@10.5.0`      | `>=10.2.0 <=10.5.0` | `>=10.5.1`    | 2              |
| 1240097  | [GHSA-j6r3-76f7-8jcv](https://github.com/advisories/GHSA-j6r3-76f7-8jcv) | moderate | `ip-address@10.5.0`      | `<=10.7.0`          | `>=10.7.1`    | 2              |
| 1240098  | [GHSA-h3mg-xc3c-68pw](https://github.com/advisories/GHSA-h3mg-xc3c-68pw) | moderate | `ip-address@10.5.0`      | `<=10.7.0`          | `>=10.7.1`    | 2              |
| 1193683  | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) | moderate | `vitest@4.1.10`          | `>=2.1.0 <4.1.11`   | `>=4.1.11`    | 9              |

## Affected dependency paths

These shortest paths locate all affected module/version groups. Full populations
are preserved in the raw audit, rather than inferred from a single example.

| Coordinate             | Representative installed dependency path                                                                                                                                                | Distinct paths   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| fast-uri 3.1.6         | root → ajv 8.20.0 → fast-uri 3.1.6; also packages/cli → ajv 8.20.0 → fast-uri 3.1.6                                                                                                     | 154 per advisory |
| brace-expansion 1.1.18 | root → eslint 9.39.5 → minimatch 3.1.5 → brace-expansion 1.1.18                                                                                                                         | 27 per advisory  |
| brace-expansion 2.1.4  | packages/cli → minimatch 9.0.9 → brace-expansion 2.1.4                                                                                                                                  | 119 per advisory |
| brace-expansion 5.0.9  | root → typescript-eslint 8.65.0 → @typescript-eslint/typescript-estree 8.65.0 → minimatch 10.2.5 → brace-expansion 5.0.9                                                                | 7 per advisory   |
| vitest 4.1.10          | root → @vitest/coverage-v8 4.1.10 → vitest 4.1.10                                                                                                                                       | 9                |
| @vitest/mocker 4.1.10  | root → vitest 4.1.10 → @vitest/mocker 4.1.10                                                                                                                                            | 10               |
| ip-address 10.5.0      | root → @cyclonedx/cyclonedx-npm 6.0.1 → libxmljs2 0.37.0 → node-gyp 11.5.0 → make-fetch-happen 14.0.3 → @npmcli/agent 3.0.0 → socks-proxy-agent 8.0.5 → socks 2.8.9 → ip-address 10.5.0 | 2 per advisory   |

The second ip-address path inserts @cyclonedx/cyclonedx-library 10.1.1 before
libxmljs2. Runtime CLI ajv/minimatch paths are included; development dependencies
are not dismissed as waivers.

## Proposed bounded dependency changes

The separate Engineer session can perform these manifest/lockfile changes after
its Inspector predecessor is ratified. No dependency is changed here.

| Current installed line           | Candidate target | Manifest treatment                                                                                                                                                                                                                            |
| -------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fast-uri 3.1.6                   | 3.1.8            | Retarget both existing root overrides for selectors fast-uri@3.1.4 and fast-uri@3.1.5; confirm no vulnerable resolution survives.                                                                                                             |
| brace-expansion 1.1.18           | 1.1.21           | Retarget existing brace-expansion@1.1.16 override within the 1.x line.                                                                                                                                                                        |
| brace-expansion 2.1.4            | 2.1.7            | Retarget existing brace-expansion@2.1.2 override within the 2.x line.                                                                                                                                                                         |
| brace-expansion 5.0.9            | 5.0.12           | Retarget existing brace-expansion@5.0.8 override within the 5.x line.                                                                                                                                                                         |
| vitest and @vitest/mocker 4.1.10 | 4.1.11           | Raise root Vitest minimum and align exact @vitest/coverage-v8 to 4.1.11; raise the CLI Vitest minimum to the same patched floor if needed for stable importer resolution. Resolve mocker through Vitest, not a new direct runtime dependency. |
| ip-address 10.5.0                | 10.7.1           | Use an affected 10.x selector override if the existing socks range does not select the patched release; preserve CycloneDX and the native dependency chain.                                                                                   |

All seven named candidate package versions, including @vitest/coverage-v8,
were confirmed available with `pnpm view <package>@<version> version
 dist.integrity engines --json` at this task entry. Each lookup was bounded at
30 seconds. Node 24 satisfies the returned brace-expansion 5.x and Vitest engine
ranges. Availability and advisory range coverage do not prove compatibility;
installation, package checks and the post-change audit remain Engineer gates.

fast-uri 3.1.7 and brace-expansion 1.1.20/2.1.6/5.0.11 address the measured high
ranges but leave associated moderate findings. The proposed slightly later patch
versions cover those too. Vitest and ip-address are moderate-only groups at this
snapshot. Include their bounded updates because the declared downstream
`pnpm audit --json` command otherwise still exits nonzero. Do not replace it with
`--audit-level=high`, suppress findings, mute advisories or alter thresholds.

Keep DEVAI release versions, unrelated overrides, public actions, optional providers,
vendored verifier bytes and workspace package boundaries unchanged. Regenerate
pnpm-lock.yaml with the pinned package manager; inspect resolution drift and
revalidate from a frozen install. If a patched target or new advisory requires a
major upgrade, replacement or additional owned path, stop for an exact amendment.

## Actual sensor and concrete counterexamples

The current registered sensor is `security_scan`, F2:T6. Its canonical emitter
is `packages/sensors/src/security-scan.ts`, invoked by the CLI sense adapter.
The historical issue's dependency-vulnerability wording does not create a new
sensor or a rename. Its default high thresholds remain PASS maximum 0 and REVIEW
maximum 5; any positive high population is non-PASS under those defaults.

Source inspection at this exact HEAD shows `summarise` returns five zeros for
unrecognized, null or absent summaries. Numeric fields missing from a metadata
summary are also coerced to zero. `runAudit` accepts parseable JSON without
checking process completion or a recognized complete audit shape. Consequently,
`{}`, `{ "metadata": { "vulnerabilities": {} } }`, and a null metadata summary
with no valid fallback reach PASS. This is a source-traced defect, not yet an
Inspector-authored runtime counterexample.

Existing tests explicitly preserve the unsafe assumptions:

- `security-scan-shape-boundaries.test.ts` expects PASS for null summaries with
  absent/null fallback. It also ignores malformed fallback members.
- `mutation-wave8-security-scan.test.ts` uses an empty severity summary as a clean
  audit in the preferred-command and alternate-tool tests, and a partial summary
  at the high-threshold boundary.
- `security-perf-depth.test.ts` uses empty summaries for fallback success and
  partial summaries for threshold grading; its npm-shape test ignores malformed
  members. Its unrelated performance cases must be preserved.

The Inspector must exercise the real emitter through its controlled process
seam and retain all existing cases. Use explicit complete five-severity summaries
for genuinely successful pnpm fixtures. Convert unsafe PASS expectations into
non-PASS negative cases; do not delete tests or weaken high/critical assertions.
The new campaign file must record audit provenance and cover: complete clean
output, measured high output, critical output, empty/partial/wrong-shaped output,
invalid severity counts (negative, non-finite where representable, fractional,
string), malformed npm entries, failed/killed/timed-out processes, invalid JSON,
and missing tools. Preserve actual command, selected tool, timestamp and failure
reason in the reading. A normal audit exit 1 with valid vulnerability output is
valid evidence of findings, not a tool-availability failure. A tool/process error
or incoherent exit status must not manufacture a clean reading.

The Engineer should validate audit completion and supported object shapes before
threshold grading. Missing/invalid evidence yields UNKNOWN or another justified
non-PASS result with a diagnostic; a valid alternate-tool audit may establish a
result only with explicit provenance. An empty valid npm v2 vulnerability map can
represent a clean audit when its process and shape are valid. Distinguish that
from an absent map or incomplete pnpm summary. Do not silently discard malformed
entries or allow invalid metadata to hide a valid high population. Preserve
ordinary valid npm/pnpm support, the controlled 60-second process bound, fallback
behavior, public identity and configurable threshold contract. This strengthens
evidence validation without changing the accepted thresholds or adding a waiver.

## Owner-approved scope amendment before downstream execution

The pre-amendment TASK-0623 boundary owned only package.json, pnpm-lock.yaml and
packages/cli/package.json. It could not repair the source defect. TASK-0622 owned
only the new campaign test, so it could not repair the conflicting existing fixtures.
The task stop rule requires a bounded amended plan for an undeclared path or test
weakening. The human mandate holder approved this exact amendment; this Architect
contribution records it without implementing the separate source/test work.

The approved additional implementation/test paths are exactly:

| Task/role             | Additional owned path                                              | Bounded purpose                                                                                                                             |
| --------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| TASK-0623 / Engineer  | packages/sensors/src/security-scan.ts                              | Validate audit process/shape/count completeness and retain non-PASS diagnostics; preserve sensor identity, thresholds and command contract. |
| TASK-0622 / Inspector | packages/sensors/tests/unit/security-scan-shape-boundaries.test.ts | Preserve shape cases while correcting incomplete-evidence PASS expectations and rejecting malformed members.                                |
| TASK-0622 / Inspector | packages/sensors/tests/unit/mutation-wave8-security-scan.test.ts   | Replace incomplete successful fixtures with complete summaries; retain command/environment, fallback and threshold assertions.              |
| TASK-0622 / Inspector | packages/sensors/tests/unit/security-perf-depth.test.ts            | Use complete security fixtures and retain malformed-output negatives; preserve every performance case.                                      |

Expand the common CTG-0621 lock set by these same four paths. Retain all existing
owned paths and forbidden sibling scopes, separate role sessions, human review,
one cumulative PR and final green acceptance. Run the three existing focused
security files as added acceptance commands for Inspector and Engineer, alongside
the new campaign file and live audit. Inspector red counterexamples remain
source-checkpoint evidence only, never passing final admission.

The approved Architect planning amendment changes only these exact
files: `product/campaigns/CMP-0006-open-issue-closure/campaign.json`, the three
`prompts/TASK-0621.md`, `prompts/TASK-0622.md`, `prompts/TASK-0623.md` under that
campaign, `docs/dev/operations/open-issue-closure-campaign/rounds-and-waves.md`
and `product/campaigns/CMP-0006-open-issue-closure/artifact-manifest.json`.
Keep deliverables synchronized with the source validation repair, add the four
locks to all three prompts, and update prompt hashes and the artifact manifest
from actual bytes. The amendment also records the accepted bounded moderate
patches needed by the unchanged full-audit gate. Proposed commits stay separate:
`docs(operations)` for this report, `plan(campaign)` for the campaign/prompt/
manifest amendment, and `docs(operations)` for the wave-guide synchronization.
The direct human approval authorizes these three local commits and this exact
planning amendment. It does not ratify a future commit/tree or authorize any
Inspector/Engineer dispatch or external effect.

The original scope-gap stop froze the draft and released its five wave locks.
After approval, the nine amended wave paths plus the six one-time planning paths
were locked before further writes. After an amended
Architect checkpoint is committed and human-ratified, freeze and release its
wave locks. A separately initiated Inspector session derives from
that exact commit/tree. This Architect session never changes role, dispatches
workers, starts the Engineer task or fabricates merged_as/round closure.

## Input identity and validation

The audit and defect analysis bind to these unchanged input bytes:

| File                                                                 | SHA-256                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `package.json`                                                       | `598e1fa1c00ba5bc4eb132ca6e6756122e185438eb806e47f0cf0e94c4daf314` |
| `pnpm-lock.yaml`                                                     | `724059da14a4d04b9fcc1fd857848523faecbe9c5f6ea18d1b5d567fb02af8d1` |
| `packages/cli/package.json`                                          | `660e8f4bfca5ff1d7227bb112faeef0b690a0e07e3454b6efee83c16f7974abf` |
| `packages/sensors/src/security-scan.ts`                              | `2c53d0d441b5d0737a00d7c9abdb42b29125912b6d3bb3cefaa0166a34e5be77` |
| `packages/sensors/tests/unit/security-scan-shape-boundaries.test.ts` | `50d3a7c743a3cf61610ec67823b4a7e975f5e25080aa362453deb697c81b3571` |
| `packages/sensors/tests/unit/mutation-wave8-security-scan.test.ts`   | `967acb7b3c4cd1f87b5b768c6f5b62d1d29b9b090a2e36ec6b0677f08f042c8d` |
| `packages/sensors/tests/unit/security-perf-depth.test.ts`            | `d790daef5019a4c55578b0500b6142ab58596e11757795e113d1aece9bc2a42b` |

Build and release:bootstrap completed successfully in this exact checkout before
using the bootstrap CLI. The TASK-0621 acceptance commands are:

```bash
node .devai/state/pr-bootstrap/cli/bin.js check --only adrs --format json
node .devai/state/pr-bootstrap/cli/bin.js check --only schemas --format json
node .devai/state/pr-bootstrap/cli/bin.js check --only docs-links --format json
```

All three returned exit 0 and verdict PASS: ADR semantic resolution scanned 104
files with no errors; schema validation covered 116 canonical schemas with no
findings; documentation validation reported zero broken links. The final
document hash/candidate identity and actual command outputs are retained with
the source coordinator handoff. The baseline audit's
exit 1 is preserved as measured remediation input. No full Vitest, coverage,
RC, package publication, push, PR, merge, issue update or other external effect
is authorized by this design. Verdict: inventory and bounded design prepared;
the approved scope amendment is recorded; downstream source/test execution waits
for human ratification of this exact Architect commit/tree and a separate
Inspector session.
