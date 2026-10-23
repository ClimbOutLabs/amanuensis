/** The tab that Left, Right, Home or End moves to, or null for any other key. Wraps at the ends. */
export function tablistTargetIndex({
  key,
  current,
  count,
}: {
  key: string;
  current: number;
  count: number;
}): number | null {
  if (count === 0) return null;
  if (key === 'ArrowRight') return (current + 1) % count;
  if (key === 'ArrowLeft') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
