# Independent installed qualification and remaining U1/B1 scope

This additive phase follows the human's authorization of DEVAI internal work and
publication as 2.8.0. Earlier approval packets, their historical holds and evidence
remain unchanged. DETRAN and downstream execution remain excluded. The current
assembled P1 package is a qualification candidate, not completed U1/B1 delivery.

## Real installed tests

`packages/cli/tests/installed/authority_policy_review_pty.py` invokes the actual
installed bin in independent Node processes. It uses real OS PTYs for stdin,
stdout and stderr, without importing workspace modules or replacing resolver,
publisher, authority or TTY behavior. The orchestrator supplies the independently
staged installation through `DEVAI_INSTALLED_PACKAGE`; the harness does not pack,
build, install or select a mutable registry version. Disposable adopter fixtures
start with the preserved predecessor pin/project/pointer and an actual Git HEAD
and index. Evidence and PTY transcripts live outside the adopter and package.

| Check | Required observation |
| --- | --- |
| Package identity | Installed public `--version` equals its package manifest version; orchestrator supplies tarball SHA/size, source/assembly identity and dependency custody |
| Public help | Actual `init bind --help` advertises both exact review selectors |
| Legacy branches | Default bind, full bind and upgrade dry plans succeed without changing any fixture file, including Git state |
| Pipe refusal | Review with piped streams returns terminal-required exit2 before creating any output |
| Live READY | Complete public review envelope and immediate prompt are visible before input; whole-plan canonical digest and displayed base64 size/SHA independently recompute; fixture inventory unchanged |
| EOF cancellation | Real PTY EOF yields exactly one terminal cancellation after READY, exit0 and no file change |
| Wrong token | Exact-length wrong confirmation yields refusal exit2 without any file change |
| Existing target | Foreign target refuses before READY and remains byte-identical |
| Real precursor/create | While review waits, a separate actual installed `init bind --constitution --write` performs the precursor. Exact confirmation creates only the displayed policy bytes; all other files equal the post-precursor inventory |

The runner is the unchanged `scripts/process/validation-runner.mjs`; no timeout
configuration or existing test is changed. The 20-second test-protocol deadline
is a bound on receiving output, not a modification to product expiry. PTY streams
are deliberately combined by the kernel; earlier source-boundary tests separately
prove stdout/stderr channel ownership. Whole-host syscall tracing is not claimed.

First actual tarball candidate: manifest2.8.0, digest
`cd761fb4f64807bb88450b2b5010a4067652b98d9c1d53552c14ec6efff911a0`.
Its CLI still reported2.7.1 because build preceded version advancement. The first
run retained in `installed-01-first.txt` has3PASS/2FAIL: help, legacy dry branches
and pipe refusal pass; both READY attempts refuse INPUTS_UNSUPPORTED. This is a
rejected package identity baseline, not installed acceptance. Root rebuilds and
supplies a new immutable candidate before rerun.

## Additional P1 qualification

The previous source-public suite's201PASS/2preserved installed-asset failures and
real two-process no-replace race remain historical. A successful installed PTY
run will close package/public transport and actual precursor/byte identity gaps,
not every independent fault combination. Installed qualification still needs:

- Fresh review from an already exact successor now passes in the real installed extension run, without predecessor restoration.
- Full write/default/upgrade compatibility and receipt/consent/adapter branches,
  using existing installed-tarball smoke and migration tests unchanged.
- Two real installed CLI processes now pass both-READY-before-precursor contention; independent exact confirmations produce one winner and one refusal, preserving exact winner bytes/inode.
- Real installed post-link uncertainty under an isolated filesystem fault
  facility. No production injection switch, loader hook or rebuilt fixture
  package will be introduced to claim this result. Existing real-publisher/source
  public controlled-fault proof remains separately identified.
- Actual five-minute expiry, interruption/process death, stale package/source
  changes and missing-role/selector variants at the installed public boundary.
  Existing deterministic private/source tests are supporting evidence, not a
  replacement for package qualification.

## U1 remains a separate implementation

The controlling implementation-release plan requires supported public
`evidence record --recover-divergent-anchor ...` under accepted ADR-EVI-0006.
At the entry observation the searched runtime/schema paths contained neither that option nor
`recovered_from`; separate U1 implementation is now in progress and must have its own final verdict. P1 policy review does not implement either. The original U1
fourteen-path envelope includes four Engineer runtime files, two Architect
schema/docs files, three new Inspector test files and five existing regression
additions. Independent authentic RED must precede implementation and IA-001–008
must pass afterward.

Those cases require the real eight-line fork/orphan fixture with full epochs;
source-entry/raw-line/common-prefix custody; newest/historical/original-anchor
refusals; actual serialized expected-head concurrency and idempotent retry;
symlink/path/role/consent refusal; append-only immediate-head sequence and
manifest-bound source-chain/physical-line artifacts. Source/line replacement,
crash/uncertainty, actual installed help/schema/behavior and exact-head CI are
additional required evidence. Neither a flattened chain nor a recovered anchor
can substitute for the preserved original direct-anchor source.

## B1 remains a separate implementation

The plan's B1-I-r2 closure is broader than P1 and the accepted normative contract:
logical git-index identity/selectors; trusted host classification and capability;
decision/resolver/adapter dispatch; action/effect schemas and generated consumers;
public reconciliation/bootstrap routing; complete chain/epoch selection events;
staged-source inventory admission with actual HEAD/index tokens; packaged runtime
roster/validator closure; linked-worktree, stale-token, retry, race/crash and final
clean-mode assurance. Source-authority policy creation supplies none of those
runtime operations by itself.

B1's multi-output phases must have explicit predecessor/source/head/index-bound
tokens. Inspector proof authority and Architect inventory/export authority remain
distinct. Failure cannot roll back appended proof history, silently stage source,
substitute fs/proc authority for typed Git-index authority, or claim final clean
native acceptance from a diagnostic bootstrap. A fresh exact consumer/path and
state/output table is needed before runtime implementation is judged complete.

## Release acceptance

DEVAI publication authorization now exists, but technical release gates still
need implementation, independent review, actual bound candidate, unchanged
checks, exact-head CI, final source/tree/version, signed artifact/certification
and protected lifecycle receipts. Package publication, registry/GitHub release
observation and actual installed U1+B1 qualification remain distinct outcomes.
No DETRAN dependency update, proof recovery, task/round action or downstream
execution is part of this Inspector work.

## Current independent results

Actual installed02 tarball SHA256
`0d829a6103141dfd54ec5435d0fc59d5b194f7c75c9e4268356ce004b0396bb7`
passes ten real-package tests in `installed-02-extended.txt` (25.070 seconds).
It is the candidate prepared before subsequent U1/B1 changes, not the final
release artifact. Ordinary PTY ECHO is disabled to keep input/control echo out of
JSON streams; all three descriptors remain genuine terminal descriptors. The
first installed02 run's sole failure was a harness parser confused by kernel EOF
echo before the valid cancellation JSON; its raw evidence remains intact.

The exact predecessor fixture files now come from immutable source commit
`2df84159caabf869b866fb2a05e5b06be83295fb`, whose three blob digests independently
match the earlier successful fixtures. This prevents subsequent real self-binding
from silently changing future test inputs. No old result has been overwritten.

The extended create READY plan is
`fb114ceb2610657b13eed4e6117ab21799d638c1f6229b060b630aa1a8f11409`,
artifact SHA256
`b5f4f03d3371c95142ecce29b8a9a694df65d586d8959d785dced2c8a9d83a39`,
size71,367bytes. Independent real CLI race PIDs97172/97436 return6/0; winner
SHA256`0155fb68419d45224cdfb692179fa8ed43d5feded7b5b9f3eb4a828e3adf05db`,
device16777233/inode1116603601. Both READY observations precede the registered
precursor. These are disposable test effects, separate from root's real binding.

The original complete133-record/134-file pre-ratification population is frozen in
`packages/schemas/tests/fixtures/adr-pre-280-ratification.json`, protected by a
literal SHA assertion. Its original proposed/non-effective642-subject assertions
remain exact. A separate current test requires approved GOV0027/AUT0008 accepted
with exact original subjects and no other prior record changed. Authentic
pre-ratification17PASS/1FAIL and post-ratification28PASS/0FAIL (governance plus
original binding suites) are retained. Two initial fixture setup errors (formatter
hash mismatch and missing local variable) are retained separately and are not
claimed as product/security findings.

The additive B1 review is `release-280/b1-design/inspector-review.json`: the50-path
candidate needs18 concrete reader/type paths, explicit Owner-origin approval
custody, exact output/lock/object recipes and schema/index-format closure before
Engineer mutation. It is an independent design finding, not a B1 runtime verdict.

The four original canonical-selection/Article6/proof-index/materializer suites
pass unchanged:67PASS/0FAIL in `actual-binding-historical-contracts.txt`, after
actual registered self-binding and ADR ratification. This changes current standing
without rewriting any historical held result. Scope review and fixture test
changes pass `git diff --check`; the modified governance test and frozen JSON
pass ESLint/Prettier. Python source parses successfully with the standard parser.
