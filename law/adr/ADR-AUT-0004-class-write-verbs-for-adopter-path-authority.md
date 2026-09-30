---
id: ADR-AUT-0004
title: Registered write verbs per path class for adopter path authority
type: adr
status: accepted
date: 2026-09-30
authority: Architect
supersedes: []
provenance:
  - ADR-AUT-0003
  - ADR-GOV-0024
  - law/constitution.md Articles 6 to 10 (1.0.2)
  - law/policy/action-registry.json
  - packages/cli/src/authority/policy-support.ts
  - packages/cli/src/authority/policy-core-rules.ts
  - packages/cli/src/authority/policy-adopter-extension.ts
  - packages/cli/src/authority/broker.ts
  - packages/authority/src/capabilities/path-domains.ts
  - packages/authority/src/runtime/policy-resolver.ts
  - packages/authority/src/runtime/declaration.ts
  - docs/dev/operations/multi-stack-path-authority-proposal.md
  - the R-0502 Inspector finding on TASK-0522 of campaign CMP-0005 (issue aarusso-nyx/devai#186)
affected_rules:
  - packages/cli/src/authority/policy-support.ts
  - packages/cli/src/authority/policy-adopter-extension.ts
  - packages/cli/src/authority/policy.ts
  - packages/cli/src/services/adopter-policy.ts
  - packages/cli/scripts/installed-tarball-smoke.mjs
  - docs/adopters/path-authority.md
inspector_acceptance:
  - IA-001 -- With the reference source of ADR-AUT-0003 bound in a fixture repository pinned at 1.0.2, a check write initiated by the Inspector, presented with the registered check entry and no substituted subject, to apps/dashboard/web/src/example.spec.ts and to backend/domains/ops/tests/example.test.ts reads allow naming the matched 700 test rule; a task start write initiated by the Engineer to the same paths reads AUTHORITY_ACTION_DENIED naming only the 700 rules, never the 500 root grant.
  - IA-002 -- Under the same bound policy, a round seal write by the human Architect to backend/ddl/example.sql and to backend/blueprints/ops.md reads allow naming the matched 750 architecture rule; a task start write initiated by the Engineer and a check write initiated by the Inspector to the same paths each read AUTHORITY_ACTION_DENIED naming only the 750 rule.
  - IA-003 -- Under the same bound policy, a task start write initiated by the Engineer to apps/dashboard/web/src/example.ts and to backend/domains/ops/README.md reads allow naming the 500 root rules; a check write initiated by the Inspector and a round seal write by the Architect to the same paths each read AUTHORITY_ACTION_DENIED naming only the root rules; docs/index.md, vendor/x.ts, and the escape targets of ADR-AUT-0003 IA-002 read what they read before this record.
  - IA-004 -- The compiled extension carries on every root rule exactly task start, on every test rule exactly check, and on every architecture rule exactly init apply architect, release export, round plan, and round seal; round run and task finish appear on no extension rule; one registry-derived function produces the sets and a test freezes them at these values, so a registry change that would admit a verb to a class fails a test instead of granting silently.
  - IA-005 -- law/policy/action-registry.json and its three generated views are byte-identical before and after this record, no action admits a new human role or harness initiator, and the immutable core rules and the package extension devai-adopter-authority materialize byte-identically; a task start request declared by the Inspector and a check request declared by the Engineer read AUTHORITY_HUMAN_ROLE_DENIED at the declaration boundary before any rule.
  - IA-006 -- The packed tarball, installed in a disposable adopter that binds the reference source, reproduces the Inspector allow and the Engineer deny of IA-001 and the Architect allow and the Engineer deny of IA-002 through the installed bin under the registered verbs, and the adopter page decision matrix names, per cell, the verb it was decided under and the code it reads.
---

# Registered write verbs per path class for adopter path authority

## Status

Accepted on 2026-09-30 by the Architect, after the Owner accepted on
2026-09-30 the fix for the gap the R-0502 Inspector verified on TASK-0522 of
campaign CMP-0005: a record that defines which verbs each class rule carries.
Proposed and accepted on the same day; it opens with round R-0503 of
CMP-0005 as wave CTG-0532. It narrows the verb clause of ADR-AUT-0003 only:
the roots grammar, the class ladder, the subjects clause (Owner decision (j)
of CMP-0005, the harness subject bound to the class role), the constitution
gate, the materialization, the receipt provenance, and the drift behaviour of
ADR-AUT-0003 are unchanged and that record is not edited. One choice the
Owner had not made is decided here under the Owner's acceptance of the fix:
the class rules name existing registered actions per class role, derived from
the action registry, and no action of the registry admits a new role or
initiator. Restoring a human Inspector write action so the core `**/tests/**`
rows compile again stays the deferred core defect the proposal names; it is
not decided here.

## Context

ADR-AUT-0003 makes every compiled class rule carry the Engineer write verbs
`round run`, `task start`, and `task finish`, as the package extension rule
`adopter-engineer-packages` does, whatever the class role. The broker decides
a filesystem target in two steps before any rule is read: it classifies the
canonical path into a filesystem capability
(`packages/authority/src/capabilities/path-domains.ts`) and refuses
`AUTHORITY_PATH_DOMAIN_VIOLATION` unless the action's authority contract
carries that capability; every path under a declared adopter root classifies
as `fs:workspace`. Then the declaration boundary admits the request only when
the registry's subject for the action names the session role
(`AUTHORITY_HUMAN_ROLE_DENIED` otherwise). In the registered action registry,
`round run` and `task finish` carry no `fs:workspace`, so neither can reach
an adopter root at all, and `task start` is the only one of the three that
carries it, with a harness subject initiated by the Engineer only. The
Inspector, whose class is the test class, and the Architect, whose class is
the architecture class, therefore cannot write their granted paths under a
declared root through any registered action: the R-0502 decision test reaches
the class rules only by substituting the subject of the `task start` entry
with the requested role, which proves the ladder and proves nothing about a
real Inspector or Architect write. The registry has no human Inspector write
action at all, which is why the core `**/test/**` and `**/tests/**` rows of
`policy-core-rules.ts`, built from `subjectGroups(entries).inspector`, compile
to no rule today; the proposal records that defect as outside #186.

The resolver (`packages/authority/src/runtime/policy-resolver.ts`)
classifies a target by selector match alone, keeps the rules of the highest
matched precedence, and refuses `AUTHORITY_ACTION_DENIED` when none of them
carries the requested action; it never falls through to a lower precedence.
A class rule that carries only its own role's verbs therefore stops a request
under another class's verb at the class precedence, which is the property the
ladder needs. No host-enforcement adapter for editors, shells, or external
agents is declared in the runtime today: Article 6 requires one for writes
outside the runtime and requires DEVAI to report that boundary rather than
imply control, so no action id exists for a host-mediated write and this
record invents none.

## Decision

**Verbs by class.** A class rule carries exactly the registered write actions
by which its class role performs governed workspace writes. For a class role
`R`, that set is every registry entry whose effect is not `read`, whose
authority contract carries the capability `fs:workspace`, and whose subject is
either the human subject admitting `R` or the harness subject whose initiator
set is exactly `{R}`. Under the registered action registry the sets are:

- root rules (`adopter-path-root-<R>` and `adopter-path-root-<R>-tree`,
  Engineer, 500): `task start`;
- test rules (`adopter-path-test-<R>-<n>`, Inspector, 700): `check`;
- architecture rules (`adopter-path-architecture-<R>-<n>`, Architect, 750):
  `init apply architect`, `release export`, `round plan`, `round seal`.

`round run` and `task finish` leave the extension: neither carries
`fs:workspace`, so neither could reach a root path, and their presence only
suggested a grant that never existed. `check` is the Inspector's registered
workspace write verb, as the package extension already binds it for the
Inspector on its git-ref and database selectors, and the Architect set is the
subset of the human Architect verbs the core `law/**` rows carry that can
present a workspace target. The subjects of every class rule stay as
ADR-AUT-0003 states, the human class role and the harness subject initiated
by that role, so a human-only verb and a harness-only verb each match one of
the two.

**Derivation, not a list.** `packages/cli/src/authority/policy-support.ts`
gains one function beside `subjectGroups` that computes the three sets from
the registry entries by the rule above; the compiler
`compileAdopterAuthorityExtension` takes the sets as an input in place of its
constant and stays pure; `buildTrustedAuthoritySources` and the bind
(`compileAdopterPolicyAuthority`) pass the registry they already hold. The
extension digest therefore covers the verb sets: a package whose registry
changes a set makes the bound extension drift, which Doctor reports and
`init bind --adopter-policy` repairs, exactly as a package version change
does today. When a human Inspector write action is registered by a later
record, the test class admits it by this derivation without a further record;
a contract test freezes the current sets so that admission is a reviewed diff.

**No registry change.** The action registry admits no new role or initiator
for any action. Admitting the Inspector to `task start` is rejected: it would
grant the Inspector the task-spawn transition with its database write, its
git-ref rules, and its process capabilities to reach one filesystem grant, and
it would widen the core `**/tests/**` rows by a side effect of an adopter
record. Because the registry's subject admission and the class verbs now name
the same role, a cross-role request under a class verb is refused at the
declaration boundary, and a same-role request under another class's verb is
refused at the class precedence with `AUTHORITY_ACTION_DENIED`; the
`AUTHORITY_SUBJECT_DENIED` cells of the ADR-AUT-0003 matrix become
`AUTHORITY_ACTION_DENIED`, and the adopter page names, per cell, the verb it
was decided under. Core rows, `docs/`, unclassified paths, and escapes are
unchanged.

**Host boundary.** A host-enforcement adapter, when one is declared, presents
a registered action whose subject admits the session role; this derivation
then admits it to the class of that role. Until then the runtime reports
editor and shell writes as outside its control, as Article 6 requires.

## Consequences

An Inspector session and an Architect session can now write their granted
paths under a declared root through the verbs the runtime actually admits
them to, and the acceptance matrix is driven with the registered entries and
no substituted subject. Each extension rule names fewer verbs and each role's
verbs appear on one class only, so a verb mismatch is refused at the class
precedence and a rule can no longer be read as granting a role a verb the
registry withholds. The price is that the compiled bytes of every bound
adopter extension change once, so an adopter that bound under the R-0502
rules rebinds with the package that carries this record; no such adopter
exists before the release of CMP-0005. The Architect set carries verbs that no
Architect would use to write a DDL file; they are admitted because the role's
registered write set is the unit of admission, as the core `law/**` rows
already treat it, and naming a hand-picked subset would make the list, not the
registry, the authority.

## Alternatives Considered

Keeping the Engineer verbs on every class and testing the ladder with
substituted subjects is rejected: it proves a precedence order and no real
write. Admitting the Inspector, and by symmetry the Architect, to `task start`
is rejected as a widening of two registry subjects and of the core rows for
one filesystem grant. A hand-written verb list per class inside the compiler
is rejected because the registry is the law source for what each role may
invoke and a list would drift from it silently; the derivation plus a frozen
contract test keeps the registry authoritative and the change visible.
Inventing an action id for host-mediated writes is rejected because no
adapter is declared and Article 6 forbids implying control the runtime does
not possess. Restoring a human Inspector write action is a change to the
registry and to the core rows, outside this campaign, and stays deferred.

## Affected Rules

- `packages/cli/src/authority/policy-support.ts`: the registry-derived class
  write verb sets beside `subjectGroups`.
- `packages/cli/src/authority/policy-adopter-extension.ts`: the compiler
  takes the class verb sets as an input and drops its Engineer verb constant.
- `packages/cli/src/authority/policy.ts` and
  `packages/cli/src/services/adopter-policy.ts`: the trusted sources and the
  bind pass the registry entries to the compiler.
- `packages/cli/scripts/installed-tarball-smoke.mjs`: the packed rehearsal
  drives the matrix probes under the registered verbs.
- `docs/adopters/path-authority.md`: the verb clause and the decision matrix
  name the verb per cell and the codes this record fixes.

## Inspector Adversarial Acceptance

Bind the reference source in a fixture repository pinned at 1.0.2 and drive
the broker with the registry entries exactly as registered: `check` declared
by the Inspector, `task start` declared by the Engineer, and `round seal`
declared by the Architect. Confirm every allow and every deny of IA-001,
IA-002, and IA-003 by code and by the matched rule ids, and confirm that no
deny under a class verb names a rule of a lower precedence. Declare `task
start` as the Inspector and `check` as the Engineer and confirm
`AUTHORITY_HUMAN_ROLE_DENIED` before any rule. Read the compiled extension and
confirm the exact verb sets of IA-004 on every rule of every root; compute the
sets from the registry with the derivation and confirm the two agree. Diff
the action registry, its generated views, and a policy materialized without
an adopter block before and after; confirm byte identity. Pack the tarball,
install it in a disposable adopter, bind the reference source, and repeat the
four probes of IA-006 through the installed bin. Read the adopter page and
confirm the matrix names a verb and a code per cell that the probes reproduce.
