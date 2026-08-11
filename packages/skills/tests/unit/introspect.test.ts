import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { introspectRepo } from '../../src/bootstrap/introspect.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(dirname(HERE));
const REPO_ROOT = dirname(dirname(PKG_ROOT));

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devai-introspect-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('introspectRepo', () => {
  it('detects pnpm via lockfile', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    writeFileSync(join(dir, 'package.json'), '{}');
    const out = introspectRepo({ targetRoot: dir });
    expect(out.package_manager).toBe('pnpm');
  });

  it('detects yarn / npm / bun by lockfile presence', () => {
    const probe = (lockfile: string, expected: string): void => {
      const sub = join(dir, lockfile.replace('.', '_'));
      mkdirSync(sub);
      writeFileSync(join(sub, lockfile), '');
      writeFileSync(join(sub, 'package.json'), '{}');
      const out = introspectRepo({ targetRoot: sub });
      expect(out.package_manager).toBe(expected);
    };
    probe('yarn.lock', 'yarn');
    probe('package-lock.json', 'npm');
    probe('bun.lockb', 'bun');
  });

  it('returns "unknown" when no lockfile or package.json is present', () => {
    const out = introspectRepo({ targetRoot: dir });
    expect(out.package_manager).toBe('unknown');
  });

  it('detects NestJS + Angular from package.json deps', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { '@nestjs/core': '^10', '@angular/core': '^16' },
      }),
    );
    const out = introspectRepo({ targetRoot: dir });
    const names = out.frameworks.map((f) => f.name).sort();
    expect(names).toContain('nestjs');
    expect(names).toContain('angular');
  });

  it('detects TypeScript files via extension', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/index.ts'), 'export {};');
    writeFileSync(join(dir, 'src/foo.tsx'), 'export {};');
    const out = introspectRepo({ targetRoot: dir });
    const ts = out.languages.find((l) => l.name === 'typescript');
    expect(ts?.file_count).toBe(2);
    expect(out.source_globs).toContain('src/**');
  });

  it('detects test files via .test.ts / .spec.ts naming', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'foo.test.ts'), '');
    writeFileSync(join(dir, 'bar.spec.ts'), '');
    const out = introspectRepo({ targetRoot: dir });
    expect(out.test_globs).toContain('**/*.test.*');
    expect(out.test_globs).toContain('**/*.spec.*');
  });

  it('flags protected surfaces (.env, *.pem)', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    writeFileSync(join(dir, '.env.local'), '');
    writeFileSync(join(dir, 'tls.pem'), '');
    const out = introspectRepo({ targetRoot: dir });
    expect(out.protected_surfaces).toContain('.env');
    expect(out.protected_surfaces).toContain('.env.local');
    expect(out.protected_surfaces).toContain('tls.pem');
  });

  it('flags existing_devai_config when .devai/config/project.json present', () => {
    mkdirSync(join(dir, '.devai/config'), { recursive: true });
    writeFileSync(join(dir, '.devai/config/project.json'), '{}');
    const out = introspectRepo({ targetRoot: dir });
    expect(out.existing_devai_config).toBe(true);
  });

  it('proposes runtime-host when NestJS is detected', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { '@nestjs/core': '^10' } }),
    );
    const out = introspectRepo({ targetRoot: dir });
    expect(out.proposed_project_type).toBe('runtime-host');
  });

  it('proposes platform-package for pnpm + src + no frameworks', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    writeFileSync(join(dir, 'package.json'), '{}');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/index.ts'), 'export {};');
    const out = introspectRepo({ targetRoot: dir });
    expect(out.proposed_project_type).toBe('platform-package');
  });

  it('introspects the current repository and finds its pnpm and TypeScript shape', () => {
    const out = introspectRepo({ targetRoot: REPO_ROOT });
    expect(out.package_manager).toBe('pnpm');
    expect(out.languages.find((l) => l.name === 'typescript')?.file_count).toBeGreaterThan(50);
    expect(out.source_globs).toContain('packages/*/src/**');
  });

  // Quiet the unused-import warning when REPO_ROOT happens to be skipped.
  void cpSync;
});
// Invariants: INV-DEVAI-001
