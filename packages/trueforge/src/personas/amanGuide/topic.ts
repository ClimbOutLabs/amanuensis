/** One page of the built-in Aman guide. Written as plain words; the build checks `covers` against the Tour cards. */
export interface AmanGuideTopic {
  id: string;
  title: string;
  /** Tour card keys this page explains. A Tour card with no page fails the build. */
  covers: string[];
  body: string;
}
