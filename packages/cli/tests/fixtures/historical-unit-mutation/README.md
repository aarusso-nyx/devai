# Historical mutation reader fixtures

These five immutable snapshots preserve the existing historical-reader test populations. They are synthetic test data, not DEVAI release evidence.

Source: DEVAI commit `18fc6cf01645648dfe3b6d5c256a926c3c75ef47`, `packages/cli/tests/helpers/release-unit-mutation-evidence-fixture.ts` and its pure artifact normalizer, both archived in Bedel. Snapshots were captured with the pinned semantic verifier and no mutation-engine execution. The temporary capture builder was removed.

Filenames are SHA-256 of canonical fixture options. Each snapshot contains its options, document identities, original report bytes, and compositions. The helper reads defensive copies without invoking the retired normalizer or composing new evidence. The historical-reader tests still independently verify the preserved documents and exercise corruption, identity substitution, ordering, reuse and quotas.
