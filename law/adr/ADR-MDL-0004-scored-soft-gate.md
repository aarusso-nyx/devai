---
id: ADR-MDL-0004
title: Independent scored soft gate evidence preserves generic review contracts
type: adr
status: accepted
date: 2026-10-02
authority: Architect
supersedes:
  - ADR-MDL-0003
provenance:
  - ADR-MDL-0003
  - docs/dev/operations/open-issue-closure-campaign/execution-discipline.md
  - docs/dev/operations/open-issue-closure-campaign/ci-invariant-contract.md
affected_rules:
  - law/schemas/soft-gate-score.schema.json
  - law/schemas/soft-gate-rubric.schema.json
  - law/schemas/soft-gate-evidence.schema.json
  - law/schemas/soft-gate-trust.schema.json
  - law/schemas/thresholds.schema.json
  - law/policy/soft-gate-rubric.json
  - law/policy/thresholds.json
  - law/policy/sensor-notes/llm_judge.md
  - packages/sensors/src/judge.ts
  - packages/sensors/src/ci-invariant-gate.ts
  - packages/skills/src/model-bridge/index.ts
  - packages/skills/src/model-bridge/soft-gate-observation.ts
  - packages/schemas/src/roster.ts
  - packages/schemas/src/reply-extract.ts
  - scripts/process/produce-ci-invariant-evidence.mjs
  - scripts/process/fetch-ci-invariant-evidence.mjs
  - scripts/process/check-ci-invariant-gate.mjs
inspector_acceptance:
  - IA-001 -- A valid legacy generic review still validates byte-exactly; a scored reply cannot substitute for triage or generic review.
  - IA-002 -- One dimension at2 or fractional/unknown score refuses; four3 scores pass only with verdict pass and complete valid observations/citations. High scores with review/fail block; unknown is an evidence error.
  - IA-003 -- Missing observations yield error; score0 requires a demonstrated contradiction and confidence never overrides a low dimension.
  - IA-004 -- Wrong candidate/tree/base/control/input/reply/envelope/configuration digest, stale or future evidence, duplicated keys or noncanonical manifest bytes refuse.
  - IA-005 -- Candidate-provided keys, incompatible key types, malformed base64/SPKI, wrong key identity or non64byte detached signatures refuse.
  - IA-006 -- Actual tool/MCP events, inherited configuration, incomplete inventory, absent positive completion, errors and truncation refuse even when a signature is valid.
  - IA-007 -- Same working/evaluator identity, declaration-only isolation or mutation after verification refuses before gate consumption.
  - IA-008 -- Wrong repository/ref selection, redirect, missing/extra/unsafe members, symlinks/submodules, bounds breach or transport ambiguity refuse without automatic retries.
  - IA-009 -- Only the exact declared public trust variable seam is allowed; secrets/other vars/bracket/whole-context/duplicate/relocated reads remain refused.
  - IA-010 -- A PR-head artifact cannot admit a moved PR/base or merge-group head; missing new independent evidence blocks without CI provider initiation.
---

# Independent scored soft gate evidence preserves generic review contracts

## Status

Accepted source decision under CMP0006-OD-EXEC-20261002 and standing Owner autoaccept, following distinct exact Architect review. No implementation, live evaluation, signing, trust setting, publication or deployment is reported. The accepted predecessor stays byte-exact.

## Context

Issue235 requires measured Article18 soft dimensions and distinct evidence custody. A generic verdict/signature/fixture alone cannot demonstrate candidate-specific no-tools/MCP observation or evaluator independence.

## Decision

This adds a separate scored llm_judge mode. Every unchanged transport/extraction/isolation/completion clause of ADR-MDL-0003 remains binding; generic review-verdict and triage schemas/projections stay byte-exact. No new public action or implicit provider dispatch is added.

The fully required soft-gate-score reply has four integer0..4 dimensions and per-dimension structured citation arrays. PASS requires verdict=pass, every score>=3 independently and complete valid observed evidence. Verdict review/fail blocks admission even with four high scores; unknown or invalid evidence is an evidence error, never PASS. Locations are L<line>, L<start>-L<end> or #<anchor>; citations resolve actual frozen source bytes, increasing valid lines and existing anchors. Missing observation is an error;0 requires a demonstrated contradiction. Rubric levels are deterministic criteria, not confidence or average/mutation substitutes. Original hard thresholds remain unchanged.

# R-0602 exact soft-evidence custody source proposal

This proposal resolves the REVIEW transport gap within CMP0006-OD-EXEC-20261002. It selects a source-only evidence transport, not a new runtime action, release format, automatic provider call or performed external effect. Required credentials/custody/no-tool support remain technical gates. It does not assert their availability.

## Selected producer, store and trust root

A trusted source producer explicitly invoked under the Owner-initiated campaign and its concrete OE-04 envelope, scripts/process/produce-ci-invariant-evidence.mjs, is executed by a custodian distinct from the working source agent. Its exact reviewed control commit/tree and executable digest are pinned outside the candidate. It calls the registered llm_judge scored mode through the integrated CTG-0661 bridge using a fresh process instance with the verified effective empty tool/MCP/configuration/context boundary. It retains the complete bounded host envelope and selected reply bytes; no self-declared isolated/completed flags supply evidence. The custodian signs only after the host observation verifier and candidate binding checks pass. No signature alone proves execution.

The immutable evidence store is an evidence-only Git commit in the same repository, published through the separate codex/cmp-0006-soft-evidence ref by central. It contains no source change or PR and never targets main. Content-addressed path evidence/<candidate_sha>/<payload_sha256>/ contains manifest.json, score-reply.json, host-envelope bytes, configuration/help/inventory observations and detached signature. Git object identity plus Ed25519 authentication binds exact bytes. Only exact commit selection is admitted; ref HEAD/latest/date/name lookup is never an admission source. The ref is merely reachability for fetching the already-pinned object.

External trust input DEVAI_SOFT_GATE_TRUST_JSON is a separately controlled GitHub repository variable, changed by central only through a concrete single-use effect packet after review. It is supplied to the PR job through vars, not read from the candidate law/config/fixture. It is a closed object binding schema version, evidence commit, payload SHA-256, producer control commit/tree/digest, custodian verification public key and key identity, working-agent identity, candidate commit/tree/base, and expiration. Read permission remains contents:read. No private key/credential is stored in law, candidate, variables or artifact. The signing key is held independently; unavailable custody or independently controlled trust input blocks publication/admission. This proposal does not infer permission to read any protected private signing material.

The exact Ed25519 signed bytes are UTF-8 domain separator DEVAI-SOFT-GATE-EVIDENCE-V1 followed by LF and canonical manifest JSON with an explicit sorted-key canonicalization version. Manifest members are unique contained relative paths with byte length and SHA-256; each member's bytes are hashed before transformation. The score reply and original host envelope have separate exact digests. If diagnostics are sanitized, metadata records original digest only when computed before sanitization; admission uses the retained evidence-preserving transformed stream and rejects sanitization that obscures completion/isolation. Original and transformed digests are never interchanged. The signature uses the key from external trust input, never a key supplied inside the artifact. Root controls the exact public trust key/producer identity through normal separate custody; source workers cannot nominate themselves independent observers.

## Provider-free fetch and validation

scripts/process/fetch-ci-invariant-evidence.mjs validates the external trust schema, reads the exact evidence commit with repository read credentials through bounded fixed-repository GitHub HTTPS commit/tree/blob endpoints, and retrieves only blob members named by the signed manifest into a new contained scratch directory. It invokes no provider, signs nothing and creates no runtime proof. Git blobs avoid unsafe archive extraction. Ref/commit ambiguity, wrong repository, symbolic links/submodules/nonblob entries, path traversal/absolute paths, duplicates, missing/unlisted members, unreachable/missing evidence, invalid signature/control identity/key/digest, expired trust and unknown fields refuse before candidate admission. Bound manifest to <=1MiB, <=64 files, each <=16MiB and total <=32MiB; network/fetch timeout 60s, one attempt, no automatic retry. Retain bounded redacted refusal logs.

scripts/process/check-ci-invariant-gate.mjs consumes only the verified object produced by fetch plus exact independently observed hard check outputs and current git identity. Typed packages/sensors/src/ci-invariant-gate.ts verifies schema/canonical scores/threshold comparator, every digest and actual host-observation result, strict candidate commit/tree/base and <=24h freshness with no future timestamps. For pull_request use the checked-out PR head and exact event base; for merge_group use the merge-group head/base. An artifact for a PR head cannot substitute for the merge-group candidate. New candidates require a new separately initiated evaluation/trust selection; absence blocks without provider initiation.

The existing PR workflow remains nonattesting. It neither establishes custodian independence itself nor weakens absent evidence to not-required/PASS. The source-focused validator tests can pass while actual end-to-end admission remains blocked pending the real artifact. Central may perform exact evidence-ref and external trust-tuple effects before PR admission using the independently reviewed immutable producer control checkpoint and concrete single-use effect packets; producer code need not already be merged. This avoids a PR-A bootstrap cycle and adds no source PR. performed_at remains unset until observed.

## Host-observation verification seam

packages/skills/src/model-bridge/soft-gate-observation.ts consumes the integrated CTG-0661 adapter's exact bounded event/envelope bytes and effective-control observation. It verifies actual executable path/version/help digest, control argv/config precedence/digests, explicitly empty tool inventory, explicitly empty MCP inventory, absence of inherited hooks/plugins/agents/conversation, distinct working/evaluator process identities and positive terminal completion. Unknown/unsupported controls, incomplete inventory or precedence, tool/MCP request, refusal, error, truncation, ambiguous final, or signature of a declaration rather than observation refuses. Claude/Codex exact completion and structured marker rules remain those of ADR-MDL-0003. Selected reply bytes are extracted through that same validated adapter path and revalidated against the separate fully required soft-gate-score schema. Do not reconstruct provider success from sanitized prose. Any existing adapter change or llm_judge-note change serializes behind CTG-0661 frozen acceptance/released locks and exact new-head revalidation.

## Exact additional role paths

Architect: law/schemas/soft-gate-score.schema.json, soft-gate-rubric.schema.json, soft-gate-evidence.schema.json, soft-gate-trust.schema.json, thresholds.schema.json; law/policy/soft-gate-rubric.json; law/policy/thresholds.json; law/adr/ADR-MDL-0004-scored-soft-gate.md; ci-invariant-contract.md. Separate later locked sensor-note amendment preserves current generic identity/standing/tier. Strict scored reply includes required per-dimension citation arrays (contained source path, anchor/line and source-byte digest), not one vague free-text rationale. Scores are integers0..4 and every dimension>=3; missing observation is error, zero is demonstrated contradiction. Generic review-verdict stays byte-exact.

Inspector: tests/contract/cmp0006-soft-gate.contract.test.ts; tests/contract/cmp0006-soft-evidence-custody.contract.test.ts; packages/skills/tests/model-bridge/soft-gate-observation.test.ts; packages/schemas/tests/unit/soft-gate-schema.test.ts; original CTG0622 suites. Prove artifact/key/control/candidate substitution, stale/future evidence, same/shared evaluator, unavailable controls, declaration-only isolation, hidden tool/MCP/failure events, transformed reply mismatch, exact dimension3/2 boundaries, fractional/unknown scores, malformed citations and absent trust. Preserve all legacy review/projection tests.

Engineer: packages/sensors/src/judge.ts, ci-invariant-gate.ts; packages/cli/src/commands/sense/adapters.ts; packages/schemas/src/roster.ts, reply-extract.ts; packages/skills/src/bootstrap/policy-content.ts; packages/skills/src/model-bridge/soft-gate-observation.ts; scripts/process/produce-ci-invariant-evidence.mjs, fetch-ci-invariant-evidence.mjs, check-ci-invariant-gate.mjs; existing workflow/parser paths. Actual producer/bridge orchestration needs exact transcript/control seam from CTG0661; any edit to its index/extract source or tests is listed as deferred serialized shared scope, never concurrent acquisition.

No external effect is performed by this source proposal. The final live gate cannot pass with synthetic tests, a worker's self-signature, unsupported no-tool/MCP isolation, missing independent custodian or unperformed trusted-variable/evidence publication. These are exact prerequisites, not scope ambiguity or permission to fabricate readiness.

## Binding review resolutions — 2026-10-02

These clauses replace any less precise preceding phrasing. The Owner has already
initiated/authorized the campaign and necessary evaluations. A distinct eligible
evaluator receives one concrete OE-04 invocation envelope with supported
host/model, candidate/context, time/output/cost bounds, no-tool/MCP controls and
stop conditions. No new routine human initiation or ratification is introduced.
Only actual unavailable protected custody/service approval requires help.

The signed unsigned manifest lists payload files only. Exclude manifest.json and
signature.ed25519 from its member roster; allow exactly those two metadata files
besides the named payload population. The evidence commit SHA and manifest's own
digest do not appear inside that manifest. External trust binds both after they
are computed; the directory's content address is the manifest digest. This avoids
circular member/commit/signature hashes.

Canonical bytes are UTF-8 of @devai-nyx/utils canonicalJson, version
DEVAI-CANONICAL-JSON-V1, with no trailing newline. Require byte equality with canonical serialization only for the manifest, external
trust tuple and canonical score projection. Duplicate keys, nonfinite numbers,
extra whitespace and noncanonical spellings refuse in those canonical objects.
Preserve and hash the adapter-selected reply bytes exactly as observed; inherited
structured-output serialization and fenced or prefaced selected replies need not
be canonical JSON. Parse them through the unchanged ADR-MDL-0003 extraction
contract; bind their exact reply digest separately from the canonical projection.
All manifest/trust/score objects are closed schema-valid objects. Signed message
bytes are UTF-8 `DEVAI-SOFT-GATE-EVIDENCE-V1\n` followed by those canonical manifest
bytes. Ed25519 is the only algorithm. External public key is canonical base64 DER
SPKI, round-trip checked; key_id is lowercase SHA-256 of decoded DER bytes.
Detached signature file is exactly64 raw bytes, never inferred text/hex/base64.
Reject incompatible key types, invalid encodings, signature lengths and unknown
canonicalization/version/domain identifiers.

HTTP transport uses only HTTPS api.github.com endpoints for the exact
repository aarusso-nyx/devai, no redirects, no git checkout/fetch/pack/history or
ambient git configuration. Fetch the pinned commit, verify its returned identity,
then its tree and contained immutable blob population. Maximum8 tree levels,
128 object requests, metadata responses<=2MiB each, manifest<=1MiB,64 payload
members, each<=16MiB and total<=32MiB. Streaming counters stop before buffering
beyond any limit; entire operation deadline60s, one attempt/no automatic retries.
Verify reported object IDs/types, truncated flags, sizes and decoded bytes/digests;
HTTP failure, ambiguous tree/member, symlink/submodule, missing/extra objects or
oversized responses refuse. Signed manifests authenticate artifact origin against
the external key; GitHub authentication alone never proves evaluator execution.

Fetch/signature/member/host-observation verification and typed gate consumption
share the actual verified immutable bytes in one process. No serialized
`verified:true` field or candidate-supplied verified object is accepted. Use a
private constructor/opaque result or reopen and fully reverify staged bytes
against the same frozen external trust snapshot immediately before consumption.
Reject any mutation of members/trust/candidate between verification and gate.

The exact additional PR read is `${{ vars.DEVAI_SOFT_GATE_TRUST_JSON }}` only in
the declared provider-free soft-gate fetch/consume step env. Amend the existing
workflow checker and credential policy for precisely this one public trust input.
All secrets, other vars, whole-context expressions, bracket access, duplicated
reads, input relocation and unknown fields remain refused. Add
law/policy/credential-requirements.json, docs/dev/operations/remote-preflight-contract.md,
docs/dev/operations/workflows/pull-request-checks.md and
tests/contract/check-workflows-credentials.contract.test.ts to exact role scope.
This metadata carries no private material. Required trust availability is a gate,
not a default embedded in the candidate.

PR-head and merge-group evidence are distinct exact candidates. Fetch checks
candidate commit/tree/base against the current event snapshot; neither branch
name nor PR number nor ancestor equivalence admits changed inputs. Merge-group
creation/movement requires a newly invoked bounded evaluation and new external
trust selection before admission. Missing/expired/unsupported independent
capabilities stay blocked; the PR job never initiates providers or manufactures
freshness to preserve throughput.

PR transport credential boundary

The fixed evidence repository is public (livevisibility verified2026-10-02). The PR fetch uses bounded unauthenticated fixed GitHub commit/tree/blob HTTPS reads and consumes only the independently controlled public trust variable; it introduces no GitHub token/secret/private credential read. Rate limits, inaccessible/private repository or unavailable evidence failclosed without a secret fallback. The separate central producer/evidence/trust publication effects use their exact separately observed credentials outside the PR job.

Schema field names in this record

The unsigned payload uses candidate(commit/tree/base_commit), producer_control(commit/tree/executable_sha256), working_agent and evaluator identities, created_at, invocation_id, ten bound_inputs digests, exact reply_sha256 and host_envelope_sha256, separate canonical score_projection_sha256, payload_roles and sorted members(path/byte_length/sha256). Every payload role is a distinct listed contained member. The external tuple additionally pins evidence_commit, payload_sha256, custodian_id/evaluator_identity, key/SPKI identity, selection time and expiration. Semantic equality, canonical NFC paths, exact population, summed byte bounds, source citations, agent independence, times and actual observations are rechecked by the typed gate; schema validity alone is not evidence. Blob JSON wire bodies have an explicit separate streaming bound of2MiB plus twice base64 encoded declared raw size, bounded by the16MiB raw member limit; metadata2MiB limits apply to commit/tree responses, not decoded payload bodies. Refuse before buffering beyond raw/encoded/global/deadline bounds.

## Consequences

This makes the declared producer/validator boundary reviewable and testable. Missing observations or custody remain explicit refusals. Source checks establish only their declared source result; final candidate and actual effect gates remain mandatory.

## Alternatives Considered

Blanket exceptions, inferred successful observations, candidate-selected trust and weakening existing assertions or permissions are rejected. Reusing independent exact content-addressed evidence is permitted only when every bound input matches.

## Affected Rules

- law/schemas/soft-gate-score.schema.json
- law/schemas/soft-gate-rubric.schema.json
- law/schemas/soft-gate-evidence.schema.json
- law/schemas/soft-gate-trust.schema.json
- law/schemas/thresholds.schema.json
- law/policy/soft-gate-rubric.json
- law/policy/thresholds.json
- law/policy/sensor-notes/llm_judge.md
- packages/sensors/src/judge.ts
- packages/sensors/src/ci-invariant-gate.ts
- packages/skills/src/model-bridge/index.ts
- packages/skills/src/model-bridge/soft-gate-observation.ts
- packages/schemas/src/roster.ts
- packages/schemas/src/reply-extract.ts
- scripts/process/produce-ci-invariant-evidence.mjs
- scripts/process/fetch-ci-invariant-evidence.mjs
- scripts/process/check-ci-invariant-gate.mjs

## Inspector Adversarial Acceptance

- IA-001 -- A valid legacy generic review still validates byte-exactly; a scored reply cannot substitute for triage or generic review.
- IA-002 -- One dimension at2 or fractional/unknown score refuses; four3 scores pass only with verdict pass and complete valid observations/citations. High scores with review/fail block; unknown is an evidence error.
- IA-003 -- Missing observations yield error; score0 requires a demonstrated contradiction and confidence never overrides a low dimension.
- IA-004 -- Wrong candidate/tree/base/control/input/reply/envelope/configuration digest, stale or future evidence, duplicated keys or noncanonical manifest bytes refuse.
- IA-005 -- Candidate-provided keys, incompatible key types, malformed base64/SPKI, wrong key identity or non64byte detached signatures refuse.
- IA-006 -- Actual tool/MCP events, inherited configuration, incomplete inventory, absent positive completion, errors and truncation refuse even when a signature is valid.
- IA-007 -- Same working/evaluator identity, declaration-only isolation or mutation after verification refuses before gate consumption.
- IA-008 -- Wrong repository/ref selection, redirect, missing/extra/unsafe members, symlinks/submodules, bounds breach or transport ambiguity refuse without automatic retries.
- IA-009 -- Only the exact declared public trust variable seam is allowed; secrets/other vars/bracket/whole-context/duplicate/relocated reads remain refused.
- IA-010 -- A PR-head artifact cannot admit a moved PR/base or merge-group head; missing new independent evidence blocks without CI provider initiation.
