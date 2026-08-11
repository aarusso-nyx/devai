# Local test evidence

Local task results live in the ignored content-addressed check cache. Only PASS results with an
exact matching task key and complete dependency closure are reusable.

```bash
devai check --local --task-plan --format json
devai check --local --run --as-role inspector --write --format json
devai check --local --status --format json
```

The local profile is a complete cheap cached closure and is never attestable. Run the affected or
RC profile from a clean exact Git tree when candidate evidence is required. A successful run writes
an **unsigned** receipt to
`.devai/state/check-cache/v1/receipts/<digest>.json`; its exact task results are under
`.devai/state/check-cache/v1/results/`. Both paths are ignored local state.

## Protected export and signing

Signing is not a DEVAI CLI action. Use `src/export-cli.js` from the independent
`devai-nyx/devai-verifier` checkout at the exact immutable commit pinned in
`.github/workflows/devai-ledger-verify.yml`. Keep the verifier checkout, toolchain and environment
maps, Ed25519 keys, signer ID, and output directory outside the candidate repository:

```text
node src/export-cli.js \
  --repo /exact/candidate \
  --receipt /exact/candidate/.devai/state/check-cache/v1/receipts/<digest>.json \
  --results-dir /exact/candidate/.devai/state/check-cache/v1/results \
  --profile rc \
  --commit <exact-commit> \
  --tree <exact-tree> \
  --toolchain /protected/control/toolchain.json \
  --environment /protected/control/environment.json \
  --private-key /protected/control/ed25519-private.pem \
  --public-key /protected/control/ed25519-public.pem \
  --signer-id <approved-signer-id> \
  --output-dir /protected/evidence/<exact-commit>
```

For an affected-profile receipt, use `--profile affected --base <exact-ancestor-commit>`. The
exporter independently rebuilds the committed `test-tasks.json` selection, verifies the unsigned
receipt and exact digest-named results, and only then signs. It atomically produces
`envelope.json`, `task-policy.json`, `trust-store.json`, `manifest.json`, and `results/*.json`.
An absent allowlisted environment key is represented as `null`, not silently dropped.

## Remote boundary

The GitHub workflow receives the envelope, result archive, task policy, and trust store through
the protected `DEVAI_LEDGER_*_B64` secrets and receives the expected policy digest through
`DEVAI_LEDGER_POLICY_DIGEST`. Candidate files do not control these inputs. CI checks out the exact
candidate and the independent verifier at immutable commits, then verifies repository, commit,
tree, policy, signer allowlist/revocation state, and required-node completeness. It does not run
the product test commands.

Trusted local attestation is deliberately limited: it makes tampering and identity mismatch
detectable, but cannot prove that a trusted signer executed the commands. Failed or incomplete
verification is a hard rejection, never an invitation to silently reuse evidence.
