# Security

- [Secret handling](secret-handling.md)
- [Threat model](threat-model.md)
- [Authority overrides](inv-override-discipline.md)

Recipe permissions are variant-specific and enforced by the host. No recipe may widen
its write scope, invoke a nested model, or perform publication.
