---
name: devai-resource-control
description: Apply an explicit Owner change to a DEVAI token budget, waiver, model or effort assignment for a task, round or campaign, preserving scope, duration and accounting. Use when the Owner says raise or waive the budget, use a cheaper model, lower effort, or re-steer resources.
license: Apache-2.0
compatibility: Needs the project-local @aarusso-nyx/devai package.
metadata:
  devai-status: stable
  devai-workflow-schema: '1'
---

# devai-resource-control

Identify which limit the instruction means: campaign/round/task allocation, runtime goal budget, or provider account quota (a skill cannot waive a provider quota or reset account usage). Read the governing plan, the budget record and the instruction itself.

Resolve: the new cap or waived state, affected ids, effective time, duration (one occasion | rest of round | rest of campaign | until revoked), expiry. Apply through the existing budget/assignment mechanism and record format. A prospective change never rewrites a historical FAIL into PASS; previous windows and overruns stay. When a runtime limit needs a user-controlled host setting, say exactly which control and stop — a plan-file edit does not change the runtime.

Keep model/effort changes separate from budget unless the instruction includes both. Confirm the model is available locally; don't turn a steering instruction into a permanent default. Reduce cost through bounded reading, smaller packets, focused checks and valid evidence reuse — never by accepting defects, skipping required security or product evidence, or widening write scopes. Parallel work gets non-overlapping owned paths, locks, ceilings and an integration owner; dispatch only when the current session rules allow it.

Output: old → new, scope, expiry, what was applied, what could not be and why, remaining restrictions. Reuse the decision within its scope on later turns without asking again.
