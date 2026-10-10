// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017; ADR-SCR-0015 IA-001, IA-004, IA-005.
import { describe, expect, it } from 'vitest';
import { getValidator } from '../../src/index.js';

const KINDS = [
  'type_check',
  'unit_test',
  'integration_test',
  'e2e_test',
  'perf_test',
  'build',
  'migration_check',
] as const;

function document(kind: string, input: unknown) {
  return { schemaVersion: '1.0.0', inputs: { [kind]: input } };
}

function descriptor(node: Record<string, unknown>) {
  return {
    schemaVersion: '1.0.0',
    descriptorVersion: 'fixture-1',
    repositoryId: 'fixture',
    fallbackNodeId: null,
    dynamicFallbackSelectors: [],
    profiles: [],
    tasks: [
      {
        nodeId: 'reviewed-task',
        dependencies: [],
        cwd: '.',
        runner: 'exec-v1',
        argv: ['pnpm', 'run', 'reviewed-task'],
        inputSelectors: [{ kind: 'prefix', pattern: 'src/' }],
        toolchainKeys: [],
        allowlistedEnv: [],
        outputContract: { population: 'workspace' },
        ...node,
      },
    ],
  };
}

describe('closed task-bound sensor input contracts', () => {
  it.each(KINDS)(
    'admits the exact task/population pair for %s through standalone and adopter schemas',
    (kind) => {
      const inputs = document(kind, { taskId: 'reviewed-task', population: 'workspace' });
      const validate = getValidator('sensor-inputs.schema.json');
      expect(validate(inputs), JSON.stringify(validate.errors)).toBe(true);
      const adopter = getValidator('adopter-policy.schema.json');
      expect(
        adopter({
          schemaVersion: '1.0.0',
          policy_id: 'fixture.adoption',
          policy_version: '1.0.0',
          sensor_inputs: inputs,
        }),
        JSON.stringify(adopter.errors),
      ).toBe(true);
    },
  );

  it.each(KINDS)('refuses incomplete, empty and command-mixed task references for %s', (kind) => {
    const validate = getValidator('sensor-inputs.schema.json');
    for (const input of [
      { taskId: 'reviewed-task' },
      { population: 'workspace' },
      { taskId: '', population: 'workspace' },
      { taskId: 'reviewed-task', population: '' },
      { taskId: 'reviewed-task', population: 'workspace', argv: ['pnpm', 'run', 'other'] },
      { taskId: 'reviewed-task', population: 'workspace', cwd: 'src' },
      { taskId: 'reviewed-task', population: 'workspace', scriptName: 'other' },
      { taskId: 'reviewed-task', population: 'workspace', memberKind: kind },
    ])
      expect(validate(document(kind, input)), `${kind}: ${JSON.stringify(input)}`).toBe(false);
  });

  it('refuses task bindings on an undeclared sensor kind', () => {
    expect(
      getValidator('sensor-inputs.schema.json')(
        document('inventory_api', { taskId: 'reviewed-task', population: 'workspace' }),
      ),
    ).toBe(false);
  });

  it('admits Angular route selection and rejects escaping, absolute and unknown inputs', () => {
    const validate = getValidator('sensor-inputs.schema.json');
    expect(
      validate(document('inventory_routes', { framework: 'angular', scanDirs: ['apps/web/src'] })),
    ).toBe(true);
    for (const input of [
      { framework: 'vue' },
      { scanDirs: ['../outside'] },
      { scanDirs: ['apps/../../outside'] },
      { scanDirs: ['/tmp/source'] },
      { scanDirs: [] },
      { scanDirs: ['src', 'src'] },
      { framework: 'angular', memberKind: 'type_check' },
    ])
      expect(validate(document('inventory_routes', input)), JSON.stringify(input)).toBe(false);
  });

  it.each(KINDS)('admits explicit %s descriptor annotation with a nonempty population', (kind) => {
    const validate = getValidator('test-task-descriptor.schema.json');
    expect(validate(descriptor({ sensorKinds: [kind] })), JSON.stringify(validate.errors)).toBe(
      true,
    );
  });

  it('rejects empty, duplicate, unknown annotations and missing output populations', () => {
    const validate = getValidator('test-task-descriptor.schema.json');
    for (const node of [
      { sensorKinds: [] },
      { sensorKinds: ['type_check', 'type_check'] },
      { sensorKinds: ['inventory_api'] },
      { sensorKinds: ['type_check'], outputContract: {} },
      { sensorKinds: ['type_check'], outputContract: { population: '' } },
    ])
      expect(validate(descriptor(node)), JSON.stringify(node)).toBe(false);
    expect(validate(descriptor({ sensorKinds: undefined, outputContract: {} }))).toBe(true);
  });
  it('keeps ordinary preflight nodes valid while forbidding a sensor annotation on them', () => {
    const validate = getValidator('test-task-descriptor.schema.json');
    const node = {
      runner: 'preflight-v1',
      argv: undefined,
      probes: [
        {
          id: 'input-present',
          class: 'intrinsic',
          probe: { kind: 'file', path: 'src/input.ts', must_exist: true },
          expected: 'present',
          observed: 'present',
          status: 'pass',
          remediation: 'Restore input',
          depends_on: [],
        },
      ],
    };
    expect(validate(descriptor(node)), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(descriptor({ ...node, sensorKinds: ['type_check'] }))).toBe(false);
  });
  it.each([
    { kind: 'mutation-report-set-v2', population: 'workspace' },
    { kind: 'unregistered', population: 'workspace' },
    { population: 'workspace', generated_namespaces: [] },
  ])(
    'forbids unsupported sensor output contracts without narrowing ordinary tasks: %j',
    (outputContract) => {
      const validate = getValidator('test-task-descriptor.schema.json');
      expect(validate(descriptor({ outputContract })), JSON.stringify(validate.errors)).toBe(true);
      expect(validate(descriptor({ outputContract, sensorKinds: ['build'] }))).toBe(false);
    },
  );
});
