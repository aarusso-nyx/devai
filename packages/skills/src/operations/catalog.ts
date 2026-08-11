import { minimatch } from 'minimatch';
import { loadRecipe } from '../recipes/loader.js';
import {
  OPERATION_IDS,
  type OperationDefinition,
  type OperationHost,
  type OperationInvocation,
  type OperationResult,
} from './types.js';

const definitions = [
  [
    'check.inspect',
    'Triage current evidence without mutation.',
    'read',
    'host-command',
    ['devai', 'check', '--suite', 'quick'],
  ],
  [
    'sense.inventory',
    'Inspect one deterministic repository inventory slice.',
    'read',
    'host-command',
    ['devai', 'sense', 'inventory'],
  ],
  [
    'init.plan',
    'Build the exact non-authorizing initialization plan.',
    'read',
    'host-command',
    ['devai', 'init', 'plan'],
  ],
  [
    'round.assess',
    'Assess one explicit local round without mutation.',
    'read',
    'host-command',
    ['devai', 'round', 'assess'],
  ],
  [
    'evidence.verify',
    'Verify existing local evidence without mutation.',
    'read',
    'host-command',
    ['devai', 'evidence', 'verify'],
  ],
  [
    'check.lint',
    'Run the configured lint repair against explicit files.',
    'local-write',
    'host-command',
    ['pnpm', 'lint', '--fix'],
  ],
  [
    'check.build',
    'Repair a build failure within explicit files.',
    'local-write',
    'host-command',
    ['pnpm', 'build'],
  ],
  [
    'check.test',
    'Repair a focused failing test within explicit files.',
    'local-write',
    'host-command',
    ['pnpm', 'test'],
  ],
  ['scaffold.db', 'Render database scaffold outputs.', 'local-write', 'host-scaffolder'],
  ['scaffold.api', 'Render API scaffold outputs.', 'local-write', 'host-scaffolder'],
  ['scaffold.ui', 'Render UI scaffold outputs.', 'local-write', 'host-scaffolder'],
  ['scaffold.tests', 'Render test scaffold outputs.', 'local-write', 'host-scaffolder'],
  ['scaffold.docs', 'Render documentation scaffold outputs.', 'local-write', 'host-scaffolder'],
  ['scaffold.ci', 'Render module CI scaffold outputs.', 'local-write', 'host-scaffolder'],
  [
    'scaffold.tests-from-docs',
    'Materialize reviewed test candidates derived from explicit documentation.',
    'local-write',
    'host-materializer',
  ],
  [
    'check.typecheck',
    'Repair type errors within explicit files.',
    'local-write',
    'host-command',
    ['pnpm', 'typecheck'],
  ],
  [
    'check.coverage',
    'Add focused tests for an observed coverage gap.',
    'local-write',
    'host-command',
    ['pnpm', 'test:coverage'],
  ],
  [
    'round.plan.preview',
    'Record an explicit local preview plan in runtime state.',
    'runtime-write',
    'host-materializer',
  ],
  [
    'round.run.preview',
    'Record results of separately authorized local child operations.',
    'runtime-write',
    'host-materializer',
  ],
  [
    'round.close.preview',
    'Record a close summary after supplied local completion verification.',
    'runtime-write',
    'host-materializer',
  ],
] as const satisfies readonly (readonly [
  OperationDefinition['id'],
  string,
  OperationDefinition['effect'],
  OperationDefinition['execution'],
  (readonly string[])?,
])[];

const CATALOG = new Map<OperationDefinition['id'], OperationDefinition>(
  definitions.map(([id, description, effect, execution, argv]) => [
    id,
    Object.freeze({
      id,
      description,
      effect,
      execution,
      ...(argv === undefined ? {} : { argv: Object.freeze([...argv]) }),
    }),
  ]),
);

if (CATALOG.size !== OPERATION_IDS.length) throw new Error('OPERATION_CATALOG_DIVERGENCE');

export function listOperations(): readonly OperationDefinition[] {
  return Object.freeze(
    OPERATION_IDS.map((id) => {
      const operation = CATALOG.get(id);
      if (operation === undefined) throw new Error(`OPERATION_UNKNOWN:${id}`);
      return operation;
    }),
  );
}

export function getOperation(id: string): OperationDefinition | undefined {
  return CATALOG.get(id as OperationDefinition['id']);
}

function pathAllowed(path: string, scopes: readonly string[]): boolean {
  return (
    !path.startsWith('/') &&
    !path.split('/').includes('..') &&
    scopes.some((scope) => minimatch(path, scope, { dot: true }))
  );
}

export async function runOperation(
  invocation: OperationInvocation,
  host: OperationHost,
): Promise<OperationResult> {
  const recipe = loadRecipe(invocation.recipe);
  const variant = recipe.manifest.variants[invocation.variant];
  if (variant === undefined)
    throw new Error(`OPERATION_VARIANT_UNKNOWN:${invocation.recipe}:${invocation.variant}`);
  if (!variant.operations.includes(invocation.operation))
    throw new Error(`OPERATION_NOT_IN_VARIANT:${invocation.operation}`);
  const definition = getOperation(invocation.operation);
  if (definition === undefined) throw new Error(`OPERATION_UNKNOWN:${invocation.operation}`);
  if (
    definition.effect !== variant.effect &&
    !(definition.effect === 'read' && variant.effect !== 'read')
  ) {
    throw new Error(`OPERATION_EFFECT_MISMATCH:${invocation.operation}`);
  }
  const paths = invocation.write_paths ?? [];
  if (variant.write_policy.mode === 'none' && paths.length > 0)
    throw new Error('OPERATION_WRITE_PATHS_FORBIDDEN');
  const scopes = variant.write_policy.mode === 'none' ? [] : variant.write_policy.scopes;
  if (paths.some((path) => !pathAllowed(path, scopes))) {
    throw new Error('OPERATION_WRITE_PATH_OUT_OF_SCOPE');
  }
  if (definition.effect !== 'read' && paths.length === 0)
    throw new Error('OPERATION_EXPLICIT_WRITE_PATHS_REQUIRED');
  return host.execute({ ...invocation, definition, variant_contract: variant });
}
