/** Fold a collected YAML block body, preserving paragraph and extra-indent breaks. */
export function foldWorkflowLines(body: readonly string[]): string {
  const first = body.find((line) => line.trim() !== '');
  if (first === undefined) return '';
  const indent = first.length - first.trimStart().length;
  const lines = body.map((line) => (line.trim() === '' ? '' : line.slice(indent)));
  let result = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line === '') {
      result += '\n';
      continue;
    }
    result += line;
    let next = index + 1;
    while (next < lines.length && lines[next] === '') next += 1;
    if (next === lines.length) break;
    const emptyLines = next - index - 1;
    const extraIndent = /^\s/.test(line) || /^\s/.test(lines[next] ?? '');
    result += extraIndent
      ? '\n'.repeat(emptyLines + 1)
      : emptyLines > 0
        ? '\n'.repeat(emptyLines)
        : ' ';
    index = next - 1;
  }
  return result;
}
