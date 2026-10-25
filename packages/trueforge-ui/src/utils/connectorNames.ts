/**
 * The one owner of how a connector's catalog name reads to a person: `parallel-web` is the web
 * search, and brand names keep their own spelling. Any other name is tidied into words.
 */
const CONNECTOR_NAMES: ReadonlyMap<string, string> = new Map([
  ['parallel-web', 'Web search'],
  ['github', 'GitHub'],
  ['deepwiki', 'DeepWiki'],
  ['posthog', 'PostHog'],
  ['bright-data', 'Bright Data'],
]);

export function connectorDisplayName(name: string): string {
  const known = CONNECTOR_NAMES.get(name);
  if (known !== undefined) return known;
  const plain = name.replace(/[_-]+/g, ' ').trim();
  return plain === '' ? name : plain.charAt(0).toUpperCase() + plain.slice(1);
}
