# REC-B1-A-P1 output-boundary amendment — proposed, not authorized

The approved 19 human-authored paths plus one additional generated path cannot
complete the public two-phase protocol. The existing
`packages/cli/src/action-output.ts:277–351` captures both streams until the handler
Promise settles, then emits one action envelope. READY and the confirmation prompt
would remain invisible while awaiting input. Private handler tests alone do not
exercise this wrapper. No raw descriptor, `_write`, global monkeypatch, alternate
format or bypass is admitted as a substitute.

## Exact additional paths

1. Engineer: `packages/cli/src/action-output.ts` — existing 12,516 bytes,
   SHA-256 `11da5e163aa687ce01130367bf8b2715c19f56c5e8ef50bbc4e9c18459791c8d`,
   base blob `a89e3717947cb05cebca920caccb5062dec6aeca` at
   `2df84159caabf869b866fb2a05e5b06be83295fb`.
2. Inspector: NEW
   `packages/cli/tests/unit/action-output-authority-policy-review.test.ts`.

This would increase the current inventory from 20 to 22 distinct implementation
paths (19 to 21 human-authored paths). Existing approved paths may be updated only
as needed for this protocol, its proposed ADR subjects/catalogue checksum, bounded
CLI narrative and assertions. Generated error-reference changes remain restricted
to the unchanged generator. Another required path or capability needs a further
exact amendment.

## Bounded requested effect

Admit an invocation-local, non-replayable two-phase output transport only for the
exact paired review selectors on `init bind`, JSON, direct Architect, `--write`,
exact target and real terminal. Emit one existing-format READY action envelope
before awaiting input and display its exact confirmation prompt immediately on
stderr. Emit one terminal completion/cancellation/refusal envelope. Transport
access cannot issue a grant, publish a file, supply a canonical source, replay a
plan or enable another action. Restore stream/exit handling on every settlement
and preserve ordinary action-envelope behavior. The live public route remains
closed until this boundary is implemented and independently verified.

## Required independent tests

Use the actual `attachActionOutputBoundaries` wrapper, not a mocked wrapper:

- Genuine RED: READY and prompt are buffered while the handler Promise is pending.
- After implementation, READY is observable and schema-valid before any input;
  stderr prompt is visible while pending; no filesystem or tracking effect occurs.
- Exact confirmation, cancellation, EOF, interruption, timeout, thrown exception,
  asynchronous rejection, publication uncertainty and cleanup failure each emit an
  honest single terminal envelope and restore streams, exit and authority scope.
- An unowned/foreign/cloned/reused transport, wrong action, selector, format or
  declaration cannot activate streaming or bypass the existing boundary.
- All existing ordinary action output, refusal classification and exit behavior
  remain unchanged. Run the smallest relevant envelope/router/async-finalization
  checks and the unchanged error-reference generator check.

The original P1 acceptance matrix remains binding for the already approved paths.
Complete its remaining private/integrated fixture counterexamples and current
public RED cases; the additional transport tests do not waive any row. Installed
package build/qualification and live precursor custody remain separate gates.

No accepted ADR, constitutional/policy/schema/registry permission, filesystem
publisher primitive, receipt TTL, runtime roster or release-host API changes are
included. No dependency, package build, full RC/coverage run or graph rebuild is
included.

## Approval language for later review

“Approve the REC-B1-A-P1 output-boundary amendment for the two exact additional
paths and bounded output effects above, with independent disposable-fixture tests.
Preserve historical checks and return exact public preview evidence before live
use. Keep binding, integration, U1/B1 runtime, release and DETRAN effects held.”

This text is a proposal. The current user approval does not authorize these
additional writes. Installed-package qualification, live preview, precursor
binding, policy binding, source publication/integration, U1/B1 operations, release
and DETRAN effects remain held independently of this proposed amendment.
