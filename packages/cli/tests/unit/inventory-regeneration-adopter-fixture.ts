// #382: a disposable adopter whose http, database and rbac surfaces are all present, so
// every inventory kind has real source for its typed producer to measure.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const ALL_SURFACES = { http: true, database: true, rbac: true, actions: true } as const;

/** The state body of every kind regeneration produces, as the #382 contract names them. */
export const STATE_BODY = {
  inventory_api: '.devai/state/sensors/inventory_api/api-map.json',
  inventory_routes: '.devai/state/sensors/inventory_routes/routes-react.json',
  inventory_data_model: '.devai/state/sensors/inventory_data_model/data-model.json',
  inventory_rbac: '.devai/state/sensors/inventory_rbac/rbac.json',
  inventory_data_handling: '.devai/state/sensors/inventory_data_handling/data-model-pii.json',
  inventory_dep_graph: '.devai/state/sensors/inventory_dep_graph/dep-graph.json',
  inventory_coverage: '.devai/state/sensors/inventory_coverage/coverage-matrix.json',
} as const;

export type StateKind = keyof typeof STATE_BODY;
export const STATE_KINDS = Object.keys(STATE_BODY) as readonly StateKind[];

/** The direct sensor defaults under record/proofs, which regeneration neither writes nor removes. */
export const PROOF_BODY = {
  inventory_api: 'record/proofs/sensors/inventory_api/api-map.json',
  inventory_routes: 'record/proofs/sensors/inventory_routes/routes-react.json',
  inventory_data_model: 'record/proofs/sensors/inventory_data_model/data-model.json',
} as const;

export const ADOPTER_SOURCES: Readonly<Record<string, string>> = {
  'apps/api/users.controller.ts': [
    "import { Body, Controller, Get, Param, Post, Roles, UseGuards } from './nest.js';",
    "import { SessionGuard } from './session.guard.js';",
    '',
    "@Controller('/users')",
    '@UseGuards(SessionGuard)',
    'export class UsersController {',
    "  @Get(':id')",
    "  @Roles('admin')",
    "  getOne(@Param('id') id: string) {",
    '    return id;',
    '  }',
    '',
    '  @Post()',
    "  @Roles('admin')",
    '  create(@Body() body: unknown) {',
    '    return body;',
    '  }',
    '}',
    '',
  ].join('\n'),
  'apps/api/nest.ts': [
    'const decorator = (..._args: unknown[]) => (..._target: unknown[]) => undefined;',
    'export const Controller = decorator;',
    'export const Get = decorator;',
    'export const Post = decorator;',
    'export const Roles = decorator;',
    'export const UseGuards = decorator;',
    'export const Param = decorator;',
    'export const Body = decorator;',
    '',
  ].join('\n'),
  'apps/api/session.guard.ts': 'export class SessionGuard {}\n',
  'apps/web/routes.tsx': [
    "import { UserPage } from './user-page.js';",
    'export const routes = (',
    '  <Routes>',
    '    <Route path="/users/:id" element={<UserPage />} />',
    '  </Routes>',
    ');',
    '',
  ].join('\n'),
  'apps/web/user-page.tsx': 'export const UserPage = () => <main />;\n',
  'database/001-schema.sql': [
    'CREATE TABLE auth.roles (',
    '  id uuid PRIMARY KEY,',
    '  name varchar(100) NOT NULL',
    ');',
    '',
    'CREATE TABLE auth.permissions (',
    '  id uuid PRIMARY KEY,',
    '  name text NOT NULL',
    ');',
    '',
    'CREATE TABLE auth.role_permissions (',
    '  role_id uuid NOT NULL REFERENCES auth.roles(id),',
    '  permission_id uuid NOT NULL REFERENCES auth.permissions(id),',
    '  PRIMARY KEY (role_id, permission_id)',
    ');',
    '',
    'CREATE TABLE app.users (',
    '  id uuid PRIMARY KEY,',
    '  email text NOT NULL, -- @pii_class: contact @legal_basis: contract @retention: P2Y',
    '  full_name text,',
    '  role_id uuid REFERENCES auth.roles(id)',
    ');',
    '',
  ].join('\n'),
  'law/trace.json': `${JSON.stringify({
    invariants: [{ id: 'INV-FIX-001', code_areas: ['apps/api/users.controller.ts'] }],
  })}\n`,
};

export interface AdopterFixture {
  readonly root: string;
  readonly head: string;
  readonly cleanup: () => void;
}

export function put(root: string, path: string, body: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, body);
}

export function read(root: string, path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

export function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=DEVAI Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  ).trim();
}

/** A committed adopter with ignored state; `extra` files are committed beside the sources. */
export function adopter(
  extra: Readonly<Record<string, string>> = {},
  /** Further .gitignore lines, committed with the fixture. */
  ignore: readonly string[] = [],
): AdopterFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-inventory-adopter-')));
  put(root, '.gitignore', ['.devai/state/', ...ignore, ''].join('\n'));
  for (const [path, body] of Object.entries({ ...ADOPTER_SOURCES, ...extra })) {
    put(root, path, body);
  }
  git(root, 'init', '--quiet');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'fixture');
  return {
    root,
    head: git(root, 'rev-parse', 'HEAD'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
