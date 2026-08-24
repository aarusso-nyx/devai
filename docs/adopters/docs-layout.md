# Documentation layout

Adopters should use the smallest `docs/` tree that makes their product contracts
easy to find. Recommended directories are:

- `docs/eng/` for engineering specifications;
- `docs/arch/` for architecture descriptions;
- `docs/adr/` or `law/adr/` for architecture decisions, according to the repository's
  declared convention;
- `docs/contracts/` for outward-facing contracts;
- `docs/ops/` for operational runbooks;
- `docs/user/` for user-facing documentation;
- `docs/security/` for threat models and controls.

Do not maintain parallel directories for the same purpose. Record project-specific
choices in the adopter's `AGENTS.md` and keep links from stable documents pointed at
other stable documents.

See [adopter conventions](./CONVENTIONS.md), [ADR authoring](./adr/README.md), and
[contract authoring](./contracts/README.md).

## Repository classification and builder

Declare `repo.kind` as `library` or `application` and declare `docs.builder` as
`docusaurus` or `jekyll` in `.devai/config/project.json`. Libraries must use
Docusaurus because their downstream consumers need searchable, versioned API
documentation. Applications default to Docusaurus; an application that selects
Jekyll must record `law/adr/ADR-DOCS-BUILDER-OPT-OUT.md` with rationale, reviewer,
date, and a sunset trigger.

Place the site under `docs/site/`. A Docusaurus site provides its configuration,
sidebar, and package manifest there. A Jekyll site provides `_config.yml` and
`Gemfile`. Documentation governance validates this declared shape and its build
toolchain.

## Information architecture

A Docusaurus projection provides a landing page, publishes the repository law,
keeps `law/` and `docs/` as sibling source categories, and uses a curated sidebar
with explicit labels. Regenerate derived dashboards and projections before
publication so build-frozen pages do not drift from their inputs.

Application adopters with no downstream consumers may declare collapsed sections
under `docs.ia.collapsed_sections`; each stub points to the upstream source.
When a binding adopter ADR relocates a canonical documentation path, declare the
mapping under `docs.ia.path_overrides` rather than maintaining a parallel tree.

## Publication boundary

The documentation publication branch is inspected as repository state. A CI
workflow must not publish documentation: publishing is an explicitly authorized
local external effect. Build and link checks do not grant publication authority.

## Upstream decision records

The following references preserve the provenance of rules that DEVAI inherited. They
are not live links or substitutes for the current product contracts: the historical
ADR files predate this repository and were not carried forward. The enforceable
behavior is documented on this page, in [CI economy](./ci-economy.md), and in the
package-owned checks.

| Current contract | Upstream provenance |
| --- | --- |
| `repo.kind` | `ADR-DOCS-GOVERNANCE` Decision 1 |
| `docs.builder`, including the Docusaurus requirement for libraries | `ADR-DOCS-GOVERNANCE` Decisions 2 and 4 |
| `docs/site/` | `ADR-DOCS-GOVERNANCE` Decision 5 |
| Documentation-governance authority | `ADR-DOCS-GOVERNANCE` Decision 6 |
| Publishing the Constitution in the documentation projection | `ADR-DOCS-IA` Decisions 4 and 8 |
| `docs.ia.collapsed_sections` | `ADR-DOCS-IA` Decision 11 |
| CI must not publish documentation | `ADR-LOCAL-PUBLISH-WORKFLOW` section 10 |
| Local CI evidence | `ADR-CI-ECONOMY` Decisions 1-3 and 8 |

## Documentation-governance rules

The package-owned documentation-governance check evaluates these nine rules. The
severity below is the rule's failure severity; successful evaluation is reported as
`pass`.

| Rule | Requirement | Severity |
| --- | --- | --- |
| `docs-governance.classification` | `repo.kind` is `library` or `application` | `fail` |
| `docs-governance.builder-declared` | `docs.builder` is `docusaurus` or `jekyll` | `fail` |
| `docs-governance.library-docusaurus-required` | Libraries use Docusaurus | `fail` |
| `docs-governance.opt-out-adr-required` | An application using Jekyll supplies the required opt-out ADR | `fail` |
| `docs-governance.site-dir-shape` | `docs/site/` has the files required by the selected builder | `fail` |
| `docs-governance.build-toolchain` | The configured documentation build command dry-validates | `warn` |
| `docs-governance.gh-pages-branch` | The configured publication branch exists on `origin` | `warn` |
| `docs-governance.no-ci-publish` | No GitHub Actions workflow publishes documentation | `fail` |
| `docs-governance.config-not-placeholder` | Docusaurus configuration has no scaffold or placeholder values | `fail` |
