---
title: Framework
sidebar_position: 1
slug: /framework
---

# Framework

> §3 is the framework reference — the contract DEVAI offers to an adopter. Reading it tells you what you are getting and what is expected of you. The [Constitution](../reference/law.md) is the index; everything else here is commentary that orients you to the Constitution's binding text.
>
> §3 is deliberately separated from the [developer guide](../dev), which describes how human maintainers work on the DEVAI source repository. Maintainer procedures do not silently add requirements to the adopter contract.

## What's here

| Page                                            | What it covers                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Constitution](../reference/law.md)             | The ordered constitutional articles. The Index. Cite by article number.                                                                                      |
| [Substrates](./framework/substrates.md)         | F1-F5 — Specification, Plant, Observation, Inventory, Harness — and how authority-by-path enforcement works.                                                 |
| [Transversals](./framework/transversals.md)     | T1-T9 — Coverage, Depth, Coherence, Alignment, Idiomaticity, Security/Privacy, Performance/Efficiency, Robustness, Discipline — evaluated across substrates. |
| [Aspect grid](./framework/aspect-grid.md) (W10) | The 5×9 substrate × transversal grid with the sensor that scores each cell.                                                                                  |
| [Scorecard](./framework/scorecard.md)           | Hard gate, soft gate, tri-state verdicts, threshold defaults, tie-breaker ladder.                                                                            |
| [Loop](./framework/loop.md)                     | Triage → three cycles (A/B/C) → iteration cap → RGR → escalation.                                                                                            |
| [Concurrency](./framework/concurrency.md)       | Coupled triplets, module locks, pipelined rebase, worktree discipline.                                                                                       |
| [Evidence](./framework/evidence.md)             | Hash-chained per-event records; what's evidenced; verification and redaction.                                                                                |
| [Invariants](./framework/invariants.md)         | The atomic spec unit; trace; per-invariant change policy.                                                                                                    |
| [Test policy](./framework/test-policy.md) (W09) | Six test suites, journeys, DB tests, mutation scenarios, weakening, quarantine, coverage, per-batch verification.                                            |
| Contracts                                       | API/data contracts under `docs/reference/contracts/`.                                                                                                        |
| Schemas                                         | The schema roster is explicit in `packages/schemas/src/roster.ts` and guarded by schema liveness checks; no prose count is authoritative.                    |
| Glossary                                        | Canonical vocabulary under `law/glossary/`; cite by term.                                                                                                    |
| Product                                         | Owner-authored journeys and use-cases under `product/`.                                                                                                      |

## How to read this section

Pick by purpose:

- **First contact with the framework.** Read [Constitution](../reference/law.md) end-to-end (~30 min). The constitutional articles; each is short. The constitution is the binding contract; everything else derives.
- **You need to do something specific** (write an invariant, gate a merge, route a failure, declare a coupled triplet). Use the table above to jump.
- **You need to understand a sensor.** Start at the [Aspect grid](./framework/aspect-grid.md), find the cell, follow the link to the sensor's design note.
- **You need to argue about authority.** Articles 4-10 cover substrates, paths, roles, agent disciplines, the authority chain, and the within-iteration separation rule. Cite by article number when you make the argument.

## Adopter contract anchor

Every page in §3 describes a property of DEVAI that holds for _every_ adopter that runs the framework. Source-maintenance procedures live in the developer guide and are not adopter requirements.
