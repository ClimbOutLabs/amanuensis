/**
 * Answers some page links from local fixtures instead of the web. Only an eval instance sets one; a
 * link it does not serve is read from the web as usual.
 */
export interface PageFixtureSource {
  /** Whether this link is answered from fixtures. */
  serves(url: string): boolean;
  /** The fixture page for a link `serves` accepted, or undefined when no fixture has that page. */
  read(url: string): { title: string; text: string } | undefined;
}
