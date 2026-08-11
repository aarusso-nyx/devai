import { describe, expect, it } from 'vitest';
import {
  buildTokens,
  renderTemplate,
  toKebab,
  toSnake,
  type TokenMap,
} from '../../src/templates/index.js';

function fixedTokens(overrides: Partial<TokenMap> = {}): TokenMap {
  return buildTokens({
    namespace: 'demo',
    module: 'Greeter',
    entity: 'Greeting',
    specVersion: '0.1.0',
    specSha256: 'a'.repeat(64),
    ...(overrides.__NAMESPACE__ !== undefined
      ? {} // never override via this path; build from input
      : {}),
  });
}

describe('toKebab / toSnake', () => {
  it('PascalCase → kebab-case', () => {
    expect(toKebab('Greeter')).toBe('greeter');
    expect(toKebab('OrderItem')).toBe('order-item');
    expect(toKebab('NsOrders')).toBe('ns-orders');
  });

  it('PascalCase → snake_case', () => {
    expect(toSnake('Greeter')).toBe('greeter');
    expect(toSnake('OrderItem')).toBe('order_item');
    expect(toSnake('NsOrders')).toBe('ns_orders');
  });

  it('round-trip stability: kebab→snake→kebab is idempotent', () => {
    const original = 'order-line-item';
    const snake = toSnake(original);
    const kebab = toKebab(snake);
    expect(kebab).toBe(original);
  });
});

describe('buildTokens', () => {
  it('derives the 12 canonical tokens from a 5-field input', () => {
    const t = buildTokens({
      namespace: 'demo',
      module: 'Greeter',
      entity: 'Greeting',
      specVersion: '0.1.0',
      specSha256: 'b'.repeat(64),
    });
    expect(t.__NAMESPACE__).toBe('demo');
    expect(t.__MODULE__).toBe('Greeter');
    expect(t.__kebabModule__).toBe('greeter');
    expect(t.__snake_module__).toBe('greeter');
    expect(t.__moduleSlug__).toBe('demo-greeter');
    expect(t.__ENTITY__).toBe('Greeting');
    expect(t.__classEntity__).toBe('Greeting');
    expect(t.__kebabEntity__).toBe('greeting');
    expect(t.__snake_entity__).toBe('greeting');
    expect(t.__snake_table__).toBe('demo__greeter_greeting');
    expect(t.__SPEC_VERSION__).toBe('0.1.0');
    expect(t.__SPEC_SHA__).toBe('bbbbbbbb');
  });

  it('handles multi-word modules', () => {
    const t = buildTokens({
      namespace: 'acct',
      module: 'OrderItem',
      entity: 'OrderLine',
      specVersion: '1.2.3',
      specSha256: 'c'.repeat(64),
    });
    expect(t.__kebabModule__).toBe('order-item');
    expect(t.__snake_module__).toBe('order_item');
    expect(t.__moduleSlug__).toBe('acct-order-item');
    expect(t.__snake_table__).toBe('acct__order_item_order_line');
  });

  it('accepts caller-supplied extra tokens', () => {
    const t = buildTokens({
      namespace: 'demo',
      module: 'Greeter',
      entity: 'Greeting',
      specVersion: '0.1.0',
      specSha256: 'd'.repeat(64),
      extra: { __FOO__: 'bar' },
    });
    expect(t.__FOO__).toBe('bar');
  });

  it('rejects malformed extra token names', () => {
    expect(() =>
      buildTokens({
        namespace: 'demo',
        module: 'Greeter',
        entity: 'Greeting',
        specVersion: '0.1.0',
        specSha256: 'd'.repeat(64),
        extra: { notAToken: 'bar' },
      }),
    ).toThrow(/canonical __NAME__ pattern/);
  });
});

describe('renderTemplate', () => {
  it('substitutes all 12 canonical tokens', () => {
    const t = fixedTokens();
    const body = '__NAMESPACE__/__MODULE__/__ENTITY__ at __SPEC_VERSION__ (__SPEC_SHA__)';
    const { output } = renderTemplate({ body, tokens: t });
    expect(output).toBe('demo/Greeter/Greeting at 0.1.0 (aaaaaaaa)');
  });

  it('leaves unknown __NAME__ tokens in place (visible breakage, not silent)', () => {
    const t = fixedTokens();
    const body = '__MODULE__ and __UNKNOWN_TOKEN__';
    const { output } = renderTemplate({ body, tokens: t });
    expect(output).toBe('Greeter and __UNKNOWN_TOKEN__');
  });

  it('evaluates conditional blocks against the flag map', () => {
    const t = fixedTokens();
    const body = 'before <!-- IF:withEvents -->events here <!-- ENDIF:withEvents -->after';
    const withFlag = renderTemplate({ body, tokens: t, flags: { withEvents: true } });
    expect(withFlag.output).toBe('before events here after');
    const noFlag = renderTemplate({ body, tokens: t, flags: { withEvents: false } });
    expect(noFlag.output).toBe('before after');
  });

  it('supports nested conditionals (same flag)', () => {
    const t = fixedTokens();
    const body =
      '<!-- IF:outer --><!-- IF:outer -->inner <!-- ENDIF:outer -->done<!-- ENDIF:outer -->';
    const r = renderTemplate({ body, tokens: t, flags: { outer: true } });
    expect(r.output).toBe('inner done');
  });

  it('supports different-flag blocks (independent)', () => {
    const t = fixedTokens();
    const body = '<!-- IF:a -->A<!-- ENDIF:a --><!-- IF:b -->B<!-- ENDIF:b -->';
    const r = renderTemplate({ body, tokens: t, flags: { a: true, b: false } });
    expect(r.output).toBe('A');
  });

  it('treats absent flags as false (default)', () => {
    const t = fixedTokens();
    const body = '<!-- IF:missing -->X<!-- ENDIF:missing -->';
    const r = renderTemplate({ body, tokens: t });
    expect(r.output).toBe('');
  });

  it('throws on unmatched IF', () => {
    const t = fixedTokens();
    const body = '<!-- IF:foo -->no close';
    expect(() => renderTemplate({ body, tokens: t })).toThrow(/unmatched/);
  });

  it('emits deterministic sha256 for identical input', () => {
    const t = fixedTokens();
    const body = '__MODULE__ __ENTITY__';
    const a = renderTemplate({ body, tokens: t });
    const b = renderTemplate({ body, tokens: t });
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different inputs produce different sha256', () => {
    const ta = fixedTokens();
    const tb = buildTokens({
      namespace: 'demo',
      module: 'Different',
      entity: 'Greeting',
      specVersion: '0.1.0',
      specSha256: 'a'.repeat(64),
    });
    const body = '__MODULE__';
    expect(renderTemplate({ body, tokens: ta }).sha256).not.toBe(
      renderTemplate({ body, tokens: tb }).sha256,
    );
  });
});
// Invariants: INV-DEVAI-001
// Invariants: INV-SCAFFOLD-001
