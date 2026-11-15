/**
 * Turns the name a person types ("Morning email helper") into the saved form agent names must take:
 * lowercase letters, digits and hyphens, starting with a letter. Returns '' when nothing usable is left.
 */
export function agentNameFromLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}
