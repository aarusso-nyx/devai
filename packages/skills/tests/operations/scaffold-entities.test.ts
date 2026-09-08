import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect((await execute()).evidence).toMatchObject({
      files_created: [],
      files_modified: [],
      idempotency: 'no-op',
    });
    for (const [path, before] of bytes) expect(readFileSync(join(root, path))).toEqual(before);
    expect(command).not.toHaveBeenCalled();
  });
});
