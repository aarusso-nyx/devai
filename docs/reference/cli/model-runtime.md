---
title: Model runtime bridges
---

# Model runtime bridges

This generated reference describes runtime bridges, not a framework-owned model roster. The host
must supply the exact model identity and requested effort. Every attempt still requires adapter,
credential or login, provider reachability, and identity preflight. DEVAI never substitutes a
model. Edit the registry or renderer, never the bytes between markers.

<!-- devai:generated-reference:start category="runtimes" -->

## Runtimes

<!-- devai:generated-entry category="runtimes" id="anthropic-api" -->

### `anthropic-api` — Anthropic Provider Api runtime

- **Stable ID:** anthropic-api
- **User-facing label:** Anthropic Provider Api runtime
- **Purpose:** Connect an agent request through the declared `anthropic-sdk-adapter` adapter.
- **Population or projection:** Vendor `Anthropic`; family `claude`; transport `provider-api`; adapter `anthropic-sdk-adapter` at `packages/skills/src/model-bridge/index.ts`; capabilities `text-generation`, `structured-output-best-effort`.
- **Prerequisites:** adapter is present; credentials, provider reachability, exact model identity, and effort support require host preflight; host preflight is mandatory.
- **Required external tools:** `ANTHROPIC_API_KEY` and provider reachability.
- **Accepted inputs:** A task agent executor selecting `anthropic-api`, an exact host model identity, and one supported effort.
- **Defaults:** No adapter, credential, provider alias, or fallback is inferred.
- **Output contract:** Resolved runtime/model/effort, adapter/tool versions, selection decision, prompt and I/O digests, usage/cost, timestamps, verdict, and evidence references.
- **Verdict semantics:** Unavailable adapter, missing credential/login, unreachable provider, identity mismatch, or unsupported capability blocks before invocation.
- **Declared effect:** Not applicable: runtime capability and transport grant no action effect or governance authority.
- **Consent flags:** Not applicable: consent is resolved from the task work and its action effects, not from runtime availability.
- **Cost class:** `external-dependent`
- **When to use:** Use when the host selects `anthropic-api` and supplies an exact model identity.
- **When not to use:** Do not treat registry availability as proof of host reachability or as governance authority.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai doctor --probe llm --repo-root .`
- **Canonical source:** [`law/policy/model-runtime-registry.json`](../../../law/policy/model-runtime-registry.json#/runtimes)
- **Related workflow:** `round`

<!-- devai:generated-entry category="runtimes" id="claude-cli" -->

### `claude-cli` — Anthropic Host Cli runtime

- **Stable ID:** claude-cli
- **User-facing label:** Anthropic Host Cli runtime
- **Purpose:** Connect an agent request through the declared `claude-cli-adapter` adapter.
- **Population or projection:** Vendor `Anthropic`; family `claude`; transport `host-cli`; adapter `claude-cli-adapter` at `packages/skills/src/model-bridge/index.ts`; capabilities `text-generation`, `structured-output-best-effort`, `repository-context`.
- **Prerequisites:** adapter is present; executable, login, exact model identity, and effort support require host preflight; host preflight is mandatory.
- **Required external tools:** `claude` plus `host-cli-session`.
- **Accepted inputs:** A task agent executor selecting `claude-cli`, an exact host model identity, and one supported effort.
- **Defaults:** No adapter, credential, provider alias, or fallback is inferred.
- **Output contract:** Resolved runtime/model/effort, adapter/tool versions, selection decision, prompt and I/O digests, usage/cost, timestamps, verdict, and evidence references.
- **Verdict semantics:** Unavailable adapter, missing credential/login, unreachable provider, identity mismatch, or unsupported capability blocks before invocation.
- **Declared effect:** Not applicable: runtime capability and transport grant no action effect or governance authority.
- **Consent flags:** Not applicable: consent is resolved from the task work and its action effects, not from runtime availability.
- **Cost class:** `external-dependent`
- **When to use:** Use when the host selects `claude-cli` and supplies an exact model identity.
- **When not to use:** Do not treat registry availability as proof of host reachability or as governance authority.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai doctor --probe llm --repo-root .`
- **Canonical source:** [`law/policy/model-runtime-registry.json`](../../../law/policy/model-runtime-registry.json#/runtimes)
- **Related workflow:** `round`

<!-- devai:generated-entry category="runtimes" id="codex-cli" -->

### `codex-cli` — OpenAI Host Cli runtime

- **Stable ID:** codex-cli
- **User-facing label:** OpenAI Host Cli runtime
- **Purpose:** Connect an agent request through the declared `codex-cli-adapter` adapter.
- **Population or projection:** Vendor `OpenAI`; family `codex`; transport `host-cli`; adapter `codex-cli-adapter` at `packages/skills/src/model-bridge/index.ts`; capabilities `text-generation`, `structured-output`, `repository-context`.
- **Prerequisites:** adapter is present; executable, login, exact model identity, and effort support require host preflight; host preflight is mandatory.
- **Required external tools:** `codex` plus `host-cli-session`.
- **Accepted inputs:** A task agent executor selecting `codex-cli`, an exact host model identity, and one supported effort.
- **Defaults:** No adapter, credential, provider alias, or fallback is inferred.
- **Output contract:** Resolved runtime/model/effort, adapter/tool versions, selection decision, prompt and I/O digests, usage/cost, timestamps, verdict, and evidence references.
- **Verdict semantics:** Unavailable adapter, missing credential/login, unreachable provider, identity mismatch, or unsupported capability blocks before invocation.
- **Declared effect:** Not applicable: runtime capability and transport grant no action effect or governance authority.
- **Consent flags:** Not applicable: consent is resolved from the task work and its action effects, not from runtime availability.
- **Cost class:** `external-dependent`
- **When to use:** Use when the host selects `codex-cli` and supplies an exact model identity.
- **When not to use:** Do not treat registry availability as proof of host reachability or as governance authority.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai doctor --probe llm --repo-root .`
- **Canonical source:** [`law/policy/model-runtime-registry.json`](../../../law/policy/model-runtime-registry.json#/runtimes)
- **Related workflow:** `round`

<!-- devai:generated-entry category="runtimes" id="openai-api" -->

### `openai-api` — OpenAI Provider Api runtime

- **Stable ID:** openai-api
- **User-facing label:** OpenAI Provider Api runtime
- **Purpose:** Connect an agent request through the declared `openai-sdk-adapter` adapter.
- **Population or projection:** Vendor `OpenAI`; family `codex`; transport `provider-api`; adapter `openai-sdk-adapter` at `packages/skills/src/model-bridge/index.ts`; capabilities `text-generation`, `structured-output`.
- **Prerequisites:** adapter is present; credentials, provider reachability, exact model identity, and effort support require host preflight; host preflight is mandatory.
- **Required external tools:** `OPENAI_API_KEY` and provider reachability.
- **Accepted inputs:** A task agent executor selecting `openai-api`, an exact host model identity, and one supported effort.
- **Defaults:** No adapter, credential, provider alias, or fallback is inferred.
- **Output contract:** Resolved runtime/model/effort, adapter/tool versions, selection decision, prompt and I/O digests, usage/cost, timestamps, verdict, and evidence references.
- **Verdict semantics:** Unavailable adapter, missing credential/login, unreachable provider, identity mismatch, or unsupported capability blocks before invocation.
- **Declared effect:** Not applicable: runtime capability and transport grant no action effect or governance authority.
- **Consent flags:** Not applicable: consent is resolved from the task work and its action effects, not from runtime availability.
- **Cost class:** `external-dependent`
- **When to use:** Use when the host selects `openai-api` and supplies an exact model identity.
- **When not to use:** Do not treat registry availability as proof of host reachability or as governance authority.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai doctor --probe llm --repo-root .`
- **Canonical source:** [`law/policy/model-runtime-registry.json`](../../../law/policy/model-runtime-registry.json#/runtimes)
- **Related workflow:** `round`

<!-- devai:generated-reference:end category="runtimes" -->

<!-- devai:generated-reference:start category="supported-efforts" -->

## Supported efforts

<!-- devai:generated-entry category="supported-efforts" id="default" -->

### `default` — Default

- **Stable ID:** default
- **User-facing label:** Default
- **Purpose:** Request the exact rostered `default` effort without inventing provider semantics.
- **Population or projection:** Supported by `anthropic-api`, `claude-cli`, `openai-api`.
- **Prerequisites:** One runtime bridge that explicitly lists this effort, an exact host model identity, and a successful preflight.
- **Required external tools:** The selected model runtime adapter and provider or host session.
- **Accepted inputs:** An agent executor selecting `default` with one of the listed runtime bridges and an exact host model.
- **Defaults:** No effort is inferred across runtimes; the selected runtime must declare the requested effort.
- **Output contract:** Requested effort remains in the immutable executor digest and resolved effort appears in task-execution evidence.
- **Verdict semantics:** An effort/model mismatch blocks before invocation and never falls back implicitly.
- **Declared effect:** Not applicable: effort selection grants no action effect or governance authority.
- **Consent flags:** Not applicable: consent is resolved from the task work and its action effects, not from effort selection.
- **Cost class:** `external-dependent`
- **When to use:** Use `default` only with a runtime listed in this generated projection.
- **When not to use:** Do not assume every runtime or host model supports this effort.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai doctor --probe llm --repo-root .`
- **Canonical source:** [`law/policy/model-runtime-registry.json`](../../../law/policy/model-runtime-registry.json#/runtimes/*/efforts)
- **Related workflow:** `round`

<!-- devai:generated-entry category="supported-efforts" id="high" -->

### `high` — High

- **Stable ID:** high
- **User-facing label:** High
- **Purpose:** Request the exact rostered `high` effort without inventing provider semantics.
- **Population or projection:** Supported by `claude-cli`, `codex-cli`, `openai-api`.
- **Prerequisites:** One runtime bridge that explicitly lists this effort, an exact host model identity, and a successful preflight.
- **Required external tools:** The selected model runtime adapter and provider or host session.
- **Accepted inputs:** An agent executor selecting `high` with one of the listed runtime bridges and an exact host model.
- **Defaults:** No effort is inferred across runtimes; the selected runtime must declare the requested effort.
- **Output contract:** Requested effort remains in the immutable executor digest and resolved effort appears in task-execution evidence.
- **Verdict semantics:** An effort/model mismatch blocks before invocation and never falls back implicitly.
- **Declared effect:** Not applicable: effort selection grants no action effect or governance authority.
- **Consent flags:** Not applicable: consent is resolved from the task work and its action effects, not from effort selection.
- **Cost class:** `external-dependent`
- **When to use:** Use `high` only with a runtime listed in this generated projection.
- **When not to use:** Do not assume every runtime or host model supports this effort.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai doctor --probe llm --repo-root .`
- **Canonical source:** [`law/policy/model-runtime-registry.json`](../../../law/policy/model-runtime-registry.json#/runtimes/*/efforts)
- **Related workflow:** `round`

<!-- devai:generated-entry category="supported-efforts" id="low" -->

### `low` — Low

- **Stable ID:** low
- **User-facing label:** Low
- **Purpose:** Request the exact rostered `low` effort without inventing provider semantics.
- **Population or projection:** Supported by `claude-cli`, `codex-cli`, `openai-api`.
- **Prerequisites:** One runtime bridge that explicitly lists this effort, an exact host model identity, and a successful preflight.
- **Required external tools:** The selected model runtime adapter and provider or host session.
- **Accepted inputs:** An agent executor selecting `low` with one of the listed runtime bridges and an exact host model.
- **Defaults:** No effort is inferred across runtimes; the selected runtime must declare the requested effort.
- **Output contract:** Requested effort remains in the immutable executor digest and resolved effort appears in task-execution evidence.
- **Verdict semantics:** An effort/model mismatch blocks before invocation and never falls back implicitly.
- **Declared effect:** Not applicable: effort selection grants no action effect or governance authority.
- **Consent flags:** Not applicable: consent is resolved from the task work and its action effects, not from effort selection.
- **Cost class:** `external-dependent`
- **When to use:** Use `low` only with a runtime listed in this generated projection.
- **When not to use:** Do not assume every runtime or host model supports this effort.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai doctor --probe llm --repo-root .`
- **Canonical source:** [`law/policy/model-runtime-registry.json`](../../../law/policy/model-runtime-registry.json#/runtimes/*/efforts)
- **Related workflow:** `round`

<!-- devai:generated-entry category="supported-efforts" id="max" -->

### `max` — Max

- **Stable ID:** max
- **User-facing label:** Max
- **Purpose:** Request the exact rostered `max` effort without inventing provider semantics.
- **Population or projection:** Supported by `codex-cli`, `openai-api`.
- **Prerequisites:** One runtime bridge that explicitly lists this effort, an exact host model identity, and a successful preflight.
- **Required external tools:** The selected model runtime adapter and provider or host session.
- **Accepted inputs:** An agent executor selecting `max` with one of the listed runtime bridges and an exact host model.
- **Defaults:** No effort is inferred across runtimes; the selected runtime must declare the requested effort.
- **Output contract:** Requested effort remains in the immutable executor digest and resolved effort appears in task-execution evidence.
- **Verdict semantics:** An effort/model mismatch blocks before invocation and never falls back implicitly.
- **Declared effect:** Not applicable: effort selection grants no action effect or governance authority.
- **Consent flags:** Not applicable: consent is resolved from the task work and its action effects, not from effort selection.
- **Cost class:** `external-dependent`
- **When to use:** Use `max` only with a runtime listed in this generated projection.
- **When not to use:** Do not assume every runtime or host model supports this effort.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai doctor --probe llm --repo-root .`
- **Canonical source:** [`law/policy/model-runtime-registry.json`](../../../law/policy/model-runtime-registry.json#/runtimes/*/efforts)
- **Related workflow:** `round`

<!-- devai:generated-entry category="supported-efforts" id="medium" -->

### `medium` — Medium

- **Stable ID:** medium
- **User-facing label:** Medium
- **Purpose:** Request the exact rostered `medium` effort without inventing provider semantics.
- **Population or projection:** Supported by `claude-cli`, `codex-cli`, `openai-api`.
- **Prerequisites:** One runtime bridge that explicitly lists this effort, an exact host model identity, and a successful preflight.
- **Required external tools:** The selected model runtime adapter and provider or host session.
- **Accepted inputs:** An agent executor selecting `medium` with one of the listed runtime bridges and an exact host model.
- **Defaults:** No effort is inferred across runtimes; the selected runtime must declare the requested effort.
- **Output contract:** Requested effort remains in the immutable executor digest and resolved effort appears in task-execution evidence.
- **Verdict semantics:** An effort/model mismatch blocks before invocation and never falls back implicitly.
- **Declared effect:** Not applicable: effort selection grants no action effect or governance authority.
- **Consent flags:** Not applicable: consent is resolved from the task work and its action effects, not from effort selection.
- **Cost class:** `external-dependent`
- **When to use:** Use `medium` only with a runtime listed in this generated projection.
- **When not to use:** Do not assume every runtime or host model supports this effort.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai doctor --probe llm --repo-root .`
- **Canonical source:** [`law/policy/model-runtime-registry.json`](../../../law/policy/model-runtime-registry.json#/runtimes/*/efforts)
- **Related workflow:** `round`

<!-- devai:generated-entry category="supported-efforts" id="ultra" -->

### `ultra` — Ultra

- **Stable ID:** ultra
- **User-facing label:** Ultra
- **Purpose:** Request the exact rostered `ultra` effort without inventing provider semantics.
- **Population or projection:** Supported by `codex-cli`, `openai-api`.
- **Prerequisites:** One runtime bridge that explicitly lists this effort, an exact host model identity, and a successful preflight.
- **Required external tools:** The selected model runtime adapter and provider or host session.
- **Accepted inputs:** An agent executor selecting `ultra` with one of the listed runtime bridges and an exact host model.
- **Defaults:** No effort is inferred across runtimes; the selected runtime must declare the requested effort.
- **Output contract:** Requested effort remains in the immutable executor digest and resolved effort appears in task-execution evidence.
- **Verdict semantics:** An effort/model mismatch blocks before invocation and never falls back implicitly.
- **Declared effect:** Not applicable: effort selection grants no action effect or governance authority.
- **Consent flags:** Not applicable: consent is resolved from the task work and its action effects, not from effort selection.
- **Cost class:** `external-dependent`
- **When to use:** Use `ultra` only with a runtime listed in this generated projection.
- **When not to use:** Do not assume every runtime or host model supports this effort.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai doctor --probe llm --repo-root .`
- **Canonical source:** [`law/policy/model-runtime-registry.json`](../../../law/policy/model-runtime-registry.json#/runtimes/*/efforts)
- **Related workflow:** `round`

<!-- devai:generated-entry category="supported-efforts" id="xhigh" -->

### `xhigh` — Xhigh

- **Stable ID:** xhigh
- **User-facing label:** Xhigh
- **Purpose:** Request the exact rostered `xhigh` effort without inventing provider semantics.
- **Population or projection:** Supported by `codex-cli`, `openai-api`.
- **Prerequisites:** One runtime bridge that explicitly lists this effort, an exact host model identity, and a successful preflight.
- **Required external tools:** The selected model runtime adapter and provider or host session.
- **Accepted inputs:** An agent executor selecting `xhigh` with one of the listed runtime bridges and an exact host model.
- **Defaults:** No effort is inferred across runtimes; the selected runtime must declare the requested effort.
- **Output contract:** Requested effort remains in the immutable executor digest and resolved effort appears in task-execution evidence.
- **Verdict semantics:** An effort/model mismatch blocks before invocation and never falls back implicitly.
- **Declared effect:** Not applicable: effort selection grants no action effect or governance authority.
- **Consent flags:** Not applicable: consent is resolved from the task work and its action effects, not from effort selection.
- **Cost class:** `external-dependent`
- **When to use:** Use `xhigh` only with a runtime listed in this generated projection.
- **When not to use:** Do not assume every runtime or host model supports this effort.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai doctor --probe llm --repo-root .`
- **Canonical source:** [`law/policy/model-runtime-registry.json`](../../../law/policy/model-runtime-registry.json#/runtimes/*/efforts)
- **Related workflow:** `round`

<!-- devai:generated-reference:end category="supported-efforts" -->
