/**
 * The only way a chat title may reach model-visible memory text. A bare title can read as the
 * user's name (a chat titled after an assistant looks like an introduction), so it is always
 * labeled, collapsed to one line, and dropped when it contains any name the assistant answers to.
 */
export function chatTitleContext({
  title,
  assistantNames,
}: {
  title: string | undefined;
  assistantNames: readonly (string | null | undefined)[];
}): string | undefined {
  const singleLine = title?.replace(/\s+/g, ' ').trim();
  if (singleLine === undefined || singleLine === '') {
    return undefined;
  }
  for (const name of assistantNames) {
    const trimmed = name?.replace(/\s+/g, ' ').trim();
    if (trimmed === undefined || trimmed === '') {
      continue;
    }
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Unicode-aware boundaries so "Al" does not drop "Alpine" but still matches "hey Al, hi".
    if (new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(singleLine)) {
      return undefined;
    }
  }
  return `Chat title: ${singleLine}`;
}
