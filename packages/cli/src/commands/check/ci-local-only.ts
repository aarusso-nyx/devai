import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface AttestedRcConfig {
  readonly profile: 'rc';
  readonly transport: 'protected-tag-v1';
  readonly tag_prefix: string;
  readonly binding: 'exact-tree';
  readonly required_check: 'verified-local-rc';
  readonly failure_mode: 'fail-closed';
  readonly local_only_nodes: readonly string[];
}

export interface LocalOnlyInspection {
  readonly enabled: boolean;
  readonly config?: AttestedRcConfig;
  readonly errors: readonly string[];
  readonly violations: readonly string[];
  readonly forbiddenScripts: readonly string[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readAttestedRcConfig(repoRoot: string): {
  config?: AttestedRcConfig;
  errors: string[];
} {
  const path = join(repoRoot, '.devai/config/project.json');
  if (!existsSync(path)) return { errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return { errors: ['.devai/config/project.json is not valid JSON'] };
  }
  if (!object(parsed) || !object(parsed.ci_economy) || parsed.ci_economy.attested_rc === undefined) {
    return { errors: [] };
  }
  const value = parsed.ci_economy.attested_rc;
  if (!object(value)) return { errors: ['ci_economy.attested_rc must be an object'] };
  const expectedKeys = [
    'binding',
    'failure_mode',
    'local_only_nodes',
    'profile',
    'required_check',
    'tag_prefix',
    'transport',
  ];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) {
    return { errors: ['ci_economy.attested_rc has missing or unknown fields'] };
  }
  if (
    value.profile !== 'rc' ||
    value.transport !== 'protected-tag-v1' ||
    value.binding !== 'exact-tree' ||
    value.required_check !== 'verified-local-rc' ||
    value.failure_mode !== 'fail-closed' ||
    typeof value.tag_prefix !== 'string' ||
    !value.tag_prefix.startsWith('devai-local-evidence/') ||
    !Array.isArray(value.local_only_nodes) ||
    value.local_only_nodes.length === 0 ||
    value.local_only_nodes.some((node) => typeof node !== 'string' || node.length === 0) ||
    new Set(value.local_only_nodes).size !== value.local_only_nodes.length
  ) {
    return { errors: ['ci_economy.attested_rc does not match the protected-tag-v1 contract'] };
  }
  return { config: value as unknown as AttestedRcConfig, errors: [] };
}

function manifestsBelow(repoRoot: string): string[] {
  const manifests: string[] = [];
  const excluded = new Set(['.git', '.devai', 'node_modules', 'dist', 'coverage', 'reports']);
  const visit = (directory: string, depth: number): void => {
    if (depth > 5) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name === 'package.json') manifests.push(path);
      else if (entry.isDirectory() && !excluded.has(entry.name)) visit(path, depth + 1);
    }
  };
  visit(repoRoot, 0);
  return manifests.sort();
}

function scriptBodies(repoRoot: string): Map<string, string[]> {
  const scripts = new Map<string, string[]>();
  for (const manifest of manifestsBelow(repoRoot)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifest, 'utf8')) as unknown;
    } catch {
      continue;
    }
    if (!object(parsed) || !object(parsed.scripts)) continue;
    for (const [name, body] of Object.entries(parsed.scripts)) {
      if (typeof body !== 'string') continue;
      const values = scripts.get(name) ?? [];
      values.push(body);
      scripts.set(name, values);
    }
  }
  return scripts;
}

function tokenPresent(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9:_-])${escaped}(?=$|[^A-Za-z0-9:_-])`, 'u').test(text);
}

function forbiddenScriptClosure(scripts: Map<string, string[]>, seeds: readonly string[]): string[] {
  const forbidden = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, bodies] of scripts) {
      if (forbidden.has(name)) continue;
      if (
        bodies.some(
          (body) =>
            /(?:^|\s)(?:stryker|test:mutation)(?:\s|$)/u.test(body) ||
            [...forbidden].some((dependency) => tokenPresent(body, dependency)),
        )
      ) {
        forbidden.add(name);
        changed = true;
      }
    }
  }
  return [...forbidden].sort();
}

function descriptorLocalNodes(repoRoot: string, ids: readonly string[]): { scripts: string[]; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(repoRoot, 'test-tasks.json'), 'utf8')) as unknown;
  } catch {
    return { scripts: [], errors: ['test-tasks.json is missing or invalid'] };
  }
  if (!object(parsed) || !Array.isArray(parsed.tasks)) {
    return { scripts: [], errors: ['test-tasks.json has no task roster'] };
  }
  const tasks = parsed.tasks.filter(object);
  const scripts: string[] = [];
  const errors: string[] = [];
  for (const id of ids) {
    const task = tasks.find((entry) => entry.nodeId === id);
    if (task === undefined || !Array.isArray(task.argv) || task.argv.some((arg) => typeof arg !== 'string')) {
      errors.push(`local-only node ${id} is absent or malformed in test-tasks.json`);
      continue;
    }
    scripts.push(id);
    const argv = task.argv as string[];
    const runIndex = argv.indexOf('run');
    if (runIndex >= 0 && argv[runIndex + 1] !== undefined) scripts.push(argv[runIndex + 1] as string);
    else if (argv[0] === 'pnpm' && argv[1] !== undefined && !argv[1]?.startsWith('-')) scripts.push(argv[1]);
  }
  return { scripts, errors };
}

export function inspectRemoteLocalOnlyNodes(
  repoRoot: string,
  workflows: readonly { file: string; text: string }[],
): LocalOnlyInspection {
  const loaded = readAttestedRcConfig(repoRoot);
  if (loaded.config === undefined) {
    return { enabled: false, errors: loaded.errors, violations: [], forbiddenScripts: [] };
  }
  const descriptor = descriptorLocalNodes(repoRoot, loaded.config.local_only_nodes);
  const scripts = scriptBodies(repoRoot);
  const forbidden = forbiddenScriptClosure(scripts, [...descriptor.scripts, 'test:mutation']);
  const violations: string[] = [];
  const invokedScripts = new Set(scripts.keys());
  for (const workflow of workflows) {
    if (/\bstryker\b/u.test(workflow.text)) violations.push(`${workflow.file}: direct Stryker invocation`);
    for (const name of forbidden) {
      if (tokenPresent(workflow.text, name)) {
        violations.push(`${workflow.file}: reaches local-only script ${name}`);
      }
    }
    for (const match of workflow.text.matchAll(/\b(?:pnpm|npm|yarn)\s+(?:run\s+)?([A-Za-z][A-Za-z0-9:_-]*)/gu)) {
      const name = match[1];
      if (name !== undefined && !['exec', 'install', 'ci', 'dlx'].includes(name) && !invokedScripts.has(name)) {
        violations.push(`${workflow.file}: script chain ${name} cannot be resolved`);
      }
    }
  }
  return {
    enabled: true,
    config: loaded.config,
    errors: [...loaded.errors, ...descriptor.errors],
    violations: [...new Set(violations)].sort(),
    forbiddenScripts: forbidden,
  };
}
