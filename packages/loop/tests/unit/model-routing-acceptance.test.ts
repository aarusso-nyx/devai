import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAgentExecutor, type AgentExecutorRequest } from '../../src/loop/agent-routing.js';
import {
  loadModelRuntimeRegistry,
  validateModelRuntimeRegistry,
} from '../../src/loop/model-runtime.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const source = readFileSync(resolve(ROOT, 'law/policy/model-runtime-registry.json'), 'utf8');
const document = JSON.parse(source) as Record<string, unknown>;

describe('runtime bridge registry', () => {
  it('loads runtime bridges without a framework model roster', () => {
    const registry = validateModelRuntimeRegistry(document);
    expect(registry.runtimes).toHaveLength(4);
    expect('models' in registry).toBe(false);
    expect(loadModelRuntimeRegistry({ repoRoot: ROOT, candidate: source })).toEqual(registry);
    expect(loadModelRuntimeRegistry({ repoRoot: ROOT, candidate: Buffer.from(source) })).toEqual(
      registry,
    );
  });

  it('rejects model rosters, selection policy, duplicate runtimes, and malformed bridges', () => {
    const invalid: unknown[] = [
      null,
      { ...structuredClone(document), models: [] },
      { ...structuredClone(document), selection: {} },
    ];
    const duplicate = structuredClone(document);
    (duplicate['runtimes'] as unknown[]).push(
      structuredClone((duplicate['runtimes'] as unknown[])[0]),
    );
    invalid.push(duplicate);
    for (const candidate of invalid) expect(() => validateModelRuntimeRegistry(candidate)).toThrow();
  });
});

describe('exact host-selected model resolution', () => {
  const registry = validateModelRuntimeRegistry(document);
  const request: AgentExecutorRequest = {
    kind: 'agent',
    runtime: 'codex-cli',
    model: 'host-exact-model-id',
    effort: 'high',
    selection: { mode: 'exact', registry_id: 'codex-cli:host-exact-model-id' },
    capabilities: ['repository-context'],
    agent_class: 'coding-agent',
  };
  const report = {
    registry_id: 'codex-cli:host-exact-model-id',
    runtime: 'codex-cli',
    model: 'host-exact-model-id',
    effort: 'high',
    adapter_id: 'codex-cli-adapter',
  } as const;

  it('requires and preserves the exact identity reported by the selected host bridge', () => {
    expect(resolveAgentExecutor({ request, registry })).toMatchObject({
      ok: false,
      code: 'TASK_HOST_IDENTITY_REQUIRED',
    });
    expect(resolveAgentExecutor({ request, registry, reportedIdentity: report })).toMatchObject({
      ok: true,
      resolved: report,
      selection: { fallback_used: false, fallback_reason: null },
    });
  });

  it('fails closed on substitution, unsupported effort, capability, runtime, or adapter report', () => {
    const cases = [
      {
        request: { ...request, selection: { mode: 'exact' as const, registry_id: 'other' } },
        code: 'TASK_REGISTRY_IDENTITY_MISMATCH',
      },
      { request: { ...request, effort: 'default' }, code: 'TASK_EFFORT_UNSUPPORTED' },
      { request: { ...request, capabilities: ['missing'] }, code: 'TASK_MODEL_CAPABILITY_UNSUPPORTED' },
      { request: { ...request, runtime: 'missing' }, code: 'TASK_REGISTRY_IDENTITY_MISMATCH' },
    ];
    for (const item of cases) {
      expect(resolveAgentExecutor({ request: item.request, registry, reportedIdentity: report })).toMatchObject({
        ok: false,
        code: item.code,
      });
    }
    expect(
      resolveAgentExecutor({
        request,
        registry,
        reportedIdentity: { ...report, model: 'substituted' },
      }),
    ).toMatchObject({ ok: false, code: 'TASK_RESOLVED_IDENTITY_MISMATCH' });
  });
});
