import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Blueprint } from '@devai-nyx/spec';
import type { StackAdapterPack } from '../../pack-resolver/index.js';
import type { OperationHostRequest, OperationResult } from '../types.js';
import { runScaffolder, type ScaffolderSpec, type ScaffolderTargetTask } from './runner.js';

const TEMPLATE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../resources/operations/scaffold',
);

const TEMPLATE_PATHS = {
  'db.migration': 'templates/db/migration.sql.tpl',
  'db.seed': 'templates/db/seed.sql.tpl',
  'api.module': 'templates/api/__kebabModule__.module.ts.tpl',
  'api.controller': 'templates/api/controllers/__kebabEntity__.controller.ts.tpl',
  'api.service': 'templates/api/services/__kebabEntity__.service.ts.tpl',
  'api.dto.create': 'templates/api/dto/create-__kebabEntity__.dto.ts.tpl',
  'api.dto.update': 'templates/api/dto/update-__kebabEntity__.dto.ts.tpl',
  'api.entity': 'templates/api/entities/__kebabEntity__.entity.ts.tpl',
  'api.guard.policy': 'templates/api/guards/policy.guard.ts.tpl',
  'api.decorator.policy': 'templates/api/decorators/policy.decorator.ts.tpl',
  'ui.module': 'templates/ui/__kebabModule__.module.ts.tpl',
  'ui.list-component': 'templates/ui/__kebabEntity__-list.component.ts.tpl',
  'ui.detail-component': 'templates/ui/__kebabEntity__-detail.component.ts.tpl',
  'ui.service': 'templates/ui/__kebabEntity__.service.ts.tpl',
  'tests.controller-spec': 'templates/tests/__kebabEntity__.controller.spec.ts.tpl',
  'tests.service-spec': 'templates/tests/__kebabEntity__.service.spec.ts.tpl',
  'docs.readme': 'templates/docs/README.md.tpl',
  'docs.adr': 'templates/docs/ADR-0001.md.tpl',
  'ci.workflow': 'templates/ci/module-workflow.yml.tpl',
} as const;

const CANONICAL_PACK = Object.freeze({
  schemaVersion: '1.0.0',
  id: 'devai-canonical-typescript',
  name: 'DEVAI canonical TypeScript scaffold templates',
  version: '1.0.0',
  stack: { backend: 'typescript', frontend: 'typescript', db: 'postgres' },
  detect: { signals: [] },
  _packDir: TEMPLATE_ROOT,
  templates: Object.fromEntries(
    Object.entries(TEMPLATE_PATHS).map(([id, path]) => [id, { path, consumed_by: id }]),
  ),
}) as unknown as StackAdapterPack;

function kebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replace(/[_\s]+/gu, '-')
    .toLowerCase();
}

function fieldTokens(entity: Blueprint['database']['entities'][number]): Record<string, string> {
  const fields = entity.fields.filter((field) => field.name !== 'id');
  const ts = (value: string): string =>
    /int|numeric|decimal|real|double/iu.test(value)
      ? 'number'
      : /bool/iu.test(value)
        ? 'boolean'
        : /json/iu.test(value)
          ? 'Record<string, unknown>'
          : 'string';
  const entityFields = fields
    .map(
      (field) =>
        `  ${field.name}${field.nullable === true ? '?' : '!'}: ${ts(field.type)}${field.nullable === true ? ' | null' : ''};`,
    )
    .join('\n');
  const dto = (optional: boolean): string =>
    fields
      .map((field) => {
        const isOptional = optional || field.nullable === true;
        return `${isOptional ? '  @IsOptional()\n' : ''}  ${field.name}${isOptional ? '?' : '!'}: ${ts(field.type)}${field.nullable === true ? ' | null' : ''};`;
      })
      .join('\n\n');
  return {
    __ENTITY_TS_FIELDS__: entityFields,
    __DTO_FIELDS_CREATE__: dto(false),
    __DTO_FIELDS_UPDATE__: dto(true),
  };
}

function entityTasks(
  blueprint: Blueprint,
  moduleSlug: string,
  make: (
    entity: Blueprint['database']['entities'][number],
    name: string,
  ) => readonly ScaffolderTargetTask[],
): ScaffolderTargetTask[] {
  return blueprint.database.entities.flatMap((entity) => make(entity, kebab(entity.name)));
}

const SPECS: Readonly<Record<string, ScaffolderSpec>> = Object.freeze({
  'scaffold.db': {
    operationId: 'scaffold.db',
    templateIds: ['db.migration', 'db.seed'],
    deriveTasks: (_blueprint, _pack, slug) => [
      { template_id: 'db.migration', target_path: `domain/${slug}/db/migration.sql` },
      { template_id: 'db.seed', target_path: `domain/${slug}/db/seed.sql` },
    ],
  },
  'scaffold.api': {
    operationId: 'scaffold.api',
    templateIds: [
      'api.module',
      'api.controller',
      'api.service',
      'api.dto.create',
      'api.dto.update',
      'api.entity',
      'api.guard.policy',
      'api.decorator.policy',
    ],
    deriveTasks: (blueprint, _pack, slug) => [
      {
        template_id: 'api.module',
        target_path: `domain/${slug}/api/src/${slug}/${slug}.module.ts`,
      },
      {
        template_id: 'api.guard.policy',
        target_path: `domain/${slug}/api/src/${slug}/guards/policy.guard.ts`,
      },
      {
        template_id: 'api.decorator.policy',
        target_path: `domain/${slug}/api/src/${slug}/decorators/policy.decorator.ts`,
      },
      ...entityTasks(blueprint, slug, (entity, name) => {
        const extra_tokens = fieldTokens(entity);
        return [
          {
            template_id: 'api.controller',
            target_path: `domain/${slug}/api/src/${slug}/controllers/${name}.controller.ts`,
          },
          {
            template_id: 'api.service',
            target_path: `domain/${slug}/api/src/${slug}/services/${name}.service.ts`,
          },
          {
            template_id: 'api.entity',
            target_path: `domain/${slug}/api/src/${slug}/entities/${name}.entity.ts`,
            extra_tokens,
          },
          {
            template_id: 'api.dto.create',
            target_path: `domain/${slug}/api/src/${slug}/dto/create-${name}.dto.ts`,
            extra_tokens,
          },
          {
            template_id: 'api.dto.update',
            target_path: `domain/${slug}/api/src/${slug}/dto/update-${name}.dto.ts`,
            extra_tokens,
          },
        ];
      }),
    ],
  },
  'scaffold.ui': {
    operationId: 'scaffold.ui',
    templateIds: ['ui.module', 'ui.list-component', 'ui.detail-component', 'ui.service'],
    deriveTasks: (blueprint, _pack, slug) => [
      {
        template_id: 'ui.module',
        target_path: `domain/${slug}/web/src/app/${slug}/${slug}.module.ts`,
      },
      ...entityTasks(blueprint, slug, (_entity, name) => [
        {
          template_id: 'ui.list-component',
          target_path: `domain/${slug}/web/src/app/${slug}/${name}-list.component.ts`,
        },
        {
          template_id: 'ui.detail-component',
          target_path: `domain/${slug}/web/src/app/${slug}/${name}-detail.component.ts`,
        },
        {
          template_id: 'ui.service',
          target_path: `domain/${slug}/web/src/app/${slug}/${name}.service.ts`,
        },
      ]),
    ],
  },
  'scaffold.tests': {
    operationId: 'scaffold.tests',
    templateIds: ['tests.controller-spec', 'tests.service-spec'],
    deriveTasks: (blueprint, _pack, slug) =>
      entityTasks(blueprint, slug, (_entity, name) => [
        {
          template_id: 'tests.controller-spec',
          target_path: `domain/${slug}/api/test/${name}.controller.spec.ts`,
        },
        {
          template_id: 'tests.service-spec',
          target_path: `domain/${slug}/api/test/${name}.service.spec.ts`,
        },
      ]),
  },
  'scaffold.docs': {
    operationId: 'scaffold.docs',
    templateIds: ['docs.readme', 'docs.adr'],
    deriveTasks: (_blueprint, _pack, slug) => [
      { template_id: 'docs.readme', target_path: `domain/${slug}/docs/README.md` },
      { template_id: 'docs.adr', target_path: `domain/${slug}/docs/ADR-0001.md` },
    ],
  },
  'scaffold.ci': {
    operationId: 'scaffold.ci',
    templateIds: ['ci.workflow'],
    deriveTasks: (_blueprint, _pack, slug) => [
      { template_id: 'ci.workflow', target_path: `.github/workflows/module-${slug}.yml` },
    ],
  },
});

export function executeScaffoldOperation(request: OperationHostRequest): OperationResult {
  const spec = SPECS[request.operation];
  if (spec === undefined) throw new Error(`SCAFFOLD_OPERATION_UNKNOWN:${request.operation}`);
  const result = runScaffolder({
    spec,
    ctx: {
      repoRoot: request.repo_root,
      inputs: { ...(request.inputs ?? {}) },
      canonicalPack: CANONICAL_PACK,
      allowedPaths: request.write_paths,
    },
  });
  return {
    operation: request.operation,
    status: result.status,
    evidence: result.evidence ?? { notes: result.notes ?? [] },
  };
}
