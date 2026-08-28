# Remote preflight contract

Amends the remote-workflow posture of [CI economy](../../adopters/ci-economy.md).
Status: proposed. Supersedes nothing; narrows one previously absolute statement.

## What changed and why

Before this amendment `scripts/check-workflows.mjs` accepted exactly two workflow
files and `ci-economy.md` stated without qualification that "Remote CI does not
rerun product tests." Read together they forbade any remote execution of lint,
typecheck, or tests in this repository.

That reading is stronger than the doctrine requires. The economy argument is
about the *attested RC closure*: heavy, database-backed, coverage-instrumented
nodes whose results are bound into a signed receipt. Re-running that closure
remotely costs real money and proves nothing the receipt does not already claim.
It is not an argument against cheap, unprivileged, non-attesting execution.

The absolute reading has a cost the doctrine never intended to pay. Every
quality gate in this repository executes on one maintainer's machine and reaches
CI only as an attestation which, as `ci-economy.md` says plainly, "does not prove
that the signer actually executed the commands." Nothing independent observes
whether lint, typecheck, or the local suite ran at all.

This amendment permits exactly one additional workflow, under a contract narrow
enough that it cannot become a second evidence path.

## The invariant, restated

Remote CI does not execute the attested RC closure, and remote execution never
produces, substitutes for, or supplements a candidate receipt.

Remote CI may execute the cheap local closure — `lint`, `typecheck`,
`test:local` — as a non-attesting preflight signal.

The distinction is provenance, not cost. A preflight run is a fast contradiction
check: if it fails, the candidate is wrong and no receipt should be signed. If it
passes, nothing is proven and no evidence is created. The ledger remains the sole
path by which any claim about this repository becomes evidence.

## Permitted workflow set

| File | Status | Role |
| --- | --- | --- |
| `devai-ledger-verify.yml` | required | Protected ledger verification |
| `release.yml` | required | Rehearsal and authorized publication |
| `pull-request-checks.yml` | optional | Non-attesting preflight |

`pull-request-checks.yml` is the only permitted addition. Any other file remains
`CI_WORKFLOW_SET_INVALID`. Absence of the preflight file is not a finding: the
repository's contract is unchanged for anyone who does not adopt it.

## Preflight contract

A conforming `pull-request-checks.yml`:

1. triggers on `pull_request` only — never `push`, `schedule`, or
   `workflow_dispatch`, so it cannot run on a protected ref;
2. declares `permissions: { contents: read }` and nothing else;
3. declares `concurrency` with `cancel-in-progress: true`;
4. runs every job on a Linux runner with an explicit `timeout-minutes`;
5. declares no `environment:` on any job, and references no `secrets` context —
   it therefore cannot reach the protected ledger environment, the verifier
   provenance value, or any package token;
6. pins every `uses` to a 40-character object, matching the pins the workflow
   contract already declares for checkout, setup-node, and pnpm setup;
7. checks out with `persist-credentials: false`;
8. invokes only `install --frozen-lockfile` and the allowed script closure —
   `build`, `lint`, `typecheck`, `test:local`;
9. never invokes an RC script (`test:coverage:rc`, `test:db:rc`, `test:e2e:rc`,
   `test:performance:rc`, `test:containment:rc`) or a release script;
10. contains no evidence, receipt, attestation, verifier, or signing token, and
    uploads no artifact — a preflight run leaves nothing behind.

Rules 1–7 make the job untrusted. Rules 8–10 make it non-attesting. Both
properties are checked mechanically; neither depends on reviewer vigilance.

## What this does not change

- The task-policy digest is unchanged. No RC node is added, removed, or reordered,
  so the existing ledger attestation stays valid.
- The published product is unchanged. `check --only ci-economy` already permits an
  adopter to run tests remotely — its binding rules are concurrency cancellation,
  no macOS on pull requests, no triple trigger, evidence-gate wiring, and
  `local_only_nodes` reachability. None of them forbids a preflight lane. The
  prohibition existed only in this repository's own checker and in one sentence of
  adopter prose.
- No schema, action, sensor, or authority contract is touched. The public action
  count stays at 48.
- `ci_economy.attested_rc.local_only_nodes` remains the adopter-facing mechanism
  for declaring what must never run remotely. This amendment makes DEVAI's own
  repository consistent with the mechanism it already ships.

## Honest limits

A green preflight is a weaker claim than a signed receipt and must never be
described as a stronger one. It proves that a GitHub-hosted runner executed three
commands against the pull-request head and they exited zero. It does not prove
the RC closure passed, does not observe the database, coverage, end-to-end,
performance, or containment lanes, and does not bind a tree.

What it does provide is the property the trust model currently lacks entirely:
one execution of the cheap gates that the signer did not perform and cannot forge.
