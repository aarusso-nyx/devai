---
title: Inventory slices
---

# Select and render an inventory slice

An inventory slice is a deterministic projection of repository structure selected
through `devai sense inventory`. The generated reference below is rendered from the
canonical slice policy and the live inventory runtime descriptors; it is the lookup
authority for current contents, supported inputs, output bodies, limitations, effects,
costs, and examples. This page does not duplicate the mutable slice population.

<!-- devai:generated-reference:start category="inventory-slices" -->

## Inventory slices

<!-- devai:generated-entry category="inventory-slices" id="pack" -->

### `pack` — Pack

- **Stable ID:** pack
- **User-facing label:** Pack
- **Purpose:** Resolve the matching canonical stack-adapter pack.
- **Population or projection:** `stack-adapter-pack-resolution`. Supported stacks: Stacks represented by canonical pack detect rules; no hard-coded stack alias is inferred.
- **Prerequisites:** readable repository root; canonical pack registry and detect rules
- **Required external tools:** Not applicable: this slice declares no external tool.
- **Accepted inputs:** `--repo-root <path>`, `--adopter-root <path>`
- **Defaults:** repo root .; adopter root equals repo root
- **Output contract:** Action envelope containing {slice, members, status, results, implicit_persistence:false}; member bodies: `stack-adapter-pack-resolution` {matched, ambiguous, candidates, diagnostics} pack-resolution body.
- **Verdict semantics:** Only `pass` and `review` are emitted in a successful payload; process exit is pass or review respectively. Member rules: review when matched is null or resolution is ambiguous; otherwise pass. Exceptions exit fail.
- **Declared effect:** Not applicable to the vocabulary value; the enclosing canonical inventory action is read-only.
- **Consent flags:** No role, write, or publish consent is accepted or required by the read-only inventory action.
- **Cost class:** `moderate`
- **When to use:** Use for the exact deterministic `pack` repository projection.
- **When not to use:** Does not choose among ambiguous packs or invent support for an unmatched stack.
- **Non-pass semantics:** `review` is explicit and exits non-pass; implementation exceptions are `fail`. `unknown`, `skipped`, and `N/A` are not emitted by the current inventory payload.
- **Example:** `devai sense inventory --slice pack --repo-root . --adopter-root . --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/inventory_slices)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="inventory-slices" id="adherence" -->

### `adherence` — Adherence

- **Stable ID:** adherence
- **User-facing label:** Adherence
- **Purpose:** Project reverse adherence from regenerated inventory and the trace registry.
- **Population or projection:** `inventory-adherence`. Supported stacks: Any repository shape supported by the canonical inventory regeneration and trace contracts.
- **Prerequisites:** readable repository root; schema-valid trace registry
- **Required external tools:** Not applicable: this slice declares no external tool.
- **Accepted inputs:** `--repo-root <path>`, `--trace <path>`
- **Defaults:** repo root .; trace law/trace.json
- **Output contract:** Action envelope containing {slice, members, status, results, implicit_persistence:false}; member bodies: `inventory-adherence` reverse-adherence body with counts and orphan records.
- **Verdict semantics:** Only `pass` and `review` are emitted in a successful payload; process exit is pass or review respectively. Member rules: review when orphan count is nonzero; otherwise pass. Exceptions exit fail.
- **Declared effect:** Not applicable to the vocabulary value; the enclosing canonical inventory action is read-only.
- **Consent flags:** No role, write, or publish consent is accepted or required by the read-only inventory action.
- **Cost class:** `moderate`
- **When to use:** Use for the exact deterministic `adherence` repository projection.
- **When not to use:** A missing trace file is an execution error; no empty trace is synthesized.
- **Non-pass semantics:** `review` is explicit and exits non-pass; implementation exceptions are `fail`. `unknown`, `skipped`, and `N/A` are not emitted by the current inventory payload.
- **Example:** `devai sense inventory --slice adherence --repo-root . --trace law/trace.json --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/inventory_slices)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="inventory-slices" id="components" -->

### `components` — Components

- **Stable ID:** components
- **User-facing label:** Components
- **Purpose:** Extract Angular and NestJS decorated components from TypeScript.
- **Population or projection:** `component-inventory`. Supported stacks: Angular Component/Directive/Pipe and Angular or NestJS Injectable/Controller decorators in .ts files.
- **Prerequisites:** readable TypeScript source tree
- **Required external tools:** Not applicable: this slice declares no external tool.
- **Accepted inputs:** `--repo-root <path>`
- **Defaults:** repo root .
- **Output contract:** Action envelope containing {slice, members, status, results, implicit_persistence:false}; member bodies: `component-inventory` {count, components} with kind, name, module, and repository-relative path.
- **Verdict semantics:** Only `pass` and `review` are emitted in a successful payload; process exit is pass or review respectively. Member rules: pass after deterministic extraction; parser-unreadable files are omitted by the extractor. Exceptions exit fail.
- **Declared effect:** Not applicable to the vocabulary value; the enclosing canonical inventory action is read-only.
- **Consent flags:** No role, write, or publish consent is accepted or required by the read-only inventory action.
- **Cost class:** `moderate`
- **When to use:** Use for the exact deterministic `components` repository projection.
- **When not to use:** Does not infer undecorated components or non-TypeScript framework conventions.
- **Non-pass semantics:** `review` is explicit and exits non-pass; implementation exceptions are `fail`. `unknown`, `skipped`, and `N/A` are not emitted by the current inventory payload.
- **Example:** `devai sense inventory --slice components --repo-root . --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/inventory_slices)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="inventory-slices" id="contracts" -->

### `contracts` — Contracts

- **Stable ID:** contracts
- **User-facing label:** Contracts
- **Purpose:** Compile and validate discovered JSON Schema contracts.
- **Population or projection:** `contract-inventory`. Supported stacks: JSON Schema 2020-12 files named `*.schema.json`; OpenAPI regeneration remains outside this member.
- **Prerequisites:** readable repository root; parseable discovered schema files
- **Required external tools:** Ajv 2020 and ajv-formats workspace dependencies
- **Accepted inputs:** `--repo-root <path>`
- **Defaults:** repo root .
- **Output contract:** Action envelope containing {slice, members, status, results, implicit_persistence:false}; member bodies: `contract-inventory` {ok, checks[]} with file, json_schema kind, per-file ok, and errors.
- **Verdict semantics:** Only `pass` and `review` are emitted in a successful payload; process exit is pass or review respectively. Member rules: review when any schema check is not ok; otherwise pass. Exceptions exit fail.
- **Declared effect:** Not applicable to the vocabulary value; the enclosing canonical inventory action is read-only.
- **Consent flags:** No role, write, or publish consent is accepted or required by the read-only inventory action.
- **Cost class:** `moderate`
- **When to use:** Use for the exact deterministic `contracts` repository projection.
- **When not to use:** Does not perform the deferred OpenAPI byte-regeneration comparison.
- **Non-pass semantics:** `review` is explicit and exits non-pass; implementation exceptions are `fail`. `unknown`, `skipped`, and `N/A` are not emitted by the current inventory payload.
- **Example:** `devai sense inventory --slice contracts --repo-root . --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/inventory_slices)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="inventory-slices" id="coverage" -->

### `coverage` — Coverage

- **Stable ID:** coverage
- **User-facing label:** Coverage
- **Purpose:** Normalize Istanbul/Jest/Vitest coverage bytes into one summary.
- **Population or projection:** `inventory-coverage`. Supported stacks: Istanbul-compatible coverage-final.json emitted by Jest or Vitest.
- **Prerequisites:** readable repository root; the coverage file may be absent and is reported explicitly
- **Required external tools:** Not applicable: this slice declares no external tool.
- **Accepted inputs:** `--repo-root <path>`, `--coverage <path>`
- **Defaults:** repo root .; coverage coverage/coverage-final.json
- **Output contract:** Action envelope containing {slice, members, status, results, implicit_persistence:false}; member bodies: `inventory-coverage` {source_path, summary, missing}; summary contains statement, branch, function, line, and file counts.
- **Verdict semantics:** Only `pass` and `review` are emitted in a successful payload; process exit is pass or review respectively. Member rules: review when summary is null, including a missing/non-file path; otherwise pass. Exceptions exit fail.
- **Declared effect:** Not applicable to the vocabulary value; the enclosing canonical inventory action is read-only.
- **Consent flags:** No role, write, or publish consent is accepted or required by the read-only inventory action.
- **Cost class:** `moderate`
- **When to use:** Use for the exact deterministic `coverage` repository projection.
- **When not to use:** Malformed coverage JSON errors; no coverage run is started and statement-only line counts are an approximation.
- **Non-pass semantics:** `review` is explicit and exits non-pass; implementation exceptions are `fail`. `unknown`, `skipped`, and `N/A` are not emitted by the current inventory payload.
- **Example:** `devai sense inventory --slice coverage --repo-root . --coverage coverage/coverage-final.json --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/inventory_slices)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="inventory-slices" id="dependencies" -->

### `dependencies` — Dependencies

- **Stable ID:** dependencies
- **User-facing label:** Dependencies
- **Purpose:** Build a deterministic TypeScript import/export dependency graph.
- **Population or projection:** `dependency-graph`. Supported stacks: Static .ts import and export declarations; relative/local and external module specifiers.
- **Prerequisites:** readable TypeScript source tree
- **Required external tools:** TypeScript parser workspace dependency
- **Accepted inputs:** `--repo-root <path>`
- **Defaults:** repo root .
- **Output contract:** Action envelope containing {slice, members, status, results, implicit_persistence:false}; member bodies: `dependency-graph` {nodes, edges, hash} with sorted repository-relative nodes and import edges.
- **Verdict semantics:** Only `pass` and `review` are emitted in a successful payload; process exit is pass or review respectively. Member rules: pass after deterministic extraction; parser-unreadable files are omitted by the extractor. Exceptions exit fail.
- **Declared effect:** Not applicable to the vocabulary value; the enclosing canonical inventory action is read-only.
- **Consent flags:** No role, write, or publish consent is accepted or required by the read-only inventory action.
- **Cost class:** `moderate`
- **When to use:** Use for the exact deterministic `dependencies` repository projection.
- **When not to use:** Does not resolve dynamic imports, require calls, runtime loaders, or non-TypeScript dependency syntax.
- **Non-pass semantics:** `review` is explicit and exits non-pass; implementation exceptions are `fail`. `unknown`, `skipped`, and `N/A` are not emitted by the current inventory payload.
- **Example:** `devai sense inventory --slice dependencies --repo-root . --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/inventory_slices)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="inventory-slices" id="glossary" -->

### `glossary` — Glossary

- **Stable ID:** glossary
- **User-facing label:** Glossary
- **Purpose:** Count canonical glossary-term usage across source and Markdown.
- **Population or projection:** `glossary-inventory`. Supported stacks: `GE-*.json` glossary records and `.ts`/`.md` sources under the canonical search roots.
- **Prerequisites:** readable law/glossary and repository source roots
- **Required external tools:** Not applicable: this slice declares no external tool.
- **Accepted inputs:** `--repo-root <path>`
- **Defaults:** repo root .; glossary law/glossary; search root packages
- **Output contract:** Action envelope containing {slice, members, status, results, implicit_persistence:false}; member bodies: `glossary-inventory` {entries_count, terms[]} with id, term, used_count, and sorted used_in paths.
- **Verdict semantics:** Only `pass` and `review` are emitted in a successful payload; process exit is pass or review respectively. Member rules: pass after deterministic projection. Exceptions exit fail.
- **Declared effect:** Not applicable to the vocabulary value; the enclosing canonical inventory action is read-only.
- **Consent flags:** No role, write, or publish consent is accepted or required by the read-only inventory action.
- **Cost class:** `moderate`
- **When to use:** Use for the exact deterministic `glossary` repository projection.
- **When not to use:** Malformed glossary records are skipped here and must be rejected by the separate glossary validator.
- **Non-pass semantics:** `review` is explicit and exits non-pass; implementation exceptions are `fail`. `unknown`, `skipped`, and `N/A` are not emitted by the current inventory payload.
- **Example:** `devai sense inventory --slice glossary --repo-root . --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/inventory_slices)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="inventory-slices" id="modules" -->

### `modules` — Modules

- **Stable ID:** modules
- **User-facing label:** Modules
- **Purpose:** Extract Angular and NestJS module declarations from TypeScript.
- **Population or projection:** `module-inventory`. Supported stacks: Angular NgModule and NestJS Module class decorators in .ts files.
- **Prerequisites:** readable TypeScript source tree
- **Required external tools:** Not applicable: this slice declares no external tool.
- **Accepted inputs:** `--repo-root <path>`
- **Defaults:** repo root .
- **Output contract:** Action envelope containing {slice, members, status, results, implicit_persistence:false}; member bodies: `module-inventory` {count, modules} with stable id, kind, name, and repository-relative path.
- **Verdict semantics:** Only `pass` and `review` are emitted in a successful payload; process exit is pass or review respectively. Member rules: pass after deterministic extraction; parser-unreadable files are omitted by the extractor. Exceptions exit fail.
- **Declared effect:** Not applicable to the vocabulary value; the enclosing canonical inventory action is read-only.
- **Consent flags:** No role, write, or publish consent is accepted or required by the read-only inventory action.
- **Cost class:** `moderate`
- **When to use:** Use for the exact deterministic `modules` repository projection.
- **When not to use:** Does not infer undecorated modules or non-TypeScript module conventions.
- **Non-pass semantics:** `review` is explicit and exits non-pass; implementation exceptions are `fail`. `unknown`, `skipped`, and `N/A` are not emitted by the current inventory payload.
- **Example:** `devai sense inventory --slice modules --repo-root . --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/inventory_slices)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="inventory-slices" id="routes" -->

### `routes` — Routes

- **Stable ID:** routes
- **User-facing label:** Routes
- **Purpose:** Extract NestJS controller routes and local guard hints from TypeScript.
- **Population or projection:** `route-inventory`. Supported stacks: NestJS Controller plus Get/Post/Put/Patch/Delete/Options/Head/All decorators in .ts files.
- **Prerequisites:** readable TypeScript source tree
- **Required external tools:** TypeScript parser workspace dependency
- **Accepted inputs:** `--repo-root <path>`
- **Defaults:** repo root .
- **Output contract:** Action envelope containing {slice, members, status, results, implicit_persistence:false}; member bodies: `route-inventory` {count, routes} with method, path, module, and optional protected hint.
- **Verdict semantics:** Only `pass` and `review` are emitted in a successful payload; process exit is pass or review respectively. Member rules: pass after deterministic extraction; parser-unreadable files are omitted by the extractor. Exceptions exit fail.
- **Declared effect:** Not applicable to the vocabulary value; the enclosing canonical inventory action is read-only.
- **Consent flags:** No role, write, or publish consent is accepted or required by the read-only inventory action.
- **Cost class:** `moderate`
- **When to use:** Use for the exact deterministic `routes` repository projection.
- **When not to use:** Protection is only a same-method UseGuards/Auth hint; global guards and non-NestJS routers are not inferred.
- **Non-pass semantics:** `review` is explicit and exits non-pass; implementation exceptions are `fail`. `unknown`, `skipped`, and `N/A` are not emitted by the current inventory payload.
- **Example:** `devai sense inventory --slice routes --repo-root . --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/inventory_slices)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="inventory-slices" id="schemas" -->

### `schemas` — Schemas

- **Stable ID:** schemas
- **User-facing label:** Schemas
- **Purpose:** Discover file schemas and optionally read PostgreSQL table/view metadata.
- **Population or projection:** `schema-inventory`. Supported stacks: JSON Schema, OpenAPI JSON/YAML, and optional PostgreSQL information_schema tables/views.
- **Prerequisites:** readable repository root; optional reachable read-only PostgreSQL URL for database projection
- **Required external tools:** PostgreSQL only when --database-url is supplied
- **Accepted inputs:** `--repo-root <path>`, `--database-url <url>`, `--database-schema <name>`
- **Defaults:** repo root .; no database introspection; no database schema filter
- **Output contract:** Action envelope containing {slice, members, status, results, implicit_persistence:false}; member bodies: `schema-inventory` {count, schemas} with kind, name, optional path, and optional db_schema.
- **Verdict semantics:** Only `pass` and `review` are emitted in a successful payload; process exit is pass or review respectively. Member rules: pass after file discovery and any requested read-only database introspection. Exceptions exit fail.
- **Declared effect:** Not applicable to the vocabulary value; the enclosing canonical inventory action is read-only.
- **Consent flags:** No role, write, or publish consent is accepted or required by the read-only inventory action.
- **Cost class:** `moderate`
- **When to use:** Use for the exact deterministic `schemas` repository projection.
- **When not to use:** Database records are absent by default; a supplied unreachable URL errors instead of falling back to file-only output.
- **Non-pass semantics:** `review` is explicit and exits non-pass; implementation exceptions are `fail`. `unknown`, `skipped`, and `N/A` are not emitted by the current inventory payload.
- **Example:** `devai sense inventory --slice schemas --repo-root . --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/inventory_slices)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="inventory-slices" id="tests" -->

### `tests` — Tests

- **Stable ID:** tests
- **User-facing label:** Tests
- **Purpose:** Discover TypeScript tests, classify suites, and extract invariant markers.
- **Population or projection:** `test-inventory`. Supported stacks: `*.test.ts` and `*.spec.ts` with unit/api/int/e2e/sec/perf/journey/db filename conventions.
- **Prerequisites:** readable TypeScript test tree
- **Required external tools:** Not applicable: this slice declares no external tool.
- **Accepted inputs:** `--repo-root <path>`
- **Defaults:** repo root .; unmatched test filenames classify as unit
- **Output contract:** Action envelope containing {slice, members, status, results, implicit_persistence:false}; member bodies: `test-inventory` {count, tests} with repository-relative path, suite, and sorted invariant ids.
- **Verdict semantics:** Only `pass` and `review` are emitted in a successful payload; process exit is pass or review respectively. Member rules: pass after deterministic discovery. Exceptions exit fail.
- **Declared effect:** Not applicable to the vocabulary value; the enclosing canonical inventory action is read-only.
- **Consent flags:** No role, write, or publish consent is accepted or required by the read-only inventory action.
- **Cost class:** `moderate`
- **When to use:** Use for the exact deterministic `tests` repository projection.
- **When not to use:** Does not discover non-TypeScript test conventions or infer a non-unit suite without the filename marker.
- **Non-pass semantics:** `review` is explicit and exits non-pass; implementation exceptions are `fail`. `unknown`, `skipped`, and `N/A` are not emitted by the current inventory payload.
- **Example:** `devai sense inventory --slice tests --repo-root . --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/inventory_slices)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="inventory-slices" id="all" -->

### `all` — All

- **Stable ID:** all
- **User-facing label:** All
- **Purpose:** Resolve the matching canonical stack-adapter pack. Project reverse adherence from regenerated inventory and the trace registry. Extract Angular and NestJS decorated components from TypeScript. Compile and validate discovered JSON Schema contracts. Normalize Istanbul/Jest/Vitest coverage bytes into one summary. Build a deterministic TypeScript import/export dependency graph. Count canonical glossary-term usage across source and Markdown. Extract Angular and NestJS module declarations from TypeScript. Extract NestJS controller routes and local guard hints from TypeScript. Discover file schemas and optionally read PostgreSQL table/view metadata. Discover TypeScript tests, classify suites, and extract invariant markers.
- **Population or projection:** `stack-adapter-pack-resolution`, `inventory-adherence`, `component-inventory`, `contract-inventory`, `inventory-coverage`, `dependency-graph`, `glossary-inventory`, `module-inventory`, `route-inventory`, `schema-inventory`, `test-inventory`. Supported stacks: Stacks represented by canonical pack detect rules; no hard-coded stack alias is inferred. Any repository shape supported by the canonical inventory regeneration and trace contracts. Angular Component/Directive/Pipe and Angular or NestJS Injectable/Controller decorators in .ts files. JSON Schema 2020-12 files named `*.schema.json`; OpenAPI regeneration remains outside this member. Istanbul-compatible coverage-final.json emitted by Jest or Vitest. Static .ts import and export declarations; relative/local and external module specifiers. `GE-*.json` glossary records and `.ts`/`.md` sources under the canonical search roots. Angular NgModule and NestJS Module class decorators in .ts files. NestJS Controller plus Get/Post/Put/Patch/Delete/Options/Head/All decorators in .ts files. JSON Schema, OpenAPI JSON/YAML, and optional PostgreSQL information_schema tables/views. `*.test.ts` and `*.spec.ts` with unit/api/int/e2e/sec/perf/journey/db filename conventions.
- **Prerequisites:** readable repository root; canonical pack registry and detect rules; schema-valid trace registry; readable TypeScript source tree; parseable discovered schema files; readable repository root; the coverage file may be absent and is reported explicitly; readable law/glossary and repository source roots; optional reachable read-only PostgreSQL URL for database projection; readable TypeScript test tree
- **Required external tools:** Ajv 2020 and ajv-formats workspace dependencies; TypeScript parser workspace dependency; PostgreSQL only when --database-url is supplied
- **Accepted inputs:** `--repo-root <path>`, `--adopter-root <path>`, `--trace <path>`, `--coverage <path>`, `--database-url <url>`, `--database-schema <name>`
- **Defaults:** repo root .; adopter root equals repo root; trace law/trace.json; coverage coverage/coverage-final.json; glossary law/glossary; search root packages; no database introspection; no database schema filter; unmatched test filenames classify as unit
- **Output contract:** Action envelope containing {slice, members, status, results, implicit_persistence:false}; member bodies: `stack-adapter-pack-resolution` {matched, ambiguous, candidates, diagnostics} pack-resolution body; `inventory-adherence` reverse-adherence body with counts and orphan records; `component-inventory` {count, components} with kind, name, module, and repository-relative path; `contract-inventory` {ok, checks[]} with file, json_schema kind, per-file ok, and errors; `inventory-coverage` {source_path, summary, missing}; summary contains statement, branch, function, line, and file counts; `dependency-graph` {nodes, edges, hash} with sorted repository-relative nodes and import edges; `glossary-inventory` {entries_count, terms[]} with id, term, used_count, and sorted used_in paths; `module-inventory` {count, modules} with stable id, kind, name, and repository-relative path; `route-inventory` {count, routes} with method, path, module, and optional protected hint; `schema-inventory` {count, schemas} with kind, name, optional path, and optional db_schema; `test-inventory` {count, tests} with repository-relative path, suite, and sorted invariant ids.
- **Verdict semantics:** Only `pass` and `review` are emitted in a successful payload; process exit is pass or review respectively. Member rules: review when matched is null or resolution is ambiguous; otherwise pass; review when orphan count is nonzero; otherwise pass; pass after deterministic extraction; parser-unreadable files are omitted by the extractor; review when any schema check is not ok; otherwise pass; review when summary is null, including a missing/non-file path; otherwise pass; pass after deterministic extraction; parser-unreadable files are omitted by the extractor; pass after deterministic projection; pass after deterministic extraction; parser-unreadable files are omitted by the extractor; pass after deterministic extraction; parser-unreadable files are omitted by the extractor; pass after file discovery and any requested read-only database introspection; pass after deterministic discovery. Exceptions exit fail.
- **Declared effect:** Not applicable to the vocabulary value; the enclosing canonical inventory action is read-only.
- **Consent flags:** No role, write, or publish consent is accepted or required by the read-only inventory action.
- **Cost class:** `moderate`
- **When to use:** Use for the exact deterministic `all` repository projection.
- **When not to use:** Does not choose among ambiguous packs or invent support for an unmatched stack. A missing trace file is an execution error; no empty trace is synthesized. Does not infer undecorated components or non-TypeScript framework conventions. Does not perform the deferred OpenAPI byte-regeneration comparison. Malformed coverage JSON errors; no coverage run is started and statement-only line counts are an approximation. Does not resolve dynamic imports, require calls, runtime loaders, or non-TypeScript dependency syntax. Malformed glossary records are skipped here and must be rejected by the separate glossary validator. Does not infer undecorated modules or non-TypeScript module conventions. Protection is only a same-method UseGuards/Auth hint; global guards and non-NestJS routers are not inferred. Database records are absent by default; a supplied unreachable URL errors instead of falling back to file-only output. Does not discover non-TypeScript test conventions or infer a non-unit suite without the filename marker.
- **Non-pass semantics:** `review` is explicit and exits non-pass; implementation exceptions are `fail`. `unknown`, `skipped`, and `N/A` are not emitted by the current inventory payload.
- **Example:** `devai sense inventory --slice all --repo-root . --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/inventory_slices)
- **Related workflow:** `sense`

<!-- devai:generated-reference:end category="inventory-slices" -->

## Choose a slice

Pass exactly one `--slice <name>` from the generated reference. There is no implicit
slice default. Prefer the narrowest projection that answers the question; use the
aggregate slice only when you need its complete canonical member population and have
satisfied every member-specific input prerequisite.

For a read-only route projection of the current repository:

```sh
devai sense inventory --slice routes --repo-root . --format json
```

An unknown slice or unimplemented canonical member fails instead of silently returning
an empty or partial inventory.

## Inputs and defaults

`--repo-root` defaults to the current directory. Other inputs are slice-dependent and
are listed in each generated descriptor: adopter root for stack-pack resolution, trace
input for adherence, coverage JSON for coverage, and optional read-only database URL
and schema filtering for schema discovery. Paths are resolved against the repository
root. When the runtime declares a default path, absence of the required file is an
error or an explicit review result according to that member's contract; it is never an
invented empty success.

Inventory output is read-only and has no implicit persistence. Supplying a database URL
authorizes only the descriptor's read-only introspection path; it does not grant database
write authority. The command requires neither `--write` nor `--publish`.

## Results and exits

Machine output contains the selected slice identifier, its source-derived member order,
one result object per member, aggregate status, and `implicit_persistence: false`. A
member returns PASS or REVIEW with its typed projection. Any REVIEW makes the aggregate
REVIEW. PASS exits `0`, REVIEW exits `1`, and invalid input or execution failure exits
`2`.

The projections describe what the registered extractors can observe from their declared
inputs. Unsupported syntax, ambiguous stack matching, absent optional substrates, stale
coverage, or incomplete trace data must remain visible as a limitation, review, or error
as specified by the generated descriptor. The current inventory-slice aggregate does
not emit N/A or skipped results. Do not treat an inventory as a readiness, release, or
conformance verdict.

## Canonical descriptor

- [Round-execution policy](../../../law/policy/round-execution.json) — exact inventory
  slice identities, member populations, and order.
- [Inventory slice loader](../../../packages/sensors/src/inventory-slices.ts) — runtime
  consumption and fail-closed descriptor validation.
- [Inventory command runtime](../../../packages/cli/src/commands/sense/inventory.ts) —
  accepted inputs, defaults, projections, aggregate result, and errors.
- [Inventory action contract](../../../law/policy/action-registry.json) — public read
  route, authority, consent, and output envelope.
- [Documentation information architecture](../../../law/policy/documentation-information-architecture.json)
  — deterministic rendering and no-copy rule.

This is the current canonical inventory-slice reference. It describes the supported
inventory projections, not readiness, release, or deployment.
