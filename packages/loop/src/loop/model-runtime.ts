import { isAbsolute, relative, resolve, sep } from 'node:path';

export const MODEL_RUNTIME_REGISTRY_PATH = 'law/policy/model-runtime-registry.json';

export type AgentClass = 'coding-agent' | 'review-agent' | 'ops-agent';
export type RuntimeTransport = 'provider-api' | 'host-cli';

export interface RuntimeRegistryEntry {
  readonly id: string;
  readonly vendor: string;
  readonly family: string;
  readonly adapter_id: string;
  readonly adapter_module: string;
  readonly transport: RuntimeTransport;
  readonly executable?: string;
  readonly credential_binding?: string | null;
  readonly efforts: readonly string[];
  readonly capabilities: readonly string[];
  readonly eligible_agent_classes: readonly AgentClass[];
  readonly available: boolean;
  readonly availability_basis: string;
}

export interface ModelRuntimeRegistry {
  readonly schemaVersion: '1.0.0';
  readonly id: 'model-runtime-registry';
  readonly status: 'active';
  readonly authority: 'Architect';
  readonly runtimes: readonly RuntimeRegistryEntry[];
}

export class ModelRuntimeRegistryError extends Error {
  public readonly code: string;

  public constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'ModelRuntimeRegistryError';
    this.code = code;
  }
}

export interface RegistryCandidateReader {
  (
    repoRoot: string,
    candidate: unknown,
    repositoryPath: typeof MODEL_RUNTIME_REGISTRY_PATH,
  ): string;
}

export interface LoadModelRuntimeRegistryOptions {
  readonly repoRoot: string;
  readonly candidate: unknown;
  readonly readCandidate?: RegistryCandidateReader;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, detail: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModelRuntimeRegistryError('TASK_MODEL_REGISTRY_INVALID', detail);
  }
  return value as JsonRecord;
}

function nonemptyString(value: unknown, detail: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ModelRuntimeRegistryError('TASK_MODEL_REGISTRY_INVALID', detail);
  }
  return value;
}

function stringSet(value: unknown, detail: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw new ModelRuntimeRegistryError('TASK_MODEL_REGISTRY_INVALID', detail);
  }
  return value as readonly string[];
}

function containedRepositoryPath(path: string): boolean {
  if (isAbsolute(path)) return false;
  const root = resolve('.');
  const absolute = resolve(root, path);
  const contained = relative(root, absolute);
  return contained !== '' && contained !== '..' && !contained.startsWith(`..${sep}`);
}

function parseCandidate(options: LoadModelRuntimeRegistryOptions): unknown {
  if (options.repoRoot.length === 0) {
    throw new ModelRuntimeRegistryError(
      'TASK_MODEL_REGISTRY_SOURCE_INVALID',
      'repoRoot must be explicit',
    );
  }
  let candidate = options.candidate;
  if (options.readCandidate !== undefined) {
    candidate = options.readCandidate(
      options.repoRoot,
      options.candidate,
      MODEL_RUNTIME_REGISTRY_PATH,
    );
  }
  if (candidate instanceof Uint8Array) candidate = Buffer.from(candidate).toString('utf8');
  if (typeof candidate === 'string') {
    try {
      return JSON.parse(candidate) as unknown;
    } catch (error) {
      throw new ModelRuntimeRegistryError(
        'TASK_MODEL_REGISTRY_INVALID',
        `candidate is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return candidate;
}

export function validateModelRuntimeRegistry(candidate: unknown): ModelRuntimeRegistry {
  const root = record(candidate, 'registry must be an object');
  if (
    root['$schema'] !== '../schemas/model-runtime-registry.schema.json' ||
    root['schemaVersion'] !== '1.0.0' ||
    root['id'] !== 'model-runtime-registry' ||
    root['status'] !== 'active' ||
    root['authority'] !== 'Architect' ||
    root['decision'] !== undefined ||
    root['models'] !== undefined ||
    root['selection'] !== undefined
  ) {
    throw new ModelRuntimeRegistryError(
      'TASK_MODEL_REGISTRY_IDENTITY_MISMATCH',
      'registry identity does not match the runtime-bridge contract',
    );
  }
  if (!Array.isArray(root['runtimes']) || root['runtimes'].length === 0) {
    throw new ModelRuntimeRegistryError('TASK_MODEL_REGISTRY_INVALID', 'runtimes must be nonempty');
  }

  const ids = new Set<string>();
  for (const raw of root['runtimes']) {
    const entry = record(raw, 'runtime entry must be an object');
    const id = nonemptyString(entry['id'], 'runtime id is required');
    if (ids.has(id)) {
      throw new ModelRuntimeRegistryError('TASK_MODEL_REGISTRY_DUPLICATE', `duplicate runtime ${id}`);
    }
    ids.add(id);
    const adapterModule = nonemptyString(
      entry['adapter_module'],
      `runtime ${id} adapter_module is required`,
    );
    if (!containedRepositoryPath(adapterModule) || !adapterModule.endsWith('.ts')) {
      throw new ModelRuntimeRegistryError(
        'TASK_MODEL_REGISTRY_INVALID',
        `runtime ${id} adapter_module is not a contained TypeScript path`,
      );
    }
    const transport = entry['transport'];
    if (transport !== 'provider-api' && transport !== 'host-cli') {
      throw new ModelRuntimeRegistryError(
        'TASK_MODEL_REGISTRY_INVALID',
        `runtime ${id} transport is invalid`,
      );
    }
    if (transport === 'host-cli') {
      nonemptyString(entry['executable'], `host runtime ${id} executable is required`);
    }
    nonemptyString(entry['vendor'], `runtime ${id} vendor is required`);
    nonemptyString(entry['family'], `runtime ${id} family is required`);
    nonemptyString(entry['adapter_id'], `runtime ${id} adapter_id is required`);
    stringSet(entry['efforts'], `runtime ${id} efforts are invalid`);
    stringSet(entry['capabilities'], `runtime ${id} capabilities are invalid`);
    const classes = stringSet(
      entry['eligible_agent_classes'],
      `runtime ${id} agent classes are invalid`,
    );
    if (classes.some((value) => !['coding-agent', 'review-agent', 'ops-agent'].includes(value))) {
      throw new ModelRuntimeRegistryError(
        'TASK_MODEL_REGISTRY_INVALID',
        `runtime ${id} has an unknown agent class`,
      );
    }
    if (typeof entry['available'] !== 'boolean') {
      throw new ModelRuntimeRegistryError(
        'TASK_MODEL_REGISTRY_INVALID',
        `runtime ${id} availability is invalid`,
      );
    }
    nonemptyString(entry['availability_basis'], `runtime ${id} availability basis is required`);
  }

  return root as unknown as ModelRuntimeRegistry;
}

export function loadModelRuntimeRegistry(
  options: LoadModelRuntimeRegistryOptions,
): ModelRuntimeRegistry {
  return validateModelRuntimeRegistry(parseCandidate(options));
}
