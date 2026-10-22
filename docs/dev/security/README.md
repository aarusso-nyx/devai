# Security

- [Secret handling](secret-handling.md)
- [Threat model](threat-model.md)
- [Authority overrides](inv-override-discipline.md)
- [Issue 422 runtime boundary and closure design](issue-422-closure-design.md)

Recipe permissions are variant-specific and enforced by the host. No recipe may widen
its write scope, invoke a nested model, or perform publication.
