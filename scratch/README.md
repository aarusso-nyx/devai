# scratch/ — rules of the tree

Everything here is ephemeral and gitignored (this README is the only committed file).
Per-session work under sessions/<id>/; harness worktrees under worktrees/ (cap-enforced).
Anything worth keeping graduates explicitly into work/, packages/, or a register entry.
Scratch that persists is a filing failure — devai doctor warns on aging content.

`scratch/typecheck/` is the disposable compiler output for CLI type checking.
The publishable `packages/cli/dist/` directory is owned exclusively by
`packages/cli/scripts/assemble-package.mjs`.
