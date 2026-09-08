import { execFileSync, spawnSync } from 'node:child_process';
// Invariants: INV-DEVAI-019
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseHarnessInvariantAlignment } from '../../src/harness-invariant-alignment.js';

const ACTION = 'check --only dependencies';
const CANDIDATE = 'c'.repeat(40);
const NOW = '2026-09-07T12:00:00.000Z';
const RECENT = '2026-09-07T11:00:00.000Z';

let root: string;

/** Single-step workflow whose only gate step runs `script`. */
function workflow(script: string): void {
  writeFileSync(
    join(root, '.github/workflows/ci.yml'),
    `jobs:\n  check:\n    steps:\n      - run: ${script}\n`,
  );
}

function workflowFile(body: string): void {
  writeFileSync(join(root, '.github/workflows/ci.yml'), body);
}

function evidence(command: unknown, file = 'result.json'): void {
  writeFileSync(
    join(root, 'evidence', file),
    JSON.stringify({
      command,
      status: 'pass',
      lifecycle: 'supported',
      candidate_sha: CANDIDATE,
      completed_at: RECENT,
    }),
  );
}

function sense() {
  return senseHarnessInvariantAlignment({
    repoRoot: root,
    candidateHead: CANDIDATE,
    now: NOW,
    evidenceDir: 'evidence',
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-alignment-shell-'));
  for (const path of ['law/invariants', '.github/workflows', 'evidence']) {
    mkdirSync(join(root, path), { recursive: true });
  }
  writeFileSync(
    join(root, 'law/invariants/INV-TEST-001.json'),
    JSON.stringify({ id: 'INV-TEST-001', severity: 'gate', measurable_via: [ACTION] }),
  );
  workflow(`devai ${ACTION}`);
  evidence(`devai ${ACTION}`);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('shell word parsing of gate commands', () => {
  it('establishes the unquoted control on both the CI and the evidence side', () => {
    expect(sense().status).toBe('pass');
  });

  it.each([
    `devai "check" --only 'dependencies'`,
    `devai check --only "depend"'encies'`,
    `devai check --only depend\\encies`,
    `devai   check    --only     dependencies`,
  ])('reads the same action out of an equivalently quoted command: %s', (command) => {
    workflow(command);
    evidence(command);
    expect(sense().status).toBe('pass');
  });

  it.each([`"devai ${ACTION}"`, `'devai ${ACTION}'`])(
    'unwraps a YAML-quoted step scalar before reading the command: %s',
    (scalar) => {
      // Only the step scalar is YAML-quoted here; the recorded evidence command
      // is the shell command itself, where those quotes would name a single
      // executable with spaces in it.
      workflow(scalar);
      evidence(`devai ${ACTION}`);
      expect(sense().status).toBe('pass');
    },
  );

  it('does not read a quoted evidence command as a bare invocation', () => {
    evidence(`"devai ${ACTION}"`);
    expect(sense().status).toBe('review');
  });

  it('reads a quoted executable out of a block-scalar step body', () => {
    // A quoted scalar cannot carry trailing text in flow style, so the quoted
    // executable form only occurs inside a block scalar.
    workflowFile(
      `jobs:\n  check:\n    steps:\n      - run: |\n          "devai" check --only "dependencies"\n`,
    );
    evidence(`"devai" check --only "dependencies"`);
    expect(sense().status).toBe('pass');
  });

  it.each([
    `devai check --only "dependencies`,
    `devai check --only 'dependencies`,
    `devai check --only "dependencies'`,
    `devai check --only dependencies \\`,
    `devai check --only "dependencies\\`,
  ])('refuses a command it cannot split into words: %s', (command) => {
    workflow(command);
    expect(sense().status).toBe('review');
    workflow(`devai ${ACTION}`);
    evidence(command);
    expect(sense().status).toBe('review');
  });

  it('does not let quotes smuggle the action into an unrelated executable', () => {
    workflow(`"grep" devai check --only dependencies README.md`);
    evidence(`"grep" devai check --only dependencies README.md`);
    expect(sense().status).toBe('review');
  });
});

describe('output discarding and gate masking in CI steps', () => {
  it.each([
    `devai ${ACTION} > /dev/null`,
    `devai ${ACTION} >> /dev/null`,
    `devai ${ACTION} >/dev/null`,
    `devai ${ACTION} 1> /dev/null`,
    `devai ${ACTION} 1>>/dev/null`,
    `devai ${ACTION} 2> /dev/null`,
    `devai ${ACTION} 2>>/dev/null`,
  ])('refuses a gate step that discards its output: %s', (script) => {
    workflow(script);
    expect(sense().status).toBe('review');
  });

  it('still accepts a gate step that redirects to a real file', () => {
    workflow(`devai ${ACTION} > report.txt`);
    evidence(`devai ${ACTION} > report.txt`);
    expect(sense().status).toBe('pass');
  });

  it.each([
    `set +e\n          devai ${ACTION}`,
    `devai ${ACTION}\n          set +e`,
    `set +e; devai ${ACTION}`,
    `mkdir -p out && set +e\n          devai ${ACTION}`,
    `set +e && devai ${ACTION}`,
  ])('refuses a gate step whose body disables errexit: %s', (body) => {
    workflowFile(
      `jobs:\n  check:\n    steps:\n      - name: gate\n        run: |\n          ${body}\n`,
    );
    expect(sense().status).toBe('review');
  });

  it.each([`set +e; devai ${ACTION}`, `set +e && devai ${ACTION}`])(
    'refuses an evidence command that recorded a run with errexit dropped: %s',
    (command) => {
      evidence(command);
      expect(sense().status).toBe('review');
    },
  );

  it('keeps accepting the same body when errexit is established rather than dropped', () => {
    workflowFile(
      `jobs:\n  check:\n    steps:\n      - name: gate\n        run: |\n          set -euo pipefail\n          mkdir -p out\n          devai ${ACTION}\n`,
    );
    expect(sense().status).toBe('pass');
  });

  it('refuses the whole step when errexit is dropped in an earlier run line', () => {
    workflowFile(
      `jobs:\n  check:\n    steps:\n      - name: gate\n        run: |\n          set +e\n\n          devai ${ACTION}\n`,
    );
    expect(sense().status).toBe('review');
  });
});

describe('comment-aware reading of gate commands', () => {
  it('drops a trailing YAML comment without losing the command before it', () => {
    workflow(`devai ${ACTION} # gate for INV-TEST-001`);
    expect(sense().status).toBe('pass');
  });

  it('does not treat a quoted hash as the start of a comment', () => {
    workflow(`devai ${ACTION} '#tagged' # gate for INV-TEST-001`);
    expect(sense().status).toBe('pass');
  });

  it('refuses a commented-out gate step', () => {
    workflowFile(
      `jobs:\n  check:\n    steps:\n      - name: gate\n        run: |\n          # devai ${ACTION}\n          echo skipped\n`,
    );
    expect(sense().status).toBe('review');
  });
});

describe('evidence files holding record arrays', () => {
  it('promotes a matching record from an array-valued evidence file', () => {
    rmSync(join(root, 'evidence/result.json'));
    writeFileSync(
      join(root, 'evidence/batch.json'),
      JSON.stringify([
        {
          command: `devai ${ACTION}`,
          status: 'fail',
          candidate_sha: CANDIDATE,
          completed_at: RECENT,
        },
        {
          command: `devai ${ACTION}`,
          status: 'pass',
          candidate_sha: CANDIDATE,
          completed_at: RECENT,
        },
      ]),
    );
    const result = sense();
    expect(result.status).toBe('pass');
    expect(result.metrics).toMatchObject({ evidence_records: 2, misaligned: 0 });
  });

  it('keeps only the object entries of an array-valued evidence file', () => {
    rmSync(join(root, 'evidence/result.json'));
    writeFileSync(
      join(root, 'evidence/batch.json'),
      JSON.stringify([
        `devai ${ACTION}`,
        null,
        7,
        {
          command: `devai ${ACTION}`,
          status: 'pass',
          candidate_sha: CANDIDATE,
          completed_at: RECENT,
        },
      ]),
    );
    const result = sense();
    expect(result.status).toBe('pass');
    expect(result.metrics).toMatchObject({ evidence_records: 1 });
  });

  it('cannot promote a gate from an array holding no evidence object', () => {
    rmSync(join(root, 'evidence/result.json'));
    writeFileSync(join(root, 'evidence/batch.json'), JSON.stringify([`devai ${ACTION}`, null]));
    const result = sense();
    expect(result.status).toBe('review');
    expect(result.metrics).toMatchObject({ evidence_records: 0 });
  });
});

// The shell itself supplies the expected word population; no DEVAI command is executed.
it.each([
  [String.raw`devai check --only "depend\encies"`, ['devai', 'check', '--only', 'depend\\encies']],
  [String.raw`devai "ch\eck" --only dependencies`, ['devai', 'ch\\eck', '--only', 'dependencies']],
])('preserves non-special double-quoted backslashes as the shell does: %s', (command, expected) => {
  const actual = execFileSync('/bin/sh', ['-c', `printf '%s\n' ${command}`], { encoding: 'utf8' })
    .trimEnd()
    .split('\n');
  expect(actual).toEqual(expected);
  workflow(command as string);
  expect(sense().status).toBe('review');
  workflow(`devai ${ACTION}`);
  evidence(command);
  expect(sense().status).toBe('review');
});

it.each([`"set" '+e'`, 'set +eu', 'set +o errexit'])(
  'refuses shell-equivalent errexit disabling on both evidence and workflow: %s',
  (setting) => {
    const shell = spawnSync('/bin/sh', ['-c', `set -e; ${setting}; false; printf disabled`], {
      encoding: 'utf8',
    });
    expect(shell.status).toBe(0);
    expect(shell.stdout).toBe('disabled');
    const command = `${setting}; devai ${ACTION}`;
    workflowFile(`jobs:\n  check:\n    steps:\n      - run: |\n          ${command}\n`);
    expect(sense().status).toBe('review');
    workflow(`devai ${ACTION}`);
    evidence(command);
    expect(sense().status).toBe('review');
  },
);

it.each(['set -- +e', 'set -o errexit', 'set -e'])(
  'does not confuse positional arguments or enabling errexit with disabling it: %s',
  (setting) => {
    const shell = spawnSync('/bin/sh', ['-c', `set -e; ${setting}; false; printf disabled`], {
      encoding: 'utf8',
    });
    expect(shell.status).toBe(1);
    expect(shell.stdout).toBe('');
    const command = `${setting}; devai ${ACTION}`;
    workflowFile(`jobs:\n  check:\n    steps:\n      - run: |\n          ${command}\n`);
    evidence(command);
    expect(sense().status).toBe('pass');
  },
);
