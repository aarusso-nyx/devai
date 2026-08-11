// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// Inspector acceptance: routine, agent, and composite executors remain bounded
// by their immutable requests and return structured fail-closed outcomes.
import { describe, expect, it, vi } from 'vitest';
import {
  executeAgentExecutor,
  validateAgentExecutor,
  type AgentAuthority,
  type AgentExecutorRequest,
  type AgentPromptComposition,
  type AgentRecipeMetadata,
  type ResolvedAgentAdapterTarget,
} from '../../src/loop/agent-executor.js';
import {
  validateCompositeExecutor as validateCompositeExecutorCore,
  type CompositeChild,
  type CompositeExecutorRequest,
} from '../../src/loop/composite-executor.js';
import {
  executeRoutineExecutor,
  validateRoutineExecutor,
  type RoutineActionRegistryEntry,
  type RoutineAuthority,
  type RoutineExecutorRequest,
} from '../../src/loop/routine-executor.js';

function code(result: { readonly ok: boolean; readonly code?: string }): string | undefined {
  return result.code;
}

function validateCompositeExecutor(
  options: Parameters<typeof validateCompositeExecutorCore>[0],
): ReturnType<typeof validateCompositeExecutorCore> & { readonly code?: string } {
  return validateCompositeExecutorCore(options);
}

function routine(overrides: Partial<RoutineExecutorRequest> = {}): RoutineExecutorRequest {
  return {
    kind: 'routine',
    argv: ['node', 'fixture.mjs'],
    cwd: '.',
    inputs: ['input.json'],
    outputs: ['output.json'],
    effects: ['read'],
    timeout_ms: 1_000,
    authority_checks: ['discipline'],
    ...overrides,
  };
}

const ROUTINE_AUTHORITY: RoutineAuthority = {
  discipline: 'engineer',
  capabilities: ['fs.read', 'fs.write', 'publish'],
  write: true,
  allow_publish: true,
};

function action(overrides: Partial<RoutineActionRegistryEntry> = {}): RoutineActionRegistryEntry {
  return {
    action_id: 'fixture action',
    internal_binding: 'fixture action',
    effect: 'read',
    authority_contract: {
      effect: 'read',
      capabilities: ['fs.read'],
      subject: { kind: 'human', allowed_roles: ['engineer'] },
      consent: { write: false, allow_publish: false },
    },
    ...overrides,
  };
}

function registered(overrides: Partial<RoutineExecutorRequest> = {}): RoutineExecutorRequest {
  return routine({ argv: undefined, action_id: 'fixture action', ...overrides });
}

function agent(overrides: Partial<AgentExecutorRequest> = {}): AgentExecutorRequest {
  return {
    kind: 'agent',
    runtime: 'codex',
    model: 'gpt-fixture',
    effort: 'high',
    prompt_composition_id: 'PC-0123456789abcdef',
    max_iterations: 2,
    capabilities: ['code.read'],
    ...overrides,
  };
}

const RESOLVED: ResolvedAgentAdapterTarget = {
  registry_id: 'codex:gpt-fixture:high',
  runtime: 'codex',
  model: 'gpt-fixture',
  effort: 'high',
  adapter_id: 'codex-adapter',
  capabilities: ['code.read', 'code.write'],
  eligible_agent_classes: ['coding-agent'],
};
const AGENT_AUTHORITY: AgentAuthority = {
  discipline: 'engineer',
  agent_class: 'coding-agent',
  permission_tier: 'write',
  capabilities: ['code.read', 'code.write'],
};
const PROMPT: AgentPromptComposition = {
  id: 'PC-0123456789abcdef',
  digest: 'a'.repeat(64),
};
const RECIPE: AgentRecipeMetadata = {
  name: 'devai-fix',
  variant: 'lint',
  agent_class: 'coding-agent',
  permission_tier: 'read',
  capabilities: ['code.read', 'code.write'],
  authority_role: 'engineer',
};

function compositeExecutor(
  overrides: Partial<CompositeExecutorRequest> = {},
): CompositeExecutorRequest {
  return {
    kind: 'composite',
    child_task_ids: ['TASK-8101', 'TASK-8102', 'TASK-8103'],
    dependencies: [
      { task_id: 'TASK-8101', depends_on: [] },
      { task_id: 'TASK-8102', depends_on: ['TASK-8101'] },
      { task_id: 'TASK-8103', depends_on: ['TASK-8101'] },
    ],
    failure_policy: 'stop-dependent-branch',
    ...overrides,
  };
}

const CHILDREN: readonly CompositeChild[] = [
  { id: 'TASK-8101', round_id: 'R-0007' },
  { id: 'TASK-8102', round_id: 'R-0007' },
  { id: 'TASK-8103', round_id: 'R-0007' },
];

describe('routine executor acceptance', () => {
  it('rejects malformed literal requests and authority widening', () => {
    const cases: readonly [RoutineExecutorRequest, string][] = [
      [{ ...routine(), kind: 'agent' } as never, 'TASK_ROUTINE_KIND_INVALID'],
      [routine({ action_id: 'fixture action' }), 'TASK_ROUTINE_BINDING_INVALID'],
      [routine({ argv: undefined }), 'TASK_ROUTINE_BINDING_INVALID'],
      [routine({ cwd: '/tmp' }), 'TASK_ROUTINE_CWD_INVALID'],
      [routine({ cwd: '../outside' }), 'TASK_ROUTINE_CWD_INVALID'],
      [routine({ inputs: ['same', 'same'] }), 'TASK_ROUTINE_INPUTS_INVALID'],
      [routine({ inputs: ['../outside'] }), 'TASK_ROUTINE_INPUTS_INVALID'],
      [routine({ outputs: ['same', 'same'] }), 'TASK_ROUTINE_OUTPUTS_INVALID'],
      [routine({ effects: [] }), 'TASK_ROUTINE_EFFECTS_INVALID'],
      [routine({ effects: ['read', 'read'] }), 'TASK_ROUTINE_EFFECTS_INVALID'],
      [routine({ effects: ['network'] as never }), 'TASK_ROUTINE_EFFECTS_INVALID'],
      [routine({ timeout_ms: 0 }), 'TASK_ROUTINE_TIMEOUT_INVALID'],
      [routine({ timeout_ms: 1.5 }), 'TASK_ROUTINE_TIMEOUT_INVALID'],
      [routine({ authority_checks: [] }), 'TASK_ROUTINE_AUTHORITY_CHECKS_INVALID'],
      [routine({ authority_checks: ['same', 'same'] }), 'TASK_ROUTINE_AUTHORITY_CHECKS_INVALID'],
      [routine({ argv: [] }), 'TASK_ROUTINE_ARGV_INVALID'],
      [routine({ argv: ['node\0bad'] }), 'TASK_ROUTINE_ARGV_INVALID'],
      [routine({ argv: ['/bin/zsh', '-c', 'true'] }), 'TASK_ROUTINE_SHELL_FORBIDDEN'],
      [routine({ effects: ['local-write'] }), 'TASK_ROUTINE_AUTHORITY_REQUIRED'],
    ];
    for (const [executor, expected] of cases) {
      expect(code(validateRoutineExecutor({ executor })), expected).toBe(expected);
    }
    expect(
      code(
        validateRoutineExecutor({
          executor: routine(),
          authority: ROUTINE_AUTHORITY,
          authorize: () => false,
        }),
      ),
    ).toBe('TASK_ROUTINE_AUTHORITY_DENIED');
    expect(
      code(
        validateRoutineExecutor({
          executor: routine(),
          authority: ROUTINE_AUTHORITY,
          authorize: () => ({ ok: false, code: 'FIXTURE_DENIAL', message: 'denied' }),
        }),
      ),
    ).toBe('FIXTURE_DENIAL');
  });

  it('validates registered actions against role, consent, capability, and effect authority', () => {
    expect(code(validateRoutineExecutor({ executor: registered() }))).toBe(
      'TASK_ROUTINE_ACTION_UNAVAILABLE',
    );
    expect(
      code(
        validateRoutineExecutor({
          executor: registered(),
          actionRegistry: [
            action({
              authority_contract: {
                ...action().authority_contract,
                effect: 'local-write',
              },
            }),
          ],
        }),
      ),
    ).toBe('TASK_ROUTINE_ACTION_AUTHORITY_DRIFT');
    expect(
      code(
        validateRoutineExecutor({
          executor: registered({ effects: ['local-write'] }),
          actionRegistry: [action()],
        }),
      ),
    ).toBe('TASK_ROUTINE_EFFECT_UNDERDECLARED');
    expect(
      code(
        validateRoutineExecutor({
          executor: registered({ authority_checks: undefined }),
          actionRegistry: [action()],
        }),
      ),
    ).toBe('TASK_ROUTINE_AUTHORITY_CHECKS_REQUIRED');

    const forbidden = action({
      authority_contract: {
        ...action().authority_contract,
        subject: { kind: 'derived-machine', initiator: { allowed_roles: ['auditor'] } },
      },
    });
    expect(
      code(
        validateRoutineExecutor({
          executor: registered(),
          actionRegistry: [forbidden],
          authority: ROUTINE_AUTHORITY,
        }),
      ),
    ).toBe('TASK_ROUTINE_DISCIPLINE_FORBIDDEN');

    const consent = action({
      authority_contract: {
        ...action().authority_contract,
        consent: { write: true, allow_publish: true },
      },
    });
    expect(
      code(
        validateRoutineExecutor({
          executor: registered(),
          actionRegistry: [consent],
          authority: { ...ROUTINE_AUTHORITY, write: false },
        }),
      ),
    ).toBe('TASK_WRITE_CONSENT_REQUIRED');
    expect(
      code(
        validateRoutineExecutor({
          executor: registered(),
          actionRegistry: [consent],
          authority: { ...ROUTINE_AUTHORITY, allow_publish: false },
        }),
      ),
    ).toBe('TASK_PUBLISH_CONSENT_REQUIRED');
    expect(
      code(
        validateRoutineExecutor({
          executor: registered(),
          actionRegistry: [action()],
          authority: { ...ROUTINE_AUTHORITY, capabilities: [] },
        }),
      ),
    ).toBe('TASK_ROUTINE_CAPABILITY_UNAUTHORIZED');
    expect(
      validateRoutineExecutor({
        executor: registered(),
        actionRegistry: [
          action({
            authority_contract: { ...action().authority_contract, subject: { kind: 'none' } },
          }),
        ],
        authority: ROUTINE_AUTHORITY,
        authorize: () => true,
      }).ok,
    ).toBe(true);
  });

  it('executes literal and registered adapters without a shell or LLM seam', async () => {
    const runArgv = vi.fn(() => ({ exit_code: 0, stdout: 'ok' }));
    const invokeLlm = vi.fn();
    const literal = await executeRoutineExecutor({ executor: routine(), runArgv, invokeLlm });
    expect(literal.ok).toBe(true);
    expect(runArgv).toHaveBeenCalledWith(['node', 'fixture.mjs'], {
      cwd: '.',
      shell: false,
      timeout: 1_000,
    });
    expect(invokeLlm).not.toHaveBeenCalled();
    expect(
      code(
        await executeRoutineExecutor({
          executor: routine(),
          runArgv: () => ({ exit_code: 9 }),
        }),
      ),
    ).toBe('TASK_ROUTINE_PROCESS_FAILED');

    const base = {
      executor: registered(),
      actionRegistry: [action()],
      authority: ROUTINE_AUTHORITY,
      runArgv,
    } as const;
    expect(code(await executeRoutineExecutor(base))).toBe('TASK_ROUTINE_ACTION_ADAPTER_REQUIRED');
    expect(
      code(
        await executeRoutineExecutor({
          ...base,
          runAction: () => ({ exit_code: 7 }),
        }),
      ),
    ).toBe('TASK_ROUTINE_PROCESS_FAILED');
    const registeredResult = await executeRoutineExecutor({
      ...base,
      runAction: () => ({ exit_code: 0, stdout: 'recorded' }),
    });
    expect(registeredResult.ok).toBe(true);
  });
});

describe('agent executor acceptance', () => {
  it('rejects identity, resolution, capability, class, and iteration drift', () => {
    const validate = (
      executor: AgentExecutorRequest,
      overrides: Partial<Parameters<typeof validateAgentExecutor>[0]> = {},
    ) =>
      validateAgentExecutor({
        executor,
        resolved: RESOLVED,
        authority: AGENT_AUTHORITY,
        promptComposition: PROMPT,
        ...overrides,
      });
    expect(code(validate({ ...agent(), kind: 'routine' } as never))).toBe(
      'TASK_AGENT_KIND_INVALID',
    );
    expect(code(validate(agent({ prompt_composition_id: 'bad' })))).toBe(
      'TASK_PROMPT_COMPOSITION_REQUIRED',
    );
    expect(
      code(validate(agent(), { promptComposition: { ...PROMPT, id: 'PC-fedcba9876543210' } })),
    ).toBe('TASK_PROMPT_COMPOSITION_MISMATCH');
    expect(code(validate(agent(), { promptComposition: { ...PROMPT, digest: 'bad' } }))).toBe(
      'TASK_PROMPT_COMPOSITION_MISMATCH',
    );
    expect(code(validate(agent({ max_iterations: 0 })))).toBe('TASK_AGENT_ITERATIONS_INVALID');
    expect(code(validate(agent({ max_iterations: 1.5 })))).toBe('TASK_AGENT_ITERATIONS_INVALID');
    expect(code(validate(agent({ capabilities: ['same', 'same'] })))).toBe(
      'TASK_AGENT_CAPABILITIES_INVALID',
    );
    expect(code(validate(agent({ runtime: 'other' })))).toBe('TASK_AGENT_RESOLUTION_MISMATCH');
    expect(code(validate(agent({ model: 'other' })))).toBe('TASK_AGENT_RESOLUTION_MISMATCH');
    expect(code(validate(agent({ effort: 'low' })))).toBe('TASK_AGENT_RESOLUTION_MISMATCH');
    expect(
      code(
        validate(agent(), {
          authority: { ...AGENT_AUTHORITY, agent_class: 'review-agent' },
        }),
      ),
    ).toBe('TASK_AGENT_CLASS_INELIGIBLE');
    expect(code(validate(agent({ capabilities: ['network'] })))).toBe(
      'TASK_AGENT_CAPABILITY_UNSUPPORTED',
    );
    expect(
      code(
        validate(agent({ capabilities: ['code.write'] }), {
          authority: { ...AGENT_AUTHORITY, capabilities: ['code.read'] },
        }),
      ),
    ).toBe('TASK_AGENT_CAPABILITY_UNAUTHORIZED');
  });

  it('keeps recipe variants, preflight, and authorization within task discipline', async () => {
    const withRecipe = agent({ recipe_name: 'devai-fix', recipe_variant: 'lint' });
    const validate = (overrides: Partial<Parameters<typeof validateAgentExecutor>[0]> = {}) =>
      validateAgentExecutor({
        executor: withRecipe,
        resolved: RESOLVED,
        authority: AGENT_AUTHORITY,
        promptComposition: PROMPT,
        recipe: RECIPE,
        ...overrides,
      });
    expect(code(validate({ recipe: undefined }))).toBe('TASK_AGENT_RECIPE_UNAVAILABLE');
    expect(code(validate({ recipe: { ...RECIPE, name: 'devai-plan' } }))).toBe(
      'TASK_AGENT_RECIPE_UNAVAILABLE',
    );
    expect(code(validate({ recipe: { ...RECIPE, authority_role: 'auditor' } }))).toBe(
      'TASK_AGENT_RECIPE_AUTHORITY_MISMATCH',
    );
    expect(code(validate({ recipe: { ...RECIPE, agent_class: 'review-agent' } }))).toBe(
      'TASK_AGENT_RECIPE_CLASS_MISMATCH',
    );
    expect(code(validate({ recipe: { ...RECIPE, permission_tier: 'act' } }))).toBe(
      'TASK_AGENT_RECIPE_PERMISSION_DENIED',
    );
    expect(code(validate({ recipe: { ...RECIPE, capabilities: [] } }))).toBe(
      'TASK_AGENT_RECIPE_CAPABILITY_MISMATCH',
    );
    expect(
      code(
        validateAgentExecutor({
          executor: agent(),
          resolved: RESOLVED,
          authority: AGENT_AUTHORITY,
          promptComposition: PROMPT,
          recipe: RECIPE,
        }),
      ),
    ).toBe('TASK_AGENT_RECIPE_UNREQUESTED');
    expect(code(validate({ preflight: () => false }))).toBe('TASK_AGENT_PREFLIGHT_FAILED');
    expect(
      code(validate({ preflight: () => ({ ok: false, code: 'PREFLIGHT', message: 'no' }) })),
    ).toBe('PREFLIGHT');
    expect(code(validate({ authorize: () => false }))).toBe('TASK_AGENT_AUTHORITY_DENIED');
    expect(
      code(validate({ authorize: () => ({ ok: false, code: 'AUTHORITY', message: 'no' }) })),
    ).toBe('AUTHORITY');

    const invokeAgent = vi.fn(() => ({ verdict: 'PASS' }));
    const result = await executeAgentExecutor({
      executor: withRecipe,
      resolved: RESOLVED,
      authority: AGENT_AUTHORITY,
      promptComposition: PROMPT,
      recipe: RECIPE,
      preflight: () => true,
      authorize: () => true,
      invokeAgent,
    });
    expect(result.ok).toBe(true);
    expect(invokeAgent).toHaveBeenCalledOnce();
  });
});

describe('composite executor acceptance', () => {
  it('orders complete graphs before dispatch and refuses malformed populations', () => {
    const parent = { id: 'TASK-8199', round_id: 'R-0007', executor: compositeExecutor() };
    const success = validateCompositeExecutor({ parent, children: CHILDREN });
    expect(success).toEqual({
      ok: true,
      ordered_task_ids: ['TASK-8101', 'TASK-8102', 'TASK-8103'],
      generations: [['TASK-8101'], ['TASK-8102', 'TASK-8103']],
    });
    expect(
      validateCompositeExecutor({
        parent: { ...parent, executor: { ...compositeExecutor(), kind: 'agent' } as never },
        children: CHILDREN,
      }).code,
    ).toBe('TASK_COMPOSITE_EXECUTOR_REQUIRED');
    expect(
      validateCompositeExecutor({
        parent: { ...parent, executor: compositeExecutor({ child_task_ids: [] }) },
        children: [],
      }).code,
    ).toBe('TASK_COMPOSITE_CHILD_REQUIRED');
    expect(
      validateCompositeExecutor({
        parent: {
          ...parent,
          executor: compositeExecutor({ child_task_ids: ['TASK-8101', 'TASK-8101'] }),
        },
        children: [CHILDREN[0] as CompositeChild],
      }).code,
    ).toBe('TASK_COMPOSITE_DUPLICATE_CHILD');
    expect(
      validateCompositeExecutor({
        parent: { id: 'TASK-8199', round_id: 'R-0007' },
        children: [CHILDREN[0] as CompositeChild, CHILDREN[0] as CompositeChild],
      }).code,
    ).toBe('TASK_COMPOSITE_EXECUTOR_REQUIRED');
    expect(
      validateCompositeExecutor({
        parent,
        children: [...CHILDREN, { id: 'TASK-8110', round_id: 'R-0007' }],
      }).code,
    ).toBe('TASK_COMPOSITE_CHILD_UNDECLARED');
    expect(validateCompositeExecutor({ parent, children: CHILDREN.slice(0, 2) }).code).toBe(
      'TASK_DEPENDENCY_MISSING',
    );
    expect(
      validateCompositeExecutor({
        parent: {
          id: 'TASK-8199',
          round_id: 'R-0007',
          executor: compositeExecutor({ child_task_ids: ['TASK-8199'] }),
        },
        children: [{ id: 'TASK-8199', round_id: 'R-0007' }],
      }).code,
    ).toBe('TASK_COMPOSITE_CYCLE');
    expect(
      validateCompositeExecutor({
        parent,
        children: CHILDREN.map((child, index) =>
          index === 1 ? { ...child, round_id: 'R-0008' } : child,
        ),
      }).code,
    ).toBe('TASK_COMPOSITE_CROSS_ROUND');
  });

  it('refuses incomplete, duplicate, missing, cyclic, and failed-dispatch dependencies', () => {
    const parent = { id: 'TASK-8199', round_id: 'R-0007', executor: compositeExecutor() };
    expect(
      validateCompositeExecutor({
        parent: { ...parent, executor: { ...compositeExecutor(), dependencies: null } as never },
        children: CHILDREN,
      }).code,
    ).toBe('TASK_COMPOSITE_DEPENDENCIES_REQUIRED');
    expect(
      validateCompositeExecutor({
        parent: {
          ...parent,
          executor: compositeExecutor({
            dependencies: [{ task_id: 'TASK-8999', depends_on: [] }],
          }),
        },
        children: CHILDREN,
      }).code,
    ).toBe('TASK_DEPENDENCY_MISSING');
    expect(
      validateCompositeExecutor({
        parent: {
          ...parent,
          executor: compositeExecutor({
            dependencies: [
              { task_id: 'TASK-8101', depends_on: [] },
              { task_id: 'TASK-8101', depends_on: [] },
            ],
          }),
        },
        children: CHILDREN,
      }).code,
    ).toBe('TASK_COMPOSITE_DUPLICATE_DEPENDENCY');
    expect(
      validateCompositeExecutor({
        parent: {
          ...parent,
          executor: compositeExecutor({
            dependencies: [{ task_id: 'TASK-8101', depends_on: ['TASK-8102', 'TASK-8102'] }],
          }),
        },
        children: CHILDREN,
      }).code,
    ).toBe('TASK_COMPOSITE_DUPLICATE_DEPENDENCY');
    expect(
      validateCompositeExecutor({
        parent: {
          ...parent,
          executor: compositeExecutor({
            dependencies: [{ task_id: 'TASK-8101', depends_on: ['TASK-8999'] }],
          }),
        },
        children: CHILDREN,
      }).code,
    ).toBe('TASK_DEPENDENCY_MISSING');
    expect(
      validateCompositeExecutor({
        parent: {
          ...parent,
          executor: compositeExecutor({
            dependencies: [{ task_id: 'TASK-8101', depends_on: ['TASK-8101'] }],
          }),
        },
        children: CHILDREN,
      }).code,
    ).toBe('TASK_COMPOSITE_CYCLE');
    expect(
      validateCompositeExecutor({
        parent: {
          ...parent,
          executor: compositeExecutor({
            child_task_ids: ['TASK-8101', 'TASK-8102'],
            dependencies: [
              { task_id: 'TASK-8101', depends_on: ['TASK-8102'] },
              { task_id: 'TASK-8102', depends_on: ['TASK-8101'] },
            ],
          }),
        },
        children: CHILDREN.slice(0, 2),
      }).code,
    ).toBe('TASK_COMPOSITE_CYCLE');

    const dispatched: string[] = [];
    expect(
      validateCompositeExecutor({
        parent,
        children: CHILDREN,
        dispatch: (child) => dispatched.push(child.id),
      }).ok,
    ).toBe(true);
    expect(dispatched).toEqual(['TASK-8101', 'TASK-8102', 'TASK-8103']);
    expect(
      validateCompositeExecutor({
        parent,
        children: CHILDREN,
        dispatch: (child) => {
          if (child.id === 'TASK-8102') throw new Error('fixture');
        },
      }),
    ).toEqual({
      ok: false,
      code: 'TASK_COMPOSITE_DISPATCH_FAILED',
      dispatched_task_ids: ['TASK-8101'],
    });
  });
});
