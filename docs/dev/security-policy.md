# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately to the repository owner or security contact. Include
the affected RC version, reproduction conditions, impact, and evidence that can be shared safely.
Never put credentials, personal data, or live exploit material in a public issue, log, or DEVAI
evidence record.

## Supported version

Security fixes target the current v1.0 release candidate.

## Security boundary

DEVAI enforces action authority, effect, consent, and bounded adapters for operations executed
through its CLI/runtime. Arbitrary shell commands, editors, and host-agent file tools remain
outside that guarantee unless a verified host adapter intercepts them.

Secrets enter through environment variables or host credential stores, never committed
configuration or evidence payloads. Database URLs supplied to `devai sense migrate` come from the
operator environment. Package registry reads use host-managed credentials; never commit npm
credentials.

See [secret handling](./security/secret-handling.md),
[authority enforcement](./security/authority-enforcement.md), and the
[threat model](./security/threat-model.md) for detailed controls and residual risks.
