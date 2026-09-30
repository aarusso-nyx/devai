# Multi-stack path authority proposal

Status: proposed. Drafted 2026-09-30 for Owner and Architect review. Nothing
here binds until ADR-GOV-0024 and ADR-AUT-0003 are accepted and campaign
CMP-0005 is accepted; no constitution text, policy, or materialized file has
been edited. It answers issue #186 (support governed multi-stack path
authority for adopter repositories), deferred by decision 7 of the
[harness convergence campaign](harness-convergence-campaign/README.md) and
sketched in the
[extension proposal](harness-convergence-extension-proposal.md).

## The issue restated

DETRAN is a multi-stack monorepo. Its Owner approved treating
`{src, backend, frontend, apps, mobile, portal}/<segment>` like today's
`src/<segment>` for path authority, with path classes taking precedence over
the root grant: application source and the local implementation `README.md`
to Engineer; tests, including colocated `*.spec.*` and `*.test.*` files and
`test/` or `tests/` directories, to Inspector; architectural blueprints and
DDL to Architect; canonical `docs/` to Architect. Only `apps/` and `backend/`
exist today; the policy must be expressible for the whole set. A blanket
Engineer grant on `apps/**` would hand 690 test-like paths and 70 DDL files to
the wrong role. The issue asks for a package-supported, adopter-authored,
versioned source, materialized by `init bind` into `authority-policy.json`
with receipt and digest, verified by Doctor and the runtime, with immutable
core rules, explicit testable precedence, denial of ambiguity, deterministic
materialization, drift detection, a migration path, and fail-closed handling
of invalid or removed rules; if Article 6 cannot express it, a versioned
constitutional and schema change rather than a hand edit. Acceptance is real
broker decisions for a stated matrix, byte-stable rebinding, and drift
detection. DETRAN CTG-0005 is the adoption point and needs a published
package.

## Checked against this checkout

Main at `d21abb74`, after v1.7.0.

- **The schema is closed and has no authority field. Holds.**
  `law/schemas/adopter-policy.schema.json:7` sets `additionalProperties:
false`; its properties are `project`, `ci_economy`, `release_verification`,
  `domains`, `thresholds`, `scorecard_na`, and `glob_guards`.
- **`init bind --adopter-policy` materializes no authority rule source.
  Holds, with a nuance.** `packages/cli/src/services/adopter-policy.ts:26`
  lists the six targets (project, domains, thresholds, scorecard N/A, glob
  guards, release verification) and `:87` refuses any other key. But
  `packages/cli/src/commands/init/bind-adapters.ts:249` already
  re-materializes `.devai/config/authority-policy.json` right after the
  projection, from package sources only.
- **No filesystem rule for `apps/` or `backend/`. Holds for the framework's
  own policy and, by the DETRAN report, for DETRAN's.** The materialized
  policy of this checkout carries 92 rules; every filesystem rule is a core
  row or the package extension `devai-adopter-authority`
  (`packages/cli/src/authority/policy-additive-rules.ts:85`, `packages/**`
  at 500). No adopter-authored input reaches
  `buildTrustedAuthoritySources` (`packages/cli/src/authority/policy.ts`).
- **The existing Inspector glob does not cover colocated spec files. Holds,
  and it is worse than stated.** The core rows `**/test/**` and
  `**/tests/**` (`policy-core-rules.ts:249`) are compiled from
  `groups.inspector`, the human Inspector actions with a write effect
  (`policy-support.ts:125`); `rule()` returns nothing for an empty action set
  (`policy-support.ts:102`), and `law/policy/action-registry.json` declares
  no human Inspector write action. This checkout's materialized policy holds
  no rule with a human Inspector subject on a filesystem selector at all. An
  Inspector's test write through the runtime is admitted only by the harness
  subject of the Engineer `packages/**` rule, which admits every initiator
  role. DETRAN's report says its 1.5.6 policy carries the two rows; not
  re-verified here.
- **Article 6 cannot represent class precedence. Holds.**
  `law/constitution.md:86` decides authority "by a fixed path prefix of at
  most two segments — a table lookup, never a wildcard rule with a default
  remainder"; `:101` admits additive client extensions of "the path mapping".
  `apps/dashboard/web/src/example.ts` and `.../example.spec.ts` share every
  prefix, and a root grant with class exceptions is a wildcard rule with a
  default remainder. Article 9 (`:133`) makes a change to Articles 6 to 10 a
  constitutional amendment and forbids a policy artifact from doing it
  implicitly.
- **The runtime already has the mechanism the design needs.** Not claimed by
  the issue; found here. The resolver matches minimatch globs and keeps the
  rules of the highest numeric precedence
  (`packages/authority/src/runtime/policy-resolver.ts:237`), denies an
  unmatched path with `UNCLASSIFIED_RESOURCE` (`:317`) and equal-precedence
  rules of different effect with `AMBIGUOUS_POLICY_MATCH` (`:370`); equal
  precedence and equal effect union their subjects. Precedence is the enum
  500, 650, 700, 750, 800, 900, 1000 and effect admits `deny`
  (`law/schemas/authority-policy.schema.json:623`). The materializer accepts a
  list of additive extensions, refuses a duplicate extension id or rule id,
  and refuses an extension rule with a core selector at or above the core
  precedence (`policy-materializer.ts:146`, `:167`). The loader recomputes
  every extension from its source bytes and refuses a stale file with
  `AUTHORITY_POLICY_DIGEST_MISMATCH` (`policy-loader.ts:188`). The same
  builder feeds the broker before every governed write (`broker.ts:260`),
  `init bind` at commit time (`:1361`), and Doctor
  (`doctor-install-checks.ts:184`), which compares `additive_extensions` and
  the resolved digest. Repository escapes are refused before any rule
  (`broker-paths.ts:78`, `:89`, `:102`, `:106`).
- **Not verified.** DETRAN's inventory counts (690, 70, 69) and the state of
  its installed policy come from the issue and the R-0020 report
  (`A3.4-path-policy-feasibility.md`, read on 2026-09-30). The packed
  behaviour of v1.7.0 was not exercised.

## Design options

1. **Where the norm lives.** (A1) Amend Article 6: keep the core table
   immutable and admit client extensions by declared root and path class
   with a fixed ladder; constitution 1.1.0. (A2) Stay inside the current
   grammar with an extension table of fixed prefixes: cannot separate
   `example.ts` from `example.spec.ts`, so tests and DDL go to Engineer with
   the root; fails requirements 2 and 3. (A3) Read the existing extension
   sentence as already admitting glob rules with precedence: no amendment,
   but Article 9 forbids widening Article 6 through a policy artifact, and
   the issue asks for a versioned change.
2. **Where the source lives.** (B1) An `authority` block in the adopter
   policy: one verb, one receipt, one `policy_version`, ADR-CFG-0002
   atomicity and Doctor coverage already exist, and the bind already
   re-materializes the authority policy. (B2) A separate governed file with
   its own bind flag: a second receipt, a second drift check, and a second
   verb to document.
3. **How precedence is decided.** (C1) A fixed class ladder with fixed roles:
   root at 500 (Engineer), test at 700 (Inspector), architecture at 750
   (Architect); precedence between any two rules is proven by construction
   and a valid source cannot produce two rules of equal precedence with
   different roles; the resolver additionally denies extension ties at run
   time. (C2) Adopter-declared ordered rules with a precedence each: more
   expressive, but overlap between two globs at equal precedence is
   undecidable in general and needs a witness heuristic at bind time.
4. **Which roots.** (D1) Adopter-declared single segments under a closed
   grammar (no separator, no dot segment, no glob, not a core-table prefix,
   no root nested in another). (D2) The fixed six of the issue: a seventh
   root needs a package release; the spelling of a root is not what makes
   it safe.
5. **Existing adopters and the framework itself.** (E1) The framework
   declares `packages` as a root so `packages/*/tests/**` gets an enforced
   Inspector class through the same mechanism. (E2) The framework declares
   no roots; the feature is proved in a packed disposable adopter and by
   DETRAN's rehearsal. Adopters without the block are unchanged either way.
6. **The release.** (F1) One immutable release after R-0503, recommended
   1.8.0 (the `feat` floor since v1.7.0), told to DETRAN. (F2) 2.0.0 if the
   Owner treats a constitutional amendment as breaking. (F3) No release in
   this campaign: DETRAN cannot adopt.
7. **Subjects.** The package rule `packages/**` binds the harness subject
   with any initiator. The class rules must bind the harness subject to the
   class role (`harnessSubject(['inspector'])` and so on) or an Inspector
   harness write to source is admitted; the matrix requires it denied.

## Recommended design

A1 + B1 + C1 + D1 + E2 + F1, drafted in
[ADR-GOV-0024](../../../law/adr/ADR-GOV-0024-article-6-client-extensions-by-root-and-class.md)
(the amendment, with the exact amended text and the version bump) and
[ADR-AUT-0003](../../../law/adr/ADR-AUT-0003-governed-adopter-path-authority.md)
(the source grammar, the compiler, materialization, enforcement, drift, and
migration). In one paragraph: the adopter policy gains an `authority` block
(`extension_id`, `roots`, `classes.test`, `classes.architecture`); a pure
compiler turns it into an extension document with, per root, two root rules
at 500 for Engineer, one rule per test selector at 700 for Inspector, and one
rule per architecture selector at 750 for Architect, each binding the human
role and the harness subject initiated by that role; the default test
selectors are a law source under `law/policy/adopter-defaults/`; the compiler
refuses a source bound under a constitution below 1.1.0 and every malformed
source with a named code; `buildTrustedAuthoritySources` appends the compiled
document as the second additive extension, so the existing digests, the
non-additive check, the loader's refusal of stale bytes, and Doctor's
comparison all cover it without new machinery; the receipt gains an
`authority_extension` field; local READMEs are the root remainder and
canonical `docs/` stays core.

## Rounds

| Round  | Title                                           | Records                    | Outcome                                                                                                                                                                |
| ------ | ----------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-0501 | Amendment and adopter authority source contract | ADR-GOV-0024, ADR-AUT-0003 | Constitution 1.1.0 applied and the framework pin rebound; schema block; pure compiler with the ladder and every refusal code; adopter page                             |
| R-0502 | Materialization and broker enforcement          | ADR-AUT-0003               | Default test class as law; second additive extension with receipt provenance, byte-stable; the matrix as real broker decisions; extension ties denied                  |
| R-0503 | Doctor drift, migration, and adoption rehearsal | ADR-AUT-0003               | Doctor names drifted, unbound, or missing sources with the rebind command; migration documented; packed-adopter rehearsal through the installed bin; release published |

Each round is one coupled triplet (architect, inspector, engineer) with
prompts TASK-0511 to TASK-0533 under
`product/campaigns/CMP-0005-multi-stack-path-authority/`.

## Sequencing

- OE-01 (approve the amendment and answer the decisions) precedes R-0501;
  the Architect then accepts both records and TASK-0511 applies the text.
- R-0502 depends on R-0501: the compiler exists before it is wired into the
  trusted sources, so the R-0501 engineer task never touches
  `policy.ts` and the broker.
- R-0503 depends on R-0502 and cannot close before OE-02 publishes the
  release, as R-0308 closed after OE-07.
- CMP-0004 (trustworthy observations) touches `broker.ts` and the sensing
  admission (ADR-AUT-0002); R-0502 touches `policy.ts`, `policy-support.ts`,
  and the resolver. Run CTG-0411 and CTG-0521 in separate rounds of the
  calendar, not concurrently.

## Separate Owner effects

- OE-01: approve the amended Article 6 text and the constitution version, and
  answer the decisions below.
- OE-02: publish the release that carries the campaign and tell DETRAN the
  version; DETRAN then pins it, rebinds the constitution at 1.1.0, binds its
  source, and runs Doctor and the matrix in a clone before claiming
  enforcement (CTG-0005). The clone rehearsal on DETRAN's candidate is
  DETRAN's, not this campaign's.

## Non-decisions

- The historical R-0020 READMEs and their archival disposition (A3.4-P2):
  this campaign governs future writes only.
- Restoring a human Inspector write action so the core `**/tests/**` rows
  compile again: a defect of the core, outside #186; a candidate for a later
  AUT record.
- Host enforcement of editor and shell writes: Article 6's declared
  host-enforcement adapter boundary is unchanged.
- The wording of DETRAN's own `authority` block: the reference source in
  ADR-AUT-0003 is a fixture, not DETRAN's policy.

## Decisions required

Each item names the question, the options with consequences, the
recommendation the drafts take, and what changes if the Owner chooses
otherwise. The ledger records the answers under OE-01.

- **(a) Amend Article 6, and to which version.** A1 amends (recommended,
  1.1.0); A2 cannot meet requirements 2 and 3; A3 has no amendment but
  contradicts Article 9. Under A2 or A3: ADR-GOV-0024 is rejected, TASK-0511
  loses `law/constitution.md`, the pin, and the authority policy from its
  boundary, the constitution gate leaves ADR-AUT-0003 and TASK-0513, and the
  amendment test leaves TASK-0512. Version 1.0.2 instead of 1.1.0 changes
  only the markers in ADR-GOV-0024, the gate threshold, and TASK-0511.
- **(b) The source.** B1, a block in the adopter policy (recommended); B2, a
  separate file and flag. Under B2: the schema block moves to a new
  `law/schemas/authority-extension.schema.json`, `init bind` gains
  `--authority-extension`, a second receipt is written, and TASK-0511,
  TASK-0513, TASK-0523, TASK-0533, and the adopter page change accordingly.
- **(c) Precedence.** C1, a fixed class ladder (recommended); C2, declared
  precedence per rule. Under C2: the block gains a `precedence` per selector,
  the compiler gains a pairwise witness check, TASK-0512 and TASK-0522 gain
  overlap fixtures, and the resolver tie denial of TASK-0523 becomes the
  only guarantee.
- **(d) Roots.** D1, adopter-declared (recommended); D2, the fixed six.
  Under D2: `roots` becomes a closed enum in the schema (TASK-0511) and the
  root grammar tests of TASK-0512 shrink to the enum.
- **(e) Migration and dogfood.** E2, the framework declares no roots
  (recommended); E1, the framework declares `packages`. Under E1: TASK-0533
  (or a fourth single-role task in R-0503) adds the block to
  `law/policy/devai-adoption.json`, bumps its `policy_version`, and rebinds
  (`law` with its generated copies), and the freeze of the framework's own
  policy in the smoke changes.
- **(f) Release.** F1, one release after R-0503 at 1.8.0 (recommended); F2,
  2.0.0; F3, none. Under F2 only OE-02's text changes; under F3 OE-02 is
  removed, R-0503 loses `owner_effects_required`, and DETRAN adoption waits.
- **(g) Tiers and budgets.** The CMP-0003 pattern is kept: architect tasks at
  tier `architect` (high, 60 to 120 minutes; TASK-0531 is medium),
  inspector and engineer tasks at `worker-high` (high, 120 to 180 minutes).
  No deviation is proposed; an Owner who wants `worker` for TASK-0531 or
  TASK-0532 changes only the ledger and the two prompts.
- **(h) Runtime effect of a source edited after binding.** Refuse every
  governed write until rebind (recommended; it is what the loader does today
  for any digest mismatch and Doctor names the command); or keep the last
  bound extension and refuse only the paths it governs, which would need a
  partial policy the loader has no notion of. Under the alternative,
  TASK-0523 and TASK-0522 change and ADR-AUT-0003 is revised before
  acceptance.
- **(i) Nested `docs` directories under a root.** Engineer by remainder,
  with an adopter free to name `**/docs/**` in its architecture class
  (recommended); or a package default architecture selector `**/docs/**`.
  Under the alternative, `path-authority-classes.json` gains an architecture
  default (TASK-0521) and the matrix gains a row (TASK-0522).
- **(j) The harness subject of class rules.** Bound to the class role
  (recommended, required by the matrix); or any initiator as the package
  `packages/**` rule does, which would admit an Inspector harness write to
  source. No draft takes the alternative.
