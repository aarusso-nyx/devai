import { canonicalJson } from '@devai-nyx/utils';

/** API source identity is independent of auth, generated timestamps and walk order. */
export interface EndpointIdentityInput {
  readonly id?: string;
  readonly method: string;
  readonly path: string;
  readonly controller?: {
    readonly file: string;
    readonly class?: string;
    readonly methodName?: string;
    readonly startLine?: number;
    readonly endLine?: number;
  };
  readonly evidence?: readonly {
    readonly path: string;
    readonly startLine?: number;
    readonly endLine?: number;
  }[];
}

function portablePath(path: string): string {
  return path.replace(/\\/gu, '/');
}

/** Reversible versioned encoding of the producer's complete source/composition tuple. */
export function qualifiedEndpointId(endpoint: EndpointIdentityInput): string {
  if (endpoint.controller === undefined || endpoint.evidence === undefined) {
    throw new Error('ENDPOINT_SOURCE_IDENTITY_MISSING');
  }
  const controller = { ...endpoint.controller, file: portablePath(endpoint.controller.file) };
  const evidence = endpoint.evidence
    .map((entry) => ({ ...entry, path: portablePath(entry.path) }))
    .sort((a, b) => {
      const left = canonicalJson(a);
      const right = canonicalJson(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  return `api:v1:${encodeURIComponent(canonicalJson([endpoint.method, endpoint.path, controller, evidence]))}`;
}

export function endpointId(endpoint: EndpointIdentityInput): string {
  return (
    endpoint.id ??
    (endpoint.controller !== undefined && endpoint.evidence !== undefined
      ? qualifiedEndpointId(endpoint)
      : `${endpoint.method} ${endpoint.path}`)
  );
}

/** Legacy method/path references are aliases only when exactly one entry owns them. */
export function endpointIdentityPopulation(endpoints: readonly EndpointIdentityInput[]): {
  readonly ids: readonly string[];
  readonly references: ReadonlyMap<string, readonly string[]>;
  readonly collisions: readonly string[];
} {
  const ids = endpoints.map(endpointId);
  const references = new Map<string, string[]>();
  const counts = new Map<string, number>();
  for (const endpoint of endpoints) {
    const id = endpointId(endpoint);
    counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const reference of new Set([id, `${endpoint.method} ${endpoint.path}`])) {
      const targets = references.get(reference) ?? [];
      if (!targets.includes(id)) targets.push(id);
      references.set(reference, targets);
    }
  }
  return {
    ids,
    references,
    collisions: [...counts].filter(([, count]) => count > 1).map(([id]) => id),
  };
}
