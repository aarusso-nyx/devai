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
- At convergence time, treat legacy Pages deployment failure and package
  delete/republication behavior as open experimental claims. Settle them only with
  disposable Pages and package-version experiments; do not use the public rc.2
  artifacts as test subjects.

## Subsequent experimental closure

The Owner later authorized both disposable experiments. Their durable record is
[`experiments-20260812.json`](https://github.com/aarusso-nyx/devai-release-experiment-20260811/blob/main/evidence/experiments-20260812.json):

- The same Pages workflow failed while the disposable repository used legacy mode
  ([run 31553446004](https://github.com/aarusso-nyx/devai-release-experiment-20260811/actions/runs/31553446004))
  and succeeded after switching to workflow mode
  ([run 31553480810](https://github.com/aarusso-nyx/devai-release-experiment-20260811/actions/runs/31553480810)).
  The legacy-mode incompatibility claim is therefore confirmed.
- `@aarusso-nyx/devai-republication-probe@0.0.0-exp.20260812-final` was
  published as version ID `1123904964`, deleted and verified absent, then republished
  with the same version and bytes as version ID `1123905035`. GitHub Packages is
  therefore a convenience mirror; the immutable GitHub Release manifest and
  `SHA256SUMS` remain the canonical stable identity.

## Confirmed findings retained

The bootstrap capability/policy mismatch, adopter check policy lookup, unbound-first
UX, pnpm setup conflict, normalized-manifest/SBOM failure, byte-nondeterministic rc.2
packing, DB-policy precondition gap, cross-package affected-selector gaps, bind-source
resolution, error-envelope model, empty build population, documentation drift, mutable
tag/assets, and same-custody verifier limitations remain in the rc.3 remediation scope.

## External-gate boundary at convergence time

Pages mode, protected environments, immutable Releases, `v*` tag rules, signed release
tags, package publication, registry digest verification, deployment, disposable
experiments, and the public `devai-rc-demo` proof require separate Owner authorization.
Local source changes do not establish those external facts.
