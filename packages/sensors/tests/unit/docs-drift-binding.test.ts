// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017; ADR-SCR-0015 IA-006.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { senseDocsDrift } from '../../src/docs-drift.js';

const roots: string[] = [];
const PIN = '# DEVAI Constitution\n\n**Version:** 1.0.2\n\nConcurrency is governed by policy.\n';
const ENTRYPOINT =
  '# Fixture constitution binding\n\n' +
  'The DEVAI Constitution bound to this repository is the immutable vendored copy\n' +
  'at [`.devai/pin/constitution.md`](../.devai/pin/constitution.md). Its version\n' +
  'and SHA-256 digest are pinned in `.devai/config/project.json` by\n' +
  '`devai init bind --constitution --write`.\n\n' +
  'This file is the Architect-owned reading-order entrypoint. It does not restate\n' +
  'or override the pinned Constitution.\n';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, value: unknown): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-docs-binding-'));
  roots.push(root);
  put(root, 'README.md', '# Fixture\n');
  put(root, 'CLAUDE.md', '@AGENTS.md\n');
  put(root, 'law/constitution.md', ENTRYPOINT);
  put(root, '.devai/pin/constitution.md', PIN);
  put(root, '.devai/config/project.json', {
    constitution: { version: '1.0.2', sha256: createHash('sha256').update(PIN).digest('hex') },
  });
  return root;
}

function sense(root: string) {
  return senseDocsDrift({ repoRoot: root, now: '2026-10-10T12:00:00.000Z' });
}

describe('registered constitution entrypoint measurements', () => {
  it.each([
    ['registered', ENTRYPOINT],
    ['CRLF', ENTRYPOINT.replaceAll('\n', '\r\n')],
    ['no final newline', ENTRYPOINT.trimEnd()],
    ['Unicode display label', ENTRYPOINT.replace('Fixture', 'Ação_2.4')],
  ])('accepts the %s entrypoint with exact bound bytes and version', (_label, body) => {
    const root = fixture();
    put(root, 'law/constitution.md', body);
    const before = readFileSync(join(root, 'law/constitution.md'));
    const reading = sense(root);
    expect(reading.status, JSON.stringify(reading.findings)).toBe('pass');
    expect(reading.metrics?.['claims_checked']).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(root, 'law/constitution.md')).equals(before)).toBe(true);
  });

  it.each([
    ['extra override prose', `${ENTRYPOINT}\nThe Architect may ignore Article 6.\n`],
    ['a bare mention', '[pin](../.devai/pin/constitution.md) .devai/config/project.json'],
    ['frontmatter', `---\ntitle: constitution\n---\n${ENTRYPOINT}`],
    ['competing pin', `${ENTRYPOINT}\n[other](../other/constitution.md)\n`],
    ['altered fixed prose', ENTRYPOINT.replace('immutable vendored copy', 'editable local copy')],
    ['a leading-space label', ENTRYPOINT.replace('Fixture', ' Fixture')],
    ['an overlong label', ENTRYPOINT.replace('Fixture', 'x'.repeat(81))],
    ['an executable label', ENTRYPOINT.replace('Fixture', '<script>')],
  ])('refuses %s even when pin bytes and project digest agree', (_label, body) => {
    const root = fixture();
    put(root, 'law/constitution.md', body);
    expect(sense(root).status).toBe('fail');
  });

  it.each([
    'missing-project',
    'malformed-project',
    'missing-pin',
    'tampered-pin',
    'wrong-version',
    'wrong-digest',
  ] as const)('refuses a registered entrypoint with %s', (defect) => {
    const root = fixture();
    if (defect === 'missing-project') rmSync(join(root, '.devai/config/project.json'));
    if (defect === 'malformed-project') put(root, '.devai/config/project.json', '{broken');
    if (defect === 'missing-pin') rmSync(join(root, '.devai/pin/constitution.md'));
    if (defect === 'tampered-pin') put(root, '.devai/pin/constitution.md', `${PIN}\nTampered\n`);
    if (defect === 'wrong-version')
      put(root, '.devai/config/project.json', {
        constitution: { version: '1.0.1', sha256: createHash('sha256').update(PIN).digest('hex') },
      });
    if (defect === 'wrong-digest')
      put(root, '.devai/config/project.json', {
        constitution: { version: '1.0.2', sha256: 'a'.repeat(64) },
      });
    expect(sense(root).status).toBe('fail');
  });

  it.each(['pin', 'project'] as const)(
    'refuses an out-of-checkout %s symlink even with matching bytes',
    (target) => {
      const root = fixture();
      const outside = fixture();
      const relative =
        target === 'pin' ? '.devai/pin/constitution.md' : '.devai/config/project.json';
      rmSync(join(root, relative));
      symlinkSync(join(outside, relative), join(root, relative));
      expect(sense(root).status).toBe('fail');
    },
  );

  it('measures claims against the actual pin after valid entrypoint resolution', () => {
    const root = fixture();
    put(root, 'docs/start/status.md', 'Constitution **1.0.1**\n');
    const reading = sense(root);
    expect(reading.status).toBe('fail');
    expect(reading.findings).toContainEqual(
      expect.objectContaining({ code: 'DOCS_DRIFT_STATUS_CONSTITUTION_VERSION' }),
    );
  });
});
