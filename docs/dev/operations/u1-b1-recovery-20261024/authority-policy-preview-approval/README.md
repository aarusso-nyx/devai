# Authority-policy dry-plan gap — bounded approval packet

**Prepared for review only. No implementation or effect approved.**

The [exact proposal and approval wording](REC-B1-A-P1-approval.md) describes an
opt-in live review that freezes the entire policy artifact in one invocation and
requires separate exact confirmation before an atomic create. It also projects
the separately planned canonical constitution binding without writing it, so the
complete prospective policy can be reviewed before any binding.

Two explicit proposed choices keep the scope bounded:

- The exact-byte stage is an **armed local-write review**, requiring Architect and
  `--write`, with zero filesystem effects until a second exact confirmation. The
  ordinary no-consent advisory dry plan is not relabelled exact.
- Publication is **create-only** for the currently absent authority-policy file,
  using the existing guarded no-replace primitive. Existing-file replacement,
  arbitrary authority extensions and host-integrated populations require another
  packet. Existing normal branches remain unchanged.

The [path inventory](path-inventory.proposed.json) names **19 human-authored paths**:
four Architect, nine Engineer and six Inspector. The generated ADR index is already
included; the additional generated error-code reference makes **20 distinct future
write paths**. There is no broad directory, runtime-schema, action-registry or
binding-output grant. The [24-case acceptance matrix](acceptance-matrix.md) specifies
Inspector RED, exact-byte/authority/projection negatives, stale/expiry/replay cases,
real two-process create contention, crash/uncertainty preservation and regressions.
These are future requirements, not new test results.

The [source observation](source-observation.json) freezes the current inputs,
including the real existing adopter-policy receipt/source and absent policy/lock.
The current proposed Constitution remains 1.2.0 with SHA256
`d5dfdc972161e0f848dd859be7bbfa510973c5c9a449a0f9e6b8960e4f5ac96a`.
All earlier contract changes, test evidence, historical packets and binding
prestate were checked unchanged during this preparation.

Local packet checks passed: 19 unique role-owned paths, 24 numbered cases, current
source/binding hashes, prior authoring/preparation manifests, JSON, relative links,
formatting and whitespace. No proposed runtime/source/test/ADR file was modified,
no preview command was launched, and no unit/RC/build/graph refresh or service ran.
Existing 118-pass/two-held-failure results remain historical, not P1 assurance.

Binding, integration/source publication, U1/B1 runtime, release and DETRAN effects
remain held. #211 stays unmerged, C6 blocked and S3 runtime held. The next decision
available is the exact bounded implementation proposal; live use and actual
binding return separately after implementation and independent assurance.

[Packet manifest](packet-manifest.json) hashes this preparation. It grants no
execution authority or generated F4 standing.
