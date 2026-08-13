---
title: DEVAI
sidebar_position: 1
slug: /
---

# DEVAI

DEVAI is a human-supervised control harness for AI-assisted software development.
It measures a declared repository, runs bounded operations, and records evidence
without taking release authority away from its maintainers.

## Choose an entry point

| Goal                                        | Start here                                         |
| ------------------------------------------- | -------------------------------------------------- |
| Understand the model and authority boundary | [What is DEVAI?](./what-is-devai.md)               |
| Adopt DEVAI in a repository                 | [Install and adopt](../adopters/install.md)        |
| Look up a current CLI action                | [CLI reference](../reference/cli/)                 |
| Use a host-invoked recipe                   | [Recipe reference](../reference/recipes/README.md) |
| Contribute or operate this codebase         | [Developer guide](../dev/)                         |

## Current product surface

The stable release ships one publishable package, `@aarusso-nyx/devai`, with 43
catalogued actions, 59 sensors, and 7 recipes. Seven public workflow domains cover
adoption, diagnosis, validation, observation, work execution, evidence, and release
inspection. The action catalog includes stable, preview, and internal status for every action.

Start read-only:

```bash
devai init plan --target . --tier tier1 --format json
devai doctor --repo-root . --format json
devai catalog actions --format json
```

Apply only a reviewed plan, with the exact role and consent required by that action.
