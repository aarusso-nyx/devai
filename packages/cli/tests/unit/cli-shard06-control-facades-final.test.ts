import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkCiEconomy, parseTriggers } from '../../src/commands/check/ci-economy.js';

const roots: string[] = [];

function temporary(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function put(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('S06-C final observable control boundaries', () => {
  it('does not interpret an embedded trigger-like token as a block key', () => {
    expect([...parseTriggers('on:\n  ignored push:\nname: boundary')]).toEqual([]);
  });

  it('accepts protected verifier copies separated by more than one whitespace byte', () => {
    const root = temporary('devai-s06c-final-copy-');
    put(
      root,
      '.github/workflows/gate.yml',
      `on: workflow_dispatch
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: |
          actual_provenance_sha256=x
          VERIFIER_PROVENANCE_SHA256=\${{ vars.DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256 }}
          test "$actual_provenance_sha256" = "$VERIFIER_PROVENANCE_SHA256"
          cp -R "$source_root/schemas"  "$source_root/src" "$verifier_root/"
          node "$DEVAI_EVIDENCE_VERIFY"
`,
    );

    expect(
      checkCiEconomy({ repoRoot: root }).findings.find(
        (finding) => finding.ruleId === 'ci-economy.evidence-gate-wired',
      )?.severity,
    ).toBe('pass');
  });

  it('accepts a pull-request cancellation expression without padding before its close', () => {
    const root = temporary('devai-s06c-final-cancel-');
    put(
      root,
      '.github/workflows/pr.yml',
      `on: pull_request
concurrency:
  cancel-in-progress: \${{ github.event_name == 'pull_request'}}
jobs:
  test:
    runs-on: ubuntu-latest
`,
    );

    expect(
      checkCiEconomy({ repoRoot: root }).findings.find(
        (finding) => finding.ruleId === 'ci-economy.concurrency-cancel',
      )?.severity,
    ).toBe('pass');
  });
});
