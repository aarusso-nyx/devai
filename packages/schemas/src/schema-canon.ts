// --- check-schemas canon linter (improvement 6, recursive half — first slice) ---
const VERDICT_SETS = [
  JSON.stringify(['pass', 'review', 'fail'].sort()),
  JSON.stringify(['PASS', 'REVIEW', 'FAIL'].sort()),
];
export interface CanonFinding {
  schema: string;
  rule: string;
  path: string;
}
const PREDICATE_KEYWORDS = new Set(['if', 'then', 'else', 'contains', 'oneOf', 'allOf']);

export function checkSchema(name: string, schema: unknown): CanonFinding[] {
  const findings: CanonFinding[] = [];
  const localTarget = (
    ref: unknown,
    resource: unknown,
  ): { node: unknown; resource: unknown } | undefined => {
    if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
    let pointer: string;
    try {
      pointer = decodeURIComponent(ref.slice(1));
    } catch {
      return undefined;
    }
    if (pointer !== '' && !pointer.startsWith('/')) return undefined;
    let node = resource;
    let scope = resource;
    for (const token of pointer === '' ? [] : pointer.slice(1).split('/')) {
      if (/~(?:[^01]|$)/u.test(token)) return undefined;
      const key = token.replace(/~1/gu, '/').replace(/~0/gu, '~');
      if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) return undefined;
      node = (node as Record<string, unknown>)[key];
      if (
        node !== null &&
        typeof node === 'object' &&
        typeof (node as Record<string, unknown>)['$id'] === 'string'
      )
        scope = node;
    }
    return { node, resource: scope };
  };
  // Definitions inherit their actual use sites. A predicate-only definition is
  // not a complete object shape; a mixed-use or unreferenced definition still is.
  // Traverse schema-bearing keywords only, never annotation/example data.
  const uses = new Map<object, Set<boolean>>();
  const collectUses = (node: unknown, predicate: boolean, resource: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) collectUses(item, predicate, resource);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const contexts = uses.get(node) ?? new Set<boolean>();
    if (contexts.has(predicate)) return;
    contexts.add(predicate);
    uses.set(node, contexts);
    const object = node as Record<string, unknown>;
    const scope = typeof object['$id'] === 'string' ? node : resource;
    const target = localTarget(object['$ref'], scope);
    if (target !== undefined) collectUses(target.node, predicate, target.resource);
    for (const key of ['properties', 'patternProperties', 'dependentSchemas']) {
      const entries = object[key];
      if (entries !== null && typeof entries === 'object' && !Array.isArray(entries))
        for (const child of Object.values(entries)) collectUses(child, predicate, scope);
    }
    for (const key of [
      'allOf',
      'anyOf',
      'oneOf',
      'prefixItems',
      'items',
      'additionalProperties',
      'unevaluatedProperties',
      'unevaluatedItems',
      'propertyNames',
      'contains',
      'if',
      'then',
      'else',
      'not',
      'contentSchema',
    ])
      // A combinator alone can describe a complete value, not just a predicate.
      collectUses(
        object[key],
        predicate || ['if', 'then', 'else', 'contains', 'not'].includes(key),
        scope,
      );
  };
  collectUses(schema, false, schema);
  // A $ref applies its referenced constraints alongside sibling keywords. Follow
  // local pointers only; unresolved references never establish an object policy.
  const declaresObjectPolicy = (
    value: unknown,
    resource: unknown,
    seen = new Set<object>(),
  ): boolean => {
    let current = value;
    let scope = resource;
    while (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      if (seen.has(current)) return false;
      seen.add(current);
      const object = current as Record<string, unknown>;
      if (typeof object['$id'] === 'string') scope = current;
      if (
        object['additionalProperties'] !== undefined ||
        object['unevaluatedProperties'] !== undefined
      )
        return true;
      // Every allOf branch applies, so one declared object policy constrains
      // the composition. Merely having allOf (or an open branch) proves nothing.
      if (
        Array.isArray(object['allOf']) &&
        object['allOf'].some((branch) => declaresObjectPolicy(branch, scope, new Set(seen)))
      )
        return true;
      const target = localTarget(object['$ref'], scope);
      if (target === undefined) return false;
      current = target.node;
      scope = target.resource;
    }
    return false;
  };
  const walk = (
    node: unknown,
    path: string,
    predicateFragment: boolean,
    resource: unknown,
  ): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`, predicateFragment, resource));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    const scope = typeof o['$id'] === 'string' ? node : resource;
    const contexts = uses.get(node);
    const isPredicate = predicateFragment || (contexts?.has(true) === true && !contexts.has(false));
    // Predicate fragments intentionally match part of a containing object. Only
    // complete object shapes must declare their additional-properties policy.
    if (
      !isPredicate &&
      o['properties'] !== undefined &&
      !declaresObjectPolicy(o, scope) &&
      path !== '$root'
    ) {
      findings.push({ schema: name, rule: 'open-world-object', path });
    }
    // rule: no restated verdict vocabulary outside common-defs
    if (name !== 'common-defs.schema.json' && Array.isArray(o['enum'])) {
      const e = JSON.stringify([...(o['enum'] as unknown[])].sort());
      if (VERDICT_SETS.includes(e))
        findings.push({ schema: name, rule: 'restated-verdict-enum', path });
    }
    for (const [k, v] of Object.entries(o)) {
      walk(v, `${path}/${k}`, isPredicate || PREDICATE_KEYWORDS.has(k), scope);
    }
  };
  walk(schema, '$root', false, schema);
  return findings;
}
