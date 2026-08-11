import { execFileSync, spawnSync } from '@devai-nyx/authority';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative } from 'node:path';

/**
 * Phase 17.F gap-5 close (D-57): Mermaid render pipeline as a tool
 * invocation with graceful absence handling.
 *
 * Three utilities:
 *   - findMmdc():            best-effort `which mmdc` detection
 *   - extractMermaidBlocks(): pure parser, returns one entry per
 *                             ```mermaid fenced block
 *   - renderMermaidBlock():   shells out to mmdc; produces a PNG
 *
 * The contract: absence of `mmdc` is not a failure. Adopters who
 * don't have it on PATH get a clean skip signal rather than an
 * error.
 *
 * The `devai-docs/erd` recipe produces a markdown file with one ```mermaid
 * block; `devai docs render mermaid` is the standalone CLI verb
 * that picks up those blocks and writes PNGs to docs/diagrams/.
 */

export interface MmdcDetection {
  readonly available: boolean;
  readonly path?: string;
  readonly version?: string;
}

export function findMmdc(): MmdcDetection {
  // Test hook: `DEVAI_FORCE_NO_MMDC=1` short-circuits to "not
  // available" so the absent-path can be exercised cleanly without
  // breaking the test runner's PATH.
  if (process.env.DEVAI_FORCE_NO_MMDC === '1') {
    return { available: false };
  }
  // `which mmdc` first (POSIX-portable). Then fall back to running
  // `mmdc --version` if which is missing (windows / minimal images).
  try {
    const whichResult = spawnSync('which', ['mmdc'], { encoding: 'utf8' });
    if (whichResult.status === 0 && whichResult.stdout.trim().length > 0) {
      const path = whichResult.stdout.trim().split('\n')[0] ?? '';
      let version: string | undefined;
      try {
        version = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 5_000 }).trim();
      } catch {
        // Version not critical; presence is what matters.
      }
      return { available: true, path, ...(version !== undefined && { version }) };
    }
  } catch {
    // which absent or errored.
  }
  // Fallback: try invoking mmdc directly.
  try {
    const v = execFileSync('mmdc', ['--version'], { encoding: 'utf8', timeout: 5_000 }).trim();
    return { available: true, path: 'mmdc', version: v };
  } catch {
    return { available: false };
  }
}

export interface MermaidBlock {
  /** Block contents (no fence). */
  readonly body: string;
  /** 1-based line numbers spanning the entire fenced region. */
  readonly startLine: number;
  readonly endLine: number;
  /** Zero-based index of this block among all blocks in the file. */
  readonly index: number;
}

const FENCE_OPEN = /^[ \t]*```mermaid\s*$/;
const FENCE_CLOSE = /^[ \t]*```\s*$/;

export function extractMermaidBlocks(markdown: string): MermaidBlock[] {
  const out: MermaidBlock[] = [];
  const lines = markdown.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (FENCE_OPEN.test(line)) {
      const startLine = i + 1; // 1-based
      const bodyStart = i + 1;
      let j = bodyStart;
      while (j < lines.length && !FENCE_CLOSE.test(lines[j] ?? '')) j += 1;
      if (j >= lines.length) {
        // Unterminated block — skip rather than fail.
        i = j;
        continue;
      }
      const endLine = j + 1; // 1-based, points at the closing fence
      const body = lines.slice(bodyStart, j).join('\n');
      out.push({ body, startLine, endLine, index: out.length });
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

export interface RenderMermaidBlockOptions {
  readonly input: string;
  readonly outPath: string;
  readonly mmdcPath?: string;
  /** Output format ('png' default; 'svg', 'pdf' supported by mmdc). */
  readonly format?: 'png' | 'svg' | 'pdf';
  readonly timeoutMs?: number;
}

export interface RenderMermaidBlockResult {
  readonly ok: boolean;
  readonly outPath?: string;
  readonly mmdcAvailable: boolean;
  readonly error?: string;
}

export function renderMermaidBlock(opts: RenderMermaidBlockOptions): RenderMermaidBlockResult {
  const det = findMmdc();
  if (!det.available) {
    return {
      ok: false,
      mmdcAvailable: false,
      error: 'mmdc not on PATH; install @mermaid-js/mermaid-cli or set the path explicitly',
    };
  }
  const mmdcCmd = opts.mmdcPath ?? det.path ?? 'mmdc';
  // mmdc reads from a file, not stdin (the --input flag wants a path).
  // Create a tmp file with the block contents.
  const scratchDir = mkdtempSync(join(tmpdir(), 'devai-mmdc-'));
  const inPath = join(scratchDir, 'in.mmd');
  try {
    writeFileSync(inPath, opts.input);
    mkdirSync(dirname(opts.outPath), { recursive: true });
    const args = ['--input', inPath, '--output', opts.outPath, '--quiet'];
    if (opts.format !== undefined) args.push('--outputFormat', opts.format);
    const res = spawnSync(mmdcCmd, args, {
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 60_000,
    });
    if (res.status !== 0) {
      return {
        ok: false,
        mmdcAvailable: true,
        error: `mmdc exited ${String(res.status ?? '?')}: ${res.stderr.slice(0, 512)}`,
      };
    }
    return { ok: true, outPath: opts.outPath, mmdcAvailable: true };
  } finally {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

export interface RenderMermaidInDocsOptions {
  readonly repoRoot: string;
  /** Directory to scan (default: `docs/`). */
  readonly scanDir?: string;
  /** Output directory for PNGs (default: `<repoRoot>/docs/diagrams`). */
  readonly outDir?: string;
  readonly format?: 'png' | 'svg' | 'pdf';
  /** Explicit list of .md files (overrides scanDir). */
  readonly files?: readonly string[];
}

export interface RenderMermaidInDocsResult {
  readonly mmdcAvailable: boolean;
  readonly files_scanned: number;
  readonly blocks_found: number;
  readonly rendered: number;
  readonly skipped_no_mmdc: number;
  readonly errors: ReadonlyArray<{ file: string; index: number; message: string }>;
  readonly outputs: ReadonlyArray<{ file: string; index: number; out_path: string }>;
}

/**
 * Walk a directory (or explicit file list) for *.md files, extract
 * Mermaid blocks, and render each to <outDir>/<source-stem>-<index>.<format>.
 * If mmdc is not on PATH, the scan still runs and reports blocks
 * found; rendering is skipped (skipped_no_mmdc = blocks_found).
 */
export function renderMermaidInDocs(opts: RenderMermaidInDocsOptions): RenderMermaidInDocsResult {
  const det = findMmdc();
  const files: string[] = [];
  if (opts.files !== undefined) {
    files.push(...opts.files);
  } else {
    const scanDir = join(opts.repoRoot, opts.scanDir ?? 'docs');
    walkMd(scanDir, files);
  }

  const outDir = opts.outDir ?? join(opts.repoRoot, 'docs/diagrams');
  const format = opts.format ?? 'png';

  let blocks_found = 0;
  let rendered = 0;
  let skipped_no_mmdc = 0;
  const errors: Array<{ file: string; index: number; message: string }> = [];
  const outputs: Array<{ file: string; index: number; out_path: string }> = [];

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const blocks = extractMermaidBlocks(text);
    blocks_found += blocks.length;
    if (blocks.length === 0) continue;
    const stem = basename(file, extname(file)).replace(/[\s()]+/g, '-');
    for (const blk of blocks) {
      const outName =
        blocks.length === 1 ? `${stem}.${format}` : `${stem}-${String(blk.index + 1)}.${format}`;
      const outPath = join(outDir, outName);
      if (!det.available) {
        skipped_no_mmdc += 1;
        continue;
      }
      const r = renderMermaidBlock({
        input: blk.body,
        outPath,
        ...(det.path !== undefined && { mmdcPath: det.path }),
        format,
      });
      if (r.ok && r.outPath !== undefined) {
        rendered += 1;
        outputs.push({
          file: relative(opts.repoRoot, file),
          index: blk.index,
          out_path: r.outPath,
        });
      } else {
        errors.push({
          file: relative(opts.repoRoot, file),
          index: blk.index,
          message: r.error ?? 'unknown render error',
        });
      }
    }
  }

  return {
    mmdcAvailable: det.available,
    files_scanned: files.length,
    blocks_found,
    rendered,
    skipped_no_mmdc,
    errors,
    outputs,
  };
}

function walkMd(dir: string, out: string[]): void {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walkMd(full, out);
    } else if (s.isFile() && name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
}
