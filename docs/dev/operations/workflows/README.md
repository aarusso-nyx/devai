# Workflows

One reference page per admitted workflow under `.github/workflows/`, written from the
file and kept to it by a drift check on the metadata block below (ADR-GOV-0021). An
operator reads the page before dispatching or recovering a workflow; the
information-architecture gate refuses a workflow file without a page.

| Workflow file                      | Page                                                              | Purpose                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `pull-request-checks.yml`          | [pull-request-checks](./pull-request-checks.md)                   | Non-attesting merge preflight on pull-request heads and merge-queue entries                                                                    |
| `release.yml`                      | [release](./release.md)                                           | Tag validation, candidate rehearsal, and authorized promotion                                                                                  |
| `site-publish.yml`                 | [site-publish](./site-publish.md)                                 | Owner-dispatched site-only Pages publication from `main`                                                                                       |
| `devai-ledger-verify.yml`          | [devai-ledger-verify](./devai-ledger-verify.md)                   | Explicit dispatch of the protected ledger verification against one commit                                                                      |
| `update-pull-request-branches.yml` | [update-pull-request-branches](./update-pull-request-branches.md) | Rebase open pull requests behind `main` on each push to `main`, and a pull request opened behind it, with the update-branch App (ADR-CHK-0008) |

## Page shape

Every page has the same sections in the same order: an introduction, the metadata
block, then **Triggers and path scope**, **Jobs and their order**, **Environments and
who stops there**, **Secrets and variables each job reads**, **What each job runs**,
**Direct effects**, **Side effects**, **Recovery paths**, and **Steps an adopter may
reuse**. Pages link to [release discipline](../release-discipline.md) for the approval
stops and the credential matrix and to the
[remote preflight contract](../remote-preflight-contract.md) for the preflight lane
instead of restating them.

## Metadata block

The drift check compares each page with its workflow file through one block and never
by parsing the page's tables. The block is the first fenced code block that follows the
HTML comment `<!-- devai:workflow-metadata -->`, and it is YAML with exactly three keys:

```yaml
workflow: .github/workflows/<file>.yml
triggers:
  - <event>
jobs:
  - <job id>
```

- `workflow` is the repository-relative path of the file.
- `triggers` lists the keys of the file's `on:` mapping, in file order, one per item;
  activity types, tag patterns, and inputs are not part of the block.
- `jobs` lists the keys of the file's `jobs:` mapping, in file order, one per item;
  display names are not part of the block.

The block is the drift contract: a page whose block names a trigger or a job the file
no longer declares fails the check, and a page whose prose or tables drift while the
block is current is a docs review, not a gate failure.

## Adding a workflow

A new file under `.github/workflows/` needs, in the same pull request, a page
`docs/dev/operations/workflows/<file stem>.md` in the shape above, a row in the table
on this page, its consumers in `law/policy/credential-requirements.json`, and its pins
in `scripts/check-workflows.mjs`.
