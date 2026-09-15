import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_PASS, EXIT_REVIEW } from '@devai-nyx/utils';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { docsRenderMermaid } from '../../src/commands/docs/render-mermaid.js';

type Options = {
  readonly repoRoot: string;
  readonly scanDir?: string;
  readonly outDir?: string;
  readonly format?: 'png' | 'svg' | 'pdf';
  readonly human?: boolean;
};
type Capture = {
  command(): Capture;
  option(): Capture;
  action(callback: (options: Options) => void): Capture;
};
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${String(code)}`);
  }
}

const roots: string[] = [];
const originalForceNoMmdc = process.env.DEVAI_FORCE_NO_MMDC;
let invoke: (options: Options) => void;
let oldExit: typeof process.exit;
let oldCode: typeof process.exitCode;
let oldOut: typeof process.stdout.write;
let oldErr: typeof process.stderr.write;

beforeAll(() => {
  const command: Capture = {
    command: () => command,
    option: () => command,
    action: (callback) => {
      invoke = callback;
      return command;
    },
  };
  docsRenderMermaid.register({ command: () => command } as unknown as CAC);
  oldExit = process.exit;
  oldCode = process.exitCode;
  oldOut = process.stdout.write;
  oldErr = process.stderr.write;
});

afterEach(() => {
  process.exit = oldExit;
  process.exitCode = oldCode;
  process.stdout.write = oldOut;
  process.stderr.write = oldErr;
  if (originalForceNoMmdc === undefined) delete process.env.DEVAI_FORCE_NO_MMDC;
  else process.env.DEVAI_FORCE_NO_MMDC = originalForceNoMmdc;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'devai-render-mermaid-cli-depth-'));
  roots.push(value);
  return value;
}

function put(base: string, relativePath: string, body: string): void {
  const path = join(base, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

async function run(options: Options): Promise<{ stdout: string; stderr: string; exit: number }> {
  let stdout = '';
  let stderr = '';
  let exit = 0;
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
  try {
    await withAuthorityHostTestScope(() => invoke(options));
  } catch (error) {
    if (error instanceof ExitSignal) exit = error.code;
    else throw error;
  } finally {
    exit = process.exitCode ?? exit;
    process.exit = oldExit;
    process.exitCode = oldCode;
    process.stdout.write = oldOut;
    process.stderr.write = oldErr;
  }
  return { stdout, stderr, exit };
}

describe('docs render-mermaid CLI public boundaries', () => {
  it('reports a clean empty scan as JSON with the pass exit code', async () => {
    const repo = root();
    process.env.DEVAI_FORCE_NO_MMDC = '1';
    put(repo, 'docs/README.md', '# No diagrams\n');
    const result = await run({ repoRoot: repo });
    expect(result.stderr).toBe('');
    expect(result.exit).toBe(EXIT_PASS);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mmdc: { available: false },
      files_scanned: 1,
      blocks_found: 0,
      rendered: 0,
      skipped_no_mmdc: 0,
      errors: [],
      outputs: [],
    });
  });

  it('omits skipped-rendering counts from an empty human scan', async () => {
    const repo = root();
    process.env.DEVAI_FORCE_NO_MMDC = '1';
    put(repo, 'docs/README.md', '# No diagrams\n');
    const result = await run({ repoRoot: repo, human: true });
    expect(result.exit).toBe(EXIT_PASS);
    expect(result.stdout).toContain('  blocks found:  0');
    expect(result.stdout).not.toContain('  skipped (no mmdc):');
  });

  it('keeps scanning and returns review when mmdc is absent', async () => {
    const repo = root();
    process.env.DEVAI_FORCE_NO_MMDC = '1';
    put(repo, 'docs/diagram.md', '```mermaid\ngraph TD\nA-->B\n```\n');
    const result = await run({ repoRoot: repo, outDir: 'artifacts', format: 'svg' });
    expect(result.stderr).toBe('');
    expect(result.exit).toBe(EXIT_REVIEW);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mmdc: { available: false },
      files_scanned: 1,
      blocks_found: 1,
      rendered: 0,
      skipped_no_mmdc: 1,
      errors: [],
      outputs: [],
    });
  });

  it('honors a custom scan directory and emits the human summary', async () => {
    const repo = root();
    put(repo, 'handbook/nested/flow.md', '```mermaid\nsequenceDiagram\nA->>B: ping\n```\n');
    process.env.DEVAI_FORCE_NO_MMDC = '1';
    const result = await run({ repoRoot: repo, scanDir: 'handbook', human: true });
    expect(result.exit).toBe(EXIT_REVIEW);
    expect(result.stdout).toContain('docs render-mermaid: mmdc NOT FOUND (skipping render)');
    expect(result.stdout).toContain('  files scanned: 1');
    expect(result.stdout).toContain('  blocks found:  1');
    expect(result.stdout).toContain('  skipped (no mmdc): 1');
  });
});
