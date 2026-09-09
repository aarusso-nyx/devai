import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDocsGovernanceCmd } from '../../src/commands/check/docs-governance.js';

interface Options {
  readonly repoRoot?: string;
  readonly skipPublishCheck?: boolean;
  readonly human?: boolean;
}

interface Chain {
  option(flag: string, description?: string): Chain;
  action(callback: (options: Options) => void): Chain;
}

let callback: ((options: Options) => void) | undefined;
let root = '';

function register(): void {
  const command: Chain = {
    option: () => command,
    action: (next) => {
      callback = next;
      return command;
    },
  };
  checkDocsGovernanceCmd.register({ command: () => command } as unknown as CAC);
}

function write(relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`TEST_PROCESS_EXIT:${String(code)}`);
  }
}

function invoke(options: Options): { readonly stdout: string; readonly exit: number } {
  register();
  if (callback === undefined) throw new Error('DOCS_GOVERNANCE_CALLBACK_NOT_REGISTERED');
  const originalWrite = process.stdout.write;
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  let stdout = '';
  let exit = 0;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.exit = ((code?: string | number | null) => {
    exit = typeof code === 'number' ? code : 0;
    throw new ExitSignal(exit);
  }) as typeof process.exit;
  process.exitCode = undefined;
  try {
    expect(() => callback?.(options)).toThrowError(ExitSignal);
  } finally {
    process.stdout.write = originalWrite;
    process.exit = originalExit;
    process.exitCode = originalExitCode;
  }
  return { stdout, exit };
}

afterEach(() => {
  callback = undefined;
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('check docs-governance command shell and placeholder rule', () => {
  it('emits a JSON report and fail exit for a placeholder Docusaurus configuration', () => {
    root = mkdtempSync(join(tmpdir(), 'devai-docs-governance-shell-'));
    write(
      '.devai/config/project.json',
      JSON.stringify({
        repo: { kind: 'application' },
        docs: { builder: 'docusaurus', build_command: '' },
      }),
    );
    write(
      'docs/site/docusaurus.config.ts',
      'url: "https://example.invalid"\norganizationName: "devai-org"\n',
    );
    const result = invoke({ repoRoot: root, skipPublishCheck: true });
    const report = JSON.parse(result.stdout) as {
      verdict: string;
      fail_count: number;
      findings: Array<{ ruleId: string; severity: string; message: string }>;
    };
    expect(result.exit).toBe(2);
    expect(report.verdict).toBe('fail');
    expect(report.fail_count).toBeGreaterThan(0);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        ruleId: 'docs-governance.config-not-placeholder',
        severity: 'fail',
      }),
    );
    expect(
      report.findings.find((finding) => finding.ruleId === 'docs-governance.config-not-placeholder')
        ?.message,
    ).toContain('example.invalid');
  });

  it('renders the human shell with rule counts and remediation for missing configuration', () => {
    root = mkdtempSync(join(tmpdir(), 'devai-docs-governance-shell-'));
    const result = invoke({ repoRoot: root, skipPublishCheck: true, human: true });
    expect(result.exit).toBe(2);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^check docs-governance: FAIL \(\d+ rules, \d+ fail, \d+ warn\)$/);
    expect(result.stdout).toContain('docs-governance.classification');
    expect(result.stdout).toContain('Remediation:');
    expect(result.stdout).toContain('Locations:');
  });

  it('distinguishes non-placeholder metadata from placeholder values', () => {
    root = mkdtempSync(join(tmpdir(), 'devai-docs-governance-shell-'));
    write(
      '.devai/config/project.json',
      JSON.stringify({
        repo: { kind: 'application' },
        docs: { builder: 'docusaurus', build_command: '' },
      }),
    );
    write(
      'docs/site/docusaurus.config.js',
      'url: "https://docs.acme.test"\norganizationName: "acme"\n',
    );
    const result = invoke({ repoRoot: root, skipPublishCheck: true });
    const report = JSON.parse(result.stdout) as {
      findings: Array<{ ruleId: string; severity: string; message: string }>;
    };
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        ruleId: 'docs-governance.config-not-placeholder',
        severity: 'pass',
        message: expect.stringContaining('has no placeholder'),
      }),
    );
  });
});
