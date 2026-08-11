# Mutation evidence

DEVAI records mutation evidence through the current evidence action. Scenario files and a
mutator module are explicit inputs:

```bash
devai evidence record \
  --kind mutation \
  --round R-1000 \
  --scenarios ./tests/mutation/scenarios \
  --mutator ./tools/mutator.mjs \
  --out ./record/proofs/mutation/current.json \
  --run --as-role inspector --write --format json
```

Alternatively, supply precomputed reports with `--external`. `--fail-on-survivors` makes
survivors a command failure after the record is written. The recorded result remains bound to
the exact scenario, mutator, repository, and round inputs; do not generalize it to untouched
code or a later candidate.
