export function hasValidPatterns(value: unknown, required: boolean): value is readonly string[] {
  if (value === undefined) return !required;
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((pattern) => {
    if (typeof pattern !== 'string') return false;
    try {
      new RegExp(pattern, 'i');
      return true;
    } catch {
      return false;
    }
  });
}

export function firstUnallowedChangeMatch(
  pattern: RegExp,
  evidence: string,
  allowedLinePatterns: readonly RegExp[],
): RegExpExecArray | null {
  if (allowedLinePatterns.length === 0) return pattern.exec(evidence);

  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  let match = globalPattern.exec(evidence);
  while (match !== null) {
    const lineStart = evidence.lastIndexOf('\n', Math.max(0, match.index - 1)) + 1;
    const nextNewline = evidence.indexOf('\n', match.index);
    const line = evidence.slice(lineStart, nextNewline === -1 ? evidence.length : nextNewline);
    const relativeMatchStart = match.index - lineStart;
    const relativeMatchEnd = relativeMatchStart + match[0].length;
    const isAllowed = allowedLinePatterns.some((allowedPattern) => {
      const flags = allowedPattern.flags.includes('g')
        ? allowedPattern.flags
        : `${allowedPattern.flags}g`;
      const globalAllowedPattern = new RegExp(allowedPattern.source, flags);
      let allowedMatch = globalAllowedPattern.exec(line);
      while (allowedMatch !== null) {
        const allowedEnd = allowedMatch.index + allowedMatch[0].length;
        if (allowedMatch.index <= relativeMatchStart && allowedEnd >= relativeMatchEnd) return true;
        if (allowedMatch[0].length === 0) globalAllowedPattern.lastIndex += 1;
        allowedMatch = globalAllowedPattern.exec(line);
      }
      return false;
    });
    if (!isAllowed) return match;
    if (match[0].length === 0) globalPattern.lastIndex += 1;
    match = globalPattern.exec(evidence);
  }
  return null;
}
