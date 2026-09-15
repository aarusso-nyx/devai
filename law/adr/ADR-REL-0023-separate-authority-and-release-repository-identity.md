---
id: ADR-REL-0023
title: Separate local authority and canonical release repository identity
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 6 (path-bound authority and declared host boundaries)
  - law/constitution.md Article 10 (authority separation)
  - law/constitution.md Article 41 (exact immutable evidence)
  - law/adr/ADR-REL-0015-close-certification-provenance-and-sink-ambiguity.md
  - law/adr/ADR-REL-0016-protected-preflight-execution-authority.md
  - law/adr/ADR-REL-0018-bounded-ustar-prefix-prepare.md
  - law/adr/ADR-REL-0019-preserve-and-restate-installed-release-policy.md
  - law/adr/ADR-REL-0022-signed-portable-export-closure.md
affected_rules:
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
inspector_acceptance:
  - IA-001 -- A local authority slug and a canonical release repository id remain distinct exact values; a matching normalized spelling, basename, project name, slash removal or collision never authorizes a protected release operation.
  - IA-002 -- Each accepted origin form captures both its exact raw bytes and its direct canonical owner/repository extraction. An unlisted form, case change, transport rewrite, URL decoration, extra segment or post-capture raw-url substitution refuses before any protected effect.
  - IA-003 -- The protected host rejects a root that is not its realpath Git worktree top level, has zero or multiple configured URLs for named remote origin, or diverges in canonical origin, HEAD commit or HEAD tree at binding or recheck. Candidate input cannot provide the root, origin expectation or canonical release repository identity; unrelated remotes do not matter.
  - IA-004 -- A current plan, request, candidate and every protected adapter binding must agree exactly on the canonical repository locator, candidate commit/tree and plan digest. An older receipt without this forward tuple remains observational and cannot be upgraded into current execution authority.
---

# Separate local authority and canonical release repository identity

## Status

Accepted forward contract after the required adversarial review. It neither
changes an accepted ADR nor modifies public release request, state or receipt
formats. It grants no effect before an implementation replays the current
policy resolution and the host provides the complete protected tuple.

## Context

The authority policy's `repository_id` is a local slug in the existing
slash-free authority-schema domain. The release policy resolver, on the other
hand, correctly names a canonical Git release repository such as
`aarusso-nyx/devai`. Treating those independently meaningful identifiers as
the same value either rejects a genuine producer route or tempts a lossy slash
normalization. Neither is safe: distinct canonical repositories can collapse
to the same slug, and a candidate-selected remote is not an external release
identity.

The existing public `repository_locator` already carries the canonical release
repository id, commit and tree. It must remain that public identity. The
defect is solely in the private protected-host binding, which currently has no
separate local authority slug or checked origin capture.

## Decision

### Two non-interchangeable identities

Protected release host bindings carry exactly these separate identity members:

- `authority_repository_id`: the existing local authority policy/session slug;
- `expected_release_repository_id`: one exact canonical `owner/repository`
  identity supplied by trusted host configuration before candidate or request
  input;
- `repository`: the existing private binding object which is exactly the public
  locator object `{id, commit, tree}` and is never a filesystem path component;
  and
- `origin_url`: the exact raw origin URL captured by the host.

`authority_repository_id` must match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and equal the broker's existing source
`repository_id` byte-for-byte. It remains governed by the current slash-free
authority schemas. It is never computed from, compared as an alias to, or used
to select `expected_release_repository_id` or `binding.repository.id`.

The externally configured expected canonical identifier must equal
the direct origin extraction and `binding.repository.id` byte-for-byte. All
three must match
`^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9][a-z0-9._-]{0,99}$`.
The current request projection remains
unchanged: its existing `repository_locator` is still canonical and no new
public request, state, receipt, authorization or plan field is introduced.

### Closed origin and root capture

The only accepted raw origin forms are exactly:

```
https://github.com/<lowercase-owner>/<lowercase-repository>.git
ssh://git@github.com/<lowercase-owner>/<lowercase-repository>.git
git@github.com:<lowercase-owner>/<lowercase-repository>.git
```

`owner` is lowercase ASCII alphanumeric with internal hyphens only.
`repository` starts lowercase ASCII alphanumeric and otherwise contains only
lowercase ASCII alphanumerics, `.`, `_`, or `-`. The parser matches one anchored
complete listed template and consumes its final literal `.git` suffix exactly
once, never by searching for or stripping a suffix. It accepts no userinfo
other than the literal SSH `git@`, password, port, query, fragment, whitespace,
percent encoding, trailing slash or extra path component.

The protected host gets its configured checkout root and expected canonical
repository id independently of candidate and request input. Before binding and
again immediately before each protected adapter effect, it must realpath that
root, prove it is the Git worktree top level, and recheck pinned root and Git
metadata device/inode identities at the effect boundary. Candidate content is
read only through the existing immutable candidate snapshot and exact
tree-membership proof, not re-resolved paths. It then computes `HEAD` plus
`HEAD^{tree}`. `origin` has exactly one fetch URL and zero push URLs; other
remotes are neither read nor constrained. Any effective
`url.*.insteadOf` or `url.*.pushInsteadOf` key refuses. The child Git
environment has an empty `GIT_*` population; the host disables system/global
and include/`includeIf` config resolution and refuses worktree config. It binds the raw URL bytes and direct
`owner/repository` extraction without case folding, URL rewriting, percent
decoding, dot-segment cleanup, trailing-slash cleanup, SCP/URL conversion or
any alias map. The recheck requires the raw URL, direct extraction, canonical
expected id, binding repository id, commit and tree all to be exact equals. A changed
transport spelling therefore refuses even when it would denote the same GitHub
repository.

An origin match is an identity label, not proof that content was obtained from
a network remote. The immutable candidate commit/tree proof carries the
content identity. The broker compares `binding.repository.id` only to
`expected_release_repository_id`, and `authority_repository_id` only to its
existing source repository slug; each unequal comparison refuses. It never
maps, translates or compares values across these two domains.

### Current operation equality and scope

The freshly resolved current plan receipt's repository id/commit/tree and
candidate commit/tree, the public request locators, and every checkout-bound
protected preflight, certification, prepare and export host binding must equal
this tuple. The plan receipt digest remains exact and is
checked before every dependent provider, sink, signer or capacity effect.
Missing, extra, malformed, noncanonical, candidate-selected or unequal member
refuses before effect; there is no ambient root/origin fallback.

The host reloads the trusted expected canonical repository id at every live
effect boundary and requires it to equal the captured tuple. A host-config
change therefore refuses rather than silently retaining a stale expectation.
No checkout-bound effect accepts a tuple-less binding.

Pure committed-artifact-reader construction and read-only parent reconstruction
also remain root/origin-free: they verify only their exact signed or request
canonical repository, candidate and plan bytes. Offline verification remains
bundle-only under ADR-REL-0019 and ADR-REL-0022: it uses the signed canonical
locator plus external expected identities and trust, never a checkout root or
origin lookup. This is a forward current-policy contract. A past receipt, state or host
binding that lacks this complete tuple remains readable only under its
original rules. No replay may add a slug, infer an origin, relabel a locator or
upgrade historical evidence into execution authority.

## Consequences

Engineer changes only the protected host binding and its adapter/broker
verification to represent the four-member tuple. The existing authority slug
schemas, request schema, state schemas, receipt schemas and canonical release
locator stay unchanged. The host must source the expected canonical id and
checkout root from its external protected composition, not a candidate
configuration or an invocation field. Every boundary rejects before use when
the recheck fails.

Inspector proves exact positive bindings for the permitted HTTPS and SSH
forms, then attacks slug collisions, path basenames, project names, slash
removal, case variants, alternate transport, decorated URLs, changed origin,
different worktree root, changed HEAD/tree, mismatched plan digest and old
receipt replay. The authority policy grammar must not widen.

## Alternatives Considered

**Normalize `owner/repository` into the authority slug.** Rejected: it is a
collision-prone alias and changes an authority selector's semantic domain.

**Permit arbitrary Git remote URLs and canonicalize them later.** Rejected:
it creates a candidate-controlled interpretation surface and cannot preserve
the exact captured transport identity.

**Add the origin or authority slug to public lifecycle documents.** Rejected:
the public locator already carries canonical release identity; host-local
authority composition belongs in the private protected binding.

## Affected Rules

Lifecycle policy `2.12.0` adds one closed protected repository-identity
contract and requires it in protected preflight, certification and export
bindings. It does not alter the public request projection, state/receipt wire
formats, authority slug schema, action set, effect ceilings or historical
interpretation.

## Inspector Adversarial Acceptance

Run all frontmatter acceptance cases. In particular, establish that an exact
`devai` local slug does not substitute for `aarusso-nyx/devai`, and that a
canonical producer id does not substitute for the configured local authority
slug. Verify refusal before provider, sink, signer, capacity or publication
effects on every raw-origin/root/commit/tree/plan mismatch.
