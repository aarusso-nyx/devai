---
id: ADR-REL-0024
title: Host Git environment isolation for canonical repository identity
type: adr
status: accepted
date: 2026-09-04
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 6 (path-bound authority and declared host boundaries)
  - law/constitution.md Article 10 (authority separation)
  - law/constitution.md Article 41 (exact immutable evidence)
  - law/adr/ADR-REL-0016-protected-preflight-execution-authority.md
  - law/adr/ADR-REL-0023-separate-authority-and-release-repository-identity.md
affected_rules:
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
inspector_acceptance:
  - IA-001 -- An inherited or candidate-supplied `GIT_*` member, including any `GIT_DIR`, `GIT_WORK_TREE`, config-count/key/value, discovery, executable or SSH override, cannot reach a protected Git child.
  - IA-002 -- Every protected Git child has exactly the host-set values `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_SYSTEM=/dev/null`, and `GIT_CONFIG_GLOBAL=/dev/null`, and no other `GIT_*` member. A changed, absent or additional member refuses before the protected effect.
  - IA-003 -- Before any `rev-parse`, the host queries only local configuration with `git config --local --no-includes` and refuses every `include.path`, `includeIf.*.path`, `extensions.worktreeConfig`, `url.*.insteadOf`, or `url.*.pushInsteadOf` declaration, even when its value appears inactive.
  - IA-004 -- The correction preserves the separate slug/canonical identifier domains, origin forms, immutable candidate proof, exact tuple checks, pure-reader construction, and bundle-only offline verification of ADR-REL-0023.
---

# Host Git environment isolation for canonical repository identity

## Status

Accepted forward correction after adversarial review. It preserves the
accepted bytes of ADR-REL-0023, adds no action, capability, adapter, request,
state or receipt field, and grants no protected effect.

## Context

ADR-REL-0023 correctly denies inherited candidate-controlled Git environment
variables and system/global configuration. Its literal statement that the
child environment has an empty `GIT_*` population, however, conflicts with the
required Git-supported isolation controls themselves: `GIT_CONFIG_NOSYSTEM=1`,
`GIT_CONFIG_SYSTEM=/dev/null`, and `GIT_CONFIG_GLOBAL=/dev/null`. The conflict
could otherwise lead an implementation either to run Git without the required
isolation or to violate the literal empty-environment rule.

## Decision

At each checkout-bound protected boundary, before its local Git inspection and
again immediately before its protected effect, the external host removes every
inherited `GIT_*` environment member. It constructs the child environment with
only these three host-owned exact members:

```
GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_SYSTEM=/dev/null
GIT_CONFIG_GLOBAL=/dev/null
```

No candidate, request, plan, receipt, helper, profile, ambient process, or
host convenience setting may add, remove, replace, or select a child `GIT_*`
member. The host compares the final child `GIT_*` population and exact values
before invocation; absent, changed, or additional members refuse. `/dev/null`
is deliberately the supported current Linux/macOS host scope; this decision
does not infer portability to another platform.

Before `rev-parse` or any origin/HEAD/tree capture, the host invokes `git
config --local --no-includes` through that exact environment and refuses every
declared `include.path`, `includeIf.*.path`, `extensions.worktreeConfig`,
`url.*.insteadOf`, and `url.*.pushInsteadOf` key. It rejects
`extensions.worktreeConfig` regardless of value. This explicit local inspection
is separate from disabling system/global configuration: it ensures a local
rewrite or include cannot be hidden by an implementation that merely turns off
ambient config resolution.

The established raw-origin parsing, named-origin fetch-url/pushurl checks,
canonical locator equality, pinned-root and Git-metadata rechecks, immutable
candidate snapshot/tree proof, and exact plan/candidate bindings remain
unchanged. Pure committed-artifact readers and bundle-only offline verification
remain free of checkout, origin, and Git-environment requirements.

## Consequences

Engineer may implement only this finite child-environment construction and
local-config refusal before the existing protected identity capture executes.
It must not accept a generic environment map, an alternate null-device path,
an alias, or a new action capability. The protected identity parser/capture may
remain pure while Git execution waits for this accepted correction.

Inspector must cover inherited-variable stripping, exact allowlist equality,
every refused local key family, absent/changing/extra allowlist members, and
the preservation of pure-reader and offline behavior. A passing parser alone
does not establish an authorized protected Git invocation.

## Alternatives Considered

**Leave the `GIT_*` population empty.** Rejected because Git's supported
system/global isolation uses `GIT_CONFIG_*` controls.

**Pass inherited `GIT_CONFIG_*` variables through.** Rejected because caller or
candidate process state could select configuration or repository discovery.

**Treat `--no-includes` as a global Git isolation setting.** Rejected because
it scopes the config query, not `rev-parse` or every other Git child.

## Affected Rules

- The lifecycle policy and its exact schema mirror replace only the impossible
  empty-`GIT_*` phrase with the three-value host allowlist and local-config
  preflight.
- ADR-REL-0023 remains accepted historical authority without modification.

## Inspector Adversarial Acceptance

IA-001 through IA-004 in this record are mandatory. The Inspector verifies the
exact child environment allowlist, every local-config refusal family, and that
pure readers and offline verification retain their root-free behavior.
