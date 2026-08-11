# Threat model

DEVAI protects action authority, repository contracts, test evidence, secrets, and candidate
identity against accidental or hostile misuse.

| Threat                            | Current defense                                                                                    | Residual boundary                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| wrong-role or over-broad mutation | action effect/role/capability/consent checks and bounded adapters                                  | unrestricted host tools remain outside CLI containment                   |
| prompt injection                  | typed operations, allowed scopes, explicit consent, human review                                   | an allowed action can still produce poor work                            |
| test-result reuse after change    | content-addressed inputs, dependencies, toolchain, environment and output contract                 | descriptor omissions are policy defects                                  |
| receipt tampering or replay       | Ed25519 verification, signer allowlist/revocation, exact repository/commit/tree and policy binding | trusted signing does not prove execution                                 |
| evidence modification             | chained digests and `evidence verify`                                                              | a writer can corrupt files; verification detects rather than prevents it |
| credential disclosure             | environment/host stores, redaction, no ambient provider use                                        | compromised dependencies or host can read process credentials            |
| time-of-check/time-of-use         | immutable artifact reference and post-deploy `release verify`                                      | deployment and rollback remain operator-owned                            |

Supply-chain compromise, physical runner access, and defects in Git, Node, or cryptographic
libraries require controls outside DEVAI. Pin dependencies, review lockfile changes, protect
branches and signing keys, and keep human release authorization separate from evidence verdicts.
