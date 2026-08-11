---
title: Theory
sidebar_position: 1
slug: /theory
---

# Theory

DEVAI treats software delivery as a feedback loop: product contracts state the
target, implementation changes the system, tests and sensors observe it, and
evidence records what was actually verified.

## Framework

The [framework index](./framework.md) explains the current product concepts and
links to the focused reference pages.

## The metaphor map, at a glance

| DEVAI term           | Control-theory term                    | Legal term                             | Anchor              |
| -------------------- | -------------------------------------- | -------------------------------------- | ------------------- |
| Specification (F1)   | Reference signal _r(k)_                | The statute book                       | Art. 2, 4           |
| Code (F2)            | Plant _P_                              | The governed conduct                   | Art. 2, 4           |
| Test (F3)            | Sensor _y(k)_                          | Evidence-gathering apparatus           | Art. 29             |
| Inventory (F4)       | State estimate _x̂_                     | The public registry                    | Art. 4, 33          |
| Harness (F5)         | Controller infrastructure              | The institutions and records           | Art. 4              |
| Five roles           | Separated controllers                  | Separation of powers                   | Art. 7–10           |
| Authority-by-path    | Actuator authority limits              | Jurisdiction                           | Art. 6              |
| Declared effect sets | Certified actuation envelope           | Enumerated powers / ultra-vires review | Action contracts    |
| Hard gate            | Deterministic error component          | Strict-liability rule                  | Art. 17             |
| Soft gate            | Stochastic error, explicit uncertainty | Rubric-bound discretion                | Art. 18, 39         |
| Severity ladder      | Weighting matrix **Q**                 | Hierarchy of norms                     | Art. 11             |
| Triage               | Fault detection & isolation            | Jurisdictional assignment              | Art. 15             |
| RGR                  | Reference-disturbance request          | Petition for clarification             | Art. 22             |
| Tie-breaker ladder   | Gain-scheduled arbitration             | Appellate review                       | Art. 23             |
| Iteration cap        | Anti-windup / saturation               | Procedural retrial limit               | Art. 19             |
| Evidence chain       | Flight recorder                        | Court record, chain of custody         | Art. 32–33          |
| Auditor              | Estimator outside the loop             | Independent judiciary                  | Art. 7, 33          |
| Dark promotion       | Shadow-mode commissioning              | _Vacatio legis_                        | Owner authorization |

## Where to go next

- The Constitution itself: [`framework/constitution`](../reference/law.md). Forty articles; cite by number.
- The scorecard mechanics: [`framework/scorecard`](./framework/scorecard.md).
- The supported and experimental loop boundaries: [`framework/loop`](./framework/loop.md).
