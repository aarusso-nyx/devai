import {
  executorFailure,
  isUniqueNonEmptyStrings,
  permissionTierAllows,
  type AgentClass,
  type ExecutorDiscipline,
  type ExecutorFailure,
  type PermissionTier,
} from './executor-adapters.js';

export interface AgentExecutorRequest {
  readonly kind: 'agent';
  readonly runtime: string;
  readonly model: string;
  readonly effort: string;
  readonly prompt_composition_id: string;
  readonly max_iterations: number;
  readonly capabilities: readonly string[];
  readonly recipe_name?: string;
  readonly recipe_variant?: string;
}

export interface ResolvedAgentAdapterTarget {
  readonly registry_id: string;
  readonly runtime: string;
  readonly model: string;
  readonly effort: string;
  readonly adapter_id: string;
  readonly capabilities: readonly string[];
  readonly eligible_agent_classes: readonly AgentClass[];
}

export interface AgentRecipeMetadata {
  readonly name: string;
  readonly variant: string;
  readonly agent_class: AgentClass;
  readonly permission_tier: PermissionTier;
  readonly capabilities: readonly string[];
  readonly authority_role: ExecutorDiscipline;
}

export interface AgentAuthority {
  readonly discipline: ExecutorDiscipline;
  readonly agent_class: AgentClass;
  readonly permission_tier: PermissionTier;
  readonly capabilities: readonly string[];
}

export interface AgentPromptComposition {
  readonly id: string;
  readonly digest: string;
}

export interface ValidateAgentOptions {
  readonly executor: AgentExecutorRequest;
  readonly resolved: ResolvedAgentAdapterTarget;
  readonly authority: AgentAuthority;
  readonly promptComposition: AgentPromptComposition;
  readonly recipe?: AgentRecipeMetadata;
  readonly preflight?: (target: ResolvedAgentAdapterTarget) => boolean | ExecutorFailure;
  readonly authorize?: (request: {
    readonly discipline: ExecutorDiscipline;
    readonly executor: AgentExecutorRequest;
    readonly resolved: ResolvedAgentAdapterTarget;
  }) => boolean | ExecutorFailure;
}

export interface ValidatedAgentExecutor {
  readonly ok: true;
  readonly discipline: ExecutorDiscipline;
  readonly resolved: ResolvedAgentAdapterTarget;
  readonly prompt: AgentPromptComposition;
  readonly recipe?: AgentRecipeMetadata;
}

export function validateAgentExecutor(
  options: ValidateAgentOptions,
): ValidatedAgentExecutor | ExecutorFailure {
  const { executor, resolved, authority, promptComposition } = options;
  if (executor.kind !== 'agent') {
    return executorFailure('TASK_AGENT_KIND_INVALID', 'the agent adapter only accepts kind=agent');
  }
  if (!/^PC-[a-f0-9]{16}$/u.test(executor.prompt_composition_id)) {
    return executorFailure(
      'TASK_PROMPT_COMPOSITION_REQUIRED',
      'agent work requires one valid prompt-composition identity',
    );
  }
  if (
    promptComposition.id !== executor.prompt_composition_id ||
    !/^[a-f0-9]{64}$/u.test(promptComposition.digest)
  ) {
    return executorFailure(
      'TASK_PROMPT_COMPOSITION_MISMATCH',
      'the supplied prompt composition does not match the immutable task request',
    );
  }
  if (!Number.isSafeInteger(executor.max_iterations) || executor.max_iterations < 1) {
    return executorFailure('TASK_AGENT_ITERATIONS_INVALID', 'agent iterations must be bounded');
  }
  if (!isUniqueNonEmptyStrings(executor.capabilities)) {
    return executorFailure(
      'TASK_AGENT_CAPABILITIES_INVALID',
      'capabilities must be explicit and unique',
    );
  }
  if (
    resolved.runtime !== executor.runtime ||
    resolved.model !== executor.model ||
    resolved.effort !== executor.effort
  ) {
    return executorFailure(
      'TASK_AGENT_RESOLUTION_MISMATCH',
      'the adapter target does not match the separately resolved executor request',
    );
  }
  if (!resolved.eligible_agent_classes.includes(authority.agent_class)) {
    return executorFailure(
      'TASK_AGENT_CLASS_INELIGIBLE',
      `resolved model is not eligible for ${authority.agent_class}`,
    );
  }
  const resolvedCapabilities = new Set(resolved.capabilities);
  const unavailable = executor.capabilities.filter(
    (capability) => !resolvedCapabilities.has(capability),
  );
  if (unavailable.length > 0) {
    return executorFailure(
      'TASK_AGENT_CAPABILITY_UNSUPPORTED',
      `resolved model lacks: ${unavailable.join(', ')}`,
    );
  }
  const authorityCapabilities = new Set(authority.capabilities);
  const unauthorized = executor.capabilities.filter(
    (capability) => !authorityCapabilities.has(capability),
  );
  if (unauthorized.length > 0) {
    return executorFailure(
      'TASK_AGENT_CAPABILITY_UNAUTHORIZED',
      `task discipline authority does not grant: ${unauthorized.join(', ')}`,
    );
  }

  if (executor.recipe_name !== undefined) {
    const recipe = options.recipe;
    if (
      recipe === undefined ||
      recipe.name !== executor.recipe_name ||
      recipe.variant !== executor.recipe_variant
    ) {
      return executorFailure(
        'TASK_AGENT_RECIPE_UNAVAILABLE',
        'the requested recipe variant is not registered',
      );
    }
    if (recipe.authority_role !== authority.discipline) {
      return executorFailure(
        'TASK_AGENT_RECIPE_AUTHORITY_MISMATCH',
        'recipe authority must match the task discipline; it cannot widen task authority',
      );
    }
    if (recipe.agent_class !== authority.agent_class) {
      return executorFailure(
        'TASK_AGENT_RECIPE_CLASS_MISMATCH',
        'recipe and task agent classes are incompatible',
      );
    }
    if (!permissionTierAllows(authority.permission_tier, recipe.permission_tier)) {
      return executorFailure(
        'TASK_AGENT_RECIPE_PERMISSION_DENIED',
        'recipe variant permission tier exceeds task authority',
      );
    }
    const recipeCapabilities = new Set(recipe.capabilities);
    const incompatible = executor.capabilities.filter(
      (capability) => !recipeCapabilities.has(capability),
    );
    if (incompatible.length > 0) {
      return executorFailure(
        'TASK_AGENT_RECIPE_CAPABILITY_MISMATCH',
        `recipe variant does not declare: ${incompatible.join(', ')}`,
      );
    }
  } else if (options.recipe !== undefined) {
    return executorFailure(
      'TASK_AGENT_RECIPE_UNREQUESTED',
      'an adapter may not attach a recipe absent from the immutable request',
    );
  }

  const preflight = options.preflight?.(resolved);
  if (preflight === false) {
    return executorFailure('TASK_AGENT_PREFLIGHT_FAILED', 'runtime adapter preflight failed');
  }
  if (typeof preflight === 'object' && preflight.ok === false) return preflight;

  const decision = options.authorize?.({
    discipline: authority.discipline,
    executor,
    resolved,
  });
  if (decision === false) {
    return executorFailure('TASK_AGENT_AUTHORITY_DENIED', 'task discipline denied agent dispatch');
  }
  if (typeof decision === 'object' && decision.ok === false) return decision;

  return {
    ok: true,
    discipline: authority.discipline,
    resolved,
    prompt: promptComposition,
    ...(options.recipe !== undefined && { recipe: options.recipe }),
  };
}

export interface ExecuteAgentOptions extends ValidateAgentOptions {
  readonly invokeAgent: (request: {
    readonly discipline: ExecutorDiscipline;
    readonly executor: AgentExecutorRequest;
    readonly resolved: ResolvedAgentAdapterTarget;
    readonly prompt: AgentPromptComposition;
    readonly recipe?: AgentRecipeMetadata;
  }) => unknown | Promise<unknown>;
}

export type AgentExecutionResult =
  | ExecutorFailure
  | {
      readonly ok: true;
      readonly discipline: ExecutorDiscipline;
      readonly resolved: ResolvedAgentAdapterTarget;
      readonly prompt_composition_id: string;
      readonly output: unknown;
    };

export async function executeAgentExecutor(
  options: ExecuteAgentOptions,
): Promise<AgentExecutionResult> {
  const validated = validateAgentExecutor(options);
  if (!validated.ok) return validated;
  const output = await options.invokeAgent({
    discipline: validated.discipline,
    executor: options.executor,
    resolved: validated.resolved,
    prompt: validated.prompt,
    ...(validated.recipe !== undefined && { recipe: validated.recipe }),
  });
  return {
    ok: true,
    discipline: validated.discipline,
    resolved: validated.resolved,
    prompt_composition_id: validated.prompt.id,
    output,
  };
}
