import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { gcStaleInvariantCandidates, suggestInvariants } from '../../src/inv-suggest/index.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'gc recovery ç '));
  roots.push(repoRoot);
  const coverageBodyPath = join(repoRoot, 'coverage.json');
  writeFileSync(coverageBodyPath, JSON.stringify({ unmapped: { routes: ['old-route'] } }));
  const candidate = suggestInvariants({ repoRoot, coverageBodyPath, dryRun: true }).candidates[0];
  if (!candidate) throw new Error('fixture candidate missing');
  const outDir = join(repoRoot, 'candidates');
  mkdirSync(outDir);
  const file = join(outDir, `${candidate.id}.json`);
  const bytes = JSON.stringify(candidate);
  writeFileSync(file, bytes);
  writeFileSync(coverageBodyPath, JSON.stringify({ unmapped: { routes: [] } }));
  return {
    options: { repoRoot, coverageBodyPath, outDir },
    file,
    bytes,
    log: join(outDir, 'gc-evidence.jsonl'),
  };
}

describe('invariant candidate GC recovery', () => {
  it('preserves the candidate and reports an audit append failure', async () => {
    const f = fixture();
    mkdirSync(f.log);
    await withAuthorityHostTestScope(() => {
      expect(() => gcStaleInvariantCandidates(f.options)).toThrow();
      expect(readFileSync(f.file, 'utf8')).toBe(f.bytes);
    });
  });

  it('records stale evidence before removing a candidate and treats a completed retry as empty', async () => {
    const f = fixture();
    await withAuthorityHostTestScope(() => {
      const result = gcStaleInvariantCandidates(f.options);
      expect(result).toMatchObject({ scanned: 1, stale: 1, kept: 0, evidence_log_path: f.log });
      expect(existsSync(f.file)).toBe(false);
      const log = readFileSync(f.log, 'utf8');
      expect(JSON.parse(log)).toEqual(result.evidence[0]);
      expect(gcStaleInvariantCandidates(f.options)).toMatchObject({ scanned: 0, stale: 0 });
      expect(readFileSync(f.log, 'utf8')).toBe(log);
    });
  });
});
