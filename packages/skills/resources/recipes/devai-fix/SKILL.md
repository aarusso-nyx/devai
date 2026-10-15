---
name: devai-fix
description: Repair a known failing DEVAI lint, typecheck, build, test or coverage concern within explicit file bounds. Use when a DEVAI check has failed and the failing files are known.
license: Apache-2.0
compatibility: Invoked by a host that reads Agent Skills from .agents/skills or .claude/skills; needs the adjacent devai.recipe.json and devai.operations.json and the project-local @aarusso-nyx/devai package.
metadata:
  devai-status: stable
  devai-recipe-schema: '1'
---

# DEVAI fix

Before acting, read the adjacent `devai.recipe.json` and `devai.operations.json`.

Select the variant that matches the failing concern (`lint`, `typecheck`, `build`, `test`, `coverage`) and stay within its write policy.

1. Name the files you will edit; every one must match the variant's scopes. A file discovered mid-repair that lies inside the authorized task scope may be added — say so in the report. A file outside it is a cross-scope need to report, not an edit.
2. Reproduce the failure, find the cause, make the smallest repair.
3. Run the variant's check. After any further edit, run it again. If the repair exposes a failure of another kind (a type fix breaks a test), select that kind's variant and run its declared check instead of stopping (each variant permits only its own check operation); the original task's file bounds still apply. Use the task's repair limit, or at most three repair/check iterations if unspecified; stop when checks pass, the limit is reached, a failure repeats without new evidence, or progress needs broader authority.

Never weaken a test or widen a permission.

Report: changed files, cause, checks run with results, remaining risk.

Worker boundary: no delegation, commit, push, publish or other remote effect from this recipe — those belong to an explicitly authorized orchestrator operation.
