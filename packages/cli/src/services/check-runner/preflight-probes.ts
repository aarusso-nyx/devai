import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PreflightProbe, TaskDescriptorNode } from './types.js';

/** Runner kind of a descriptor node that declares probes instead of argv (ADR-CHK-0001). */
export const PREFLIGHT_RUNNER = 'preflight-v1';
/** Adopter-owned probe list the `--preflight` target plans as a synthetic root node. */
export const ADOPTER_PREFLIGHT_PROBES_PATH = '.devai/config/preflight-probes.json';
export const ADOPTER_PREFLIGHT_NODE_ID = 'preflight';

const PROBE_ID = /^[a-z][a-z0-9-]*$/u;
const BARE_EXECUTABLE = /^[A-Za-z0-9._-]+$/u;

export function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validProbeKind(value: unknown): boolean {
  const probe = record(value);
  if (probe === undefined) return false;
  const text = (key: string) => typeof probe[key] === 'string' && probe[key] !== '';
  switch (probe.kind) {
    case 'environment':
      return (
        exactKeys(probe, ['kind', 'name', 'expected']) &&
        /^[A-Z][A-Z0-9_]*$/u.test(String(probe.name)) &&
        (probe.expected === undefined || typeof probe.expected === 'string')
      );
    case 'file':
      return (
        exactKeys(probe, ['kind', 'path', 'must_exist', 'expected_sha256']) &&
        text('path') &&
        typeof probe.must_exist === 'boolean' &&
        (probe.expected_sha256 === undefined ||
          /^[0-9a-f]{64}$/u.test(String(probe.expected_sha256)))
      );
    case 'command':
      return (
        exactKeys(probe, ['kind', 'argv', 'expected_exit']) &&
        Array.isArray(probe.argv) &&
        probe.argv.length > 0 &&
        probe.argv.every((argument) => typeof argument === 'string') &&
        BARE_EXECUTABLE.test(String(probe.argv[0])) &&
        Number.isInteger(probe.expected_exit) &&
        Number(probe.expected_exit) >= 0 &&
        Number(probe.expected_exit) <= 255
      );
    case 'git':
      return (
        exactKeys(probe, ['kind', 'check', 'base']) &&
        ['base-up-to-date', 'clean-tree', 'commit-range'].includes(String(probe.check)) &&
        (probe.base === undefined || text('base'))
      );
    case 'registry':
      return (
        exactKeys(probe, ['kind', 'url', 'expected_version']) &&
        text('url') &&
        URL.canParse(String(probe.url)) &&
        (probe.expected_version === undefined || typeof probe.expected_version === 'string')
      );
    case 'toolchain':
      return exactKeys(probe, ['kind', 'manifest_path']) && text('manifest_path');
    case 'credential':
      return exactKeys(probe, ['kind', 'manifest_id']) && text('manifest_id');
    default:
      return false;
  }
}

/**
 * Structural validation of a probe list against law/schemas/preflight-probe.schema.json,
 * plus the node-level rules: unique ids and known, acyclic dependencies.
 */
export function validatePreflightProbes(value: unknown, where: string): readonly PreflightProbe[] {
  const invalid = (detail: string) =>
    new Error(`CHECK_RUNNER_DESCRIPTOR: malformed preflight probes for ${where}: ${detail}`);
  if (!Array.isArray(value) || value.length === 0) throw invalid('a non-empty array is required');
  const ids = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const probe = record(entry);
    if (
      probe === undefined ||
      !exactKeys(probe, [
        'id',
        'class',
        'probe',
        'expected',
        'observed',
        'status',
        'remediation',
        'depends_on',
      ]) ||
      typeof probe.id !== 'string' ||
      !PROBE_ID.test(probe.id) ||
      (probe.class !== 'extrinsic' && probe.class !== 'intrinsic') ||
      !validProbeKind(probe.probe) ||
      typeof probe.expected !== 'string' ||
      probe.expected === '' ||
      (probe.observed !== null && typeof probe.observed !== 'string') ||
      !['pass', 'fail', 'blocked', 'skipped'].includes(String(probe.status)) ||
      typeof probe.remediation !== 'string' ||
      probe.remediation === '' ||
      !Array.isArray(probe.depends_on) ||
      probe.depends_on.some((id) => typeof id !== 'string' || !PROBE_ID.test(id)) ||
      new Set(probe.depends_on).size !== probe.depends_on.length
    ) {
      throw invalid(`probe ${String(index)}`);
    }
    if (ids.has(probe.id)) throw invalid(`duplicate probe ${probe.id}`);
    ids.add(probe.id);
  }
  const probes = value as readonly PreflightProbe[];
  for (const probe of probes) {
    const unknown = probe.depends_on.find((id) => !ids.has(id));
    if (unknown !== undefined) throw invalid(`probe ${probe.id} depends on unknown ${unknown}`);
  }
  orderedProbes(probes, where);
  return probes;
}

export function orderedProbes(
  probes: readonly PreflightProbe[],
  where: string,
): readonly PreflightProbe[] {
  const byId = new Map(probes.map((probe) => [probe.id, probe]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: PreflightProbe[] = [];
  const visit = (probe: PreflightProbe): void => {
    if (visited.has(probe.id)) return;
    if (visiting.has(probe.id)) {
      throw new Error(`CHECK_RUNNER_DESCRIPTOR: preflight probe cycle at ${probe.id} in ${where}`);
    }
    visiting.add(probe.id);
    for (const id of probe.depends_on) {
      const dependency = byId.get(id);
      if (dependency !== undefined) visit(dependency);
    }
    visiting.delete(probe.id);
    visited.add(probe.id);
    ordered.push(probe);
  };
  probes.forEach(visit);
  return ordered;
}

/**
 * The adopter-owned probe list, or undefined when the repository declares none.
 * It is planned only by the `--preflight` target and stays outside the task policy.
 */
export function loadAdopterPreflightProbes(
  repoRoot: string,
): readonly PreflightProbe[] | undefined {
  const path = join(repoRoot, ADOPTER_PREFLIGHT_PROBES_PATH);
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `CHECK_RUNNER_DESCRIPTOR: ${ADOPTER_PREFLIGHT_PROBES_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validatePreflightProbes(value, ADOPTER_PREFLIGHT_PROBES_PATH);
}

/** The synthetic root node that carries the adopter probe list. */
export function adopterPreflightNode(probes: readonly PreflightProbe[]): TaskDescriptorNode {
  return {
    nodeId: ADOPTER_PREFLIGHT_NODE_ID,
    dependencies: [],
    argv: [],
    probes,
    cwd: '.',
    runner: PREFLIGHT_RUNNER,
    inputSelectors: [{ kind: 'exact', pattern: ADOPTER_PREFLIGHT_PROBES_PATH }],
    toolchainKeys: ['node'],
    allowlistedEnv: [],
    outputContract: { kind: 'probes', requiredStatus: 'pass' },
  };
}
