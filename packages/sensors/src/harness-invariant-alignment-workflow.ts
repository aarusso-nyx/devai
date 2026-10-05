import { readFileSync } from 'node:fs';
import { foldWorkflowLines } from './harness/folded-lines.js';

function actionSpellings(action: string): readonly (readonly string[])[] {
  // Preserve the pre-R18 dashed spelling bridge, but require either spelling
  // to occupy the action position after a recognized DEVAI launcher.
  const words = action.trim().split(/\s+/).filter(Boolean);
  return [words, [words.join('-')]];
}

interface WorkflowRunStep {
  readonly script: string;
  readonly continueOnError: boolean;
  readonly disabled: boolean;
}

function stripYamlComment(line: string): string {
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (double && char === '\\') {
      // Consume escape pairs: an even run leaves the next quote unescaped.
      i += 1;
      continue;
    }
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single) double = !double;
    else if (char === '#' && !single && !double && (i === 0 || /\s/.test(line[i - 1] ?? '')))
      return line.slice(0, i).trimEnd();
  }
  return line;
}

function unquoteYamlScalar(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Extract run steps with the one piece of step metadata that changes their
 * gate semantics. This intentionally remains a small, line-anchored YAML
 * reader like workflow-parser.ts; adding a second YAML dependency just for
 * this sensor would be disproportionate.
 */
export function extractRunSteps(content: string): WorkflowRunStep[] {
  const lines = content.split('\n');
  const steps: WorkflowRunStep[] = [];

  for (let start = 0; start < lines.length; start += 1) {
    const first = lines[start] ?? '';
    const startMatch = first.match(/^(\s*)-\s+(?:name|id|run|uses|continue-on-error)\s*:/);
    if (startMatch === null) continue;
    const stepIndent = startMatch[1]?.length ?? 0;
    let end = start + 1;
    while (end < lines.length) {
      const line = lines[end] ?? '';
      const next = line.match(/^(\s*)-\s+/);
      if (next !== null && (next[1]?.length ?? 0) <= stepIndent) break;
      const nonEmpty = line.trim();
      const indentation = line.length - line.trimStart().length;
      if (nonEmpty !== '' && indentation < stepIndent) break;
      end += 1;
    }

    const block = lines.slice(start, end);
    const continueOnErrorLine = block.find((line) =>
      /^\s*(?:-\s+)?continue-on-error\s*:/.test(line),
    );
    const continueOnError =
      continueOnErrorLine !== undefined &&
      !/^\s*(?:-\s+)?continue-on-error\s*:\s*(?:false|['"]false['"])(?:\s|#|$)/i.test(
        continueOnErrorLine,
      );
    const disabled = block.some((line) => {
      const condition = stripYamlComment(line).match(/^\s*(?:-\s+)?if\s*:\s*(.*?)\s*$/)?.[1];
      return (
        condition !== undefined &&
        /^(?:false|\$\{\{\s*false\s*\}\})(?:\s|#|$)/i.test(unquoteYamlScalar(condition))
      );
    });
    for (let offset = 0; offset < block.length; offset += 1) {
      const line = stripYamlComment(block[offset] ?? '');
      const runMatch = line.match(/^\s*(?:-\s+)?run\s*:\s*(.*)$/);
      if (runMatch === null) continue;
      const raw = (runMatch[1] ?? '').trim();
      if (/^(?:\||>|\|-|>-)?$/.test(raw)) {
        const runIndent = line.length - line.trimStart().length;
        const body: string[] = [];
        for (let bodyIndex = offset + 1; bodyIndex < block.length; bodyIndex += 1) {
          const bodyLine = block[bodyIndex] ?? '';
          const indentation = bodyLine.length - bodyLine.trimStart().length;
          if (bodyLine.trim() !== '' && indentation <= runIndent) break;
          body.push(bodyLine.slice(Math.min(bodyLine.length, runIndent + 2)));
        }
        steps.push({
          script: raw.startsWith('>') ? foldWorkflowLines(body) : body.join('\n'),
          continueOnError,
          disabled,
        });
      } else {
        steps.push({ script: unquoteYamlScalar(raw), continueOnError, disabled });
      }
      break;
    }
    start = end - 1;
  }

  return steps;
}

export function loadRunSteps(workflowFiles: readonly string[]): WorkflowRunStep[] {
  const steps: WorkflowRunStep[] = [];
  for (const file of workflowFiles) {
    try {
      steps.push(...extractRunSteps(readFileSync(file, 'utf8')));
    } catch {
      // Workflow parser already treats unreadable files as absent.
    }
  }
  return steps;
}

/** Programs whose here-document body is itself shell, so it keeps its control flow. */
const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'dash', 'ash', 'ksh', 'zsh', 'busybox']);
const SHELL_EVALUATORS = new Set(['eval', 'source', '.', 'exec']);

interface HeredocOperator {
  readonly delimiter: string;
  readonly stripTabs: boolean;
}

interface HeredocLine {
  readonly operators: readonly HeredocOperator[];
  /** The line pipes or redirects output onward, so a body may be run by a later line. */
  readonly onward: boolean;
}

/**
 * The here-document operators of one line, in order. `<<<` is a here-string and
 * `<<` inside `$((` arithmetic is a shift, so neither opens a body. A line whose
 * quoting cannot be followed yields null so the caller keeps the script unchanged.
 */
function heredocLine(line: string): HeredocLine | null {
  const operators: HeredocOperator[] = [];
  let onward = false;
  let single = false;
  let double = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (single) {
      if (char === "'") single = false;
      continue;
    }
    if (double) {
      if (char === '\\') index += 1;
      else if (char === '"') double = false;
      continue;
    }
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === "'") single = true;
    else if (char === '"') double = true;
    else if (char === '#' && (index === 0 || /\s/.test(line[index - 1] ?? ''))) break;
    else if (char === '|' || char === '>') onward = true;
    else if (char === '<' && line[index + 1] === '<') {
      if (line[index + 2] === '<') {
        index += 2;
        continue;
      }
      const before = line.slice(0, index);
      if ((before.match(/\$\(\(/g) ?? []).length > (before.match(/\)\)/g) ?? []).length) {
        index += 1;
        continue;
      }
      const rest = line.slice(index + 2);
      const match = rest.match(/^(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|((?:\\.|[^\s;&|<>()'"])+))/);
      if (match === null) return null;
      const delimiter = match[2] ?? match[3] ?? (match[4] ?? '').replace(/\\(.)/g, '$1');
      if (delimiter === '') return null;
      operators.push({ delimiter, stripTabs: match[1] === '-' });
      index += 1 + match[0].length;
    }
  }
  return single || double ? null : { operators, onward };
}

function feedsShell(line: string): boolean {
  return line
    .split(/[\s;&|()<>]+/)
    .map((token) => executableName(token.replace(/^['"]|['"]$/g, '')))
    .some((name) => SHELL_INTERPRETERS.has(name) || SHELL_EVALUATORS.has(name));
}

/**
 * Remove the bodies of here-documents fed to a program other than a shell
 * (ADR-SCR-0013). The body of `node - <<'NODE'` is that program's standard input,
 * so its `if (` and `for (` lines are not shell control flow and a devai command
 * written inside it is not executed by the step. A line that names a shell or an
 * evaluator, or that pipes or redirects output onward (a body written to a file
 * may be sourced later), keeps its bodies, so control flow they carry still makes
 * the step non-binding; an unterminated or unreadable here-document leaves the
 * script unchanged. Lines joined by `\` continuations are judged as one command.
 */
export function stripHeredocBodies(script: string): string {
  if (!script.includes('<<')) return script;
  const lines = script.split('\n');
  // A YAML block scalar reaches the shell without its common indentation, so the
  // terminator is compared after removing the spaces every non-empty line shares.
  const indent = Math.min(
    ...lines.filter((line) => line.trim() !== '').map((line) => /^ */.exec(line)?.[0].length ?? 0),
  );
  const kept: string[] = [];
  let index = 0;
  while (index < lines.length) {
    // One logical command: physical lines joined across `\` continuations, so a
    // redirect, pipe, or shell named on a continuation line is judged with its
    // opener, and the body starts after the command's last physical line.
    let last = index;
    while (last < lines.length - 1 && continuesLine(lines[last] ?? '')) last += 1;
    const physical = lines.slice(index, last + 1);
    kept.push(...physical);
    const command = physical
      .map((line, offset) => (offset < physical.length - 1 ? line.slice(0, -1) : line))
      .join(' ');
    const parsed = heredocLine(command);
    if (parsed === null) return script;
    let end = last;
    for (const operator of parsed.operators) {
      let terminator = end + 1;
      while (terminator < lines.length) {
        const candidate = (lines[terminator] ?? '').slice(indent);
        if ((operator.stripTabs ? candidate.replace(/^\t+/, '') : candidate) === operator.delimiter)
          break;
        terminator += 1;
      }
      if (terminator >= lines.length) return script;
      end = terminator;
    }
    // A kept body is read on as lines of its own; a removed one is skipped whole.
    index =
      parsed.operators.length === 0 || parsed.onward || feedsShell(command) ? last + 1 : end + 1;
  }
  return kept.join('\n');
}

/** A line ending in an unescaped backslash continues onto the next physical line. */
function continuesLine(line: string): boolean {
  return (/\\+$/u.exec(line)?.[0].length ?? 0) % 2 === 1;
}

export function shellSegments(rawScript: string): readonly string[] {
  const script = stripHeredocBodies(rawScript);
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let comment = false;
  const emit = (end: number): void => {
    const segment = script.slice(start, end).trim();
    if (segment !== '') segments.push(segment);
  };
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index];
    if (comment) {
      if (char !== '\n') continue;
      comment = false;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '#' && (index === 0 || /[\s;&|()]/.test(script[index - 1] ?? ''))) {
      comment = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '\n' || char === ';' || (char === '&' && script[index + 1] === '&')) {
      emit(index);
      if (char === '&') index += 1;
      start = index + 1;
    }
  }
  emit(script.length);
  return segments;
}

export function hasNonBindingControlFlow(script: string): boolean {
  return shellSegments(script).some((segment) =>
    /^(?:if|then|elif|else|while|until|case|for|do|done|fi|esac)(?:\s|$)/.test(
      stripYamlComment(segment).trim(),
    ),
  );
}

/**
 * `set +e` drops errexit for everything the shell runs afterwards, so it makes
 * the rest of the body non-binding however it is reached — its own line, after
 * `;`, or after `&&`. Matching on segments rather than on line starts keeps the
 * one-liner forms from slipping past the gate-masking guard.
 */
export function disablesErrexit(segment: string): boolean {
  const words = shellWords(stripYamlComment(segment).trim());
  if (words?.[0] !== 'set') return false;
  for (let index = 1; index < words.length; index += 1) {
    const option = words[index] ?? '';
    if (option === '--' || !/^[+-]/.test(option)) break;
    if (option === '+o' || option === '-o') {
      const name = words[index + 1];
      if (option === '+o' && name === 'errexit') return true;
      if (name !== undefined && !/^[+-]/.test(name)) index += 1;
    } else if (/^\+[a-zA-Z]*e[a-zA-Z]*$/.test(option)) {
      return true;
    }
  }
  return false;
}

function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word = '';
  let started = false;
  let single = false;
  let double = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? '';
    if (single) {
      if (char === "'") single = false;
      else word += char;
      started = true;
      continue;
    }
    if (double) {
      if (char === '"') {
        double = false;
      } else if (char === '\\') {
        const next = command[index + 1];
        if (next === undefined) return null;
        // Inside double quotes, the shell only removes a backslash before
        // dollar, backtick, double quote, backslash, or a continued newline.
        if (next !== '\n') {
          word += ['$', '`', '"', '\\'].includes(next) ? next : `\\${next}`;
        }
        index += 1;
      } else {
        word += char;
      }
      started = true;
      continue;
    }
    if (char === "'") {
      single = true;
      started = true;
    } else if (char === '"') {
      double = true;
      started = true;
    } else if (char === '\\') {
      const next = command[index + 1];
      if (next === undefined) return null;
      word += next;
      started = true;
      index += 1;
    } else if (/\s/.test(char)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
    } else {
      word += char;
      started = true;
    }
  }

  if (single || double) return null;
  if (started) words.push(word);
  return words;
}

function executableName(token: string): string {
  return token.replaceAll('\\', '/').split('/').pop() ?? '';
}

function skipOptions(words: readonly string[], start: number): number {
  let index = start;
  while (words[index]?.startsWith('-') === true) index += 1;
  return index;
}

function devaiActionStart(words: readonly string[]): number | null {
  let index = 0;
  if (executableName(words[index] ?? '') === 'env') {
    index += 1;
    index = skipOptions(words, index);
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index += 1;
  } else {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index += 1;
  }

  if (executableName(words[index] ?? '') === 'command') {
    index = skipOptions(words, index + 1);
  }

  const executable = executableName(words[index] ?? '');
  if (executable === 'devai') return index + 1;

  if (executable === 'node' || executable === 'nodejs') {
    index = skipOptions(words, index + 1);
    const script = (words[index] ?? '').replaceAll('\\', '/');
    // The workspace CLI, or the bootstrapped runner the pull-request lane installs
    // (`node .devai/state/pr-bootstrap/cli/bin.js <action>`).
    if (
      /(?:^|\/)packages\/cli\/(?:dist|src)\/bin\.(?:js|ts)$/.test(script) ||
      /(?:^|\/)\.devai\/state\/pr-bootstrap\/cli\/bin\.js$/.test(script)
    ) {
      return index + 1;
    }
    return null;
  }

  if (executable === 'pnpm') {
    index = skipOptions(words, index + 1);
    if (words[index] === 'exec') index = skipOptions(words, index + 1);
    return executableName(words[index] ?? '') === 'devai' ? index + 1 : null;
  }

  if (executable === 'npx') {
    index = skipOptions(words, index + 1);
    return executableName(words[index] ?? '') === 'devai' ? index + 1 : null;
  }

  if (executable === 'npm' && words[index + 1] === 'exec') {
    index = skipOptions(words, index + 2);
    if (words[index] === '--') index += 1;
    return executableName(words[index] ?? '') === 'devai' ? index + 1 : null;
  }

  return null;
}

function invokesDevaiAction(command: string, candidate: string): boolean {
  const words = shellWords(command);
  if (words === null) return false;
  const actionStart = devaiActionStart(words);
  if (actionStart === null) return false;
  return actionSpellings(candidate).some(
    (spelling) =>
      spelling.length > 0 &&
      spelling.every(
        (part, offset) => words[actionStart + offset]?.toLowerCase() === part.toLowerCase(),
      ),
  );
}

export function isFailClosedExecutableSegment(segment: string, candidate: string): boolean {
  const command = stripYamlComment(segment).trim();
  if (command === '' || command.startsWith('#')) return false;

  // These forms can make an observed command non-binding even when the text
  // occurs in a `run:` body.
  if (/\|\|/.test(command)) return false;
  if (/(?:^|\s)(?:>|>>|1>|1>>|2>|2>>)\s*\/dev\/null(?:\s|$)/.test(command)) return false;
  if (disablesErrexit(command)) return false;

  const firstToken = shellWords(command)?.[0];
  if (firstToken === undefined) return false;
  const executable = executableName(firstToken);
  if (
    [
      'echo',
      'printf',
      'true',
      ':',
      'if',
      'while',
      'until',
      'case',
      'for',
      'function',
      '!',
    ].includes(executable)
  ) {
    return false;
  }
  if (/(?:^|[^&])&\s*$/.test(command)) return false;

  // A pipeline hides the measured command's status unless pipefail is
  // established in the same run body. Treat it as non-promoting here.
  if (/(^|[^|])\|([^|]|$)/.test(command)) return false;

  return invokesDevaiAction(command, candidate);
}

export function hasExecutableMeasurement(
  steps: readonly WorkflowRunStep[],
  candidate: string,
): boolean {
  return steps.some(
    (step) =>
      !step.continueOnError &&
      !step.disabled &&
      !shellSegments(step.script).some(disablesErrexit) &&
      !hasNonBindingControlFlow(step.script) &&
      shellSegments(step.script).some((segment) =>
        isFailClosedExecutableSegment(segment, candidate),
      ),
  );
}
