# Migrate from 1.4.3 to 1.4.4

> **Superseded:** DEVAI 1.4.4 shipped an inconsistent verifier-package
> materialization identity and must not be selected for a new adoption or RC.
> Migrate directly to 1.4.5 using
> [Migrate from 1.4.4 to 1.4.5](migrate-1.4.4-to-1.4.5.md). The steps below are
> retained only to explain historical 1.4.4 receipts.

DEVAI 1.4.4 makes task-policy reconstruction portable and adds strict verification
for composed mutation receipts. Existing receipts from 1.4.3 remain historical
records; they must not be reused for a 1.4.4 candidate because the policy digest
and packaged verifier provenance change.

1. For historical reconstruction only, pin `@aarusso-nyx/devai@1.4.4` exactly
   and regenerate the governed workflow. Do not use the result for a new RC.
2. Re-materialize the verifier-package policy and confirm the generated workflow
   binds verifier source `37e75a5c27569d4cb3fdb4a3dc97a140da4d78de`.
3. Before an expensive RC run, run the installed evidence-export preflight using
   the exact candidate receipt inputs and intended output destination. Correct
   every typed refusal before executing RC tasks.
4. Run the selected 1.4 release-profile preflight, then certification with its
   exact preflight receipt. A `not-required` disposition remains non-passing
   evidence and cannot be converted into a reusable mutation pass.
5. For composed mutation output, retain the exact candidate/baseline, target
   census, input projections, and fresh/reused process provenance. The verifier
   accepts only successful `{ errorAbsent: true, signal: null, status: 0 }`
   process tuples.

The former 1.4.3 receipt and its workstation-bound policy must never be exported
or published as 1.4.4 evidence. Generate a new receipt from the exact candidate.
