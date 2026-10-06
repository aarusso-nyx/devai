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

it.each([
  `echo "before; devai ${ACTION}; after"`,
  `echo 'before; devai ${ACTION}; after'`,
  `echo "before && devai ${ACTION} && after"`,
  `echo ignored # before; devai ${ACTION}; after`,
  String.raw`echo "before\"; devai ${ACTION}; after"`,
])('does not treat quoted command-looking text as an executed gate: %s', (command) => {
  workflow(command);
  expect(sense().status).toBe('review');
  workflow(`devai ${ACTION}`);
  evidence(command);
  expect(sense().status).toBe('review');
});

it.each([';', '&&'])(
  'recognizes an actual unquoted gate after %s rather than quoted text',
  (separator) => {
    const command = `echo before ${separator} devai ${ACTION}`;
    workflow(command);
    evidence(command);
    expect(sense().status).toBe('pass');
  },
);

it('ends shell comments at a newline so a following real gate remains visible', () => {
  const command = `echo ignored # explanation; not an executable\ndevai ${ACTION}`;
  workflowFile(
    `jobs:\n  check:\n    steps:\n      - run: |\n          ${command.replaceAll('\n', '\n          ')}\n`,
  );
  evidence(command);
  expect(sense().status).toBe('pass');
});

it('does not mistake a hash inside an ordinary shell word for a comment', () => {
  const command = `echo before#tag; devai ${ACTION}`;
  workflow(command);
  evidence(command);
  expect(sense().status).toBe('pass');
});

describe('hashes and escaped quote boundaries', () => {
  it.each([2, 4])('closes a quote after %i backslashes before a real comment', (count) => {
    const command = `devai ${ACTION} --root "C:${'\\'.repeat(count)}"`;
    workflow(`${command} # explanatory || true text`);
    evidence(command);
    expect(sense().status).toBe('pass');
  });

  it.each(['v1#rc', 'dist/report#1.json'])('retains masking after a hash within %s', (word) => {
    workflow(`devai ${ACTION} --out ${word} || true`);
    expect(sense().status).toBe('review');
    workflow(`devai ${ACTION}`);
    evidence(`devai ${ACTION} --out ${word} || true`);
    expect(sense().status).toBe('review');
  });
});

describe('folded workflow commands', () => {
  it.each(['>', '>-'])('does not credit a folded failure-masking command (%s)', (style) => {
    workflow(`${style}\n          devai ${ACTION}\n          || true`);
    expect(sense().status).toBe('review');
  });

  it('joins folded action arguments into one binding invocation', () => {
    workflow(`>\n          devai check\n          --only dependencies`);
    expect(sense().status).toBe('pass');
  });
});

/** A block-scalar gate step whose body is `lines`, indented as a workflow writes it. */
function blockStep(lines: readonly string[]): void {
  workflowFile(
    `jobs:\n  check:\n    steps:\n      - run: |\n${lines.map((line) => `          ${line}`).join('\n')}\n`,
  );
}

const NODE_PROGRAM = [
  `const manifest = JSON.parse(require('node:fs').readFileSync('package.json', 'utf8'));`,
  `if (manifest.name !== 'fixture') throw new Error('identity');`,
  `for (const key of Object.keys(manifest)) {`,
  `  if (key === '') throw new Error('key');`,
  `}`,
];

describe('here-document bodies in gate steps (ADR-SCR-0013)', () => {
  it('reads the body of a heredoc fed to a program as input, not as shell control flow', () => {
    blockStep(['set -euo pipefail', `node - <<'NODE'`, ...NODE_PROGRAM, 'NODE', `devai ${ACTION}`]);
    expect(sense().status).toBe('pass');
  });

  it.each([`<<NODE`, `<<"NODE"`, `<<\\NODE`])('accepts the %s delimiter spelling', (operator) => {
    blockStep([
      'set -euo pipefail',
      `node - ${operator}`,
      ...NODE_PROGRAM,
      'NODE',
      `devai ${ACTION}`,
    ]);
    expect(sense().status).toBe('pass');
  });

  it('strips leading tabs from the terminator of a <<- heredoc', () => {
    blockStep([`node - <<-NODE`, ...NODE_PROGRAM, '\tNODE', `devai ${ACTION}`]);
    expect(sense().status).toBe('pass');
  });

  it.each([`bash <<'SH'`, `sh -s <<'SH'`, `cat <<'SH' | bash`, `eval "$(cat <<'SH'`])(
    'keeps the control flow of a heredoc a shell executes: %s',
    (opener) => {
      blockStep([
        opener,
        'if [ -n "$CI" ]; then devai check --only dependencies; fi',
        'SH',
        `devai ${ACTION}`,
      ]);
      expect(sense().status).toBe('review');
    },
  );

  it('does not credit a devai command written inside a program heredoc', () => {
    blockStep([`node - <<'NODE'`, `devai ${ACTION}`, 'NODE', 'echo done']);
    expect(sense().status).toBe('review');
  });

  it('leaves an unterminated heredoc unchanged, so its control flow stays visible', () => {
    blockStep([`node - <<'NODE'`, ...NODE_PROGRAM, `devai ${ACTION}`]);
    expect(sense().status).toBe('review');
  });

  it('reads a here-string and an arithmetic shift as neither opening a body', () => {
    blockStep([`cat <<< "if (x) {"`, 'echo $((1 << 2))', 'if true; then :; fi', `devai ${ACTION}`]);
    expect(sense().status).toBe('review');
    blockStep([`cat <<< "x"`, 'echo $((1 << 2))', `devai ${ACTION}`]);
    expect(sense().status).toBe('pass');
  });

  it.each([`cat <<'SH' > gate.sh`, `cat <<'SH' >> gate.sh`, `cat <<'SH' | tee gate.sh`])(
    'keeps the body of a heredoc written onward, which a later line may run: %s',
    (opener) => {
      blockStep(['set -euo pipefail', opener, 'set +e', 'SH', '. ./gate.sh', `devai ${ACTION}`]);
      expect(sense().status).toBe('review');
    },
  );

  it.each([
    [`cat <<'SH' \\`, '  > gate.sh'],
    [`cat > gate.sh \\`, `  <<'SH'`],
    [`cat <<'SH' \\`, '  | tee gate.sh'],
    [`cat <<'SH' \\`, '  | bash'],
  ])('judges a heredoc opener continued across lines as one command: %s / %s', (first, second) => {
    blockStep([
      'set -euo pipefail',
      first,
      second,
      'set +e',
      'SH',
      '. ./gate.sh',
      `devai ${ACTION}`,
    ]);
    expect(sense().status).toBe('review');
  });

  it('starts a continued program heredoc body after its last continuation line', () => {
    blockStep([
      'set -euo pipefail',
      'node - \\',
      `  "$ARGUMENT" <<'NODE'`,
      ...NODE_PROGRAM,
      'NODE',
      `devai ${ACTION}`,
    ]);
    expect(sense().status).toBe('pass');
  });

  it('keeps errexit masking inside a shell heredoc visible', () => {
    blockStep([`bash <<'SH'`, 'set +e', 'SH', `devai ${ACTION}`]);
    expect(sense().status).toBe('review');
  });
});

describe('in-process observations of read-only actions (ADR-SCR-0013)', () => {
  function observed(status: 'pass' | 'fail', candidate = CANDIDATE, completedAt = RECENT) {
    rmSync(join(root, 'evidence', 'result.json'), { force: true });
    return senseHarnessInvariantAlignment({
      repoRoot: root,
      candidateHead: CANDIDATE,
      now: NOW,
      evidenceDir: 'evidence',
      observations: [
        {
          command: `devai ${ACTION}`,
          status,
          candidate_sha: candidate,
          completed_at: completedAt,
        },
      ],
    });
  }

  it('accepts a passing candidate-bound observation as the action evidence', () => {
    expect(observed('pass').status).toBe('pass');
  });

  it('refuses a failing, foreign-candidate, stale or future observation', () => {
    expect(observed('fail').status).toBe('review');
    expect(observed('pass', 'd'.repeat(40)).status).toBe('review');
    expect(observed('pass', CANDIDATE, '2026-09-05T11:00:00.000Z').status).toBe('review');
    expect(observed('pass', CANDIDATE, '2026-09-07T13:00:00.000Z').status).toBe('review');
  });

  it('still requires the fail-closed CI step for the observed action', () => {
    workflow(`devai ${ACTION} || true`);
    expect(observed('pass').status).toBe('review');
  });

  // #235: two gate invariants list the same action; an observation that names the
  // invariant it measures aligns that one only and never stands in for the other.
  it('aligns only the invariants an observation names', () => {
    writeFileSync(
      join(root, 'law/invariants/INV-TEST-002.json'),
      JSON.stringify({ id: 'INV-TEST-002', severity: 'gate', measurable_via: [ACTION] }),
    );
    rmSync(join(root, 'evidence', 'result.json'), { force: true });
    const scoped = (invariantIds?: readonly string[]) =>
      senseHarnessInvariantAlignment({
        repoRoot: root,
        candidateHead: CANDIDATE,
        now: NOW,
        evidenceDir: 'evidence',
        observations: [
          {
            command: `devai ${ACTION}`,
            status: 'pass',
            candidate_sha: CANDIDATE,
            completed_at: RECENT,
            ...(invariantIds !== undefined && { invariant_ids: invariantIds }),
          },
        ],
      });
    const one = scoped(['INV-TEST-002']);
    expect(one.status).toBe('review');
    expect(one.metrics).toMatchObject({ gate_invariants: 2, misaligned: 1 });
    expect((one.findings ?? []).map((finding) => finding.message).join('\n')).toContain(
      'INV-TEST-001',
    );
    expect((one.findings ?? []).map((finding) => finding.message).join('\n')).not.toContain(
      'INV-TEST-002',
    );
    expect(scoped(['INV-TEST-001', 'INV-TEST-002']).status).toBe('pass');
    expect(scoped().status).toBe('pass');
    expect(scoped([]).status).toBe('review');
  });
});

// #235 Codex review: a scoped producer aligns its invariant only through its exact CI
// invocation and its own passing observation; another invocation of the same action, or
// persisted evidence for it, never stands in.
describe('scoped producers (#235)', () => {
  const PRODUCER = {
    invariant_id: 'INV-TEST-001',
    action: ACTION,
    arguments: ['check', '--only', 'dependencies', '--file', 'fixture.json'],
  };
  const COMMAND = `devai ${PRODUCER.arguments.join(' ')}`;
  function scopedSense(status: 'pass' | 'fail' = 'pass', invariant = 'INV-TEST-001') {
    return senseHarnessInvariantAlignment({
      repoRoot: root,
      candidateHead: CANDIDATE,
      now: NOW,
      evidenceDir: 'evidence',
      scopedProducers: [PRODUCER],
      observations: [
        {
          command: COMMAND,
          status,
          candidate_sha: CANDIDATE,
          completed_at: RECENT,
          invariant_ids: [invariant],
        },
      ],
    });
  }

  it('aligns through the exact invocation, the output format aside', () => {
    workflow(`${COMMAND} --format human`);
    expect(scopedSense().status).toBe('pass');
  });

  it('refuses another invocation of the same action in CI, with generic evidence passing', () => {
    workflow(`devai ${ACTION}`);
    expect(sense().status).toBe('pass');
    expect(scopedSense().status).toBe('review');
    workflow(`devai check --only dependencies --file other.json`);
    expect(scopedSense().status).toBe('review');
  });

  it('refuses a failing or foreign-scoped observation even beside passing persisted evidence', () => {
    workflow(COMMAND);
    evidence(COMMAND);
    expect(scopedSense('fail').status).toBe('review');
    expect(scopedSense('pass', 'INV-TEST-002').status).toBe('review');
  });
});
