/**
 * Phase 18.F: shared run-helper for every scaffold operations.
 *
 * Each scaffolder differs in (1) which template ids it consumes
 * (per the selected template registry) and
 * (2) how to derive per-entity target paths. Everything else —
 * load blueprint → resolve pack → render → idempotency check →
 * write → emit scaffold-evidence — lives here.
 *
 * Deterministic by construction. NO LLM. The locked decision (D-59
 * consequence #2): generators run from data (the validated
 * blueprint), not from prose.
 *
 * Per D-59; per INV-SCAFFOLD-001 (every emitted file carries a
 * generated-header citing blueprint_id + version + sha256).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { buildTokens, renderTemplate } from '@devai-nyx/utils';
import { blueprintSha256, loadBlueprint, validateBlueprint, type Blueprint } from '@devai-nyx/spec';
import { resolveStackAdapterPack, type StackAdapterPack } from '../../pack-resolver/index.js';

// ---------------------------------------------------------------------
// Local result shape keeps the scaffolder independent from recipe hosts.
// ---------------------------------------------------------------------

export interface ScaffoldOperationResult {
  readonly operation_id: string;
  readonly status: 'pass' | 'fail' | 'review' | 'skipped';
  readonly evidence?: unknown;
  readonly notes?: readonly string[];
}

// ---------------------------------------------------------------------
// Per-skill spec: how a concrete scaffolder configures the runner.
// ---------------------------------------------------------------------

export interface ScaffolderTargetTask {
  /** Template id from the pack's `templates` registry. */
  readonly template_id: string;
  /** Repo-relative path the rendered template writes to. */
  readonly target_path: string;
  /** Extra tokens to merge into the canonical set (e.g. entity-specific). */
  readonly extra_tokens?: Readonly<Record<string, string>>;
  /** Optional conditional flags for the template engine. */
  readonly flags?: Readonly<Record<string, boolean>>;
}

export interface ScaffolderSpec {
  readonly operationId: string;
  /** Which template ids this scaffolder consumes from the pack registry. */
  readonly templateIds: readonly string[];
  /**
   * Derive the concrete tasks (template_id × target_path) from the
   * blueprint + matched pack. The runner calls this once per run.
   * Returning [] is legal when this scaffolder has nothing to do.
   */
  readonly deriveTasks: (
    blueprint: Blueprint,
    pack: StackAdapterPack,
    moduleSlug: string,
  ) => readonly ScaffolderTargetTask[];
}

export interface RunScaffolderOptions {
  readonly spec: ScaffolderSpec;
  readonly ctx: {
    readonly repoRoot: string;
    readonly inputs?: Record<string, unknown>;
    readonly timestamp?: string;
    readonly canonicalPack?: StackAdapterPack;
    readonly allowedPaths?: readonly string[];
  };
}

// ---------------------------------------------------------------------
// Header emission (INV-SCAFFOLD-001).
// ---------------------------------------------------------------------

/**
 * Add a generated-header line at the top of every rendered output.
 * Format is comment-agnostic: the engine prepends a single-line
 * comment that fits both `//` (TS/JS/SQL with -- adapter), `#`
 * (YAML), and `<!-- -->` (Markdown). Per-skill spec.deriveTasks may
 * override the prefix via extra_tokens but the canonical pattern is:
 *
 *   <prefix> Generated from <blueprint_id> v<version> sha256:<head8>
 *
 * The prefix is auto-chosen from the target file extension; markdown
 * and HTML files use HTML-comment delimiters, .sql / .ts / .js use
 * `//`, .yml / .yaml use `#`. Anything else gets `//`.
 */
function headerFor(
  targetPath: string,
  blueprintId: string,
  version: string,
  shaHead: string,
): string {
  const base = `Generated from ${blueprintId} v${version} sha256:${shaHead}`;
  const ext = targetPath.toLowerCase();
  if (ext.endsWith('.md') || ext.endsWith('.html')) {
    return `<!-- ${base} -->\n`;
  }
  if (ext.endsWith('.sql')) {
    return `-- ${base}\n`;
  }
  if (ext.endsWith('.yml') || ext.endsWith('.yaml')) {
    return `# ${base}\n`;
  }
  return `// ${base}\n`;
}

// ---------------------------------------------------------------------
// Pack template-registry shape (consumer-facing).
// ---------------------------------------------------------------------

interface PackTemplateEntry {
  readonly path: string;
  readonly consumed_by: string;
  readonly description?: string;
}

function packTemplates(pack: StackAdapterPack): Readonly<Record<string, PackTemplateEntry>> | null {
  // The Phase 18.C schema field `templates` is optional. The
  // StackAdapterPack type doesn't currently declare it (the
  // schema-extension pre-dates the type), so we cast through unknown.
  const maybe = (pack as unknown as { templates?: Readonly<Record<string, PackTemplateEntry>> })
    .templates;
  if (maybe === undefined || maybe === null) return null;
  return maybe;
}

// ---------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------

export function runScaffolder(opts: RunScaffolderOptions): ScaffoldOperationResult {
  const { spec, ctx } = opts;

  // 1. Load + validate blueprint.
  const blueprintPath = (ctx.inputs?.blueprint_path as string | undefined) ?? '';
  if (blueprintPath === '') {
    return {
      operation_id: spec.operationId,
      status: 'fail',
      notes: ['inputs.blueprint_path: string is required (path to a module-blueprint JSON file)'],
    };
  }
  const loaded = loadBlueprint(
    isAbsolute(blueprintPath) ? blueprintPath : join(ctx.repoRoot, blueprintPath),
  );
  if (!loaded.ok || loaded.blueprint === undefined) {
    return {
      operation_id: spec.operationId,
      status: 'fail',
      notes: [`blueprint failed schema validation: ${loaded.errors.join('; ')}`],
    };
  }
  const blueprint = loaded.blueprint;
  const inv = validateBlueprint(blueprint);
  if (!inv.ok) {
    return {
      operation_id: spec.operationId,
      status: 'fail',
      notes: inv.violations.map((v) => `[${v.invariant_id}] ${v.pointer}: ${v.message}`),
    };
  }

  // Resolve a bundled or caller-provided stack-adapter pack, while evaluating
  // its detect signals against the adopter repository.
  const pack =
    ctx.canonicalPack ??
    resolveStackAdapterPack({ repoRoot: ctx.repoRoot, adopterRoot: ctx.repoRoot }).matched;
  if (pack === null) {
    return {
      operation_id: spec.operationId,
      status: 'skipped',
      notes: [
        'No stack-adapter pack matched the adopter repository; configure a matching canonical pack before scaffolding.',
      ],
      evidence: { blueprint_id: blueprint.id, blueprint_version: blueprint.module.version },
    };
  }
  const templates = packTemplates(pack);
  if (templates === null) {
    return {
      operation_id: spec.operationId,
      status: 'skipped',
      notes: [`Pack '${pack.id}' has no \`templates\` registry; no scaffolding for this stack.`],
      evidence: { blueprint_id: blueprint.id, stack_adapter_pack: pack.id },
    };
  }
  const packDir = pack._packDir;
  if (packDir === undefined) {
    return {
      operation_id: spec.operationId,
      status: 'fail',
      notes: [`Pack '${pack.id}' has no _packDir; resolver did not populate it.`],
    };
  }

  // 3. Filter to templates this scaffolder consumes.
  const consumedTemplates: Array<{ id: string; entry: PackTemplateEntry }> = [];
  for (const id of spec.templateIds) {
    const entry = templates[id];
    if (entry === undefined) continue;
    consumedTemplates.push({ id, entry });
  }
  if (consumedTemplates.length === 0) {
    return {
      operation_id: spec.operationId,
      status: 'skipped',
      notes: [
        `Pack '${pack.id}' declares no templates consumed by '${spec.operationId}'. Expected ids: ${spec.templateIds.join(', ')}.`,
      ],
      evidence: { blueprint_id: blueprint.id, stack_adapter_pack: pack.id },
    };
  }

  // 4. Derive concrete (template_id × target_path) tasks.
  const moduleSlug = `${blueprint.module.namespace}-${toKebab(blueprint.module.name)}`;
  const tasks = spec.deriveTasks(blueprint, pack, moduleSlug);
  if (tasks.length === 0) {
    return {
      operation_id: spec.operationId,
      status: 'skipped',
      notes: [`Blueprint '${blueprint.id}' produced no scaffold tasks for '${spec.operationId}'.`],
      evidence: { blueprint_id: blueprint.id, stack_adapter_pack: pack.id },
    };
  }
  const allowedPaths = new Set(ctx.allowedPaths ?? []);
  if (tasks.some((task) => !allowedPaths.has(task.target_path))) {
    return {
      operation_id: spec.operationId,
      status: 'fail',
      notes: ['derived scaffold output is absent from the exact invocation write_paths'],
    };
  }

  // 5. Render each task; track idempotency.
  const bpSha = blueprintSha256(blueprint);
  const bpShaHead = bpSha.slice(0, 8);
  const filesCreated: string[] = [];
  const filesModified: string[] = [];
  const filesSkipped: Array<{ path: string; reason: string; note?: string }> = [];
  const templatesUsed: Array<{
    template_id: string;
    rendered_to: string;
    rendered_sha256: string;
  }> = [];
  const driftFiles: Array<{ path: string; expected_sha256: string; actual_sha256: string }> = [];
  const aggregateTokens: Record<string, string> = {};

  for (const task of tasks) {
    const consumed = consumedTemplates.find((c) => c.id === task.template_id);
    if (consumed === undefined) {
      filesSkipped.push({
        path: task.target_path,
        reason: 'no_template_in_pack',
        note: `template id '${task.template_id}' not in pack`,
      });
      continue;
    }
    const tplPath = join(packDir, consumed.entry.path);
    if (!existsSync(tplPath)) {
      filesSkipped.push({
        path: task.target_path,
        reason: 'no_template_in_pack',
        note: `template file ${tplPath} does not exist on disk`,
      });
      continue;
    }
    const tplBody = readFileSync(tplPath, 'utf8');

    // Build token map for this task.
    const firstEntity = blueprint.database.entities[0];
    if (firstEntity === undefined) {
      filesSkipped.push({
        path: task.target_path,
        reason: 'scope_excluded',
        note: 'blueprint has no entities (caught by INV-BLUEPRINT-001 upstream)',
      });
      continue;
    }
    const tokens = buildTokens({
      namespace: blueprint.module.namespace,
      module: blueprint.module.name,
      entity: firstEntity.name,
      specVersion: blueprint.module.version,
      specSha256: bpSha,
      extra: task.extra_tokens,
    });
    Object.assign(aggregateTokens, tokens);

    const rendered = renderTemplate({
      body: tplBody,
      tokens,
      ...(task.flags !== undefined && { flags: task.flags }),
    });

    // Prepend INV-SCAFFOLD-001 header.
    const header = headerFor(task.target_path, blueprint.id, blueprint.module.version, bpShaHead);
    const fullOutput = header + rendered.output;
    const fullSha = createHash('sha256').update(fullOutput, 'utf8').digest('hex');

    const absPath = join(ctx.repoRoot, task.target_path);
    if (existsSync(absPath)) {
      const existing = readFileSync(absPath, 'utf8');
      const existingSha = createHash('sha256').update(existing, 'utf8').digest('hex');
      if (existingSha === fullSha) {
        filesSkipped.push({ path: task.target_path, reason: 'already_exists_no_template_change' });
        templatesUsed.push({
          template_id: task.template_id,
          rendered_to: task.target_path,
          rendered_sha256: fullSha,
        });
        continue;
      }
      // Drift detected — do NOT overwrite.
      filesSkipped.push({
        path: task.target_path,
        reason: 'drift_detected_no_overwrite',
        note: `existing file diverges from rendered template; bump blueprint version + re-run to regenerate intentionally`,
      });
      driftFiles.push({
        path: task.target_path,
        expected_sha256: fullSha,
        actual_sha256: existingSha,
      });
      templatesUsed.push({
        template_id: task.template_id,
        rendered_to: task.target_path,
        rendered_sha256: fullSha,
      });
      continue;
    }

    // Fresh write.
    try {
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, fullOutput);
      filesCreated.push(task.target_path);
      templatesUsed.push({
        template_id: task.template_id,
        rendered_to: task.target_path,
        rendered_sha256: fullSha,
      });
    } catch (err) {
      return {
        operation_id: spec.operationId,
        status: 'fail',
        notes: [
          `failed to write ${task.target_path}: ${err instanceof Error ? err.message : String(err)}`,
        ],
        evidence: {
          blueprint_id: blueprint.id,
          stack_adapter_pack: pack.id,
          files_created: filesCreated,
          files_modified: filesModified,
        },
      };
    }
  }

  // 6. Idempotency outcome.
  let idempotency: 'fresh' | 'no-op' | 'drift-detected';
  if (driftFiles.length > 0) {
    idempotency = 'drift-detected';
  } else if (filesCreated.length === 0 && filesModified.length === 0) {
    idempotency = 'no-op';
  } else {
    idempotency = 'fresh';
  }

  return {
    operation_id: spec.operationId,
    status: idempotency === 'drift-detected' ? 'review' : 'pass',
    evidence: {
      schemaVersion: '1.0.0',
      operation_id: spec.operationId,
      blueprint_id: blueprint.id,
      blueprint_version: blueprint.module.version,
      blueprint_sha256: bpSha,
      stack_adapter_pack: pack.id,
      files_created: filesCreated,
      files_modified: filesModified,
      files_skipped: filesSkipped,
      templates_used: templatesUsed,
      token_map: aggregateTokens,
      idempotency,
      ...(driftFiles.length > 0 && { drift_report: { differing_files: driftFiles } }),
    },
  };
}

// ---------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------

function toKebab(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
}

/**
 * Public helper exported for per-skill specs that need per-entity
 * target paths. Same logic as the internal helper; exported as a
 * convenience for the spec.deriveTasks() closures.
 */
export function entityKebab(name: string): string {
  return toKebab(name);
}
