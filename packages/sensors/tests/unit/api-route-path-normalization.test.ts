import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryApi } from '../../src/inventory-api.js';

const NOW = '2026-09-08T12:00:00.000Z';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-api-route-paths-'));
  mkdirSync(join(root, 'apps/api'), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeController(): void {
  writeFileSync(
    join(root, 'apps/api/accounts.controller.ts'),
    `
      @Controller('///api///')
      export class AccountsController {
        @Get('///users//:id')
        getUser() {}

        @Post('v1//items///')
        createItem() {}

        @Get('///')
        rootEndpoint() {}
      }
      @Controller('api//v2///')
      export class VersionedController {
        @Get('')
        rootEndpoint() {}
      }
    `,
  );
}

describe('API route path normalization', () => {
  it('trims boundary slash runs while preserving interior and trailing subpath slashes', () => {
    writeController();

    const result = senseInventoryApi({
      repoRoot: root,
      scanDirs: ['apps/api'],
      persistBody: false,
      now: NOW,
    });

    expect(result.reading.status).toBe('pass');
    expect(result.body.endpoints.map((endpoint) => [endpoint.method, endpoint.path])).toEqual([
      ['GET', '/api'],
      ['GET', '/api//v2'],
      ['GET', '/api/users//:id'],
      ['POST', '/api/v1//items///'],
    ]);
    expect(result.body.endpoints.every((endpoint) => endpoint.evidence.length === 1)).toBe(true);
  });
});
