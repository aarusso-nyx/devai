import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationHost, runOperation } from '../../src/operations/index.js';
import { withAuthorityHostTestScope } from '../unit/authority-host-test-scope.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const prefix = 'domain/demo-bookmark';
const api = `${prefix}/api/src/demo-bookmark`;
const ui = `${prefix}/web/src/app/demo-bookmark`;
const names = ['bookmark', 'audit-event'];
const cases = [
  {
    variant: 'api',
    operation: 'scaffold.api',
    paths: [
      `${api}/demo-bookmark.module.ts`,
      `${api}/guards/policy.guard.ts`,
      `${api}/decorators/policy.decorator.ts`,
      ...names.flatMap((n) => [
        `${api}/controllers/${n}.controller.ts`,
        `${api}/services/${n}.service.ts`,
        `${api}/entities/${n}.entity.ts`,
        `${api}/dto/create-${n}.dto.ts`,
        `${api}/dto/update-${n}.dto.ts`,
      ]),
    ],
    selected: `${api}/controllers/audit-event.controller.ts`,
    expected: 'export class AuditEventController',
  },
  {
    variant: 'ui',
    operation: 'scaffold.ui',
    paths: [
      `${ui}/demo-bookmark.module.ts`,
      ...names.flatMap((n) => [
        `${ui}/${n}-list.component.ts`,
        `${ui}/${n}-detail.component.ts`,
        `${ui}/${n}.service.ts`,
      ]),
    ],
    selected: `${ui}/audit-event-list.component.ts`,
    expected: 'export class AuditEventListComponent',
  },
  {
    variant: 'tests',
    operation: 'scaffold.tests',
    paths: names.flatMap((n) => [
      `${prefix}/api/test/${n}.controller.spec.ts`,
      `${prefix}/api/test/${n}.service.spec.ts`,
    ]),
    selected: `${prefix}/api/test/audit-event.controller.spec.ts`,
    expected: "describe('AuditEventController'",
  },
] as const;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai entity scaffold ç '));
  roots.push(root);
  const blueprint = JSON.parse(
    readFileSync(new URL('./fixtures/blueprint.json', import.meta.url), 'utf8'),
  );
  blueprint.database.entities.push({
    name: 'AuditEvent',
    primaryKey: ['id'],
    fields: [
      { name: 'id', type: 'uuid' },
      { name: 'count', type: 'int' },
      { name: 'active', type: 'bool' },
      { name: 'payload', type: 'jsonb' },
      { name: 'label', type: 'text', nullable: true },
    ],
  });
  blueprint.api.resources.push({ entity: 'AuditEvent', operations: ['list', 'get', 'create'] });
  writeFileSync(join(root, 'blueprint.json'), JSON.stringify(blueprint));
  return root;
}
describe('scaffold entity bindings', () => {
  it.each(cases)('renders each entity identity in $variant outputs', async (value) => {
    const root = fixture();
    const command = vi.fn(() => {
      throw new Error('scaffold must render without a command');
    });
    const request = {
      recipe: 'devai-scaffold' as const,
      variant: value.variant,
      operation: value.operation,
      repo_root: root,
      write_paths: [...value.paths],
      inputs: { blueprint_path: 'blueprint.json' },
    };
    const execute = () =>
      withAuthorityHostTestScope(() =>
        runOperation(request, createOperationHost({ run: command })),
      );
    const result = await execute();
    expect(result.status, JSON.stringify(result)).toBe('pass');
    expect(result.evidence).toMatchObject({
      operation_id: value.operation,
      files_created: [...value.paths],
      files_modified: [],
      idempotency: 'fresh',
    });
    const bytes = new Map(value.paths.map((p) => [p, readFileSync(join(root, p))]));
    expect(readFileSync(join(root, value.selected), 'utf8')).toContain(value.expected);
    if (value.variant === 'api') {
      const module = readFileSync(join(root, `${api}/demo-bookmark.module.ts`), 'utf8');
      for (const [entityName, fileName] of [
        ['Bookmark', 'bookmark'],
        ['AuditEvent', 'audit-event'],
      ]) {
        expect(module).toContain(
          `import { ${entityName}Controller } from './controllers/${fileName}.controller';`,
        );
        expect(module).toContain(
          `import { ${entityName}Service } from './services/${fileName}.service';`,
        );
      }
      expect(module).toContain('controllers: [BookmarkController, AuditEventController]');
      expect(module).toContain(
        'providers: [BookmarkService, AuditEventService, BookmarkPolicyGuard]',
      );
      expect(module).toContain('exports: [BookmarkService, AuditEventService]');
      const entity = readFileSync(join(root, `${api}/entities/audit-event.entity.ts`), 'utf8');
      expect(entity).toContain('export class AuditEvent');
      for (const field of [
        'count!: number;',
        'active!: boolean;',
        'payload!: Record<string, unknown>;',
        'label?: string | null;',
      ])
        expect(entity).toContain(field);
      const create = readFileSync(join(root, `${api}/dto/create-audit-event.dto.ts`), 'utf8');
      const update = readFileSync(join(root, `${api}/dto/update-audit-event.dto.ts`), 'utf8');
      expect(create).toContain('class CreateAuditEventDto');
      expect(create).toContain('count!: number;');
      expect(update).toContain('class UpdateAuditEventDto');
      expect(update).toContain('extends PartialType(CreateAuditEventDto)');
      expect(update).toContain("from './create-audit-event.dto'");
    }
    if (value.variant === 'ui') {
      const module = readFileSync(join(root, `${ui}/demo-bookmark.module.ts`), 'utf8');
      expect(module).toContain('export class DemoBookmarkFeatureModule {}');
      for (const [name, file] of [
        ['Bookmark', 'bookmark'],
        ['AuditEvent', 'audit-event'],
      ]) {
        expect(module).toContain(
          `import { ${name}ListComponent } from './${file}-list.component';`,
        );
        expect(module).toContain(
          `import { ${name}DetailComponent } from './${file}-detail.component';`,
        );
        expect(module).toContain(`import { ${name}Service } from './${file}.service';`);
      }
      expect(module).toContain(
        'declarations: [BookmarkListComponent, BookmarkDetailComponent, AuditEventListComponent, AuditEventDetailComponent]',
      );
      expect(module).toContain('providers: [BookmarkService, AuditEventService, CognitoGuard]');
      const expectedRoutes = [
        ['audit-event', 'AuditEventListComponent', 'audit-event'],
        ['audit-event/:id', 'AuditEventDetailComponent', 'audit-event'],
        ['', 'BookmarkListComponent', 'bookmark'],
        [':id', 'BookmarkDetailComponent', 'bookmark'],
      ];
      let previous = -1;
      for (const [path, component, resource] of expectedRoutes) {
        const route = `{ path: '${path}', component: ${component}, canActivate: [BookmarkPolicyGuard], data: { resource: '${resource}', action: 'read' } }`;
        expect(module).toContain(route);
        const offset = module.indexOf(route);
        expect(offset).toBeGreaterThan(previous);
        previous = offset;
      }

      expect(module).not.toContain('__NsModulePascal__');
      expect(module).toContain('canActivate: [CognitoGuard]');
      expect(module).toContain('canActivate: [BookmarkPolicyGuard]');
    }
    if (value.variant === 'tests') {
      const apiResult = await withAuthorityHostTestScope(() =>
        runOperation(
          {
            ...request,
            variant: 'api',
            operation: 'scaffold.api',
            write_paths: [...cases[0].paths],
          },
          createOperationHost({ run: command }),
        ),
      );
      expect(apiResult.status, JSON.stringify(apiResult)).toBe('pass');
      for (const path of value.paths) {
        const text = readFileSync(join(root, path), 'utf8');
        const imports = [...text.matchAll(/from '(\.[^']+)'/gu)].map((match) => match[1]);
        expect(imports.length).toBe(path.endsWith('.controller.spec.ts') ? 2 : 1);
        for (const imported of imports)
          expect(existsSync(resolve(root, dirname(path), `${imported}.ts`))).toBe(true);
      }
      for (const name of names) {
        const controller = readFileSync(
          join(root, `${prefix}/api/test/${name}.controller.spec.ts`),
          'utf8',
        );
        const service = readFileSync(
          join(root, `${prefix}/api/test/${name}.service.spec.ts`),
          'utf8',
        );
        expect(controller).toContain(`from '../src/demo-bookmark/controllers/${name}.controller'`);
        expect(controller).toContain(`from '../src/demo-bookmark/services/${name}.service'`);
        expect(service).toContain(`from '../src/demo-bookmark/services/${name}.service'`);
        expect(service).toContain("from '@nestjs/testing'");
        expect(service).toContain('Test.createTestingModule(');
        expect(service).not.toContain('@angular/');
      }
    }
    expect((await execute()).evidence).toMatchObject({
      files_created: [],
      files_modified: [],
      idempotency: 'no-op',
    });
    for (const [path, before] of bytes) expect(readFileSync(join(root, path))).toEqual(before);
    expect(command).not.toHaveBeenCalled();
  });
});
