import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveAgentExecutor,
  type AgentExecutorRequest,
  type ResolveAgentExecutorOptions,
} from '../../src/loop/agent-routing.js';
import { validateModelRuntimeRegistry } from '../../src/loop/model-runtime.js';
const registry = validateModelRuntimeRegistry(
  JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../../../../law/policy/model-runtime-registry.json'),
      'utf8',
    ),
  ),
);
function fixture(): ResolveAgentExecutorOptions {
  return {
    registry: structuredClone(registry),
    request: {
      kind: 'agent',
      runtime: 'codex-cli',
      model: 'exact-fixture-model',
      effort: 'high',
      selection: { mode: 'exact', registry_id: 'codex-cli:exact-fixture-model' },
      capabilities: ['repository-context'],
      agent_class: 'coding-agent',
    },
    reportedIdentity: {
      registry_id: 'codex-cli:exact-fixture-model',
      runtime: 'codex-cli',
      model: 'exact-fixture-model',
      effort: 'high',
      adapter_id: 'codex-cli-adapter',
    },
  };
}
function expectRefusal(
  options: ResolveAgentExecutorOptions,
  code: string,
  considered = ['codex-cli:exact-fixture-model'],
): void {
  const before = JSON.stringify(options);
  expect(resolveAgentExecutor(options)).toEqual({
    ok: false,
    code,
    requested: options.request,
    selection: {
      mode: 'exact',
      considered,
      considered_registry_ids: considered,
      rejection_codes: considered.length === 0 ? [] : [code],
      fallback_used: false,
      fallback_reason: null,
    },
  });
  expect(JSON.stringify(options)).toBe(before);
}

describe('exact agent resolution preserves identity and explicit rejection evidence', () => {
  it('returns the complete exact selection without modifying the host request or registry', () => {
    const f = fixture();
    const before = JSON.stringify(f);
    expect(resolveAgentExecutor(f)).toEqual({
      ok: true,
      requested: f.request,
      resolved: f.reportedIdentity,
      selection: {
        mode: 'exact',
        considered: ['codex-cli:exact-fixture-model'],
        considered_registry_ids: ['codex-cli:exact-fixture-model'],
        selected_registry_id: 'codex-cli:exact-fixture-model',
        rejection_codes: [],
        fallback_used: false,
        fallback_reason: null,
      },
    });
    expect(JSON.stringify(f)).toBe(before);
  });
  it.each(['runtime', 'model', 'effort'] as const)(
    'refuses an empty %s before considering any provider',
    (key) => {
      const f = fixture();
      expectRefusal(
        { ...f, request: { ...f.request, [key]: '' } },
        'TASK_MODEL_SELECTION_INVALID',
        [],
      );
    },
  );
  it('rejects non-exact selection at the runtime boundary', () => {
    const f = fixture();
    const request = {
      ...f.request,
      selection: { mode: 'automatic', registry_id: f.request.selection.registry_id },
    } as unknown as AgentExecutorRequest;
    expectRefusal({ ...f, request }, 'TASK_MODEL_SELECTION_INVALID', []);
  });
  it('rejects an unknown runtime even with a self-consistent requested registry identity', () => {
    const f = fixture();
    expectRefusal(
      {
        ...f,
        request: {
          ...f.request,
          runtime: 'unregistered',
          selection: { mode: 'exact', registry_id: 'unregistered:exact-fixture-model' },
        },
      },
      'TASK_RUNTIME_UNKNOWN',
      ['unregistered:exact-fixture-model'],
    );
  });
  it('does not choose another available runtime when the selected one is unavailable', () => {
    const f = fixture();
    expectRefusal(
      {
        ...f,
        registry: {
          ...f.registry,
          runtimes: f.registry.runtimes.map((entry) =>
            entry.id === 'codex-cli' ? { ...entry, available: false } : entry,
          ),
        },
      },
      'TASK_RUNTIME_UNAVAILABLE',
    );
  });
  it('requires every requested capability, including one absent from the selected runtime', () => {
    const f = fixture();
    expectRefusal(
      {
        ...f,
        request: { ...f.request, capabilities: ['repository-context', 'unavailable-capability'] },
      },
      'TASK_MODEL_CAPABILITY_UNSUPPORTED',
    );
  });
  it('uses explicit host agent class over the request class', () => {
    const f = fixture();
    const limited = {
      ...f.registry,
      runtimes: f.registry.runtimes.map((entry) =>
        entry.id === 'codex-cli'
          ? { ...entry, eligible_agent_classes: ['coding-agent'] as const }
          : entry,
      ),
    };
    expectRefusal(
      { ...f, registry: limited, agentClass: 'review-agent' },
      'TASK_AGENT_CLASS_INELIGIBLE',
    );
    expect(
      resolveAgentExecutor({
        ...f,
        registry: limited,
        request: { ...f.request, agent_class: 'review-agent' },
        agentClass: 'coding-agent',
      }).ok,
    ).toBe(true);
  });
  it('uses the declared class when no explicit host class is supplied', () => {
    const f = fixture();
    expectRefusal(
      {
        ...f,
        registry: {
          ...f.registry,
          runtimes: f.registry.runtimes.map((entry) =>
            entry.id === 'codex-cli'
              ? { ...entry, eligible_agent_classes: ['ops-agent'] as const }
              : entry,
          ),
        },
      },
      'TASK_AGENT_CLASS_INELIGIBLE',
    );
  });
  it('allows omitted optional capabilities and class while retaining exact identity', () => {
    const f = fixture();
    expect(
      resolveAgentExecutor({
        ...f,
        request: { ...f.request, agent_class: undefined, capabilities: undefined },
      }),
    ).toMatchObject({ ok: true, resolved: f.reportedIdentity });
  });
  it('refuses a missing host identity report instead of inferring the model', () => {
    expectRefusal({ ...fixture(), reportedIdentity: undefined }, 'TASK_HOST_IDENTITY_REQUIRED');
  });
  it.each(['registry_id', 'runtime', 'model', 'effort', 'adapter_id'] as const)(
    'rejects a substituted host report %s',
    (key) => {
      const f = fixture();
      if (!f.reportedIdentity) throw new Error('Missing fixture report');
      expectRefusal(
        { ...f, reportedIdentity: { ...f.reportedIdentity, [key]: 'substituted' } },
        'TASK_RESOLVED_IDENTITY_MISMATCH',
      );
    },
  );
});
