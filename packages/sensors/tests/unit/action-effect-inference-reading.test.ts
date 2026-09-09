import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EffectReport } from '@devai-nyx/effects-check';

const analyze = vi.hoisted(() => vi.fn());
vi.mock('@devai-nyx/effects-check', () => ({ analyzeEffectProgram: analyze }));

import {
  senseActionEffectInference,
  type ActionEffectInferenceOptions,
} from '../../src/action-effect-inference.js';

const reportWithFindings: EffectReport = {
  actions: {
    'fs writeFile': {
      declared_effect: 'read',
      declared_capabilities: [],
      capabilities: ['fs:unknown-write'],
      unresolved_edges: ['fs writeFile'],
      dispositions: [],
    },
  },
  findings: [
    {
      code: 'EFFECT_UNDER_DECLARED',
      action_id: 'fs writeFile',
      message: 'write needs local-write',
    },
    { code: 'EFFECT_EDGE_UNRESOLVED', message: 'edge could not be resolved' },
  ],
  subprocess_templates: [],
  advisory_patterns: { violations: 0, dispositions: [] },
  metrics: {
    program_files: 1,
    catalog_actions: 2,
    extracted_actions: 2,
    unresolved_edges: 1,
    dispositioned_edges: 0,
    duration_ms: 17,
  },
};

const cleanReport: EffectReport = {
  ...reportWithFindings,
  findings: [],
  metrics: { ...reportWithFindings.metrics, unresolved_edges: 0 },
};

const options: ActionEffectInferenceOptions = {
  tsconfigPath: '/tmp/effects/tsconfig.json',
  catalog: ['fs writeFile', 'fs readFileSync'],
  contracts: [{ action_id: 'fs writeFile', effect: 'read', capabilities: [] }],
  subprocessRegistry: { templates: [] },
};

afterEach(() => analyze.mockReset());

describe('action effect inference reading projection', () => {
  it('forwards analysis options and projects every finding into review reading metadata', async () => {
    analyze.mockResolvedValue(reportWithFindings);

    const result = await senseActionEffectInference(options);

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledWith(options);
    expect(result.report).toBe(reportWithFindings);
    expect(result.reading).toMatchObject({
      lifecycle: 'experimental',
      sensor: {
        name: 'action-effect-inference',
        kind: 'action_effect_inference',
        version: '1.0.0-shadow',
      },
      command: 'devai policy check action effects',
      status: 'review',
      deterministic: true,
      tier: 'L0',
      duration_ms: 17,
      metrics: {
        catalog_actions: 2,
        extracted_actions: 2,
        unresolved_edges: 1,
        dispositioned_edges: 0,
      },
    });
    expect(result.reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'EFFECT_UNDER_DECLARED',
        message: 'write needs local-write',
        invariant_id: 'INV-DEVAI-020',
      },
      {
        severity: 'warning',
        code: 'EFFECT_EDGE_UNRESOLVED',
        message: 'edge could not be resolved',
        invariant_id: 'INV-DEVAI-020',
      },
    ]);
  });

  it('reports pass with the stable command and metrics when analysis has no findings', async () => {
    analyze.mockResolvedValue(cleanReport);

    const result = await senseActionEffectInference(options);

    expect(result.report).toBe(cleanReport);
    expect(result.reading.status).toBe('pass');
    expect(result.reading.command).toBe('devai policy check action effects');
    expect(result.reading.deterministic).toBe(true);
    expect(result.reading.findings).toEqual([]);
    expect(result.reading.metrics).toEqual({
      catalog_actions: 2,
      extracted_actions: 2,
      unresolved_edges: 0,
      dispositioned_edges: 0,
    });
  });
});
