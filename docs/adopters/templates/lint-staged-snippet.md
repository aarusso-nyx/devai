# lint-staged + prettierignore snippets

Use these snippets in an adopter's lint-staged and Prettier configuration so neither
tool rewrites `record/proofs/**`. Reformatting a hash-chained record breaks its digest;
`devai evidence verify --scope chain` then reports the mismatch.

## `.prettierignore`

Append to your existing `.prettierignore` (create the file if you don't have one):

```
# DEVAI evidence ledger (Article 32 — hash-chained, do NOT reformat).
record/proofs/

# DEVAI worktree locks.
.devai/locks/
```

## `lint-staged` config

If your repo uses `lint-staged` (typical with husky pre-commit hooks), filter `record/proofs/**` out of the JSON/JS/TS globs. Two patterns:

**package.json shape:**

```json
{
  "lint-staged": {
    "*.{js,ts,tsx,json}": ["eslint --fix", "prettier --write"],
    "!record/proofs/**/*.json": []
  }
}
```

**Function-form (preferred — more robust):**

```js
// lint-staged.config.cjs
module.exports = {
  '**/*.{js,ts,tsx,json}': (files) => {
    const safe = files.filter((f) => !f.includes('/record/proofs/'));
    if (safe.length === 0) return [];
    return [`eslint --fix ${safe.join(' ')}`, `prettier --write ${safe.join(' ')}`];
  },
};
```

## `.gitattributes`

See `.gitattributes` in this directory.

## Verifying

After applying these, run a probe:

```bash
echo '{"reformatted": true}' >> record/proofs/test-marker.json
git add record/proofs/test-marker.json
git commit -m "test: ensure lint-staged skips state/"
```

Your pre-commit hook should not touch the file. Verify with `git diff --cached --stat`. (Then `git restore --staged` + delete the marker.)
