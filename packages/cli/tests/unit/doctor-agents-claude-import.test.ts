// Record: ADR-GOV-0020 (Inspector Adversarial Acceptance IA-003).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { buildBootstrapPlan, executeBootstrapPlan } from '../../../skills/src/bootstrap/index.js';
import { checkAgentsClaudeSync } from '../../src/commands/doctor-environment-checks.js';
import { FIVE_ROLES, READING_ORDER_SOURCES } from '../../src/commands/doctor-support.js';

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const IMPORT_LINE = '@AGENTS.md\n';

/** An AGENTS.md carrying every piece of content the check requires, and nothing more. */
const REQUIRED_AGENTS = [
  '# Agent instructions',
  '',
  'Constitution Article 6 fixes the roles:',
  FIVE_ROLES.join(', '),
  `Reading order: ${READING_ORDER_SOURCES.join(', ')}`,
  '',
].join('\n');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-doctor-agents-import-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe('agents-claude-sync: CLAUDE.md is the AGENTS.md import', () => {
  it('passes when CLAUDE.md is the import line and AGENTS.md carries the required content', () => {
    const root = repo({ 'AGENTS.md': REQUIRED_AGENTS, 'CLAUDE.md': IMPORT_LINE });
    expect(checkAgentsClaudeSync(root)).toEqual({ name: 'agents-claude-sync', ok: true });
  });

  it("passes on this checkout's own AGENTS.md and CLAUDE.md", () => {
    expect(readFileSync(join(CHECKOUT, 'CLAUDE.md'), 'utf8')).toBe(IMPORT_LINE);
    expect(checkAgentsClaudeSync(CHECKOUT)).toEqual({ name: 'agents-claude-sync', ok: true });
  });

  it('fails on a full copy of AGENTS.md in CLAUDE.md until it is the single import line (IA-003)', () => {
    const agents = readFileSync(join(CHECKOUT, 'AGENTS.md'), 'utf8');
    const root = repo({ 'AGENTS.md': agents, 'CLAUDE.md': agents });

    const copy = checkAgentsClaudeSync(root);
    expect(copy.ok).toBe(false);
    expect(copy.name).toBe('agents-claude-sync');
    expect(copy.errors?.some((error) => error.includes('CLAUDE.md'))).toBe(true);

    writeFileSync(join(root, 'CLAUDE.md'), IMPORT_LINE);
    expect(checkAgentsClaudeSync(root)).toEqual({ name: 'agents-claude-sync', ok: true });
  });

  it.each([
    ['the import followed by more guidance', `${IMPORT_LINE}\n${REQUIRED_AGENTS}`],
    ['more guidance followed by the import', `${REQUIRED_AGENTS}\n${IMPORT_LINE}`],
    ['the import written twice', `${IMPORT_LINE}${IMPORT_LINE}`],
    ['an import of another file', '@README.md\n'],
    ['an import of a nested AGENTS.md', '@docs/AGENTS.md\n'],
    ['a mention without the import form', 'See AGENTS.md\n'],
    ['an empty file', ''],
  ])('fails when CLAUDE.md is %s', (_name, claude) => {
    const root = repo({ 'AGENTS.md': REQUIRED_AGENTS, 'CLAUDE.md': claude });
    const result = checkAgentsClaudeSync(root);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((error) => error.includes('CLAUDE.md'))).toBe(true);
  });

  it.each<[string, string, string]>([
    ['the Article 6 reference', 'Article 6', 'Article six'],
    ...FIVE_ROLES.map((role): [string, string, string] => [`role ${role}`, role, 'someone']),
    ...READING_ORDER_SOURCES.map((source): [string, string, string] => [
      `source ${source}`,
      source,
      'elsewhere',
    ]),
  ])('fails when the imported AGENTS.md lacks %s', (_name, required, replacement) => {
    const agents = REQUIRED_AGENTS.split(required).join(replacement);
    expect(agents).not.toContain(required);
    const root = repo({ 'AGENTS.md': agents, 'CLAUDE.md': IMPORT_LINE });
    const result = checkAgentsClaudeSync(root);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((error) => error.startsWith('AGENTS.md'))).toBe(true);
    expect(result.errors?.some((error) => error.includes(required))).toBe(true);
  });

  it.each([
    ['CLAUDE.md', { 'AGENTS.md': REQUIRED_AGENTS }],
    ['AGENTS.md', { 'CLAUDE.md': IMPORT_LINE }],
  ])('fails when %s is missing', (_missing, files) => {
    const result = checkAgentsClaudeSync(repo(files));
    expect(result.ok).toBe(false);
    expect(result.name).toBe('agents-claude-sync');
  });

  it('passes on the instruction pair a fresh tier3 bootstrap writes', async () => {
    const root = repo({});
    await withAuthorityHostTestScope(() => {
      executeBootstrapPlan(
        buildBootstrapPlan({ targetRoot: root, version: '1.2.1', profile: 'tier3' }),
      );
    });
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe(IMPORT_LINE);
    expect(checkAgentsClaudeSync(root)).toEqual({ name: 'agents-claude-sync', ok: true });
  });
});
