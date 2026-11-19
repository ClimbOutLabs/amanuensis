/**
 * Reads a whole number typed into a work-limit field. Plain digits are read as
 * written, and comma-grouped digits such as 1,000,000 are read at their full
 * value, because the limits on these screens are shown with commas. Anything
 * else returns null, so the field can refuse the input instead of silently
 * keeping only its leading digits the way a bare parse would.
 */
export function parseWholeNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) && !/^\d{1,3}(,\d{3})+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed.replace(/,/g, ''));
  return Number.isSafeInteger(value) ? value : null;
}
