import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { parseConstitutionVersion } from '@devai-nyx/utils';
import { buildSensorReading, type SensorFinding, type SensorReading } from './sensor-reading.js';

/**
 * F5 docs-drift sensor (D-108; F5×T3). Per design note at
 * docs/theory/architecture/sensors/docs_drift.md: cross-checks
 * machine-derivable prose claims in the reference documents against
 * ground truth. A factually wrong reference claim is reference-signal
 * drift (Article 2), so any confirmed mismatch is FAIL, not REVIEW.
 */

export interface DocsDriftOptions {
  readonly repoRoot: string;
  /** Files scanned for count/range claims. Default README.md + CLAUDE.md. */
  readonly claimFiles?: readonly string[];
  /** Directory whose *.schema.json population is the schema-count ground truth. */
  readonly schemasDir?: string;
  /**
   * Path (relative to repoRoot) of the source file carrying the
   * `WORKTREE_CAP` constant. Absent → auto-detect DEVAI's canonical
   * source path; the check remains disabled only for adopters that do
   * not carry DEVAI's core source.
   */
  readonly worktreeCapSource?: string;
  readonly now?: string;
}

const DEFAULT_CLAIM_FILES = ['README.md', 'CLAUDE.md'] as const;
const DEFAULT_SCHEMAS_DIR = 'law/schemas';
const SELF_WORKTREE_CAP_SOURCE = 'packages/loop/src/worktrees.ts';

const SCHEMA_COUNT_CLAIM = /(\d+)\s+JSON Schema files?/gi;
const D_RANGE_CLAIM = /D-1\s*(?:…|\.{2,3})\s*D-(\d+)/g;
const CAP_PROSE = /capped at (\w+)/i;
const CAP_CONSTANT = /WORKTREE_CAP\s*=\s*(\d+)/;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function readIfPresent(repoRoot: string, rel: string): string | null {
  const path = join(repoRoot, rel);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

export function senseDocsDrift(opts: DocsDriftOptions): SensorReading {
  const claimFiles = opts.claimFiles ?? DEFAULT_CLAIM_FILES;
  const schemasDir = opts.schemasDir ?? DEFAULT_SCHEMAS_DIR;
  const findings: SensorFinding[] = [];
  let claimsChecked = 0;
  const worktreeCapSource =
    opts.worktreeCapSource ??
    (existsSync(join(opts.repoRoot, SELF_WORKTREE_CAP_SOURCE))
      ? SELF_WORKTREE_CAP_SOURCE
      : undefined);

  // Check 1 — schema-count claims vs the *.schema.json population.
  const schemasPath = join(opts.repoRoot, schemasDir);
  const schemaCount = existsSync(schemasPath)
    ? readdirSync(schemasPath).filter((f) => f.endsWith('.schema.json')).length
    : 0;
  for (const file of claimFiles) {
    const body = readIfPresent(opts.repoRoot, file);
    if (body === null) {
      findings.push({
        severity: 'info',
        code: 'DOCS_DRIFT_CLAIM_FILE_ABSENT',
        message: `${file} not present; skipped.`,
        file,
      });
      continue;
    }
    let matched = false;
    for (const m of body.matchAll(SCHEMA_COUNT_CLAIM)) {
      matched = true;
      claimsChecked += 1;
      const claimed = Number(m[1]);
      if (claimed !== schemaCount) {
        findings.push({
          severity: 'error',
          code: 'DOCS_DRIFT_SCHEMA_COUNT',
          message: `${file} claims ${String(claimed)} JSON Schema files; ${schemasDir} contains ${String(schemaCount)}.`,
          file,
        });
      }
    }
    if (!matched) {
      findings.push({
        severity: 'info',
        code: 'DOCS_DRIFT_NO_SCHEMA_COUNT_CLAIM',
        message: `${file} carries no schema-count claim (preferred state).`,
        file,
      });
    }
  }

  // Check 2 — decision-log range claims vs the highest canonical register heading.
  const decisionRegister = readIfPresent(opts.repoRoot, 'law/register/DECISIONS.md');
  const readmeBody = readIfPresent(opts.repoRoot, 'README.md');
  if (decisionRegister !== null && readmeBody !== null) {
    const maxEntry = [...decisionRegister.matchAll(/^### DII-(\d+)/gmu)].reduce(
      (highest, match) => Math.max(highest, Number(match[1])),
      0,
    );
    let matched = false;
    for (const m of readmeBody.matchAll(D_RANGE_CLAIM)) {
      matched = true;
      claimsChecked += 1;
      const claimed = Number(m[1]);
      if (claimed !== maxEntry) {
        findings.push({
          severity: 'error',
          code: 'DOCS_DRIFT_DECISION_RANGE',
          message: `README.md claims the decision log runs to D-${String(claimed)}; the highest entry is D-${String(maxEntry)}.`,
          file: 'README.md',
        });
      }
    }
    if (!matched) {
      findings.push({
        severity: 'info',
        code: 'DOCS_DRIFT_NO_DECISION_RANGE_CLAIM',
        message: 'README.md carries no decision-range claim (preferred state).',
        file: 'README.md',
      });
    }
  }

  // Check 3 — Article 27 cap prose vs the WORKTREE_CAP constant.
  const constitutionBody = readIfPresent(opts.repoRoot, 'law/constitution.md');
  if (constitutionBody === null) {
    findings.push({
      severity: 'critical',
      code: 'DOCS_DRIFT_CONSTITUTION_NOT_FOUND',
      message: 'law/constitution.md is required for DEVAI docs-drift checks.',
      file: 'law/constitution.md',
    });
  }
  if (worktreeCapSource === undefined) {
    findings.push({
      severity: 'info',
      code: 'DOCS_DRIFT_CAP_CHECK_DISABLED',
      message: 'worktree_cap_source not configured; cap-coherence check skipped.',
    });
  } else if (constitutionBody !== null) {
    const sourceBody = readIfPresent(opts.repoRoot, worktreeCapSource);
    // Scan only the live articles: the amendment history legitimately
    // quotes superseded prose (Article 40 requires prior text verbatim).
    const liveBody = constitutionBody.split(/^## Amendment history$/m)[0] ?? constitutionBody;
    const capProse = CAP_PROSE.exec(liveBody);
    if (sourceBody === null) {
      findings.push({
        severity: 'error',
        code: 'DOCS_DRIFT_CAP_SOURCE_NOT_FOUND',
        message: `worktree_cap_source ${worktreeCapSource} not found.`,
        file: worktreeCapSource,
      });
    } else if (capProse === null) {
      // 0.3.0 expected state: the constitution states no number.
      findings.push({
        severity: 'info',
        code: 'DOCS_DRIFT_CONSTITUTION_NO_CAP_VALUE',
        message: 'law/constitution.md states no cap value (cap is policy; preferred state).',
        file: 'law/constitution.md',
      });
    } else {
      claimsChecked += 1;
      const word = (capProse[1] ?? '').toLowerCase();
      const claimed = NUMBER_WORDS[word] ?? Number(word);
      const constant = CAP_CONSTANT.exec(sourceBody);
      const actual = constant === null ? Number.NaN : Number(constant[1]);
      if (Number.isNaN(claimed) || Number.isNaN(actual) || claimed !== actual) {
        findings.push({
          severity: 'error',
          code: 'DOCS_DRIFT_WORKTREE_CAP',
          message: `law/constitution.md states a cap of ${capProse[1] ?? '?'}; ${worktreeCapSource} enforces WORKTREE_CAP = ${constant?.[1] ?? '(not found)'}.`,
          file: 'law/constitution.md',
        });
      }
    }
  }

  // Check 4 — constitution version header vs the pinned snapshot.
  const snapshotBody = readIfPresent(opts.repoRoot, '.devai/pin/constitution.md');
  if (constitutionBody !== null && snapshotBody !== null) {
    const livePath = join(opts.repoRoot, 'law/constitution.md');
    const snapshotPath = join(opts.repoRoot, '.devai/pin/constitution.md');
    if (realpathSync(livePath) === realpathSync(snapshotPath)) {
      findings.push({
        severity: 'info',
        code: 'DOCS_DRIFT_CONSTITUTION_SELF_PIN',
        message: '.devai/pin/constitution.md resolves to the canonical Constitution.',
        file: '.devai/pin/constitution.md',
      });
    } else {
      const live = parseConstitutionVersion(constitutionBody);
      const pinned = parseConstitutionVersion(snapshotBody);
      if (live !== null && pinned !== null) claimsChecked += 1;
      if (live === null || pinned === null || live !== pinned) {
        findings.push({
          severity: 'error',
          code: 'DOCS_DRIFT_CONSTITUTION_VERSION',
          message: `law/constitution.md is at ${live ?? '(no version)'}; .devai/pin/constitution.md pins ${pinned ?? '(no version)'}.`,
          file: '.devai/pin/constitution.md',
        });
      }
    }
  } else if (constitutionBody !== null) {
    findings.push({
      severity: 'info',
      code: 'DOCS_DRIFT_NO_SNAPSHOT',
      message: '.devai/pin/constitution.md not present; version-coherence check skipped.',
    });
  }

  // Check 5 (R18.C.7, D-133/H3) — narrative-page version claims. status.md
  // went a full minor stale ("preparing 0.4.0 in Round 15") before an
  // external audit caught it; SECURITY.md's supported-line was rewritten
  // version-free for the same reason. Guard both shapes.
  const statusBody = readIfPresent(opts.repoRoot, 'docs/start/status.md');
  if (statusBody !== null && constitutionBody !== null) {
    claimsChecked += 1;
    const constClaim = /Constitution \*\*(\d+\.\d+\.\d+)\*\*/.exec(statusBody)?.[1];
    const live = parseConstitutionVersion(constitutionBody);
    if (constClaim !== undefined && (live === null || constClaim !== live)) {
      findings.push({
        severity: 'error',
        code: 'DOCS_DRIFT_STATUS_CONSTITUTION_VERSION',
        message: `docs/start/status.md claims Constitution ${constClaim}; law/constitution.md is at ${live}.`,
        file: 'docs/start/status.md',
      });
    }
    const lineClaim = /\*\*(\d+\.\d+)\.x\*\*/.exec(statusBody)?.[1];
    const pkgBody = readIfPresent(opts.repoRoot, 'packages/cli/package.json');
    const pkgMinor = pkgBody === null ? undefined : /"version":\s*"(\d+\.\d+)\./.exec(pkgBody)?.[1];
    if (lineClaim !== undefined && pkgMinor !== undefined && lineClaim !== pkgMinor) {
      findings.push({
        severity: 'error',
        code: 'DOCS_DRIFT_STATUS_PACKAGE_LINE',
        message: `docs/start/status.md claims the ${lineClaim}.x line; @devai-nyx/* packages are at ${pkgMinor}.x.`,
        file: 'docs/start/status.md',
      });
    }
  }
  const securityBody = readIfPresent(opts.repoRoot, 'SECURITY.md');
  if (securityBody !== null) {
    claimsChecked += 1;
    // The supported-versions sentence must stay version-free: a hardcoded
    // "N.M.x" immediately after "target the current" is the exact stale
    // shape the R18 rewrite removed.
    if (/target the current \d+\.\d+\.x/.test(securityBody)) {
      findings.push({
        severity: 'error',
        code: 'DOCS_DRIFT_SECURITY_HARDCODED_LINE',
        message:
          'SECURITY.md hardcodes a supported version line ("target the current N.M.x"); keep the sentence version-free.',
        file: 'SECURITY.md',
      });
    }
  }

  const driftCount = findings.filter(
    (finding) => finding.severity === 'error' || finding.severity === 'critical',
  ).length;

  return buildSensorReading({
    sensorName: 'docs-drift',
    sensorKind: 'docs_drift',
    command: ['devai', 'sense-docs-drift'],
    status: driftCount === 0 ? 'pass' : 'fail',
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      schema_file_count: schemaCount,
      claims_checked: claimsChecked,
      drift_count: driftCount,
    },
  });
}
