# Stack-pack inventory

Stack-adapter packs provide declared detection signals and extractor settings for a
repository stack. Pack matching is an inventory slice, not an adoption mutation:

```bash
devai sense inventory \
  --slice pack \
  --repo-root . \
  --adopter-root . \
  --format json
```

Read the selected pack, confidence, and unresolved signals. Ambiguity remains visible;
DEVAI does not silently choose a universal parser or rewrite the adopter from this
observation. Apply configuration only through a separately reviewed `init` plan.
