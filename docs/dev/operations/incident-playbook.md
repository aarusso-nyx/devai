# Incident playbook

Preserve the failing candidate before attempting repair. Record the exact repository, branch,
HEAD, tree, command, exit status, structured verdict, and relevant tool versions.

## Triage

```bash
git status --short --branch
git rev-parse HEAD^{commit}
git rev-parse HEAD^{tree}
devai doctor --repo-root . --format json
devai check --affected --explain --base <exact-base-commit> --format json
devai evidence verify --scope local --repo-root . --format json
```

- Missing or stale cache: run the selected affected closure; do not manufacture freshness.
- Task failure: inspect the named node's canonical argv, inputs, dependencies, and output.
- Receipt rejection: compare signer, revocation list, repository/commit/tree, policy digest, and
  required-node closure.
- Authority refusal: correct the role, consent, or target; do not widen an action to get past it.
- Database failure: preserve the database identity and logs before recreating an isolated DB.
- Evidence-chain failure: stop mutation, preserve the chain and candidate, and use the exact
  diagnostic location from `evidence verify`.

After repair, rerun only invalidated nodes. Run the fixed RC closure when the incident affects
the RC gate, task descriptor, toolchain, or containment boundary.
