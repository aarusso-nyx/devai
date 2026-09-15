import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import {
  executeCiScaffoldPlan,
  type CiScaffoldPlan,
} from '../../src/services/ci-scaffold/index.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'devai-ci-scaffold-execution-'));
  roots.push(value);
  return value;
}

function plan(path: string, exists: boolean, content = 'replacement\n'): CiScaffoldPlan {
  return { path, content, exists };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('CI scaffold execution boundaries', () => {
  it('preserves an existing workflow when force is omitted', async () => {
    const directory = root();
    const path = join(directory, 'workflow.yml');
    writeFileSync(path, 'original\n');

    await expect(
      withAuthorityHostTestScope(() => executeCiScaffoldPlan(plan(path, true))),
    ).resolves.toEqual({ written: false, reason: 'exists (use --force to overwrite)' });
    expect(readFileSync(path, 'utf8')).toBe('original\n');
  });

  it('creates missing parent directories and reports a successful write', async () => {
    const path = join(root(), '.github', 'workflows', 'devai.yml');

    await expect(
      withAuthorityHostTestScope(() => executeCiScaffoldPlan(plan(path, false))),
    ).resolves.toEqual({ written: true });
    expect(readFileSync(path, 'utf8')).toBe('replacement\n');
  });

  it('overwrites an existing workflow only when force is exactly true', async () => {
    const directory = root();
    const path = join(directory, 'workflow.yml');
    writeFileSync(path, 'original\n');

    await expect(
      withAuthorityHostTestScope(() => executeCiScaffoldPlan(plan(path, true), { force: true })),
    ).resolves.toEqual({ written: true });
    expect(readFileSync(path, 'utf8')).toBe('replacement\n');
  });

  it('treats an explicit false force option as overwrite refusal', async () => {
    const directory = root();
    const path = join(directory, 'workflow.yml');
    writeFileSync(path, 'original\n');

    await expect(
      withAuthorityHostTestScope(() => executeCiScaffoldPlan(plan(path, true), { force: false })),
    ).resolves.toEqual({ written: false, reason: 'exists (use --force to overwrite)' });
    expect(readFileSync(path, 'utf8')).toBe('original\n');
  });
});
