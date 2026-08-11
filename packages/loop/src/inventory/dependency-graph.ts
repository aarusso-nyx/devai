import { relative, dirname, resolve as pathResolve } from 'node:path';
import ts from 'typescript';
import { parseSourceFile } from './ts-ast.js';
import { sha256Hex } from './id.js';
import { walkFiles } from './walker.js';

export interface DependencyEdge {
  readonly from: string;
  readonly to: string;
  readonly external: boolean;
}

export interface DependencyGraph {
  readonly nodes: readonly string[];
  readonly edges: readonly DependencyEdge[];
  /** SHA-256 of the canonical form of the graph. */
  readonly hash: string;
}

export interface ExtractDependenciesOptions {
  readonly repoRoot: string;
  readonly dir?: string;
  readonly ignoreDirs?: ReadonlySet<string>;
}

/**
 * Build an import graph from TS source files. Each node is a repo-relative
 * source path. Each edge is an import statement: `from` is the importer,
 * `to` is either a repo-relative path (when the import is local) or the
 * raw module specifier (when external, e.g. 'node:fs', '@devai-nyx/utils').
 *
 * The canonical form sorts nodes and edges alphabetically and joins with
 * newlines, then takes SHA-256. Deterministic across runs.
 */
export function extractDependencies(opts: ExtractDependenciesOptions): DependencyGraph {
  const dir = opts.dir ?? opts.repoRoot;
  const files = walkFiles(dir, { extensions: ['.ts'], ignoreDirs: opts.ignoreDirs }).filter(
    (f) => !f.endsWith('.d.ts'),
  );
  const nodes = new Set<string>();
  const edges: DependencyEdge[] = [];

  for (const file of files) {
    let sourceFile;
    try {
      sourceFile = parseSourceFile(file);
    } catch {
      continue;
    }
    const fromRel = relative(opts.repoRoot, file);
    nodes.add(fromRel);
    for (const node of sourceFile.statements) {
      const spec = importSpecifier(node);
      if (spec === null) continue;
      if (spec.startsWith('.') || spec.startsWith('/')) {
        // Resolve relative to the importer's directory.
        let resolved = pathResolve(dirname(file), spec);
        // TS imports use .js extension; resolve back to source .ts.
        resolved = resolved.replace(/\.js$/, '.ts');
        const toRel = relative(opts.repoRoot, resolved);
        edges.push({ from: fromRel, to: toRel, external: false });
      } else {
        edges.push({ from: fromRel, to: spec, external: true });
      }
    }
  }

  const sortedNodes = [...nodes].sort();
  const sortedEdges = [...edges].sort((a, b) =>
    a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
  );
  const canonical = [
    ...sortedNodes.map((n) => `NODE\t${n}`),
    ...sortedEdges.map((e) => `EDGE\t${e.from}\t${e.to}\t${e.external ? '1' : '0'}`),
  ].join('\n');
  return { nodes: sortedNodes, edges: sortedEdges, hash: sha256Hex(canonical) };
}

function importSpecifier(node: ts.Statement): string | null {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isExportDeclaration(node) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  return null;
}
