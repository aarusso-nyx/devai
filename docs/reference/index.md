---
title: Reference
sidebar_position: 1
slug: /reference
---

# Reference

Current machine-readable sources are authoritative. Prose explains how to select and
interpret them.

| Reference                          | Current scope                                             |
| ---------------------------------- | --------------------------------------------------------- |
| [CLI](./cli/)                      | 41 actions in seven public domains plus internal plumbing |
| [Sensors](./sensors-quick-ref.md)  | 59 registered sensor kinds                                |
| [Recipes](./recipes/README.md)     | 7 host-invoked recipes                                    |
| [Contracts](./contracts/README.md) | current JSON schemas and result envelopes                 |
| [Examples](./examples.md)          | maintained fixtures and stack packs                       |
| [Scripts](./scripts.md)            | repository maintenance commands                           |

Query `devai catalog actions --format json` for exact action names. Generated reference
blocks identify their canonical policy source and must be refreshed by their generator,
not edited manually.
