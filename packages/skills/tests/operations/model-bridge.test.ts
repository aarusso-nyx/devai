import { describe, expect, it } from 'vitest';
import { createModelBridge } from '../../src/model-bridge/index.js';

describe('internal model bridge', () => {
  it('requires an explicit provider and non-empty model without a default family', () => {
    const bridge = createModelBridge({ provider: 'codex-cli', model: 'gpt-explicit' });
    expect({ family: bridge.family, model: bridge.model }).toEqual({
      family: 'codex-cli',
      model: 'gpt-explicit',
    });
    expect(() => createModelBridge({ provider: 'claude', model: '' })).toThrow(
      'MODEL_BRIDGE_MODEL_REQUIRED',
    );
  });
});
