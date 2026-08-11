name: module-__moduleSlug__

on:
  push:
    paths:
      - 'domain/__moduleSlug__/**'
  pull_request:
    paths:
      - 'domain/__moduleSlug__/**'

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24.x
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter ./domain/__moduleSlug__/api run build
      - run: pnpm --filter ./domain/__moduleSlug__/api run test
      - run: pnpm --filter ./domain/__moduleSlug__/api run lint

  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          if command -v npm >/dev/null 2>&1; then
            npm audit --audit-level=high --workspaces || true
          fi
