# scratch/ — rules of the tree

Everything here is ephemeral and gitignored (this README is the only committed file).
Per-session work under sessions/<id>/; harness worktrees under worktrees/ (cap-enforced).
Anything worth keeping graduates explicitly into packages/, docs/, or a register entry.
Scratch that persists is a filing failure; nothing checks it automatically, so clean it up.

`scratch/typecheck/` is the disposable compiler output for CLI type checking.
The publishable `packages/cli/dist/` directory is owned exclusively by
`packages/cli/scripts/assemble-package.mjs`.
