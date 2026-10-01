---
id: SENSOR-NOTE-site_drift
title: Site Drift
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: site_drift
emitter: packages/sensors/src/site-drift.ts
standing: diagnostic
tiers: [SWEEP]
---

# Site Drift

This note defines `site_drift`. Its canonical emitter
is `packages/sensors/src/site-drift.ts`.

Diagnostic-only; no cell binding.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.

## The journal read

The sensor compares the local `gh-pages` tip with the last verified publication identity.
When the `gh-pages` ref carries no verifiable commit provenance, which the Pages deployment
path never writes, it reads the provenance that `scripts/process/github-pages-journal.mjs`
journals through the GitHub deployments API for environment `devai-pages-publication`. The
read is two exact `gh api` GET shapes, declared as templates `gh-api-pages-deployments` and
`gh-api-pages-deployment-statuses` in `law/policy/subprocess-effects.json` and admitted by the
authority broker without a host adapter (ADR-AUT-0002):

```text
gh api /repos/<owner>/<repo>/deployments?environment=devai-pages-publication&per_page=100
gh api /repos/<owner>/<repo>/deployments/<id>/statuses?per_page=100
```

`<owner>/<repo>` is the journal repository the sensor declares, `<id>` is a decimal integer
deployment id from the first listing, the endpoint and query are fixed strings, the method is
the implicit GET, and every option is refused, including `--method`, `-X`, `-f`, `-F`,
`--field`, `--raw-field`, `--input`, `--paginate`, and `--hostname`. A `gh api` argv naming
another repository, a non-integer id, or a third endpoint is refused although the method is
GET. The sensor spawns through the authority wrapper (`packages/sensors/src/harness/gh-api.ts`)
so the admission is enforced, and it performs no write.

## Readings

- PASS when the local `gh-pages` tip matches the last verified identity.
- REVIEW with `journal-not-verified` when the journal holds no verified deployment, and with
  `journal-no-matching-intent` when no deployment carries the publication intent for the
  declared repository.
- FAIL when the tip differs from the verified identity, including a local tip ahead of it.
- When the journal yields no verified identity and the local `gh-pages` tip carries a
  well-formed publication message, the tip's own provenance stands, as it did before
  ADR-AUT-0002; the record does not decide that combination.
- Tags are listed through the admitted read `git rev-parse --symbolic --tags`, so the
  journal read adds no git shape to the broker.
- `SITE_DRIFT_PROVENANCE_ADAPTER_REQUIRED` only for an argv the broker actually refuses, which
  after ADR-AUT-0002 is a policy regression; the sensor reports the refused argv verbatim.
