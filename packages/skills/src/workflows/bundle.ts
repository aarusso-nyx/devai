/** Internal, read-only workflow preview. Installation and host hooks are separate contracts. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  type Stats,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMap, parseDocument } from 'yaml';
import { RECIPE_NAMES } from '../recipes/types.js';

const DEFAULT_WORKFLOWS_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../resources/workflows',
);

export const WORKFLOW_CORE_KEYS = [
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
] as const;
const OVERLAY_KEYS = [
  'disable-model-invocation',
  'argument-hint',
  'when_to_use',
  'effort',
  'allowed-tools',
  'paths',
];
/** Schema 1 remains unavailable to the current 2.6.2 adopter version. */
export const WORKFLOW_SCHEMA_SUPPORT: Readonly<Record<string, string>> = { '1': '2.7.0' };
export const SKILL_DISCOVERY_ROOTS = ['.claude/skills', '.agents/skills', '.codex/skills'] as const;
const HOST_ROOTS = { claude: '.claude/skills', codex: '.agents/skills' } as const;
const INTERFACE_KEYS = [
  'display_name',
  'short_description',
  'icon_small',
  'icon_large',
  'brand_color',
  'default_prompt',
];

type ErrorCode =
  | 'WORKFLOW_SKILL_SOURCE_INVALID'
  | 'WORKFLOW_SKILL_INVOCATION_MISMATCH'
  | 'WORKFLOW_SKILL_HOST_SYNTAX'
  | 'WORKFLOW_SKILL_OPENAI_YAML_INVALID'
  | 'WORKFLOW_SKILL_DUPLICATE'
  | 'WORKFLOW_SKILL_SCHEMA_UNSUPPORTED'
  | 'WORKFLOW_SKILL_DRIFT';

function invalid(code: ErrorCode, detail: string): Error {
  return Object.assign(new Error(`${code}: ${detail}`), { code });
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
  );
}

function mapping(text: string, code: ErrorCode, detail: string): Record<string, unknown> {
  try {
    const document = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
    if (document.errors.length || document.warnings.length || !isMap(document.contents)) {
      throw new Error('expected an unambiguous YAML mapping');
    }
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (!record(value)) throw new Error('expected a plain mapping');
    return value;
  } catch {
    throw invalid(code, detail);
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/** Do not follow links or block on a FIFO while previewing existing bytes. */
function readRegular(path: string, code: ErrorCode): string {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.nlink !== 1) throw new Error('not a singly linked regular file');
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened))
      throw new Error('changed file');
    const bytes = readFileSync(descriptor);
    if (!sameFile(opened, fstatSync(descriptor)) || !sameFile(opened, lstatSync(path)))
      throw new Error('changed file');
    // Preserve BOM bytes too: the Codex sidecar is copied verbatim, never normalized.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw invalid(code, `${path} is not a stable, singly linked UTF-8 regular file`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Refuse links/non-directories below the supplied root; an absent directory is harmless. */
function directories(root: string, relative: string, code: ErrorCode): boolean {
  let path = root;
  for (const part of ['', ...relative.split('/').filter(Boolean)]) {
    path = join(path, part);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat === undefined) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw invalid(code, `${path} is not a non-symlink directory`);
  }
  return true;
}

function sourceFile(root: string, path: string): string {
  if (!directories(root, dirname(path), 'WORKFLOW_SKILL_SOURCE_INVALID')) {
    throw invalid('WORKFLOW_SKILL_SOURCE_INVALID', `${path} is missing`);
  }
  return readRegular(join(root, path), 'WORKFLOW_SKILL_SOURCE_INVALID');
}

/** Supported sidecar subset, deliberately closed; this does not claim full host-schema support. */
export function validateOpenAiYaml(name: string, text: string): Record<string, unknown> {
  const code = 'WORKFLOW_SKILL_OPENAI_YAML_INVALID';
  const value = mapping(text, code, `${name}: invalid sidecar mapping`);
  if (Object.keys(value).some((key) => !['interface', 'policy'].includes(key))) {
    throw invalid(code, `${name}: unsupported sidecar field`);
  }
  const policy = value['policy'];
  if (
    !record(policy) ||
    Object.keys(policy).length !== 1 ||
    typeof policy['allow_implicit_invocation'] !== 'boolean'
  ) {
    throw invalid(code, `${name}: policy must contain only boolean allow_implicit_invocation`);
  }
  const ui = value['interface'];
  if (
    ui !== undefined &&
    (!record(ui) ||
      Object.entries(ui).some(
        ([key, field]) => !INTERFACE_KEYS.includes(key) || typeof field !== 'string',
      ))
  ) {
    throw invalid(code, `${name}: unsupported interface field or value`);
  }
  return value;
}

export interface LoadedWorkflowSkill {
  readonly name: string;
  readonly skillMarkdown: string;
  readonly coreFrontMatter: string;
  readonly core: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly overlayText: string;
  readonly overlay: Readonly<Record<string, unknown>>;
  readonly openAiYaml: string;
  readonly openAi: Readonly<Record<string, unknown>>;
}

export function loadWorkflowSkills(
  resourcesRoot = DEFAULT_WORKFLOWS_ROOT,
): readonly LoadedWorkflowSkill[] {
  const root = resolve(resourcesRoot);
  if (!directories(root, '', 'WORKFLOW_SKILL_SOURCE_INVALID'))
    throw invalid('WORKFLOW_SKILL_SOURCE_INVALID', 'source root missing');
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink()))
    throw invalid('WORKFLOW_SKILL_SOURCE_INVALID', 'linked source entry');
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const skillMarkdown = sourceFile(root, `${name}/SKILL.md`);
      const match = /^---\n([\s\S]*?)\n---\n/u.exec(skillMarkdown);
      if (match === null)
        throw invalid('WORKFLOW_SKILL_SOURCE_INVALID', `${name}: missing front matter`);
      const coreFrontMatter = match[1] ?? '';
      const core = mapping(
        coreFrontMatter,
        'WORKFLOW_SKILL_SOURCE_INVALID',
        `${name}: invalid core front matter`,
      );
      if (
        Object.keys(core).some((key) => !(WORKFLOW_CORE_KEYS as readonly string[]).includes(key)) ||
        core['name'] !== name ||
        typeof core['description'] !== 'string' ||
        !core['description'].trim()
      ) {
        throw invalid(
          'WORKFLOW_SKILL_SOURCE_INVALID',
          `${name}: invalid core keys, name or description`,
        );
      }
      const overlayText = `${sourceFile(root, `${name}/claude.overlay.yaml`)
        .replace(/^\uFEFF/u, '')
        .replace(/^---[ \t]*\n/u, '')
        .trimEnd()}\n`;
      const overlay = mapping(
        overlayText,
        'WORKFLOW_SKILL_SOURCE_INVALID',
        `${name}: invalid overlay`,
      );
      if (
        Object.entries(overlay).some(
          ([key, value]) =>
            !OVERLAY_KEYS.includes(key) ||
            (key === 'disable-model-invocation'
              ? typeof value !== 'boolean'
              : typeof value !== 'string' &&
                !(
                  ['allowed-tools', 'paths'].includes(key) &&
                  Array.isArray(value) &&
                  value.every((item) => typeof item === 'string')
                )),
        )
      ) {
        throw invalid(
          'WORKFLOW_SKILL_SOURCE_INVALID',
          `${name}: unsupported overlay field or value`,
        );
      }
      const openAiYaml = sourceFile(root, `${name}/agents/openai.yaml`);
      return {
        name,
        skillMarkdown,
        coreFrontMatter,
        core,
        body: skillMarkdown.slice(match[0].length),
        overlayText,
        overlay,
        openAiYaml,
        openAi: validateOpenAiYaml(name, openAiYaml),
      };
    });
}

function versionAtLeast(version: string, floor: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/u.exec(version);
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part, index) => !Number.isSafeInteger(part) || String(part) !== match[index + 1]))
    return false;
  for (const [index, suffix] of [match[4], match[5]].entries()) {
    if (
      suffix !== undefined &&
      suffix.split('.').some((part) => !part || (index === 0 && /^0\d+$/u.test(part)))
    )
      return false;
  }
  const required = floor.split('.').map(Number);
  for (const [index, part] of parts.entries()) {
    if (part !== required[index]) return part > (required[index] ?? 0);
  }
  return match[4] === undefined;
}

export function validateWorkflowSkill(skill: LoadedWorkflowSkill, pinnedVersion: string): void {
  const implicit = (skill.openAi['policy'] as Record<string, unknown>)['allow_implicit_invocation'];
  if ((skill.overlay['disable-model-invocation'] === true) === implicit) {
    throw invalid('WORKFLOW_SKILL_INVOCATION_MISMATCH', skill.name);
  }
  if (/!`|\$ARGUMENTS|\$\{CLAUDE_/u.test(skill.skillMarkdown))
    throw invalid('WORKFLOW_SKILL_HOST_SYNTAX', skill.name);
  const metadata = skill.core['metadata'];
  const schema = record(metadata) ? metadata['devai-workflow-schema'] : undefined;
  const floor =
    typeof schema === 'string' && Object.hasOwn(WORKFLOW_SCHEMA_SUPPORT, schema)
      ? WORKFLOW_SCHEMA_SUPPORT[schema]
      : undefined;
  if (floor === undefined || !versionAtLeast(pinnedVersion, floor)) {
    throw invalid(
      'WORKFLOW_SKILL_SCHEMA_UNSUPPORTED',
      `${skill.name}: workflow schema ${String(schema)} needs DEVAI ${floor ?? 'supported schema'} or newer; target pins ${pinnedVersion}`,
    );
  }
}

export interface WorkflowSkillFile {
  readonly host: keyof typeof HOST_ROOTS;
  readonly path: string;
  readonly content: string;
}

export interface WorkflowSkillPlanOptions {
  readonly targetRoot: string;
  readonly pinnedVersion: string;
  readonly resourcesRoot?: string;
  /** Caller-supplied prior ownership is evidence for preview only; it grants no write authority. */
  readonly owned?: ReadonlyMap<string, string>;
  /** Additional names reserved by the caller; canonical recipe names are always reserved. */
  readonly reservedNames?: readonly string[];
}

export interface WorkflowSkillPlan {
  readonly skills: readonly string[];
  readonly files: readonly WorkflowSkillFile[];
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function assertNoDuplicate(
  root: string,
  name: string,
  planned: readonly WorkflowSkillFile[],
  owned: ReadonlyMap<string, string>,
): void {
  for (const discovery of SKILL_DISCOVERY_ROOTS) {
    const location = `${discovery}/${name}`;
    if (!directories(root, location, 'WORKFLOW_SKILL_DUPLICATE')) continue;
    const expected = new Map(
      planned
        .filter((file) => file.path.startsWith(`${location}/`))
        .map((file) => [file.path, file]),
    );
    if (!expected.size)
      throw invalid(
        'WORKFLOW_SKILL_DUPLICATE',
        `${name}: ${location} is a foreign discovery location`,
      );
    const visit = (relative: string): void => {
      for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
        const path = `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
          if (![...expected.keys()].some((file) => file.startsWith(`${path}/`))) {
            throw invalid('WORKFLOW_SKILL_DUPLICATE', `${name}: unplanned directory ${path}`);
          }
          visit(path);
        } else {
          const file = expected.get(path);
          if (!file) throw invalid('WORKFLOW_SKILL_DUPLICATE', `${name}: unplanned ${path}`);
          const prior = owned.get(path);
          const digest = sha256(
            readRegular(
              join(root, path),
              prior === undefined ? 'WORKFLOW_SKILL_DUPLICATE' : 'WORKFLOW_SKILL_DRIFT',
            ),
          );
          if (digest !== sha256(file.content) && digest !== prior) {
            throw invalid(
              prior === undefined ? 'WORKFLOW_SKILL_DUPLICATE' : 'WORKFLOW_SKILL_DRIFT',
              `${path} differs from the preview and prior ownership`,
            );
          }
        }
      }
    };
    visit(location);
  }
}

/** Plans only: never creates a directory, writes a file, installs a hook or grants authority. */
export function buildWorkflowSkillPlan(options: WorkflowSkillPlanOptions): WorkflowSkillPlan {
  const root = resolve(options.targetRoot);
  const reserved = new Set<string>([...RECIPE_NAMES, ...(options.reservedNames ?? [])]);
  const skills = loadWorkflowSkills(options.resourcesRoot);
  const files: WorkflowSkillFile[] = [];
  for (const skill of skills) {
    validateWorkflowSkill(skill, options.pinnedVersion);
    if (reserved.has(skill.name))
      throw invalid('WORKFLOW_SKILL_DUPLICATE', `${skill.name}: reserved recipe/skill name`);
    const planned: WorkflowSkillFile[] = [
      {
        host: 'claude',
        path: `${HOST_ROOTS.claude}/${skill.name}/SKILL.md`,
        content: `---\n${skill.coreFrontMatter}\n${skill.overlayText}---\n${skill.body}`,
      },
      {
        host: 'codex',
        path: `${HOST_ROOTS.codex}/${skill.name}/SKILL.md`,
        content: skill.skillMarkdown,
      },
      {
        host: 'codex',
        path: `${HOST_ROOTS.codex}/${skill.name}/agents/openai.yaml`,
        content: skill.openAiYaml,
      },
    ];
    assertNoDuplicate(root, skill.name, planned, options.owned ?? new Map());
    files.push(...planned);
  }
  return { skills: skills.map((skill) => skill.name), files };
}
