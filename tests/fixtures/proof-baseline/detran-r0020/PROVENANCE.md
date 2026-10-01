# DETRAN proof-line baseline (OE-01 of CMP-0004)

Byte-exact copy of the adopter repository `aarusso-nyx/detran` at commit
`c848723c1ee9053233b7e08732c5b80bbe06d625`, the baseline its R-0020 contract
names, supplied for ADR-EVI-0002 (#168).

- `record/proofs/work/generic/*.jsonl`: 119 proof lines in rounds R-0001 to R-0019.
- `record/proofs/chain.json`: 106 chain records; 67 lines carry a direct
  `round_id`/`proof_sequence` anchor and 52 do not (R-0005 1, R-0007 38,
  R-0013 10, R-0017 3), with no duplicate anchor.
- `CTG-0002.md`: `work/rounds/R-0020/contracts/CTG-0002.md` at DETRAN commit
  `f7b0972b`, which fixes the 52 orphan identities and their line digests.

The chain records keep the absolute host paths of their `context.repo_root`
fields, because each feeds its record's manifest hash; the Owner waived the
host-path clause of OE-01 for this file on 2026-10-01. No credential is present.
Do not edit these files: the verification reads their exact bytes.

SHA-256 of every file at the time of copy:

```text
6f321a6e822c308ef75355e4109d23a3b04b625da2bcc02855d9f3fa2b7a4226  ./CTG-0002.md
ebaac78a57f913b8af1c4e251ab92d9f3151f0c7a4743704e35d30cb5c0722d0  ./record/proofs/chain.json
abfdf28d2b3bb0d3758c12a29f8fb3cbd95217ff1a652849024371eb52263fad  ./record/proofs/work/generic/R-0001.jsonl
a1caa68db542d03959c8c36a80a5ae02f83244e2edf04769515a70594a0349d5  ./record/proofs/work/generic/R-0002.jsonl
fc5f3bfad87015443ac4a748ce7cec25c6775c9644a8b107f88ca430a1855275  ./record/proofs/work/generic/R-0003.jsonl
84276e5b011f825470af1c0d3138621bbd6bb6c37f198646352b0d524f6fc9ef  ./record/proofs/work/generic/R-0004.jsonl
56bf1946dce19f34fc6e2cec9199dfd013317193384477eefe17e84bc1c27ae6  ./record/proofs/work/generic/R-0005.jsonl
3bd5c0fa634883ac9955a0f46818a51347980bbb1e309c82b70a32a419a751fb  ./record/proofs/work/generic/R-0006.jsonl
588a569f2a0591c48fe78a243de39a48f86a93d7508838fbac1b5c3920ddd2cd  ./record/proofs/work/generic/R-0007.jsonl
c2ae3cc24d27288c1890a8a3f595c4507e4b41db5b865606fb4b204e0a880c8f  ./record/proofs/work/generic/R-0008.jsonl
ff962ec4220ff2c35c90d9a046f3b075c4ebc861cd1c53e8b209601acdb63be8  ./record/proofs/work/generic/R-0009.jsonl
88faa3202290228a0cecd89791c759a2f3ea6e57ff62251b560cb3de35298d48  ./record/proofs/work/generic/R-0010.jsonl
222c19a8ef94ef5e9d680c467e013d5be3cf78811937ebfd0296b08bad63ce73  ./record/proofs/work/generic/R-0011.jsonl
46a2a30b8e7bbf7ee829b7901dc19ab6b7243f83ff385b4de1bde559285ac8c4  ./record/proofs/work/generic/R-0012.jsonl
59480ce2ae5576e795092a7aed14bb2980df1eb3dfaaed0380363e5a8bbbae4c  ./record/proofs/work/generic/R-0013.jsonl
8d68e9ea7b358d4588d93b537f74940ec580d2e4e7bb509f1710be53a921955d  ./record/proofs/work/generic/R-0014.jsonl
c35b384fc8b33fff14b9d05e5e8a6d34dd2b8d4f7d43e386a71e4a87218353c1  ./record/proofs/work/generic/R-0015.jsonl
d8b3e44d9853bb5d4130efac56760e2c32613c128c80bb5cbec624792659924c  ./record/proofs/work/generic/R-0016.jsonl
2a9905b9f8581be2c51c2b3ba5e2ef924005d4af4bc0329d914b1bdb0fe50a8f  ./record/proofs/work/generic/R-0017.jsonl
6739bfe6498b80ad10722eb1cc96df2b68138665b9f9003f3fcbf2be267b8575  ./record/proofs/work/generic/R-0018.jsonl
b49dfeb65d6a7520f504338c2dfba22fac451c237dbf08126c5174d2a0bbdce4  ./record/proofs/work/generic/R-0019.jsonl
```
