import type { PageKind } from '../../../../src/runtime/memory/memoryPages';
import { pageSlug } from '../../../../src/runtime/memory/pageSlug';

/** Everyone and everything in Maya's world that could have a page. Maya is the owner and has none. */
export const MAYA_PAGES = {
  wendy: { title: 'Wendy', kind: 'person' },
  zoe: { title: 'Zoe', kind: 'person' },
  samRossi: { title: 'Sam Rossi', kind: 'person' },
  samWhitfield: { title: 'Sam Whitfield', kind: 'person' },
  priya: { title: 'Priya Nair', kind: 'person' },
  tomas: { title: 'Tomás Herrera', kind: 'person' },
  elena: { title: 'Elena Petrova', kind: 'person' },
  dimitra: { title: 'Δήμητρα Παππά', kind: 'person' },
  minsu: { title: '김민수', kind: 'person' },
  marcus: { title: 'Marcus Bell', kind: 'person' },
  aiko: { title: 'Aiko Tanaka', kind: 'person' },
  noor: { title: 'Noor Haddad', kind: 'person' },
  madrid: { title: 'The Madrid trip', kind: 'matter' },
  kitchen: { title: 'Kitchen renovation', kind: 'matter' },
  taxes: { title: '2025 tax return', kind: 'matter' },
  halvorsen: { title: 'Halvorsen proposal', kind: 'matter' },
  school: { title: "Zoe's school", kind: 'matter' },
  dentist: { title: 'Family dentist', kind: 'matter' },
} as const satisfies Record<string, { title: string; kind: PageKind }>;

export type MayaPageKey = keyof typeof MAYA_PAGES;

export function mayaPageSlug(key: MayaPageKey): string {
  return pageSlug(MAYA_PAGES[key].title);
}

/** The calendar day of a world day: day 1 is 2026-08-01. */
export function mayaDate(day: number): string {
  return new Date(Date.UTC(2026, 7, day)).toISOString().slice(0, 10);
}

/** The page a slug names, or undefined when the world has no such page. */
export function mayaPageBySlug(slug: string): { title: string; kind: PageKind } | undefined {
  return Object.values(MAYA_PAGES).find(page => pageSlug(page.title) === slug);
}
