import { existsSync, readFileSync } from 'node:fs';
import { sha256Hex } from './canonical.js';
import type { InputSelector, TaskDescriptor, TaskDescriptorNode } from './types.js';
import { PREFLIGHT_RUNNER, validatePreflightProbes } from './preflight.js';
import { CHANGE_CLASSES, loadChangeTaxonomy } from '../change-taxonomy.js';
import { BARE_EXECUTABLE } from './executable.js';
import { normalizePath } from './policy-git.js';

function globExpression(pattern: string): RegExp {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern.charAt(index);
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          expression += '(?:.*/)?';
          index += 1;
        } else {
          expression += '.*';
        }
        index += 1;
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
    }
  }
  return new RegExp(`${expression}$`, 'u');
}

/**
 * Selector as evaluated by the policy layer: the descriptor grammar plus the
 * change-class kind (ADR-GOV-0017), which selects every path the
 * change-taxonomy binding assigns to the named class.
 */
type PolicyInputSelector = Readonly<{
  kind: InputSelector['kind'] | 'class';
  pattern: string;
}>;

/** Resolves a repository path to its change class, or undefined when unbound. */
export type PathClassifier = (path: string) => string | undefined;

export function selectorMatches(
  selector: PolicyInputSelector,
  path: string,
  classifyPath?: PathClassifier,
): boolean {
  if (selector.kind === 'exact') return path === selector.pattern;
  if (selector.kind === 'prefix') return path.startsWith(selector.pattern);
  if (selector.kind === 'class') {
    if (classifyPath === undefined) {
      throw new Error(`CHECK_RUNNER_CLASS_SELECTOR_UNRESOLVED: ${selector.pattern}`);
    }
    return classifyPath(path) === selector.pattern;
  }
  return globExpression(selector.pattern).test(path);
}

export function anySelectorMatches(
  selectors: readonly PolicyInputSelector[],
  path: string,
  classifyPath: PathClassifier | undefined,
): boolean {
  return selectors.some((selector) => selectorMatches(selector, path, classifyPath));
}

function descriptorSelectors(descriptor: TaskDescriptor): readonly PolicyInputSelector[] {
  return [
    ...(descriptor.dynamicFallbackSelectors as readonly PolicyInputSelector[]),
    ...descriptor.tasks.flatMap((task) => task.inputSelectors as readonly PolicyInputSelector[]),
  ];
}

/** The change-taxonomy classifier of the repository at repoRoot. */
export function taxonomyClassifier(repoRoot: string): PathClassifier {
  const taxonomy = loadChangeTaxonomy(repoRoot);
  return (path) => taxonomy.classify(path);
}

/**
 * The classifier that evaluates the descriptor's own selectors: loaded only
 * when the descriptor selects by class. Lane selection does not depend on it;
 * it loads the taxonomy itself when it needs one (ADR-CHK-0006).
 */
export function descriptorClassifier(
  repoRoot: string,
  descriptor: TaskDescriptor,
): PathClassifier | undefined {
  if (!descriptorSelectors(descriptor).some((selector) => selector.kind === 'class')) {
    return undefined;
  }
  return taxonomyClassifier(repoRoot);
}

function validSelector(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const { kind, pattern } = value as Record<string, unknown>;
  if (typeof pattern !== 'string' || pattern === '') return false;
  if (kind === 'class') return (CHANGE_CLASSES as readonly string[]).includes(pattern);
  return kind === 'exact' || kind === 'prefix' || kind === 'glob';
}

/** True for a node executed by the preflight runner (ADR-CHK-0001). */
export function isPreflightNode(task: Readonly<{ runner?: unknown }>): boolean {
  return task.runner === PREFLIGHT_RUNNER;
}

/** A preflight node carries no argv; the parsed form carries an empty one. */
function withPreflightArgv(descriptor: TaskDescriptor): TaskDescriptor {
  if (!descriptor.tasks.some((task) => isPreflightNode(task))) return descriptor;
  return {
    ...descriptor,
    tasks: descriptor.tasks.map((task) => (isPreflightNode(task) ? { ...task, argv: [] } : task)),
  };
}

/**
 * Adds a synthetic node (the adopter preflight root) to a parsed descriptor.
 * Task keys keep binding the authored descriptor digest.
 */
export function withSyntheticNode(
  descriptor: TaskDescriptor,
  node: TaskDescriptorNode,
): TaskDescriptor {
  if (descriptor.tasks.some((task) => task.nodeId === node.nodeId)) {
    throw new Error(
      `CHECK_RUNNER_DESCRIPTOR: synthetic node ${node.nodeId} collides with a declared node`,
    );
  }
  const augmented: TaskDescriptor = { ...descriptor, tasks: [node, ...descriptor.tasks] };
  authoredDescriptorDigests.set(augmented, taskDescriptorDigest(descriptor));
  return augmented;
}

function validateDescriptor(value: unknown): TaskDescriptor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CHECK_RUNNER_DESCRIPTOR: descriptor must be an object');
  }
  const descriptor = value as TaskDescriptor;
  if (
    descriptor.schemaVersion !== '1.0.0' ||
    typeof descriptor.descriptorVersion !== 'string' ||
    typeof descriptor.repositoryId !== 'string' ||
    !Array.isArray(descriptor.tasks) ||
    descriptor.tasks.length === 0 ||
    !Array.isArray(descriptor.profiles) ||
    !Array.isArray(descriptor.dynamicFallbackSelectors)
  ) {
    throw new Error('CHECK_RUNNER_DESCRIPTOR: unsupported or malformed descriptor');
  }
  if (!(descriptor.dynamicFallbackSelectors as readonly unknown[]).every(validSelector)) {
    throw new Error('CHECK_RUNNER_DESCRIPTOR: malformed dynamic fallback selector');
  }
  const ids = new Set<string>();
  for (const task of descriptor.tasks) {
    const preflight = isPreflightNode(task);
    if (preflight) {
      if ((task as { argv?: unknown }).argv !== undefined) {
        throw new Error(`CHECK_RUNNER_DESCRIPTOR: preflight node ${task.nodeId} declares argv`);
      }
      validatePreflightProbes(task.probes, String(task.nodeId));
    } else if ((task as { probes?: unknown }).probes !== undefined) {
      throw new Error(
        `CHECK_RUNNER_DESCRIPTOR: ${task.nodeId} declares probes outside preflight-v1`,
      );
    }
    if (
      typeof task.nodeId !== 'string' ||
      ids.has(task.nodeId) ||
      !Array.isArray(task.dependencies) ||
      (!preflight &&
        (!Array.isArray(task.argv) ||
          task.argv.length === 0 ||
          task.argv.some((argument: unknown) => typeof argument !== 'string') ||
          !BARE_EXECUTABLE.test(task.argv[0] ?? ''))) ||
      !Array.isArray(task.inputSelectors) ||
      task.inputSelectors.length === 0 ||
      !(task.inputSelectors as readonly unknown[]).every(validSelector) ||
      !Array.isArray(task.toolchainKeys) ||
      !Array.isArray(task.allowlistedEnv) ||
      task.outputContract === null ||
      typeof task.outputContract !== 'object' ||
      Array.isArray(task.outputContract)
    ) {
      throw new Error(`CHECK_RUNNER_DESCRIPTOR: malformed task ${task.nodeId ?? '<unknown>'}`);
    }
    const outputPaths = task.outputContract.paths;
    if (
      outputPaths !== undefined &&
      (!Array.isArray(outputPaths) ||
        outputPaths.length === 0 ||
        outputPaths.some((path) => typeof path !== 'string' || normalizePath(path) !== path) ||
        new Set(outputPaths).size !== outputPaths.length)
    ) {
      throw new Error(`CHECK_RUNNER_DESCRIPTOR: malformed output paths for ${task.nodeId}`);
    }
    ids.add(task.nodeId);
  }
  if (descriptor.fallbackNodeId !== null && !ids.has(descriptor.fallbackNodeId)) {
    throw new Error('CHECK_RUNNER_DESCRIPTOR: unknown fallback node');
  }
  for (const task of descriptor.tasks) {
    if ((task.dependencies as readonly string[]).some((dependency) => !ids.has(dependency))) {
      throw new Error(`CHECK_RUNNER_DESCRIPTOR: ${task.nodeId} has an unknown dependency`);
    }
  }
  for (const profile of descriptor.profiles) {
    if (
      typeof profile.profileId !== 'string' ||
      (profile.mode !== 'affected' && profile.mode !== 'fixed') ||
      !Array.isArray(profile.requiredNodes) ||
      (profile.mode === 'affected' && !Array.isArray(profile.eligibleNodes)) ||
      (profile.mode === 'fixed' && profile.eligibleNodes !== undefined)
    ) {
      throw new Error(
        `CHECK_RUNNER_DESCRIPTOR: malformed profile ${profile.profileId ?? '<unknown>'}`,
      );
    }
    const requiredNodes = profile.requiredNodes as readonly string[];
    const eligible = new Set<string>((profile.eligibleNodes ?? []) as readonly string[]);
    // Preflight nodes are selected for every target, so an affected profile is
    // closed without naming them, and an empty profile routes nothing.
    const preflightIds = new Set(
      descriptor.tasks.filter((task) => isPreflightNode(task)).map((task) => task.nodeId),
    );
    for (const nodeId of [...requiredNodes, ...eligible]) {
      if (!ids.has(nodeId)) {
        throw new Error(`CHECK_RUNNER_DESCRIPTOR: profile ${profile.profileId} names unknown node`);
      }
    }
    if (
      profile.mode === 'affected' &&
      (requiredNodes.some((nodeId) => !eligible.has(nodeId)) ||
        (descriptor.fallbackNodeId !== null &&
          eligible.size > 0 &&
          !eligible.has(descriptor.fallbackNodeId)) ||
        descriptor.tasks.some(
          (task) =>
            eligible.has(task.nodeId) &&
            (task.dependencies as readonly string[]).some(
              (dependency) => !eligible.has(dependency) && !preflightIds.has(dependency),
            ),
        ))
    ) {
      throw new Error(
        `CHECK_RUNNER_DESCRIPTOR: affected profile ${profile.profileId} is not closed`,
      );
    }
  }
  topologicalTasks(descriptor);
  return descriptor;
}

/** Recognize execution tokens, never infer execution from an arbitrary task name. */
function invokesMutationTesting(argv: readonly string[]): boolean {
  return argv.some((arg, index) => {
    const executable = arg.replaceAll('\\', '/').split('/').at(-1) ?? arg;
    const command = argv[index + 1];
    const stryker =
      /^(?:stryker(?:\.cmd|\.js)?|stryker-cli(?:@[^/]+)?)$/u.test(executable) ||
      /^@stryker-mutator\/core(?:@[^/]+)?$/u.test(arg);
    const bedel = /^bedel(?:\.cmd|\.js)?$/u.test(executable);
    return (
      arg === 'test:mutation' ||
      (stryker && (command === 'run' || command === undefined)) ||
      (bedel && (command === 'run' || command === 'resume'))
    );
  });
}

/** Strip only identified mutation-testing tasks; source-write authority is unrelated. */
export function withoutMutationTestTasks(descriptor: TaskDescriptor): TaskDescriptor {
  const retired = new Set(
    descriptor.tasks
      .filter(
        (task) =>
          ['mutation-report-set-discovery-v1', 'mutation-report-set-v1'].includes(
            String(task.outputContract['kind']),
          ) ||
          task.runner === 'stryker' ||
          task.toolchainKeys.some(
            (key) => key === 'stryker' || key.startsWith('@stryker-mutator/'),
          ) ||
          invokesMutationTesting(task.argv),
      )
      .map((task) => task.nodeId),
  );
  if (retired.size === 0) return descriptor;
  const keep = (node: string) => !retired.has(node);
  return {
    ...descriptor,
    fallbackNodeId:
      descriptor.fallbackNodeId !== null && retired.has(descriptor.fallbackNodeId)
        ? null
        : descriptor.fallbackNodeId,
    tasks: descriptor.tasks
      .filter((task) => keep(task.nodeId))
      .map((task) => ({ ...task, dependencies: task.dependencies.filter(keep) })),
    profiles: descriptor.profiles.map((profile) => ({
      ...profile,
      requiredNodes: profile.requiredNodes.filter(keep),
      ...(profile.eligibleNodes === undefined
        ? {}
        : { eligibleNodes: profile.eligibleNodes.filter(keep) }),
    })),
  };
}

/**
 * Digest of the descriptor as the adopter wrote it, keyed by the parsed
 * (mutation-stripped) descriptor. Mutation stripping narrows selection only;
 * task keys must bind the authored bytes so the package-owned evidence
 * verifier, which reconstructs policy from the committed test-tasks.json,
 * derives the same keys.
 */
const authoredDescriptorDigests = new WeakMap<TaskDescriptor, string>();

export function taskDescriptorDigest(descriptor: TaskDescriptor): string {
  return authoredDescriptorDigests.get(descriptor) ?? sha256Hex(descriptor);
}

export function parseTaskDescriptor(value: unknown): TaskDescriptor {
  try {
    const validated = validateDescriptor(value);
    const parsed = withoutMutationTestTasks(withPreflightArgv(validated));
    authoredDescriptorDigests.set(parsed, taskDescriptorDigest(validated));
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('CHECK_RUNNER_DESCRIPTOR:')) throw error;
    throw new Error(
      `CHECK_RUNNER_DESCRIPTOR: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function readTaskDescriptor(path: string): TaskDescriptor {
  if (!existsSync(path)) {
    throw new Error(
      `CHECK_TASK_DESCRIPTOR_MISSING: adopter-owned test task descriptor not found at ${path}; create test-tasks.json from the documented schema and example before using --affected, --local, or --rc`,
    );
  }
  try {
    return parseTaskDescriptor(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith('CHECK_RUNNER_DESCRIPTOR:') ||
        error.message.startsWith('CHECK_TASK_DESCRIPTOR_MISSING:'))
    )
      throw error;
    throw new Error(
      `CHECK_RUNNER_DESCRIPTOR: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function topologicalTasks(descriptor: TaskDescriptor): readonly TaskDescriptorNode[] {
  const byId = new Map(descriptor.tasks.map((task) => [task.nodeId, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: TaskDescriptorNode[] = [];
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) throw new Error(`CHECK_RUNNER_DESCRIPTOR: cycle at ${nodeId}`);
    if (visited.has(nodeId)) return;
    const task = byId.get(nodeId);
    if (task === undefined) throw new Error(`CHECK_RUNNER_DESCRIPTOR: unknown node ${nodeId}`);
    visiting.add(nodeId);
    task.dependencies.forEach(visit);
    visiting.delete(nodeId);
    visited.add(nodeId);
    ordered.push(task);
  };
  descriptor.tasks.forEach((task) => visit(task.nodeId));
  return ordered;
}
