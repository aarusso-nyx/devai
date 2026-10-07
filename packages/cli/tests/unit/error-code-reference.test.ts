// #338: the error-code reference states the class and exit the CLI emits. Each declared cell is
// checked against the code that emits it: literal envelope constructors in every package source,
// the authority renderer and the action-output wrapper. A cell is never inferred from a name.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import { renderActionFailure } from '../../src/action-output.js';
import { renderAuthorityResult } from '../../src/authority/authority-results.js';
import { canonicalRegistry } from '../../src/define-command.js';
import { ERROR_CODE_PREFIXES } from '../../src/error-code-prefixes.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const PER_ACTION = 'per action: set by the surfacing envelope';

// The parser and prefixes the generator uses (scripts/error-code-sources.mjs), loaded as the other
// script-backed tests load theirs.
const {
  ERROR_CODE_PREFIXES: SCANNED_PREFIXES,
  EXIT_CLASSES,
  parseThrowSites,
} = (await import(pathToFileURL(join(ROOT, 'scripts/error-code-sources.mjs')).href)) as {
  readonly ERROR_CODE_PREFIXES: ReadonlySet<string>;
  readonly EXIT_CLASSES: ReadonlyMap<number, string>;
  readonly parseThrowSites: (
    file: string,
    source: string,
  ) => readonly { readonly code: string; readonly exit: number }[];
};

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

  it('declares only class/exit pairs that error.schema.json admits', () => {
    // Every pair in every declared cell, the primary and each parenthesized alternative. The
    // `result` rows (ADR-CHK-0005 member statuses) are not refusal envelopes and are exempt.
    let checked = 0;
    for (const [code, cell] of reference) {
      if (cell === PER_ACTION || cell === 'internal / none' || cell.includes(' result /')) continue;
      for (const match of cell.matchAll(/([a-z-]+) \/ ([0-9])/gu)) {
        const [, cls, exit] = match;
        const envelope = {
          schemaVersion: '1.0.0',
          code,
          class: cls,
          exit: Number(exit),
          message: 'reference pair check',
        };
        expect(validators.error(envelope), `${code}: ${String(cls)} / ${String(exit)}`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it('agrees with every literal envelope constructor in package sources', () => {
    const constructors = literalConstructors();
    expect(constructors.size).toBeGreaterThanOrEqual(13);
    for (const [code, emitted] of constructors) {
      expect(reference.get(code), code).toBe(emitted);
    }
  });

  it('agrees with every task, round and tracking throw site and its exit', () => {
    // The generator and this test share one parser (scripts/error-code-sources.mjs), which reads
    // multi-line arguments and trailing commas.
    let checked = 0;
    for (const pkg of ['cli', 'loop']) {
      for (const file of sourceFiles(join(ROOT, 'packages', pkg, 'src'))) {
        for (const { code, exit } of parseThrowSites(file, readFileSync(file, 'utf8'))) {
          const cell = reference.get(code);
          if (cell === undefined || cell.startsWith('internal')) continue;
          expect(cell, `${code} thrown with exit ${String(exit)} in ${file}`).toContain(
            `${EXIT_CLASSES.get(exit) ?? '?'} / ${String(exit)}`,
          );
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
    // A multi-line constructor with a trailing comma (tracking reconcile).
    expect(reference.get('TRACKING_RECONCILE_REPLACEMENT_FORBIDDEN')).toBe('routing-authority / 2');
  });

  it('scans the same code prefixes the CLI accepts as refusal codes', () => {
    expect([...ERROR_CODE_PREFIXES].sort()).toEqual([...SCANNED_PREFIXES].sort());
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
    expect(reference.get('COVERAGE_REPORT_UNBOUND')).toBe(PER_ACTION);
    expect(reference.get('TASK_RECORD_CLAIM_STALE')).toBe('routing-authority / 2');
  });
});
