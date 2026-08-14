---
'@aarusso-nyx/devai': patch
---

Generate a digest-bound GitHub Actions adapter that uses the optional read-only
`DEVAI_REPO_TOKEN` for cross-repository package installs and falls back to the
repository-scoped `GITHUB_TOKEN` when no separate package token is required.
