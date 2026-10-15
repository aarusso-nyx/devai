---
name: devai-backlog-harvest
description: Harvest unresolved work from this session's context, memory and worktree artifacts in a DEVAI-governed repo into deduplicated GitHub issue drafts; register them only when explicitly asked. Use for "what did we leave open", "turn these findings into issues".
license: Apache-2.0
compatibility: Needs the GitHub CLI authenticated for the target repository.
metadata:
  devai-status: stable
  devai-workflow-schema: '1'
---

# devai-backlog-harvest

Runs inline: it needs this conversation's context, so never run it in a forked subagent.

Resolve the target repository, then scan the requested sources (session, round, campaign artifacts, memory as pointers) for unresolved findings, deferred scope, unanswered decisions, risks, workarounds and follow-ups. Verify current state — artifacts, open and closed issues, PRs — before treating an old concern as open; split confirmed-open, resolved, and unverifiable.

Per candidate: source locator (host/session/time/file-line or digest), symptom, current impact, evidence, component, blocking status, closure condition. Keep severity, certainty and urgency separate; a decision stays a decision and names whose answer is needed.

Search open and relevant closed issues and PRs, paginating the full scope; match by behavior, component and identifiers. One issue per coherent actionable outcome; link related items; split independently deliverable work. Redact secrets and private transcript detail. Draft title and body with the repository template; owner, labels and milestone stay proposed until verified.

Output: ready-to-post bodies, a source → issue map, and exclusions with reasons. "Inspect" or "draft" means prepare locally. "Register" or "open" means create through the authenticated GitHub tool, verify number, URL and body, and never bulk-update, close or assign unrelated issues; after an uncertain outcome, inspect state before retrying.
