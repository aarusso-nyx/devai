# Proof-line baseline fixtures

Fixtures for the line-level cross-check of `evidence verify --scope chain` under
[ADR-EVI-0002](../../../law/adr/ADR-EVI-0002-proof-line-anchoring.md). The anchoring rules, the
anchor baseline, and the historical declaration they exercise are described in
[`docs/reference/cli/evidence-verify.md`](../../../docs/reference/cli/evidence-verify.md).

## `detran-r0020/`

The DETRAN adopter baseline supplied for OE-01 of CMP-0004 (#168), byte-exact; its provenance and
the SHA-256 of every file are in [`detran-r0020/PROVENANCE.md`](detran-r0020/PROVENANCE.md).

- `record/proofs/work/generic/R-0001.jsonl` to `R-0019.jsonl`: 119 proof lines.
- `record/proofs/chain.json`: 106 chain records. 67 lines carry a direct
  `round_id`/`proof_sequence` anchor and 52 are orphaned (R-0005 1, R-0007 38, R-0013 10,
  R-0017 3), with no duplicate anchor. The chain is cryptographically valid.
- `CTG-0002.md`: the adopter contract that fixes the 52 orphan identities by canonical path,
  sequence, and line digest, and the digest of their canonical list.

Inspector acceptance IA-001 runs against this fixture: verification fails before the historical
declaration with every one of the 52 orphans listed, and passes after an appended declaration,
itself directly anchored with a digest and authorized by the Architect, with the 52 lines
labelled `historical gap acknowledged`.

## Rules for tests

- Never edit a file under `detran-r0020/`; the verification reads their exact bytes, and the
  baseline is not an allowlist.
- A test that runs a verification copies the fixture's `record/` tree into a temporary directory
  first: the first verification writes `record/proofs/anchor-baseline.json`, and declarations,
  crash simulations, and byte flips are appended or applied only to that copy.
- The declaration is built at test time in the copy, from the `CTG-0002.md` tables and the
  baseline cutoff of that run; no declaration or baseline is committed here.

Used by `packages/evidence/tests/proof-line-anchoring.test.ts` and
`packages/cli/tests/unit/evidence-verify-anchors.test.ts`.
