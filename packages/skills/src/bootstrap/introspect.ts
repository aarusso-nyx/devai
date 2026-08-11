import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

/**
 * Repo introspection for `devai init --introspect` (Phase 11.D, D-39).
 *
 * Scans a target directory and infers package manager, languages,
 * frameworks, source/test globs, and protected surfaces. The output
 * is a RepoIntrospection record that validates against the schema
 * of the same name; downstream init code uses it to seed
 * .devai/config/project.json defaults instead of writing a static
 * template.
 *
 * Scope: detection is heuristic. False positives are surfaced as
 * `notes[]` entries rather than discarded silently. The Architect
 * is expected to review the proposed defaults before adopting them.
 */

export interface IntrospectionLanguage {
  readonly name:
    | 'typescript'
    | 'javascript'
    | 'python'
    | 'go'
    | 'rust'
    | 'java'
    | 'kotlin'
    | 'csharp'
    | 'ruby'
    | 'other';
  readonly file_count: number;
}

export interface IntrospectionFramework {
  readonly name:
    | 'nestjs'
    | 'angular'
    | 'react'
    | 'vue'
    | 'express'
    | 'fastify'
    | 'next'
    | 'vite'
    | 'django'
    | 'flask'
    | 'fastapi'
    | 'rails'
    | 'spring'
    | 'other';
  readonly evidence: string;
}

export interface RepoIntrospection {
  readonly schemaVersion: '1.0.0';
  readonly target_root: string;
  readonly generated_at: string;
  readonly package_manager: 'pnpm' | 'yarn' | 'npm' | 'bun' | 'unknown';
  readonly languages: readonly IntrospectionLanguage[];
  readonly frameworks: readonly IntrospectionFramework[];
  readonly source_globs: readonly string[];
  readonly test_globs: readonly string[];
  readonly protected_surfaces: readonly string[];
  readonly existing_devai_config: boolean;
  readonly proposed_project_type?:
    'runtime-host' | 'platform-package' | 'docs-archive' | 'framework';
  readonly notes?: readonly string[];
}

const LANG_EXT: Record<string, IntrospectionLanguage['name']> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.cts': 'typescript',
  '.mts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.cs': 'csharp',
  '.rb': 'ruby',
};

const FRAMEWORK_DEPS: Record<string, IntrospectionFramework['name']> = {
  '@nestjs/core': 'nestjs',
  '@nestjs/common': 'nestjs',
  '@angular/core': 'angular',
  react: 'react',
  vue: 'vue',
  express: 'express',
  fastify: 'fastify',
  next: 'next',
  vite: 'vite',
};

const PROTECTED_FILENAME_PATTERNS = [
  /^\.env(\..+)?$/,
  /\.pem$/,
  /\.key$/,
  /credentials.*\.json$/i,
  /secrets?\..*$/i,
  /^id_rsa(\.pub)?$/,
];

const DEFAULT_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.idea',
  '.vscode',
]);

interface ScanResult {
  readonly langCounts: Map<IntrospectionLanguage['name'], number>;
  readonly protectedSurfaces: string[];
  readonly hasSrc: boolean;
  readonly hasPackagesSrc: boolean;
  readonly hasAppsSrc: boolean;
  readonly hasAppFolder: boolean;
  readonly hasTestFolder: boolean;
  readonly hasTestsFolder: boolean;
  readonly hasUnderscoreTests: boolean;
  readonly hasSpecFiles: boolean;
  readonly hasTestFiles: boolean;
}

function walk(
  root: string,
  state: {
    langCounts: Map<IntrospectionLanguage['name'], number>;
    protectedSurfaces: string[];
    hasSrc: boolean;
    hasPackagesSrc: boolean;
    hasAppsSrc: boolean;
    hasAppFolder: boolean;
    hasTestFolder: boolean;
    hasTestsFolder: boolean;
    hasUnderscoreTests: boolean;
    hasSpecFiles: boolean;
    hasTestFiles: boolean;
  },
  current: string,
  depth: number,
): void {
  if (depth > 6) return; // bound recursion; deep monorepos still get a useful sample
  let entries: string[];
  try {
    entries = readdirSync(current);
  } catch {
    return;
  }
  for (const name of entries) {
    if (DEFAULT_IGNORE.has(name)) continue;
    const full = join(current, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const rel = relative(root, full).replace(/\\/g, '/');
      if (name === 'src' && depth === 0) state.hasSrc = true;
      if (rel.match(/^packages\/[^/]+\/src$/)) state.hasPackagesSrc = true;
      if (rel.match(/^apps\/[^/]+\/src$/)) state.hasAppsSrc = true;
      if (name === 'app' && depth === 0) state.hasAppFolder = true;
      if (name === 'test' && depth <= 2) state.hasTestFolder = true;
      if (name === 'tests' && depth <= 2) state.hasTestsFolder = true;
      if (name === '__tests__') state.hasUnderscoreTests = true;
      walk(root, state, full, depth + 1);
    } else if (stat.isFile()) {
      const ext = extname(name);
      const lang = LANG_EXT[ext];
      if (lang !== undefined) {
        state.langCounts.set(lang, (state.langCounts.get(lang) ?? 0) + 1);
      }
      if (/\.spec\.(ts|js|tsx|jsx|mts|mjs|cjs)$/.test(name)) state.hasSpecFiles = true;
      if (/\.test\.(ts|js|tsx|jsx|mts|mjs|cjs)$/.test(name)) state.hasTestFiles = true;
      for (const re of PROTECTED_FILENAME_PATTERNS) {
        if (re.test(name)) {
          state.protectedSurfaces.push(relative(root, full).replace(/\\/g, '/'));
          break;
        }
      }
    }
  }
}

function detectPackageManager(root: string): RepoIntrospection['package_manager'] {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'package-lock.json'))) return 'npm';
  if (existsSync(join(root, 'bun.lockb'))) return 'bun';
  if (existsSync(join(root, 'package.json'))) return 'npm'; // default presumption
  return 'unknown';
}

function detectFrameworks(root: string): IntrospectionFramework[] {
  const found: IntrospectionFramework[] = [];
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return found;
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const deps = {
      ...(parsed.dependencies ?? {}),
      ...(parsed.devDependencies ?? {}),
      ...(parsed.peerDependencies ?? {}),
    };
    const seen = new Set<IntrospectionFramework['name']>();
    for (const [dep, fwName] of Object.entries(FRAMEWORK_DEPS)) {
      if (deps[dep] !== undefined && !seen.has(fwName)) {
        found.push({ name: fwName, evidence: `package.json dep: ${dep}` });
        seen.add(fwName);
      }
    }
  } catch {
    // unparseable package.json — leave frameworks empty
  }
  return found;
}

function inferSourceGlobs(state: ScanResult): string[] {
  const out: string[] = [];
  if (state.hasPackagesSrc) out.push('packages/*/src/**');
  if (state.hasAppsSrc) out.push('apps/*/src/**');
  if (state.hasSrc) out.push('src/**');
  if (state.hasAppFolder) out.push('app/**');
  return out.length > 0 ? out : ['src/**'];
}

function inferTestGlobs(state: ScanResult): string[] {
  const out: string[] = [];
  if (state.hasTestFolder) out.push('test/**');
  if (state.hasTestsFolder) out.push('tests/**');
  if (state.hasUnderscoreTests) out.push('**/__tests__/**');
  if (state.hasSpecFiles) out.push('**/*.spec.*');
  if (state.hasTestFiles) out.push('**/*.test.*');
  return out.length > 0 ? out : ['**/*.test.*'];
}

function proposeProjectType(
  frameworks: readonly IntrospectionFramework[],
  pkgManager: RepoIntrospection['package_manager'],
  hasSrc: boolean,
): RepoIntrospection['proposed_project_type'] {
  if (frameworks.some((f) => f.name === 'nestjs' || f.name === 'express' || f.name === 'fastify')) {
    return 'runtime-host';
  }
  if (pkgManager === 'pnpm' && hasSrc && frameworks.length === 0) {
    return 'platform-package';
  }
  if (frameworks.length === 0 && pkgManager === 'unknown') {
    return 'docs-archive';
  }
  return undefined;
}

export interface IntrospectOptions {
  readonly targetRoot: string;
  readonly now?: string;
}

export function introspectRepo(opts: IntrospectOptions): RepoIntrospection {
  const root = opts.targetRoot;
  const state: ScanResult = {
    langCounts: new Map(),
    protectedSurfaces: [],
    hasSrc: false,
    hasPackagesSrc: false,
    hasAppsSrc: false,
    hasAppFolder: false,
    hasTestFolder: false,
    hasTestsFolder: false,
    hasUnderscoreTests: false,
    hasSpecFiles: false,
    hasTestFiles: false,
  };
  walk(root, state, root, 0);

  const pkgManager = detectPackageManager(root);
  const frameworks = detectFrameworks(root);
  const langs: IntrospectionLanguage[] = Array.from(state.langCounts.entries())
    .map(([name, file_count]) => ({ name, file_count }))
    .sort((a, b) => b.file_count - a.file_count);

  const notes: string[] = [];
  if (frameworks.length === 0 && pkgManager !== 'unknown') {
    notes.push(
      'No recognized framework dependency in package.json; project_type may be platform-package or framework',
    );
  }
  if (frameworks.length > 1) {
    notes.push(
      `Multiple frameworks detected (${frameworks.map((f) => f.name).join(', ')}); review proposed_project_type`,
    );
  }
  if (state.hasPackagesSrc && state.hasAppsSrc) {
    notes.push(
      'Both packages/*/src and apps/*/src detected — monorepo with apps; source_globs covers both',
    );
  }

  const proposed = proposeProjectType(frameworks, pkgManager, state.hasSrc || state.hasPackagesSrc);

  const record: RepoIntrospection = {
    schemaVersion: '1.0.0',
    target_root: root,
    generated_at: opts.now ?? new Date().toISOString(),
    package_manager: pkgManager,
    languages: langs,
    frameworks,
    source_globs: inferSourceGlobs(state),
    test_globs: inferTestGlobs(state),
    protected_surfaces: state.protectedSurfaces.sort(),
    existing_devai_config: existsSync(join(root, '.devai/config/project.json')),
    ...(proposed !== undefined && { proposed_project_type: proposed }),
    ...(notes.length > 0 && { notes }),
  };
  return record;
}
