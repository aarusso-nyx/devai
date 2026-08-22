# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the repository owner or security contact rather than opening a public issue. Include the affected version, reproduction conditions, impact, and any evidence that can be shared safely. Do not include live credentials, personal data, or exploit material in public logs or DEVAI evidence records.

## Supported versions

`1.2.3` is the supported stable line. Earlier release candidates remain immutable audit history;
they are not supported stable releases.

## Security boundary

DEVAI mechanically enforces authority, lifecycle, consent, and path policies for operations executed through its CLI/runtime. Arbitrary shell commands, editors, and host-agent file tools are outside that guarantee unless the adopter declares `authority_enforcement.mode: "host-integrated"` and supplies a verified adapter that intercepts those operations.

The round and task loop is preview functionality. Local mutation requires declared authority and explicit `--write` consent. The CLI has no publication action and does not push or merge source.

## Secret handling

Secrets must enter through environment or host credential stores, never CLI arguments or committed configuration. Database credentials belong in the adopter's protected environment. GitHub Packages uses `NODE_AUTH_TOKEN`; never commit npm credentials.

See [secret handling](../docs/dev/security/secret-handling.md), [authority enforcement](../docs/dev/security/authority-enforcement.md), and the [threat model](../docs/dev/security/threat-model.md) for the detailed controls and residual risks.
