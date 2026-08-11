#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format as prettierFormat, resolveConfig as resolvePrettierConfig } from 'prettier';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const PRETTIER_CONFIG =
  (await resolvePrettierConfig(join(ROOT, 'docs/reference/cli/index.md'))) ?? {};
const MODE = process.argv.includes('--write')
  ? 'write'
  : process.argv.includes('--check')
    ? 'check'
    : null;
const REQUESTED = process.argv.flatMap((arg, index, argv) =>
  arg === '--category' && argv[index + 1] !== undefined ? [argv[index + 1]] : [],
);

if (MODE === null || (process.argv.includes('--write') && process.argv.includes('--check'))) {
  throw new Error('usage: render-generated-reference.mjs (--check | --write) [--category <id>]...');
}

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

function json(path) {
  return JSON.parse(read(path));
}

function objects(value, code) {
  if (
    !Array.isArray(value) ||
    value.some((item) => item === null || typeof item !== 'object' || Array.isArray(item))
  ) {
    throw new Error(`${code}: expected object array`);
  }
  return value;
}

function strings(value, code) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${code}: expected string array`);
  }
  return value;
}

function text(value, code) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
}

function human(id) {
  return id
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function code(value) {
  return `\`${String(value).replaceAll('`', '\\`')}\``;
}

function list(values, empty = 'Not applicable: the canonical source declares no values') {
  return values.length === 0 ? empty : values.map(code).join(', ');
}

function clause(value) {
  return value.replace(/[.!?]+$/gu, '');
}

function link(path, pointer = '#') {
  const relative = path.startsWith('docs/reference/cli/')
    ? `./${path.slice('docs/reference/cli/'.length)}`
    : `../../../${path}`;
  return `[${code(path)}](${relative}${pointer === '#' ? '' : pointer})`;
}

function unique(values) {
  return [...new Set(values)];
}

const FIELD_LABELS = Object.freeze({
  stable_id: 'Stable ID',
  user_facing_label: 'User-facing label',
  plain_language_purpose: 'Purpose',
  population_or_projection: 'Population or projection',
  prerequisites: 'Prerequisites',
  required_external_tools: 'Required external tools',
  accepted_inputs: 'Accepted inputs',
  defaults: 'Defaults',
  output_contract: 'Output contract',
  verdict_semantics: 'Verdict semantics',
  declared_effect: 'Declared effect',
  consent_flags: 'Consent flags',
  cost_class: 'Cost class',
  when_to_use: 'When to use',
  when_not_to_use: 'When not to use',
  failure_unknown_review_skipped_na_semantics: 'Non-pass semantics',
  example: 'Example',
  canonical_source_link: 'Canonical source',
  related_workflow: 'Related workflow',
});

const architecture = json('law/policy/documentation-information-architecture.json');
const SEMANTIC_FIELDS = strings(architecture.semantic_fields, 'DOCS_SEMANTIC_FIELDS_INVALID');
if (JSON.stringify(Object.keys(FIELD_LABELS)) !== JSON.stringify(SEMANTIC_FIELDS)) {
  throw new Error('DOCS_SEMANTIC_FIELDS_RENDERER_DRIFT');
}

const actionRegistry = json('law/policy/action-registry.json');
const actions = objects(actionRegistry.entries, 'DOCS_ACTION_REGISTRY_INVALID');
const keptAction = (id) => {
  const matches = actions.filter((entry) => entry.action_id === id);
  if (matches.length !== 1) throw new Error(`DOCS_ACTION_ROUTE_INVALID:${id}:${matches.length}`);
  return matches[0];
};

function consentForEffect(effect) {
  if (effect === 'read') return 'No write or publish consent.';
  if (effect === 'remote-write')
    return `${code('--write')} and ${code('--publish')} are both required; neither implies the other.`;
  if (effect === 'harness-write' || effect === 'local-write')
    return `${code('--write')} is required; ${code('--publish')} is not implied.`;
  throw new Error(`DOCS_EFFECT_UNKNOWN:${effect}`);
}

function dryRunConsentArgs(effect) {
  if (effect === 'read') return '';
  if (effect === 'harness-write' || effect === 'local-write') return ' --write';
  if (effect === 'remote-write') return ' --write --publish';
  throw new Error(`DOCS_EFFECT_UNKNOWN:${effect}`);
}

function allowedRoles(action) {
  const subject = action.authority_contract?.subject;
  if (subject?.kind === 'human')
    return strings(subject.allowed_roles, `DOCS_ACTION_ROLES_INVALID:${action.action_id}`);
  if (subject?.kind === 'derived-machine' && subject.initiator !== 'none') {
    return strings(
      subject.initiator?.allowed_roles,
      `DOCS_ACTION_ROLES_INVALID:${action.action_id}`,
    );
  }
  return [];
}

function roleInputs(action) {
  if (action.effect === 'read')
    return 'No role declaration is accepted or required by this read action';
  const roles = allowedRoles(action);
  return `${code(`--as-role <${roles.join('|')}>`)} or a live ${code('--authority-session <id>')}`;
}

const EFFECT_RANK = Object.freeze({
  read: 0,
  'harness-write': 1,
  'local-write': 2,
  'remote-write': 3,
});
function maxEffect(values) {
  return values.reduce((maximum, value) => {
    if (!(value in EFFECT_RANK)) throw new Error(`DOCS_EFFECT_UNKNOWN:${value}`);
    return EFFECT_RANK[value] > EFFECT_RANK[maximum] ? value : maximum;
  }, 'read');
}

const COST_RANK = Object.freeze({ fast: 0, moderate: 1, expensive: 2, 'external-dependent': 3 });
const SOURCE_COST = Object.freeze({ low: 'fast', medium: 'moderate', high: 'expensive' });
function maxCost(values) {
  return values.reduce((maximum, value) => {
    if (!(value in COST_RANK)) throw new Error(`DOCS_COST_UNKNOWN:${value}`);
    return COST_RANK[value] > COST_RANK[maximum] ? value : maximum;
  }, 'fast');
}

function fields(values) {
  const missing = SEMANTIC_FIELDS.filter(
    (field) => typeof values[field] !== 'string' || values[field].trim().length === 0,
  );
  if (missing.length > 0)
    throw new Error(`DOCS_ENTRY_SEMANTICS_INCOMPLETE:${values.stable_id}:${missing.join(',')}`);
  return values;
}

function entry(category, values) {
  const complete = fields(values);
  const lines = [
    `<!-- devai:generated-entry category="${category}" id="${complete.stable_id}" -->`,
    `### ${code(complete.stable_id)} — ${complete.user_facing_label}`,
    '',
  ];
  for (const field of SEMANTIC_FIELDS)
    lines.push(`- **${FIELD_LABELS[field]}:** ${complete[field]}`);
  return lines.join('\n');
}

function category(title, id, entries) {
  if (entries.length === 0) throw new Error(`DOCS_CATEGORY_EMPTY:${id}`);
  return [`## ${title}`, '', ...entries.flatMap((value) => [value, ''])].join('\n').trimEnd();
}

function outcomeSemantics() {
  return `${code('fail')} is a negative finding; ${code('error')} is an execution or producer defect; ${code('unknown')} never passes; ${code('review')} requires human disposition; ${code('skipped')} reports an unexecuted member; ${code('N/A')} is valid only when the governing contract explicitly permits it.`;
}

function sourceRefs(categoryPolicy) {
  return categoryPolicy.source_refs
    .map((ref) =>
      link(
        text(ref.path, 'DOCS_SOURCE_PATH_INVALID'),
        text(ref.pointer, 'DOCS_SOURCE_POINTER_INVALID'),
      ),
    )
    .join('; ');
}

const checkSuites = json('law/policy/check-suites.json');
const sensePresets = json('law/policy/sense-presets.json');
const sensorRegistry = json('law/policy/sensor-registry.json');
const roundExecution = json('law/policy/round-execution.json');
const modelRuntime = json('law/policy/model-runtime-registry.json');
const taskSchema = json('law/schemas/task.schema.json');
const actionSchema = json('law/schemas/action-registry.schema.json');
const sensors = objects(sensorRegistry.entries, 'DOCS_SENSOR_REGISTRY_INVALID');
const sensorByKind = new Map(sensors.map((sensor) => [sensor.kind, sensor]));
const presets = objects(sensePresets.presets, 'DOCS_SENSE_PRESETS_INVALID');

function renderCheckSuites(policy) {
  const definitions = new Map(
    objects(checkSuites.member_definitions, 'DOCS_CHECK_MEMBERS_INVALID').map((member) => [
      member.id,
      member,
    ]),
  );
  const action = keptAction('check');
  return category(
    'Check suites',
    policy.category_id,
    objects(checkSuites.suites, 'DOCS_CHECK_SUITES_INVALID').map((suite) => {
      const members = strings(suite.members, `DOCS_CHECK_SUITE_MEMBERS_INVALID:${suite.name}`);
      const memberDefinitions = members.map((id) => {
        const value = definitions.get(id);
        if (value === undefined)
          throw new Error(`DOCS_CHECK_MEMBER_UNRESOLVED:${suite.name}:${id}`);
        return value;
      });
      const effect = maxEffect(
        memberDefinitions.map((member) => text(member.effect, 'DOCS_CHECK_EFFECT_INVALID')),
      );
      const cost = maxCost(
        memberDefinitions.map(
          (member) => SOURCE_COST[text(member.cost, 'DOCS_CHECK_COST_INVALID')] ?? 'invalid',
        ),
      );
      const tools = unique(
        memberDefinitions.flatMap(
          (member) =>
            member.binding?.argv?.[0] ??
            (member.binding?.kind === 'runtime-gate' ? ['registered-runtime-gate'] : []),
        ),
      );
      return entry(policy.category_id, {
        stable_id: text(suite.name, 'DOCS_CHECK_SUITE_ID_INVALID'),
        user_facing_label: human(suite.name),
        plain_language_purpose: `Run the canonical ${code(suite.name)} acceptance population in declared order without coalescing members.`,
        population_or_projection: `${list(members)}. Excluded: ${list(strings(suite.excluded, 'DOCS_CHECK_EXCLUDED_INVALID'))}.`,
        prerequisites: `${list(strings(checkSuites.prerequisites, 'DOCS_CHECK_PREREQUISITES_INVALID'))}; a repository-bound authority host-process adapter is required for subprocess-bound members.`,
        required_external_tools: `${list(tools, 'Registered runtime gates only; no additional executable is declared by this suite.')}; the live authority host-process adapter for governed subprocess execution.`,
        accepted_inputs: `${code(`--suite ${suite.name}`)}, ${code('--repo-root <path>')}, ${roleInputs(action)}, ${code('--write')}, output-format options, and member-specific inputs only when the selected binding declares them.`,
        defaults:
          suite.name === 'standard'
            ? `${code('standard')} is selected when ${code('--suite')} and ${code('--only')} are omitted.`
            : `${code('standard')} remains the command default; this suite requires explicit selection.`,
        output_contract: `One result per member plus a total aggregate; member shapes are ${list(unique(memberDefinitions.map((member) => member.output)))}.`,
        verdict_semantics: `${code('pass')} requires every required member to pass; unknown members or outcomes are errors and never pass.`,
        declared_effect: `${code(effect)} aggregate ceiling derived from member effects. The action-level ceiling is ${code(action.effect)} and does not grant authority.`,
        consent_flags: consentForEffect(effect),
        cost_class: code(cost),
        when_to_use:
          suite.name === 'release'
            ? 'Use to observe release eligibility before a separately authorized ceremony.'
            : `Use when the ${code(suite.name)} acceptance population matches the required confidence level.`,
        when_not_to_use:
          suite.name === 'release'
            ? 'Do not treat a passing report as publication, release, or deployment authority.'
            : 'Do not use to omit a stricter population required by a round, candidate, or close control.',
        failure_unknown_review_skipped_na_semantics: outcomeSemantics(),
        example: code(
          `devai check --suite ${suite.name} --repo-root . --as-role inspector --write --format json`,
        ),
        canonical_source_link: sourceRefs(policy),
        related_workflow: code('check'),
      });
    }),
  );
}

function presetCost(members) {
  return maxCost(
    members.map((kind) =>
      sensorByKind.get(kind)?.effect === 'remote-write'
        ? 'external-dependent'
        : sensorByKind.get(kind)?.effect === 'read'
          ? 'moderate'
          : 'expensive',
    ),
  );
}

function renderSensePresets(policy) {
  const action = keptAction('sense run');
  return category(
    'Sense presets',
    policy.category_id,
    presets.map((preset) => {
      const members = strings(preset.members, `DOCS_PRESET_MEMBERS_INVALID:${preset.name}`);
      const excluded = strings(preset.excluded, `DOCS_PRESET_EXCLUDED_INVALID:${preset.name}`);
      const memberEntries = members.map((kind) => {
        const sensor = sensorByKind.get(kind);
        if (sensor === undefined)
          throw new Error(`DOCS_PRESET_KIND_UNKNOWN:${preset.name}:${kind}`);
        return sensor;
      });
      const effect = maxEffect(memberEntries.map((sensor) => sensor.effect));
      const exclusions = excluded.map(
        (kind) =>
          `${code(kind)} — ${clause(text(sensePresets.exclusion_reasons[kind], `DOCS_PRESET_EXCLUSION_REASON_MISSING:${kind}`))}`,
      );
      return entry(policy.category_id, {
        stable_id: text(preset.name, 'DOCS_PRESET_ID_INVALID'),
        user_facing_label: human(preset.name),
        plain_language_purpose: `Resolve and observe the canonical ${code(preset.name)} sensor population without implicit reading persistence.`,
        population_or_projection: `${list(members)}. Excluded: ${exclusions.length === 0 ? 'none' : exclusions.join('; ')}.`,
        prerequisites:
          preset.round_required === true
            ? `A repository root and explicit ${code('--round R-NNNN')}.`
            : 'A repository root; each resolved emitter checks its own inputs before execution.',
        required_external_tools:
          'Emitter-specific tools are not enumerated by the preset source; every selected emitter must complete its own preflight.',
        accepted_inputs: `${code(`--preset ${preset.name}`)}, ${code('--repo-root <path>')}, optional sensor-input JSON, ${code('--dry-run')}, ${effect === 'read' ? 'no role declaration for the resolved read-only population' : `${roleInputs(action)} plus required write consent`}, and ${preset.round_required === true ? code('--round R-NNNN') : 'an optional valid round ID'}.`,
        defaults: `No preset is implicit and persistence is forbidden. ${preset.round_required === true ? 'A round is mandatory.' : 'No round is required.'}`,
        output_contract: `${code(sensePresets.output.member_result)} per member and ${code(sensePresets.output.aggregate)} for the complete resolved population.`,
        verdict_semantics: `${code(sensePresets.output.failure)}; aggregate output names both executed and excluded populations.`,
        declared_effect: `${code(effect)} aggregate derived from the resolved members; each member retains its narrower exact effect.`,
        consent_flags: consentForEffect(effect),
        cost_class: code(presetCost(members)),
        when_to_use: `Use to run the complete named ${code(preset.name)} observation population.`,
        when_not_to_use:
          'Do not use as an acceptance suite, as implicit persistence, or to omit a required selected member.',
        failure_unknown_review_skipped_na_semantics: outcomeSemantics(),
        example: code(
          `devai sense run --preset ${preset.name}${preset.round_required === true ? ' --round R-1000' : ''} --repo-root .${effect === 'read' ? '' : ` --as-role owner${dryRunConsentArgs(effect)}`} --dry-run --format json`,
        ),
        canonical_source_link: sourceRefs(policy),
        related_workflow: code('sense'),
      });
    }),
  );
}

function renderNamedPopulation(policy, source, title, actionId, purposeNoun, example) {
  const action = keptAction(actionId);
  return category(
    title,
    policy.category_id,
    objects(source, `DOCS_${policy.category_id}_INVALID`).map((value) =>
      entry(policy.category_id, {
        stable_id: text(value.name, `DOCS_${policy.category_id}_ID_INVALID`),
        user_facing_label: human(value.name),
        plain_language_purpose: `Select the canonical ${code(value.name)} ${purposeNoun}.`,
        population_or_projection: list(
          strings(value.members, `DOCS_${policy.category_id}_MEMBERS_INVALID:${value.name}`),
        ),
        prerequisites:
          'A readable repository root and a canonical descriptor that resolves every selected member.',
        required_external_tools: `Not applicable: no additional external tool is declared by the canonical ${purposeNoun} descriptor.`,
        accepted_inputs:
          purposeNoun === 'adoption tier'
            ? `${code(`--tier ${value.name}`)} and ${code('--target <path>')}.`
            : 'This classification is emitted by the hidden action catalog; it is not selected as a public workflow input.',
        defaults:
          purposeNoun === 'adoption tier'
            ? `Target ${code('.')}; the current declared adoption tier remains authoritative and no climb is inferred.`
            : 'No surface tier is inferred outside the canonical action registry.',
        output_contract: `${action.output_contract.mode} using ${action.output_contract.envelope_schema ?? 'the action-specific result contract'}.`,
        verdict_semantics: `${code('pass')} requires the complete projection; unsupported or unresolved members return an error and never a partial pass.`,
        declared_effect: 'Not applicable: this vocabulary value grants no action effect.',
        consent_flags:
          'Not applicable: consent belongs to the enclosing action, not this vocabulary value.',
        cost_class: code('moderate'),
        when_to_use: `Use when the named ${purposeNoun} is the exact requested scope.`,
        when_not_to_use: `Do not treat it as a check suite, sense preset, or authority grant.`,
        failure_unknown_review_skipped_na_semantics: outcomeSemantics(),
        example: code(example(value.name)),
        canonical_source_link: sourceRefs(policy),
        related_workflow: code(actionId.split(' ')[0]),
      }),
    ),
  );
}

// Architect-owned reference templates for the closed runtime member switch in
// packages/cli/src/commands/sense/inventory.ts. The renderer checks that these keys are an
// exact bijection with the union of canonical slice members before it emits any page bytes.
const INVENTORY_MEMBER_CONTRACTS = Object.freeze({
  'stack-adapter-pack-resolution': {
    purpose: 'Resolve the matching canonical stack-adapter pack.',
    supported_stacks:
      'Stacks represented by canonical pack detect rules; no hard-coded stack alias is inferred.',
    prerequisites: ['readable repository root', 'canonical pack registry and detect rules'],
    tools: [],
    inputs: ['--repo-root <path>', '--adopter-root <path>'],
    defaults: ['repo root .', 'adopter root equals repo root'],
    output: '{matched, ambiguous, candidates, diagnostics} pack-resolution body',
    status: 'review when matched is null or resolution is ambiguous; otherwise pass',
    limitations: 'Does not choose among ambiguous packs or invent support for an unmatched stack.',
  },
  'inventory-adherence': {
    purpose: 'Project reverse adherence from regenerated inventory and the trace registry.',
    supported_stacks:
      'Any repository shape supported by the canonical inventory regeneration and trace contracts.',
    prerequisites: ['readable repository root', 'schema-valid trace registry'],
    tools: [],
    inputs: ['--repo-root <path>', '--trace <path>'],
    defaults: ['repo root .', 'trace law/trace.json'],
    output: 'reverse-adherence body with counts and orphan records',
    status: 'review when orphan count is nonzero; otherwise pass',
    limitations: 'A missing trace file is an execution error; no empty trace is synthesized.',
  },
  'component-inventory': {
    purpose: 'Extract Angular and NestJS decorated components from TypeScript.',
    supported_stacks:
      'Angular Component/Directive/Pipe and Angular or NestJS Injectable/Controller decorators in .ts files.',
    prerequisites: ['readable TypeScript source tree'],
    tools: [],
    inputs: ['--repo-root <path>'],
    defaults: ['repo root .'],
    output: '{count, components} with kind, name, module, and repository-relative path',
    status:
      'pass after deterministic extraction; parser-unreadable files are omitted by the extractor',
    limitations: 'Does not infer undecorated components or non-TypeScript framework conventions.',
  },
  'contract-inventory': {
    purpose: 'Compile and validate discovered JSON Schema contracts.',
    supported_stacks: `JSON Schema 2020-12 files named ${code('*.schema.json')}; OpenAPI regeneration remains outside this member.`,
    prerequisites: ['readable repository root', 'parseable discovered schema files'],
    tools: ['Ajv 2020 and ajv-formats workspace dependencies'],
    inputs: ['--repo-root <path>'],
    defaults: ['repo root .'],
    output: '{ok, checks[]} with file, json_schema kind, per-file ok, and errors',
    status: 'review when any schema check is not ok; otherwise pass',
    limitations: 'Does not perform the deferred OpenAPI byte-regeneration comparison.',
  },
  'inventory-coverage': {
    purpose: 'Normalize Istanbul/Jest/Vitest coverage bytes into one summary.',
    supported_stacks: 'Istanbul-compatible coverage-final.json emitted by Jest or Vitest.',
    prerequisites: [
      'readable repository root; the coverage file may be absent and is reported explicitly',
    ],
    tools: [],
    inputs: ['--repo-root <path>', '--coverage <path>'],
    defaults: ['repo root .', 'coverage coverage/coverage-final.json'],
    output:
      '{source_path, summary, missing}; summary contains statement, branch, function, line, and file counts',
    status: 'review when summary is null, including a missing/non-file path; otherwise pass',
    limitations:
      'Malformed coverage JSON errors; no coverage run is started and statement-only line counts are an approximation.',
  },
  'dependency-graph': {
    purpose: 'Build a deterministic TypeScript import/export dependency graph.',
    supported_stacks:
      'Static .ts import and export declarations; relative/local and external module specifiers.',
    prerequisites: ['readable TypeScript source tree'],
    tools: ['TypeScript parser workspace dependency'],
    inputs: ['--repo-root <path>'],
    defaults: ['repo root .'],
    output: '{nodes, edges, hash} with sorted repository-relative nodes and import edges',
    status:
      'pass after deterministic extraction; parser-unreadable files are omitted by the extractor',
    limitations:
      'Does not resolve dynamic imports, require calls, runtime loaders, or non-TypeScript dependency syntax.',
  },
  'glossary-inventory': {
    purpose: 'Count canonical glossary-term usage across source and Markdown.',
    supported_stacks: `${code('GE-*.json')} glossary records and ${code('.ts')}/${code('.md')} sources under the canonical search roots.`,
    prerequisites: ['readable law/glossary and repository source roots'],
    tools: [],
    inputs: ['--repo-root <path>'],
    defaults: ['repo root .', 'glossary law/glossary', 'search root packages'],
    output: '{entries_count, terms[]} with id, term, used_count, and sorted used_in paths',
    status: 'pass after deterministic projection',
    limitations:
      'Malformed glossary records are skipped here and must be rejected by the separate glossary validator.',
  },
  'module-inventory': {
    purpose: 'Extract Angular and NestJS module declarations from TypeScript.',
    supported_stacks: 'Angular NgModule and NestJS Module class decorators in .ts files.',
    prerequisites: ['readable TypeScript source tree'],
    tools: [],
    inputs: ['--repo-root <path>'],
    defaults: ['repo root .'],
    output: '{count, modules} with stable id, kind, name, and repository-relative path',
    status:
      'pass after deterministic extraction; parser-unreadable files are omitted by the extractor',
    limitations: 'Does not infer undecorated modules or non-TypeScript module conventions.',
  },
  'route-inventory': {
    purpose: 'Extract NestJS controller routes and local guard hints from TypeScript.',
    supported_stacks:
      'NestJS Controller plus Get/Post/Put/Patch/Delete/Options/Head/All decorators in .ts files.',
    prerequisites: ['readable TypeScript source tree'],
    tools: ['TypeScript parser workspace dependency'],
    inputs: ['--repo-root <path>'],
    defaults: ['repo root .'],
    output: '{count, routes} with method, path, module, and optional protected hint',
    status:
      'pass after deterministic extraction; parser-unreadable files are omitted by the extractor',
    limitations:
      'Protection is only a same-method UseGuards/Auth hint; global guards and non-NestJS routers are not inferred.',
  },
  'schema-inventory': {
    purpose: 'Discover file schemas and optionally read PostgreSQL table/view metadata.',
    supported_stacks:
      'JSON Schema, OpenAPI JSON/YAML, and optional PostgreSQL information_schema tables/views.',
    prerequisites: [
      'readable repository root',
      'optional reachable read-only PostgreSQL URL for database projection',
    ],
    tools: ['PostgreSQL only when --database-url is supplied'],
    inputs: ['--repo-root <path>', '--database-url <url>', '--database-schema <name>'],
    defaults: ['repo root .', 'no database introspection', 'no database schema filter'],
    output: '{count, schemas} with kind, name, optional path, and optional db_schema',
    status: 'pass after file discovery and any requested read-only database introspection',
    limitations:
      'Database records are absent by default; a supplied unreachable URL errors instead of falling back to file-only output.',
  },
  'test-inventory': {
    purpose: 'Discover TypeScript tests, classify suites, and extract invariant markers.',
    supported_stacks: `${code('*.test.ts')} and ${code('*.spec.ts')} with unit/api/int/e2e/sec/perf/journey/db filename conventions.`,
    prerequisites: ['readable TypeScript test tree'],
    tools: [],
    inputs: ['--repo-root <path>'],
    defaults: ['repo root .', 'unmatched test filenames classify as unit'],
    output: '{count, tests} with repository-relative path, suite, and sorted invariant ids',
    status: 'pass after deterministic discovery',
    limitations:
      'Does not discover non-TypeScript test conventions or infer a non-unit suite without the filename marker.',
  },
});

function renderInventorySlices(policy) {
  const action = keptAction('sense inventory');
  const slices = objects(
    roundExecution.vocabularies.inventory_slices,
    'DOCS_INVENTORY_SLICES_INVALID',
  );
  const members = unique(
    slices.flatMap((slice) =>
      strings(slice.members, `DOCS_INVENTORY_MEMBERS_INVALID:${slice.name}`),
    ),
  );
  const contractIds = Object.keys(INVENTORY_MEMBER_CONTRACTS);
  if (JSON.stringify([...members].sort()) !== JSON.stringify([...contractIds].sort()))
    throw new Error('DOCS_INVENTORY_MEMBER_CONTRACT_BIJECTION_FAILED');
  return category(
    'Inventory slices',
    policy.category_id,
    slices.map((slice) => {
      const ids = strings(slice.members, `DOCS_INVENTORY_MEMBERS_INVALID:${slice.name}`);
      const contracts = ids.map((id) => INVENTORY_MEMBER_CONTRACTS[id]);
      const prerequisites = unique(contracts.flatMap((contract) => contract.prerequisites));
      const tools = unique(contracts.flatMap((contract) => contract.tools));
      const inputs = unique(contracts.flatMap((contract) => contract.inputs));
      const defaults = unique(contracts.flatMap((contract) => contract.defaults));
      const extra =
        slice.name === 'pack'
          ? ' --adopter-root .'
          : slice.name === 'adherence'
            ? ' --trace law/trace.json'
            : slice.name === 'coverage'
              ? ' --coverage coverage/coverage-final.json'
              : '';
      return entry(policy.category_id, {
        stable_id: slice.name,
        user_facing_label: human(slice.name),
        plain_language_purpose: contracts.map((contract) => contract.purpose).join(' '),
        population_or_projection: `${list(ids)}. Supported stacks: ${contracts.map((contract) => contract.supported_stacks).join(' ')}`,
        prerequisites: prerequisites.join('; '),
        required_external_tools:
          tools.length === 0
            ? 'Not applicable: this slice declares no external tool.'
            : tools.join('; '),
        accepted_inputs: list(inputs),
        defaults: defaults.join('; '),
        output_contract: `Action envelope containing {slice, members, status, results, implicit_persistence:false}; member bodies: ${contracts.map((contract, index) => `${code(ids[index])} ${contract.output}`).join('; ')}.`,
        verdict_semantics: `Only ${code('pass')} and ${code('review')} are emitted in a successful payload; process exit is pass or review respectively. Member rules: ${contracts.map((contract) => contract.status).join('; ')}. Exceptions exit fail.`,
        declared_effect:
          'Not applicable to the vocabulary value; the enclosing canonical inventory action is read-only.',
        consent_flags:
          'No role, write, or publish consent is accepted or required by the read-only inventory action.',
        cost_class: code('moderate'),
        when_to_use: `Use for the exact deterministic ${code(slice.name)} repository projection.`,
        when_not_to_use: contracts.map((contract) => contract.limitations).join(' '),
        failure_unknown_review_skipped_na_semantics: `${code('review')} is explicit and exits non-pass; implementation exceptions are ${code('fail')}. ${code('unknown')}, ${code('skipped')}, and ${code('N/A')} are not emitted by the current inventory payload.`,
        example: code(
          `devai sense inventory --slice ${slice.name} --repo-root .${extra} --format json`,
        ),
        canonical_source_link: sourceRefs(policy),
        related_workflow: code('sense'),
      });
    }),
  );
}

function schemaEnums() {
  const properties = actionSchema.properties.entries.items.properties;
  return {
    roles:
      actionSchema.$defs.authorityContract.properties.subject.oneOf[1].properties.allowed_roles
        .items.enum,
    effects: properties.effect.enum,
  };
}

const SIMPLE = Object.freeze({
  verdicts: {
    title: 'Verdicts',
    source: roundExecution.vocabularies.verdicts,
    workflow: 'check',
    purpose: (id) =>
      `Represent the explicit ${code(id)} aggregate outcome without coercing it to pass.`,
  },
  'action-lifecycles': {
    title: 'Action lifecycles',
    source: roundExecution.vocabularies.action_lifecycles,
    workflow: 'catalog',
    purpose: (id) => `Describe an action whose canonical lifecycle is ${code(id)}.`,
  },
  effects: {
    title: 'Effects',
    source: schemaEnums().effects,
    workflow: 'check',
    purpose: (id) =>
      `Declare the conservative ${code(id)} capability ceiling before authority and consent checks.`,
  },
});

function renderRoles(policy) {
  return category(
    'Roles',
    policy.category_id,
    strings(schemaEnums().roles, 'DOCS_ROLES_INVALID').map((id) => {
      const applicable = actions.filter((action) => allowedRoles(action).includes(id));
      if (applicable.length === 0) throw new Error(`DOCS_ROLE_AUTHORITY_UNRESOLVED:${id}`);
      const actionIds = applicable.map((action) => action.action_id);
      const effects = unique(applicable.map((action) => action.effect));
      return entry(policy.category_id, {
        stable_id: id,
        user_facing_label: human(id),
        plain_language_purpose: `Identify the human ${code(id)} discipline; only matching action authority contracts permit an invocation.`,
        population_or_projection: `${String(applicable.length)} matching action contracts; effects ${list(effects)}; actions ${list(actionIds)}.`,
        prerequisites: `An invocation-scoped ${code(`--as-role ${id}`)} declaration or live repository-bound authority session, plus a matching action contract.`,
        required_external_tools:
          'Not applicable: a role is a governance discipline, not an executor or adapter.',
        accepted_inputs: `${code(`--as-role ${id}`)} only on a non-read action whose canonical authority contract allowlists this role.`,
        defaults:
          'No role is inferred from executor kind, model capability, environment, or prior invocation.',
        output_contract:
          'The resolved authority evidence preserves the initiating human role and exact action contract.',
        verdict_semantics:
          'A missing declaration, disallowed role, selector mismatch, or stale session refuses before effects.',
        declared_effect: 'Not applicable: role discipline grants no effect by itself.',
        consent_flags:
          'Not applicable: explicit effect-specific consent remains independently required.',
        cost_class: code('fast'),
        when_to_use: `Use ${code(id)} only when operating within that discipline's canonical path and action authority.`,
        when_not_to_use:
          'Do not use a role declaration to widen executor, model, mutation, publication, or path authority.',
        failure_unknown_review_skipped_na_semantics: outcomeSemantics(),
        example: code(
          `devai round run --round R-1000 --repo-root . --as-role ${id} --write --format json`,
        ),
        canonical_source_link: sourceRefs(policy),
        related_workflow: code('round'),
      });
    }),
  );
}

function renderSimple(policy) {
  const descriptor = SIMPLE[policy.category_id];
  if (descriptor === undefined)
    throw new Error(`DOCS_SIMPLE_CATEGORY_UNKNOWN:${policy.category_id}`);
  return category(
    descriptor.title,
    policy.category_id,
    strings(descriptor.source, `DOCS_${policy.category_id}_INVALID`).map((id) => {
      const effect = policy.category_id === 'effects' ? id : null;
      return entry(policy.category_id, {
        stable_id: id,
        user_facing_label: human(id),
        plain_language_purpose: descriptor.purpose(id),
        population_or_projection: `The single canonical ${policy.category_id} value ${code(id)} and all records that select it.`,
        prerequisites: 'A schema-valid canonical record selecting this exact value.',
        required_external_tools:
          'Not applicable: this is a vocabulary value, not an executable adapter.',
        accepted_inputs:
          'Accepted only where the linked canonical schema or policy exposes this exact value.',
        defaults: 'No undocumented value or alias is inferred.',
        output_contract:
          'Appears in the enclosing action, reading, catalog, or execution-evidence schema.',
        verdict_semantics:
          policy.category_id === 'verdicts'
            ? `${code(id)} retains its literal aggregate meaning and is never silently coerced to pass.`
            : 'Not applicable: this value classifies a record; the enclosing operation owns verdict semantics.',
        declared_effect:
          effect === null
            ? 'Not applicable: this vocabulary value grants no action effect.'
            : code(effect),
        consent_flags:
          effect === null
            ? 'Not applicable: consent belongs to the enclosing resolved action.'
            : consentForEffect(effect),
        cost_class: code('fast'),
        when_to_use: `Use only when ${code(id)} exactly describes the canonical record.`,
        when_not_to_use:
          'Do not use as a synonym for another canonical value or as an authority grant.',
        failure_unknown_review_skipped_na_semantics: outcomeSemantics(),
        example: code(
          descriptor.workflow === 'catalog'
            ? 'devai catalog actions --format json'
            : 'devai check --suite standard --repo-root . --as-role inspector --write --format json',
        ),
        canonical_source_link: sourceRefs(policy),
        related_workflow: code(descriptor.workflow),
      });
    }),
  );
}

function executorKinds() {
  return objects(taskSchema.properties.executor.oneOf, 'DOCS_EXECUTOR_SCHEMA_INVALID').map(
    (branch) => branch.properties.kind.const,
  );
}

function renderExecutorKinds(policy) {
  return category(
    'Executor kinds',
    policy.category_id,
    executorKinds().map((id) =>
      entry(policy.category_id, {
        stable_id: id,
        user_facing_label: human(id),
        plain_language_purpose: `${code(id)} is one closed requested-executor branch; discipline, not executor kind, grants authority.`,
        population_or_projection: `All schema fields in ${code(`#/$defs/${id}Executor`)} plus the exact ${code(id)} discriminator.`,
        prerequisites:
          'One active owning round and one schema-valid immutable requested executor contract.',
        required_external_tools:
          id === 'routine'
            ? 'Only the registered action or literal shell-free argv tools.'
            : id === 'agent'
              ? 'A rostered runtime adapter and provider/host preflight.'
              : 'Not applicable unless the executor record declares a tool through a child or completion procedure.',
        accepted_inputs: `The exact ${code(id)} task-schema branch; fields from other executor branches are rejected. Dispatch uses ${code('--as-role <allowed-role>')} or a live authority session plus ${code('--write')}.`,
        defaults: 'No executor kind is inferred when the task omits its executor contract.',
        output_contract:
          'Requested executor remains immutable; resolution and completion are recorded separately in task-execution evidence.',
        verdict_semantics:
          'Incomplete, mismatched, cyclic, cross-round, timed-out, or unevidenced execution blocks completion.',
        declared_effect:
          'Derived from the requested work and its registered actions; executor kind grants no effect.',
        consent_flags:
          'Derived from the resolved action effects; executor kind supplies no consent.',
        cost_class: code(
          id === 'agent' ? 'external-dependent' : id === 'composite' ? 'expensive' : 'moderate',
        ),
        when_to_use: `Use ${code(id)} only when its closed execution contract matches the task.`,
        when_not_to_use:
          'Do not use it to bypass round containment, role authority, or evidence requirements.',
        failure_unknown_review_skipped_na_semantics: outcomeSemantics(),
        example: code(
          'devai round run --round R-1000 --repo-root . --as-role owner --write --format json',
        ),
        canonical_source_link: sourceRefs(policy),
        related_workflow: code('round'),
      }),
    ),
  );
}

function selectionModes() {
  return [
    text(taskSchema.$defs.agentSelection.properties.mode.const, 'DOCS_SELECTION_MODES_INVALID'),
  ];
}

function renderSelectionModes(policy) {
  return category(
    'Agent selection modes',
    policy.category_id,
    selectionModes().map((id) =>
      entry(policy.category_id, {
        stable_id: id,
        user_facing_label: human(id),
        plain_language_purpose:
          'Require one runtime bridge and exact host model with no substitution.',
        population_or_projection: 'One registry_id plus one exact host model identity.',
        prerequisites:
          'A schema-valid agent executor, a declared runtime bridge, an exact host model, and a successful host preflight.',
        required_external_tools:
          'The adapter declared by the selected runtime entry and its provider or host preflight.',
        accepted_inputs: `Only the fields admitted by the ${code(id)} agentSelection contract.`,
        defaults: 'No model, runtime, effort, provider alias, or substitution is inferred.',
        output_contract:
          'Resolved executor identity is recorded separately from the immutable requested executor.',
        verdict_semantics:
          'The first unresolved, unavailable, capability, effort, adapter, or exact-identity mismatch blocks before provider invocation.',
        declared_effect:
          'Not applicable: a selection mode grants no action effect; the resolved task work declares effects separately.',
        consent_flags:
          'Not applicable: selection mode grants no consent; the resolved task actions enforce their own consent.',
        cost_class: code('external-dependent'),
        when_to_use: `Use ${code(id)} when one exact runtime and model identity are intended.`,
        when_not_to_use:
          'Do not use it to infer authority, aliases, defaults, or model substitution.',
        failure_unknown_review_skipped_na_semantics: outcomeSemantics(),
        example: code('devai doctor --probe llm --repo-root .'),
        canonical_source_link: sourceRefs(policy),
        related_workflow: code('round'),
      }),
    ),
  );
}

function sensorPresetMembership(kind) {
  return presets.filter((preset) => preset.members.includes(kind)).map((preset) => preset.name);
}

function renderSensorKinds(policy) {
  const action = keptAction('sense run');
  return category(
    'Sensor kinds',
    policy.category_id,
    sensors.map((sensor) => {
      const effect = text(sensor.effect, `DOCS_SENSOR_EFFECT_INVALID:${sensor.kind}`);
      const cells = objects(sensor.cells ?? [], `DOCS_SENSOR_CELLS_INVALID:${sensor.kind}`).map(
        (cell) => `${cell.substrate}×${cell.property}`,
      );
      const capabilities = strings(
        sensor.effect_basis?.capabilities ?? [],
        `DOCS_SENSOR_CAPABILITIES_INVALID:${sensor.kind}`,
      );
      const sourcePaths = strings(
        sensor.effect_basis?.source_paths ?? [],
        `DOCS_SENSOR_EFFECT_PATHS_INVALID:${sensor.kind}`,
      );
      return entry(policy.category_id, {
        stable_id: text(sensor.kind, 'DOCS_SENSOR_KIND_INVALID'),
        user_facing_label: text(sensor.title, `DOCS_SENSOR_TITLE_INVALID:${sensor.kind}`),
        plain_language_purpose: `Run the registered ${code(sensor.kind)} observation through ${code(sensor.emitter_module)} and emit its canonical reading.`,
        population_or_projection: `Emitter ${code(sensor.emitter_module)}; standing ${sensor.diagnostic === true ? 'diagnostic-only' : `scorecard cells ${list(cells)}`}; preset membership ${list(sensorPresetMembership(sensor.kind))}; registry tiers ${list(strings(sensor.tiers, `DOCS_SENSOR_TIERS_INVALID:${sensor.kind}`))}.`,
        prerequisites: `${sourcePaths.length === 0 ? 'The registered emitter and a readable repository root.' : `Reviewed effect sources ${list(sourcePaths)}.`} ${capabilities.length === 0 ? 'No additional capability is declared by the registry.' : `Capabilities ${list(capabilities)}.`}`,
        required_external_tools:
          capabilities.length === 0
            ? 'Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.'
            : `Tools or services satisfying ${list(capabilities)}; exact availability is checked before execution.`,
        accepted_inputs: `${code(`sense run ${sensor.kind}`)}, ${code('--repo-root <path>')}, optional sensor-specific JSON through ${code('--input')}, ${code('--dry-run')}, and ${effect === 'read' ? 'no role declaration for the resolved read-only kind' : `${roleInputs(action)} plus the declared consent flags`}.`,
        defaults: `Repository root ${code('.')}; no implicit persistence, preset, round, or sensor-specific input.`,
        output_contract: `A schema-valid ${link('law/schemas/sensor-reading.schema.json')} plus action-bound aggregate output when invoked in a preset.`,
        verdict_semantics: `${code('pass')} is an observation from this sensor, not a release claim; all non-pass states remain explicit.`,
        declared_effect: `${code(effect)}${sensor.effect_basis?.rationale ? ` — ${sensor.effect_basis.rationale}` : ''}`,
        consent_flags: consentForEffect(effect),
        cost_class: code(
          effect === 'remote-write'
            ? 'external-dependent'
            : effect === 'read'
              ? 'moderate'
              : 'expensive',
        ),
        when_to_use: `Use when the ${code(sensor.kind)} observation and its declared standing are required.`,
        when_not_to_use: `Do not use as a substitute for an acceptance suite, a different kind, or authority beyond ${code(effect)}.`,
        failure_unknown_review_skipped_na_semantics: outcomeSemantics(),
        example: code(
          `devai sense run ${sensor.kind} --repo-root .${effect === 'read' ? '' : ` --as-role owner${dryRunConsentArgs(effect)}`} --dry-run --format json`,
        ),
        canonical_source_link: `${sourceRefs(policy)}; ${link(sensor.design_note.path)}`,
        related_workflow: code('sense'),
      });
    }),
  );
}

function sortedUtf8(values) {
  return [...values].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function renderRuntimes(policy) {
  const runtimes = sortedUtf8(
    objects(modelRuntime.runtimes, 'DOCS_RUNTIMES_INVALID').map((value) => value.id),
  ).map((id) => modelRuntime.runtimes.find((value) => value.id === id));
  return category(
    'Runtimes',
    policy.category_id,
    runtimes.map((runtime) =>
      entry(policy.category_id, {
        stable_id: runtime.id,
        user_facing_label: `${runtime.vendor} ${human(runtime.transport)} runtime`,
        plain_language_purpose: `Connect an agent request through the declared ${code(runtime.adapter_id)} adapter.`,
        population_or_projection: `Vendor ${code(runtime.vendor)}; family ${code(runtime.family)}; transport ${code(runtime.transport)}; adapter ${code(runtime.adapter_id)} at ${code(runtime.adapter_module)}; capabilities ${list(runtime.capabilities)}.`,
        prerequisites: `${runtime.availability_basis}; host preflight is mandatory.`,
        required_external_tools:
          runtime.transport === 'host-cli'
            ? `${code(runtime.executable)} plus ${code(runtime.credential_binding)}.`
            : `${code(runtime.credential_binding)} and provider reachability.`,
        accepted_inputs: `A task agent executor selecting ${code(runtime.id)}, an exact host model identity, and one supported effort.`,
        defaults: 'No adapter, credential, provider alias, or fallback is inferred.',
        output_contract: `Resolved runtime/model/effort, adapter/tool versions, selection decision, prompt and I/O digests, usage/cost, timestamps, verdict, and evidence references.`,
        verdict_semantics:
          'Unavailable adapter, missing credential/login, unreachable provider, identity mismatch, or unsupported capability blocks before invocation.',
        declared_effect:
          'Not applicable: runtime capability and transport grant no action effect or governance authority.',
        consent_flags:
          'Not applicable: consent is resolved from the task work and its action effects, not from runtime availability.',
        cost_class: code('external-dependent'),
        when_to_use: `Use when the host selects ${code(runtime.id)} and supplies an exact model identity.`,
        when_not_to_use:
          'Do not treat registry availability as proof of host reachability or as governance authority.',
        failure_unknown_review_skipped_na_semantics: outcomeSemantics(),
        example: code('devai doctor --probe llm --repo-root .'),
        canonical_source_link: sourceRefs(policy),
        related_workflow: code('round'),
      }),
    ),
  );
}

function renderEfforts(policy) {
  const runtimes = objects(modelRuntime.runtimes, 'DOCS_RUNTIMES_INVALID');
  const efforts = sortedUtf8(
    unique(
      runtimes.flatMap((runtime) =>
        strings(runtime.efforts, `DOCS_RUNTIME_EFFORTS_INVALID:${runtime.id}`),
      ),
    ),
  );
  return category(
    'Supported efforts',
    policy.category_id,
    efforts.map((id) => {
      const supportedBy = runtimes
        .filter((runtime) => runtime.efforts.includes(id))
        .map((runtime) => runtime.id);
      return entry(policy.category_id, {
        stable_id: id,
        user_facing_label: human(id),
        plain_language_purpose: `Request the exact rostered ${code(id)} effort without inventing provider semantics.`,
        population_or_projection: `Supported by ${list(sortedUtf8(supportedBy))}.`,
        prerequisites:
          'One runtime bridge that explicitly lists this effort, an exact host model identity, and a successful preflight.',
        required_external_tools: 'The selected model runtime adapter and provider or host session.',
        accepted_inputs: `An agent executor selecting ${code(id)} with one of the listed runtime bridges and an exact host model.`,
        defaults:
          'No effort is inferred across runtimes; the selected runtime must declare the requested effort.',
        output_contract:
          'Requested effort remains in the immutable executor digest and resolved effort appears in task-execution evidence.',
        verdict_semantics:
          'An effort/model mismatch blocks before invocation and never falls back implicitly.',
        declared_effect:
          'Not applicable: effort selection grants no action effect or governance authority.',
        consent_flags:
          'Not applicable: consent is resolved from the task work and its action effects, not from effort selection.',
        cost_class: code('external-dependent'),
        when_to_use: `Use ${code(id)} only with a runtime listed in this generated projection.`,
        when_not_to_use: 'Do not assume every runtime or host model supports this effort.',
        failure_unknown_review_skipped_na_semantics: outcomeSemantics(),
        example: code('devai doctor --probe llm --repo-root .'),
        canonical_source_link: sourceRefs(policy),
        related_workflow: code('round'),
      });
    }),
  );
}

const CATEGORY_RENDERERS = Object.freeze({
  'check-suites': renderCheckSuites,
  'sense-presets': renderSensePresets,
  'inventory-slices': renderInventorySlices,
  'adoption-tiers': (policy) =>
    renderNamedPopulation(
      policy,
      roundExecution.vocabularies.adoption_tiers,
      'Adoption tiers',
      'init plan',
      'adoption tier',
      (id) => `devai init plan --tier ${id} --target . --format json`,
    ),
  'executor-kinds': renderExecutorKinds,
  'agent-selection-modes': renderSelectionModes,
  roles: renderRoles,
  effects: renderSimple,
  verdicts: renderSimple,
  'action-lifecycles': renderSimple,
  'surface-tiers': (policy) =>
    renderNamedPopulation(
      policy,
      roundExecution.vocabularies.surface_tiers,
      'Surface tiers',
      'catalog actions',
      'surface tier',
      () => 'devai catalog actions --format json',
    ),
  'sensor-kinds': renderSensorKinds,
  runtimes: renderRuntimes,
  'supported-efforts': renderEfforts,
});

const categories = objects(architecture.categories, 'DOCS_CATEGORIES_INVALID');
const pages = new Map(
  objects(architecture.pages, 'DOCS_PAGES_INVALID').map((page) => [
    page.page_id,
    page.planned_path,
  ]),
);
const routes = categories.map((policy) => {
  const render = CATEGORY_RENDERERS[policy.category_id];
  const page = pages.get(policy.page_id);
  if (render === undefined || typeof page !== 'string')
    throw new Error(`DOCS_CATEGORY_ROUTE_UNRESOLVED:${policy.category_id}`);
  return { id: policy.category_id, page, rendered: render(policy) };
});
const selected =
  REQUESTED.length === 0 ? routes : routes.filter((route) => REQUESTED.includes(route.id));
for (const requested of REQUESTED)
  if (!routes.some((route) => route.id === requested))
    throw new Error(`DOCS_CATEGORY_UNKNOWN:${requested}`);

function marker(id, side) {
  return `<!-- devai:generated-reference:${side} category="${id}" -->`;
}

async function formattedRegion(start, rendered, end) {
  const formatted = await prettierFormat(`${start}\n${rendered}\n${end}\n`, {
    ...PRETTIER_CONFIG,
    parser: 'markdown',
  });
  return formatted.trimEnd();
}

const touched = [];
for (const route of selected) {
  const path = text(route.page, `DOCS_PAGE_ROUTE_INVALID:${route.id}`);
  const start = marker(route.id, 'start');
  const end = marker(route.id, 'end');
  const source = read(path);
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end);
  if (
    startIndex < 0 ||
    endIndex < startIndex ||
    source.indexOf(start, startIndex + 1) >= 0 ||
    source.indexOf(end, endIndex + 1) >= 0
  ) {
    throw new Error(`DOCS_GENERATED_MARKERS_INVALID:${route.id}:${path}`);
  }
  const expected = await formattedRegion(start, route.rendered, end);
  const actual = source.slice(startIndex, endIndex + end.length);
  if (actual !== expected) {
    if (MODE === 'check') throw new Error(`DOCS_GENERATED_BYTES_DRIFT:${route.id}:${path}`);
    const next = `${source.slice(0, startIndex)}${expected}${source.slice(endIndex + end.length)}`;
    writeFileSync(join(ROOT, path), next, 'utf8');
    touched.push(path);
  }
}

process.stdout.write(
  `${JSON.stringify({ mode: MODE, categories: selected.map((route) => route.id), changed: touched })}\n`,
);
