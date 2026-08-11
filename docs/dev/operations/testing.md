# Testing operations

## Ordinary development

Select tests from the content-addressed task descriptor instead of repeatedly sweeping the
repository:

```bash
devai check --affected --task-plan --base <exact-base-commit> --format json
devai check --affected --run --base <exact-base-commit> \
  --as-role inspector --write --format json
devai check --affected --status --base <exact-base-commit> --format json
```

`--explain` reports why a node was selected, reused, or invalidated. Task keys bind Git blob
content, dependency keys, canonical runner/argv/cwd, toolchain, allowlisted environment, and
output contract. They do not bind mtimes or commit SHA, so identical content can reuse a PASS.
Known changed paths select matching leaf tasks and their dependent closure. Unknown or dynamic
paths select the declared `test:local-full` fallback and therefore the complete cheap closure.

`devai check --local` selects that complete cheap closure directly. It consists of generation,
the workspace build, the package and root test leaves, and the aggregate marker. Each unchanged
PASS node can be served from the ignored content-addressed cache. The current closure is 14 nodes
and its Vitest leaves collect 92 files.

Never reuse FAIL, timeout, killed, aborted, malformed, or incomplete output. Dirty-tree runs are
useful for iteration but cannot produce a candidate receipt. The local profile is deliberately
non-attestable; a clean affected or RC run may emit an unsigned receipt when the repository stays
unchanged throughout execution.

## Release-candidate gate

```bash
devai check --rc --task-plan --format json
devai check --rc --run --as-role inspector --write --format json
```

The fixed RC closure is three nodes: generation, build, then one `test:coverage:rc` node. That node
collects the complete 104-file Vitest population exactly once and enforces coverage floors of 70%
statements, 60% branches, 70% functions, and 70% lines. The narrower database, E2E, performance,
and containment scripts remain available as diagnostic slices; they are not additional required
RC nodes. Real provider credentials are always explicit opt-in; ambient credentials must not
create accidental cost or nondeterminism.

## Receipt verification

A candidate-independent exporter validates the unsigned clean affected/RC receipt and exact result
set before signing outside the candidate repository. The exported evidence is valid only for its
exact repository, commit, tree, task-policy digest, required-node closure, signer, and revocation
state. The independently pinned remote verifier rejects missing, stale, malformed, unknown, FAIL,
or ABORTED nodes. A trusted signature proves integrity and signer identity, not that execution
actually occurred.
