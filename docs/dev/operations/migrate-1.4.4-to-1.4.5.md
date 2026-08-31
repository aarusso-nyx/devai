# Migrate from 1.4.4 to 1.4.5

DEVAI 1.4.5 corrects the immutable verifier-package identity used by generated
trusted-local-RC workflows. DEVAI 1.4.4 carried verifier source
`37e75a5c27569d4cb3fdb4a3dc97a140da4d78de`, but its materializer still selected
the older 1.2.12 package, whose verifier provenance cannot satisfy that source
identity.

1. Pin `@aarusso-nyx/devai@1.4.5` exactly and regenerate the governed workflow.
2. Confirm the generated materializer downloads exact `@aarusso-nyx/devai@1.4.4`
   with its authenticated tarball, release commit/tree, and verifier provenance.
3. Under separate Owner authorization, set the protected workflow variable
   `DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256` to exactly
   `8ebafff53524031a3207a2256ebcd0fa6e0cc4271fd4bb6bca5aa003395034bd`.
   The Inspector must independently compare that value with the authenticated
   1.4.4 tarball before any verifier binary executes; candidate source cannot
   select or substitute it.
4. Run the installed non-writing evidence-export preflight before any RC task.
5. Generate a new exact-candidate receipt. A receipt from 1.4.4 or an older
   provider remains historical evidence and is not reusable as 1.4.5 evidence.

This migration changes no mutation target, threshold, disposition, or remote
execution boundary. Mutation reuse remains valid only through exact declared
input identity and independent composed-evidence verification.
