import { describe, expect, it } from 'vitest';

describe('define-command public registry intake', () => {
  it('rejects a duplicate canonical handler with its exact public action identity', async () => {
    const { canonicalRegistry, defineCommand, getFullRegistry } =
      await import('../../src/define-command.js?cli-shard09-public-registry-duplicate');
    const [entry] = canonicalRegistry();
    if (entry === undefined) throw new Error('canonical registry is empty');

    const definition = {
      name: entry.handler,
      description: entry.description,
      authority: entry.authority,
      lifecycle: entry.lifecycle,
      lifecycle_reason: entry.lifecycle_reason,
      promotion_criteria: entry.promotion_criteria,
      register: () => undefined,
    };
    defineCommand(definition);
    defineCommand(definition);

    expect(() => getFullRegistry()).toThrowError(
      new Error(`ACTION_HANDLER_DUPLICATE: ${entry.name}`),
    );
  });
});
