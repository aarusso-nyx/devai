// #338: the error-code reference states the class and exit the CLI emits. Each declared cell is
// checked against the code that emits it: literal envelope constructors in every package source,
// the authority renderer and the action-output wrapper. A cell is never inferred from a name.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderActionFailure } from '../../src/action-output.js';
import { renderAuthorityResult } from '../../src/authority/authority-results.js';
import { canonicalRegistry } from '../../src/define-command.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const PER_ACTION = 'per action: set by the surfacing envelope';

const reference = new Map(
  readFileSync(join(ROOT, 'docs/reference/error-codes.md'), 'utf8')
    .split('\n')
    .flatMap((line) => {
      const match = /^\| `([A-Z][A-Z0-9_]+)` \|/u.exec(line);
      const cell = line.split('|').at(-2)?.trim();
      return match?.[1] === undefined || cell === undefined ? [] : [[match[1], cell] as const];
    }),
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|mjs|js)$/u.test(path) ? [path] : [];
  });
}

/** Every `{ code: 'X', ..., class: 'y', ..., exit: N }` object literal in package sources. */
function literalConstructors(): Map<string, string> {
  const found = new Map<string, string>();
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    let files: string[];
    try {
      files = sourceFiles(join(ROOT, 'packages', pkg, 'src'));
    } catch {
      continue;
    }
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const pattern =
        /code:\s*'([A-Z][A-Z0-9_]+)'[\s\S]{0,200}?class:\s*'([a-z-]+)'[\s\S]{0,120}?exit:\s*(\d)/gu;
      for (const match of source.matchAll(pattern)) {
        const [, code, cls, exit] = match;
        if (code !== undefined && cls !== undefined && exit !== undefined) {
          found.set(code, `${cls} / ${exit}`);
        }
      }
    }
  }
  return found;
}

describe('#338: the error-code reference declares what the CLI emits', () => {
  it('uses only the declared cell vocabulary', () => {
    expect(reference.size).toBeGreaterThan(1000);
    for (const [code, cell] of reference) {
      const valid =
        cell === PER_ACTION ||
        cell === 'internal / none' ||
        /^[a-z-]+(?: result)? \/ [0-7](?: \(.+\))?$/u.test(cell);
      expect(valid, `${code}: ${cell}`).toBe(true);
    }
  });

  it('agrees with every literal envelope constructor in package sources', () => {
    const constructors = literalConstructors();
    expect(constructors.size).toBeGreaterThanOrEqual(13);
    for (const [code, emitted] of constructors) {
      expect(reference.get(code), code).toBe(emitted);
    }
  });

  it('agrees with the authority renderer for every AUTHORITY_ code', () => {
    const codes = [...reference.keys()].filter((code) => code.startsWith('AUTHORITY_'));
    expect(codes.length).toBeGreaterThan(100);
    for (const code of codes) {
      const cell = reference.get(code) ?? '';
      for (const category of ['refused', 'dependency-error'] as const) {
        const rendered = renderAuthorityResult({ ok: false, category, code }, 'json');
        const parsed = JSON.parse(rendered.stderr || rendered.stdout) as {
          error?: { class: string; exit: number };
          class?: string;
          exit?: number;
        };
        const error = parsed.error ?? (parsed as { class: string; exit: number });
        expect(rendered.exit_code, `${code} ${category}`).toBe(error.exit);
        expect(cell, `${code} ${category}`).toContain(`${error.class} / ${String(error.exit)}`);
      }
    }
  });

  it('agrees with the action-output wrapper for each normalized exit', () => {
    const entry = canonicalRegistry().find((candidate) => candidate.name === 'backlog show');
    if (entry === undefined) throw new Error('backlog show is not registered');
    for (const exit of [2, 3, 4, 5, 6, 7, 1]) {
      const envelope = JSON.parse(renderActionFailure(entry, 'not a structured payload', exit)) as {
        error: { code: string; class: string; exit: number };
      };
      const { code, class: cls, exit: emitted } = envelope.error;
      expect(reference.get(code), `${code} for exit ${String(exit)}`).toContain(
        `${cls} / ${String(emitted)}`,
      );
    }
  });

  it('marks the model-bridge codes internal and gives undeclared codes no guessed class', () => {
    expect(reference.get('MODEL_BRIDGE_CODEX_INCOMPATIBLE')).toBe('internal / none');
    expect(reference.get('ACTION_OUTPUT_CONTRACT_VIOLATION')).toBe('contract-violation / 7');
    expect(reference.get('TASK_RECORD_CLAIM_STALE')).toBe(PER_ACTION);
  });
});
