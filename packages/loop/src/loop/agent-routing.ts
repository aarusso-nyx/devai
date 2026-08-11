import { type AgentClass, type ModelRuntimeRegistry } from './model-runtime.js';

export type AgentSelection = { readonly mode: 'exact'; readonly registry_id: string };

export interface AgentExecutorRequest {
  readonly kind: 'agent';
  readonly runtime: string;
  readonly model: string;
  readonly effort: string;
  readonly selection: AgentSelection;
  readonly capabilities?: readonly string[];
  readonly agent_class?: AgentClass;
  readonly [key: string]: unknown;
}

export interface AgentResolvedExecutor {
  readonly registry_id: string;
  readonly runtime: string;
  readonly model: string;
  readonly effort: string;
  readonly adapter_id: string;
}

export interface AgentSelectionEvidence {
  readonly mode: 'exact';
  readonly considered: readonly string[];
  readonly considered_registry_ids: readonly string[];
  readonly selected_registry_id?: string;
  readonly rejection_codes: readonly string[];
  readonly fallback_used: false;
  readonly fallback_reason: null;
}

export type AgentResolution =
  | {
      readonly ok: true;
      readonly requested: AgentExecutorRequest;
      readonly resolved: AgentResolvedExecutor;
      readonly selection: AgentSelectionEvidence;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly requested: AgentExecutorRequest;
      readonly selection: AgentSelectionEvidence;
    };

export interface ResolveAgentExecutorOptions {
  readonly request: AgentExecutorRequest;
  readonly registry: ModelRuntimeRegistry;
  readonly agentClass?: AgentClass;
  /** Exact identity reported by the selected host bridge after preflight. */
  readonly reportedIdentity?: Readonly<{
    registry_id: string;
    runtime: string;
    model: string;
    effort: string;
    adapter_id: string;
  }>;
}

function fail(
  request: AgentExecutorRequest,
  code: string,
  considered: readonly string[] = [],
  rejectionCodes: readonly string[] = [],
): AgentResolution {
  return {
    ok: false,
    code,
    requested: request,
    selection: {
      mode: 'exact',
      considered,
      considered_registry_ids: considered,
      rejection_codes: rejectionCodes,
      fallback_used: false,
      fallback_reason: null,
    },
  };
}

/** Resolve only a host-selected runtime plus host-reported exact model identity. */
export function resolveAgentExecutor(options: ResolveAgentExecutorOptions): AgentResolution {
  const { request } = options;
  if (
    request.kind !== 'agent' ||
    request.selection.mode !== 'exact' ||
    request.runtime.length === 0 ||
    request.model.length === 0 ||
    request.effort.length === 0
  ) {
    return fail(request, 'TASK_MODEL_SELECTION_INVALID');
  }
  const registryId = `${request.runtime}:${request.model}`;
  const considered = [registryId];
  if (request.selection.registry_id !== registryId) {
    return fail(request, 'TASK_REGISTRY_IDENTITY_MISMATCH', considered, [
      'TASK_REGISTRY_IDENTITY_MISMATCH',
    ]);
  }
  const runtime = options.registry.runtimes.find((entry) => entry.id === request.runtime);
  if (runtime === undefined) {
    return fail(request, 'TASK_RUNTIME_UNKNOWN', considered, ['TASK_RUNTIME_UNKNOWN']);
  }
  if (!runtime.available) {
    return fail(request, 'TASK_RUNTIME_UNAVAILABLE', considered, ['TASK_RUNTIME_UNAVAILABLE']);
  }
  if (!runtime.efforts.includes(request.effort)) {
    return fail(request, 'TASK_EFFORT_UNSUPPORTED', considered, ['TASK_EFFORT_UNSUPPORTED']);
  }
  const agentClass = options.agentClass ?? request.agent_class;
  if (
    agentClass !== undefined &&
    !runtime.eligible_agent_classes.includes(agentClass)
  ) {
    return fail(request, 'TASK_AGENT_CLASS_INELIGIBLE', considered, [
      'TASK_AGENT_CLASS_INELIGIBLE',
    ]);
  }
  const requiredCapabilities = request.capabilities ?? [];
  if (requiredCapabilities.some((capability) => !runtime.capabilities.includes(capability))) {
    return fail(request, 'TASK_MODEL_CAPABILITY_UNSUPPORTED', considered, [
      'TASK_MODEL_CAPABILITY_UNSUPPORTED',
    ]);
  }
  const report = options.reportedIdentity;
  if (report === undefined) {
    return fail(request, 'TASK_HOST_IDENTITY_REQUIRED', considered, ['TASK_HOST_IDENTITY_REQUIRED']);
  }
  if (
    report.registry_id !== registryId ||
    report.runtime !== request.runtime ||
    report.model !== request.model ||
    report.effort !== request.effort ||
    report.adapter_id !== runtime.adapter_id
  ) {
    return fail(request, 'TASK_RESOLVED_IDENTITY_MISMATCH', considered, [
      'TASK_RESOLVED_IDENTITY_MISMATCH',
    ]);
  }
  return {
    ok: true,
    requested: request,
    resolved: {
      registry_id: registryId,
      runtime: request.runtime,
      model: request.model,
      effort: request.effort,
      adapter_id: runtime.adapter_id,
    },
    selection: {
      mode: 'exact',
      considered,
      considered_registry_ids: considered,
      selected_registry_id: registryId,
      rejection_codes: [],
      fallback_used: false,
      fallback_reason: null,
    },
  };
}
