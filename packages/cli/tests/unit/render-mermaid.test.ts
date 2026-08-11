// Invariants: INV-DEVAI-013
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const fs = await import('node:fs');
  const child = await import('node:child_process');
  return {
    ...actual,
    execFileSync: child.execFileSync,
    spawnSync: child.spawnSync,
    mkdirSync: fs.mkdirSync,
    mkdtempSync: fs.mkdtempSync,
    readdirSync: fs.readdirSync,
    readFileSync: fs.readFileSync,
    rmSync: fs.rmSync,
    statSync: fs.statSync,
    writeFileSync: fs.writeFileSync,
  };
});

const { extractMermaidBlocks, findMmdc, renderMermaidBlock, renderMermaidInDocs } =
  await import('../../src/services/docs/render-mermaid.js');

const roots: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.DEVAI_FORCE_NO_MMDC;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-mermaid-'));
  roots.push(path);
  return path;
}

function put(base: string, relativePath: string, body: string): string {
  const path = join(base, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function installMmdc(base: string, failing = false): string {
  const path = put(
    base,
    failing ? 'bin/mmdc-fail' : 'bin/mmdc',
    failing
      ? '#!/bin/sh\necho render-failed >&2\nexit 7\n'
      : `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "11.4.1"
  exit 0
fi
input=""
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --input) input="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cp "$input" "$output"
`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe('Mermaid extraction and rendering', () => {
  it('extracts complete fenced blocks and skips an unterminated tail', () => {
    expect(
      extractMermaidBlocks(
        [
          '# Diagram',
          '```mermaid',
          'graph TD',
          '  A --> B',
          '```',
          'text',
          '  ```mermaid',
          'sequenceDiagram',
          '```',
          '```mermaid',
          'unterminated',
        ].join('\n'),
      ),
    ).toEqual([
      { body: 'graph TD\n  A --> B', startLine: 2, endLine: 5, index: 0 },
      { body: 'sequenceDiagram', startLine: 7, endLine: 9, index: 1 },
    ]);
    expect(extractMermaidBlocks('```Mermaid\ngraph TD\n```')).toEqual([]);
  });

  it('reports graceful absence while still scanning explicit and discovered documents', () => {
    const repo = root();
    process.env.DEVAI_FORCE_NO_MMDC = '1';
    const diagram = put(repo, 'docs/Nested Diagram.md', '```mermaid\ngraph TD\nA-->B\n```\n');
    put(repo, 'docs/plain.md', '# Plain\n');
    put(repo, 'docs/ignore.txt', '```mermaid\ngraph TD\n```\n');

    expect(findMmdc()).toEqual({ available: false });
    expect(renderMermaidBlock({ input: 'graph TD', outPath: join(repo, 'out.png') })).toMatchObject(
      { ok: false, mmdcAvailable: false, error: expect.stringContaining('PATH') },
    );
    expect(renderMermaidInDocs({ repoRoot: repo })).toMatchObject({
      mmdcAvailable: false,
      files_scanned: 2,
      blocks_found: 1,
      rendered: 0,
      skipped_no_mmdc: 1,
      errors: [],
      outputs: [],
    });
    expect(
      renderMermaidInDocs({
        repoRoot: repo,
        files: [diagram, join(repo, 'missing.md')],
        format: 'svg',
      }),
    ).toMatchObject({ files_scanned: 2, blocks_found: 1, skipped_no_mmdc: 1 });
    expect(renderMermaidInDocs({ repoRoot: repo, scanDir: 'absent' }).files_scanned).toBe(0);
  });

  it('detects a renderer, renders formats, reports failures, and names multiple outputs', () => {
    const repo = root();
    const mmdc = installMmdc(repo);
    const failing = installMmdc(repo, true);
    process.env.PATH = `${join(repo, 'bin')}:${originalPath ?? ''}`;

    expect(findMmdc()).toEqual({
      available: true,
      path: mmdc,
      version: '11.4.1',
    });
    const directOut = join(repo, 'rendered/direct.svg');
    expect(
      renderMermaidBlock({
        input: 'graph TD\nA-->B',
        outPath: directOut,
        format: 'svg',
        timeoutMs: 2_000,
      }),
    ).toEqual({ ok: true, outPath: directOut, mmdcAvailable: true });

    expect(
      renderMermaidBlock({
        input: 'graph TD',
        outPath: join(repo, 'rendered/fail.png'),
        mmdcPath: failing,
      }),
    ).toMatchObject({
      ok: false,
      mmdcAvailable: true,
      error: expect.stringContaining('exited 7'),
    });

    put(
      repo,
      'docs/Two (flows).md',
      '```mermaid\ngraph TD\nA-->B\n```\n\n```mermaid\nflowchart LR\nB-->C\n```\n',
    );
    const result = renderMermaidInDocs({
      repoRoot: repo,
      outDir: join(repo, 'public/diagrams'),
      format: 'pdf',
    });
    expect(result).toMatchObject({
      mmdcAvailable: true,
      files_scanned: 1,
      blocks_found: 2,
      rendered: 2,
      skipped_no_mmdc: 0,
      errors: [],
    });
    expect(result.outputs.map((output) => output.out_path)).toEqual([
      join(repo, 'public/diagrams/Two-flows--1.pdf'),
      join(repo, 'public/diagrams/Two-flows--2.pdf'),
    ]);
  });
});
