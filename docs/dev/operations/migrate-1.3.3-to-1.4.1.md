# Migrate from 1.3.3 to 1.4.1

The package update is backward compatible for adopters that do not opt into
release profiles. Pin `@aarusso-nyx/devai@1.4.1`, run the ordinary Doctor and
existing task gates, and keep using `check --affected`, `--local`, or `--rc`.
Missing release intent never selects a cheaper profile.

To adopt profile-driven releases:

1. Review `release-verification-profile.schema.json` and map every required
   capability to real `test-tasks.json` nodes.
2. Declare product-specific risk mappings and the exact mutation roster. An
   empty roster is explicit: targeted mutation is `not-required` for ordinary
   releases, while LTS promotion blocks until a roster exists.
   Bind every roster entry to a real task node and declare its complete input,
   toolchain, threshold, and sanitizer identity.
3. Add `release_verification` to the reviewed adopter policy, preview `init bind`,
   resolve conflicts, then apply as Architect with `--write`.
4. Generate a candidate-bound `release-intent` record only after the candidate
   commit exists. Record the exact base-to-candidate `changed_paths` and mapped
   `changed_packages`. Run preflight, retain its digest-verified receipt, then
   run certification against the same candidate and toolchain.
5. Present one stable required-check name in CI while allowing the internal DAG
   to vary. Keep PR jobs unprivileged and publication-free.

Schema version `1.0.0` is additive. DEVAI 1.4 continues to accept the existing
task descriptor and candidate receipt versions; it does not reinterpret or
overwrite pre-1.4 adopter state.
