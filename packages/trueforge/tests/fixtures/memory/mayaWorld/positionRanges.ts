/** Sorted positions written as ranges, such as `3-5, 9, 14-20`; two in a row stay as `3, 4`. */
export function positionRanges(positions: readonly number[]): string {
  const sorted = [...positions].sort((a, b) => a - b);
  const parts: string[] = [];
  let index = 0;
  while (index < sorted.length) {
    let end = index;
    while (sorted[end + 1] === (sorted[end] ?? 0) + 1) {
      end += 1;
    }
    const first = String(sorted[index]);
    parts.push(
      end - index >= 2 ? `${first}-${String(sorted[end])}` : [...sorted.slice(index, end + 1)].map(String).join(', '),
    );
    index = end + 1;
  }
  return parts.join(', ');
}
