/** One page of the built-in Aman guide. Written as plain words; the build and the coverage check read `covers`. */
export interface AmanGuideTopic {
  id: string;
  title: string;
  /** Tour card keys and `kind:name` surfaces this page explains. A surface with no page fails the coverage check. */
  covers: string[];
  body: string;
}
