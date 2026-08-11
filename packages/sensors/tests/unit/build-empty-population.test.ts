import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { senseBuild } from '../../src/build.js';

const root = mkdtempSync(join(tmpdir(), 'devai-empty-build-'));

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('build sensor empty population', () => {
  it('returns REVIEW instead of PASS when pnpm finds no projects', async () => {
    writeFileSync(join(root, 'package.json'), '{"name":"empty","private":true}\n');
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    mkdirSync(join(root, 'packages'), { recursive: true });
    const reading = await withAuthorityHostTestScope(() => senseBuild({ cwd: root }));
    expect(reading.status, JSON.stringify(reading)).toBe('review');
    expect(reading.findings).toContainEqual(
      expect.objectContaining({ code: 'BUILD_POPULATION_EMPTY', severity: 'warning' }),
    );
  });
});
