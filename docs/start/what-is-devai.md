---
title: What is DEVAI?
sidebar_position: 2
---

# What is DEVAI?

DEVAI is a human-supervised governance and control harness for AI-assisted
software development. Each adopter declares a stack. **NestJS + Angular +
Postgres** is the primary reference stack, while explicit stack-adapter packs
extend sensing and prompt policy to additional declared stacks without claiming
universal parser coverage.

## DEVAI in one paragraph

Humans or explicitly operated agents changing code, tests, and documentation
produce defensible value only when there are rails: declared roles, enforced
CLI/runtime authority boundaries, deterministic gates, stochastic gates with
documented rubrics, and attributable evidence. DEVAI is those rails. It does
not replace build, lint, test, or CI tools; it regulates error between **what
the docs say** (the reference signal) and **what the code does** (the plant),
measured by tests (sensors). Humans set the reference and authorize actuation.

## The control-theoretic frame

[Constitution Articles 1-3](../reference/law.md) bind the vocabulary literally:

- **Specification** (F1) is the reference signal — what the framework is trying to achieve.
- **Code** (F2) is the plant — the system under control.
- **Tests** (F3) are sensors — they measure plant behavior against the reference.
- **Inventory** (F4) is plant identification — a derived model of the plant used by the controller.
- **Harness** (F5) is the controller infrastructure — DEVAI itself, as instantiated in the client repo.

This is not metaphorical. The framing dictates how authority is allocated, how concurrency is mediated, how failures are routed, and how convergence is gated. See [§2 Theory](../theory) for the full metaphor map and the unified theory document.

## Five substrates, five roles

DEVAI partitions every artifact into one of five fundamental substrates (F1-F5), each with distinct authority. Humans declare one of five roles at session start; agents inherit the same constraints:

- **Owner** authors business specs (journeys, use-cases) under F1.
- **Architect** authors engineering specs, invariants, contracts, ADRs under F1.
- **Inspector** authors tests under F3.
- **Engineer** authors code under F2.
- **Auditor** is read-only; produces reports, scorecards, backlogs.

[Article 6](../reference/law.md) is mechanically enforced for mutations
performed through DEVAI's CLI/runtime. Arbitrary shell, editor, or host-agent
writes require a separately verified host adapter; repository instructions
alone are advisory for those unrestricted surfaces.

## What you get when you adopt

1. **Governed authority.** DEVAI-mediated mutations are in scope or rejected;
   host-wide containment is claimed only when a verified adapter supplies it.
2. **Hard + soft gates.** Deterministic gates (typecheck, lint, build, tests, migrations, contract validation) plus LLM-judged stochastic gates with documented rubrics, tri-state verdicts (PASS / REVIEW / FAIL), and an explicit tie-breaker ladder.
3. **Explicit evidence.** Read-only observations do not silently write state.
   Role-declared, consented recording actions persist readings and append the
   hash chain when durable evidence is required.
4. **Observable progress.** The 59 registered sensors provide bounded readings whose
   meaning, inputs, and freshness remain explicit.
5. **Human ownership.** Maintainers decide DEVAI's changes and releases; the framework does not govern its own development.

## Where to go next

- For the architectural argument in long form: synthesis paper (under §2 Theory).
- For the formal control-theoretic treatment: control-engineering paper (under §2 Theory).
- Start with `devai init plan`, then use the explicit role-separated apply actions shown by the plan.
- For the per-role view: [Roles](../roles).
