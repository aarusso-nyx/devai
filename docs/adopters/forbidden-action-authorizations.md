# Exact forbidden-action authorizations

The pre-push forbidden-action check is deliberately fail-closed. When it finds
an action that a human has explicitly reviewed and authorized, record that
decision in the Architect-owned
`law/policy/forbidden-action-authorizations.json` artifact. Do not weaken a
detection pattern or bypass the hook. Only the Owner can authorize a finding;
the Architect materializes that decision without gaining Owner authority.

Each receipt binds one canonical forbidden-action ID to one full commit SHA:

```json
{
  "$schema": "https://devai.nyxk.com.br/schemas/forbidden-action-authorizations.schema.json",
  "schemaVersion": "1.0.0",
  "authorizations": [
    {
      "forbidden_id": "FORBID-CI-WITHOUT-ADR",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "authorized_by": "Owner",
      "reason": "Owner reviewed and approved this exact CI change for the adoption PR."
    }
  ]
}
```

The scanner applies a receipt only when both the ID and all 40 lowercase SHA
characters match. A receipt for another action or commit remains unused and the
finding still blocks. Unknown IDs, partial SHAs, duplicate receipts, unsupported
authorities, short reasons, unknown fields, and malformed bytes fail closed as
`FORBIDDEN-AUTHORIZATION-INVALID`.

The check reports declared, applied, and unused receipt keys. Keep unused
receipts visible for review or remove them in a later Architect-owned change.
Receipts never authorize registry corruption, unavailable history inspection,
or future commits.
