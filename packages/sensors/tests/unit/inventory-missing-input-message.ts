// #391: an inventory consumer whose input body is absent from every location keeps its finding
// code, and its message names each location it read, the regenerated state body first and the
// recorded body second, and points at `sense run inventory_regeneration` as the producer. The
// removed verbs (`sense-api`, `sense-routes`, `sense run inventory_data_model`) never appear.
import { expect } from 'vitest';

/** Asserts the #391 wording for a missing-input message over the input kinds it reads. */
export function expectMissingInputMessage(message: unknown, kinds: readonly string[]): void {
  expect(typeof message).toBe('string');
  const text = String(message);
  for (const kind of kinds) {
    const state = text.indexOf(`.devai/state/sensors/${kind}/`);
    const recorded = text.indexOf(`record/proofs/sensors/${kind}/`);
    expect(state, `${kind}: names the state body`).toBeGreaterThanOrEqual(0);
    expect(recorded, `${kind}: names the recorded body`).toBeGreaterThanOrEqual(0);
    expect(state, `${kind}: the state body is read first`).toBeLessThan(recorded);
  }
  expect(text).toContain('sense run inventory_regeneration');
  expect(text).not.toContain('sense-api');
  expect(text).not.toContain('sense-routes');
  expect(text).not.toMatch(/sense run inventory_data_model\b/u);
}
