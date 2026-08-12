# rc.2 assessment convergence record

This erratum is the agreed factual basis for rc.3 remediation. The rc.2 readiness
verdict remains **NOT READY**, but four claims in the original assessment require
correction or narrower wording.

## Corrections

- Remove SYN-5 and every repin requirement derived from it.
  `pnpm/action-setup@7088e561eb65bb68695d245aa206f005ef30921d` is the authentic
  immutable annotated `v4.1.0` tag object. It peels to commit
  `a7487c7e89a18df4991f7f222e4898a00d66ddda`. An annotated-tag object and its
  peeled commit are different valid Git identities; absence of the tag object from
  a commit-only lookup is not evidence of unauditable code.
- Replace approximate test counts with the rc.2 baseline measured by Vitest
  collection: **104 files and 899 tests**.
- State the DB evidence as: **DB was disabled in the attested task policy**. The
  reproduced policy digest proves the allowlisted DB environment values were absent;
  it does not independently prove what process execution occurred.
- Treat legacy Pages deployment failure and package delete/republication behavior as
  open experimental claims. Settle them only with disposable Pages and package-version
  experiments; do not use the public rc.2 artifacts as test subjects.

## Confirmed findings retained

The bootstrap capability/policy mismatch, adopter check policy lookup, unbound-first
UX, pnpm setup conflict, normalized-manifest/SBOM failure, byte-nondeterministic rc.2
packing, DB-policy precondition gap, cross-package affected-selector gaps, bind-source
resolution, error-envelope model, empty build population, documentation drift, mutable
tag/assets, and same-custody verifier limitations remain in the rc.3 remediation scope.

## Claims that remain external gates

Pages mode, protected environments, immutable Releases, `v*` tag rules, signed release
tags, package publication, registry digest verification, deployment, disposable
experiments, and the public `devai-rc-demo` proof require separate Owner authorization.
Local source changes do not establish those external facts.
