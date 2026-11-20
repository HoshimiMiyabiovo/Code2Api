function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

export function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '(.*)';
    else if (char === '?') source += '(.)';
    else source += escapeRegex(char);
  }
  return new RegExp(`^${source}$`);
}

export function matchesGlob(value: string, pattern: string): boolean {
  return globToRegExp(pattern).test(value);
}

export function isModelBlacklisted(
  modelId: string,
  patterns: string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => matchesGlob(modelId, pattern));
}

export function resolveModelAlias(
  modelId: string,
  aliases: Record<string, string> | undefined,
): string {
  if (!aliases) return modelId;
  if (aliases[modelId]) return aliases[modelId];
  for (const [pattern, target] of Object.entries(aliases)) {
    if (!pattern.includes('*') && !pattern.includes('?')) continue;
    const match = globToRegExp(pattern).exec(modelId);
    if (!match) continue;
    return target.replace(/\$(\d+)/g, (_, index: string) => match[Number(index)] ?? '');
  }
  return modelId;
}
