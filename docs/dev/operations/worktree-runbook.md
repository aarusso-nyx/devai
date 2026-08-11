# Worktree operations

The v1.0rc CLI has no public worktree action. Use Git directly and keep every concurrent change
in a dedicated worktree and branch:

```bash
git worktree add -b codex/<topic> /absolute/path/to/worktree <exact-base>
git -C /absolute/path/to/worktree status --short --branch
git worktree list --porcelain
```

Before removal, verify the exact path, branch, HEAD, clean state, and that all intended commits
are reachable. Remove a worktree only through an explicit human-reviewed Git operation. DEVAI's
ignored `.devai/worktrees/` directory is runtime state, not a replacement for Git worktrees.
